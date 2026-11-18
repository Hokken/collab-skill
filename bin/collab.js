#!/usr/bin/env node
// collab — turn-based implementer/reviewer handoff between two coding agents
// (e.g. Claude Code and Codex CLI) through a shared state folder in ~/.collab.
//
// Exit codes: 0 ok / your turn, 1 error, 10 task finished (DONE, ESCALATED,
// ABORTED, STALLED) or, for 'join --after', the implementer ended the run,
// 11 wait timed out (not your turn yet — just run it again),
// 12 submit refused because a note for you is not acknowledged ("Note #N") in your message,
// 13 the other agent looks unresponsive — ask the user whether to stop or keep waiting,
// 14 submit refused because the task's --check command failed, 15 the queue is empty,
// 16 the user has to decide (the other agent asked, or the round limit for the implementer) — show them the options,
// 17 the tree changed since the implementer's handoff (refused approve or changes) or since the approval ('verify').
//
// Zero dependencies; runs on macOS, Linux and Windows (Node >= 18).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// --- configuration ------------------------------------------------------------

const envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
};

const COLLAB_HOME = process.env.COLLAB_HOME || path.join(os.homedir(), '.collab');
const TASKS = path.join(COLLAB_HOME, 'tasks');
const DRAFTS = path.join(COLLAB_HOME, 'drafts');
const POLL = envInt('COLLAB_POLL_SECS', 5);
const STALL = envInt('COLLAB_STALL_SECS', 7200);       // 2 h without a handoff => STALLED
const IDLE = envInt('COLLAB_IDLE_SECS', 1800);         // 30 min without a handoff => ask the user
const QUIET_MINS = envInt('COLLAB_QUIET_MINS', 10);    // ...and no project file changed for this long
const DEFAULT_MAX_ROUNDS = envInt('COLLAB_MAX_ROUNDS', 4);
const CHECK_TIMEOUT = envInt('COLLAB_CHECK_TIMEOUT', 1800); // --check commands time out after 30 min
const LOCK_WAIT = envInt('COLLAB_LOCK_SECS', 10);      // wait this long before checking a lock's owner (tests lower it)
const DECIDE_REPEAT = envInt('COLLAB_DECIDE_REPEAT_SECS', 30); // a pending decision is sounded again this often (0: never)

const EXIT_TERMINAL = 10;
const EXIT_TIMEOUT = 11;
const EXIT_NOTES = 12;
const EXIT_IDLE = 13;
const EXIT_CHECK = 14;
const EXIT_EMPTY = 15;
const EXIT_DECISION = 16;
const EXIT_TREE = 17;

const TERMINAL = new Set(['DONE', 'ESCALATED', 'ABORTED', 'STALLED']);
const ROLES = ['implementer', 'reviewer'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);

let TASK_OVERRIDE = '';

// --- basics ---------------------------------------------------------------------

class CollabError extends Error {}
class ExitCode extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

const die = (msg) => { throw new CollabError(msg); };
const exit = (code) => { throw new ExitCode(code); };
const out = (s = '') => process.stdout.write(`${s}\n`);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const epoch = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pad3 = (n) => String(n).padStart(3, '0');
const isTerminal = (st) => TERMINAL.has(st);

const localStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const localTime = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function fmtDur(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

// Windows can briefly refuse a rename or read while another process has the file
// open (a wait loop or collab watch), so transient errors are retried.
function retry(fn, tries = 20) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const transient = e instanceof SyntaxError || ['EPERM', 'EBUSY', 'EACCES'].includes(e.code);
      if (!transient || i >= tries) throw e;
      sleepSync(25 + i * 10);
    }
  }
}

// silent: a collab sound already plays for this event, so the notification makes none of its own.
function notify(msg, { silent = false } = {}) {
  if (!silent) process.stderr.write('\x07');
  if (process.env.COLLAB_NOTIFY === '0') return;
  const run = (cmd, args) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch { /* notifications are best effort */ }
  };
  if (process.platform === 'darwin') {
    const m = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    run('osascript', ['-e', `display notification "${m}" with title "collab"${silent ? '' : ' sound name "Glass"'}`]);
  } else if (process.platform === 'win32') {
    const m = msg.replace(/'/g, "''");
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$x = $t.GetElementsByTagName('text')",
      "$x.Item(0).AppendChild($t.CreateTextNode('collab')) > $null",
      `$x.Item(1).AppendChild($t.CreateTextNode('${m}')) > $null`,
      "$n = [Windows.UI.Notifications.ToastNotification]::new($t)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)",
    ].join('; ');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
  } else {
    run('notify-send', ['collab', msg]);
  }
}

// --- phone notifications (opt-in per task with --phone) -----------------------------

// Read-modify-write a JSON file in COLLAB_HOME under the home lock (queue, config).
function withHomeFile(file, read, fn) {
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  return withLock(COLLAB_HOME, () => {
    const data = read();
    const res = fn(data);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    retry(() => fs.renameSync(tmp, file));
    return res;
  });
}

const configPath = () => path.join(COLLAB_HOME, 'config.json');
function readConfig() {
  try { return retry(() => JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch { return {}; }
}
const phoneUrl = () => process.env.COLLAB_PHONE_URL || readConfig().phone_url || '';

// A bare ntfy topic becomes its ntfy.sh URL; anything else must be an http(s) URL.
function phoneTarget(v) {
  const s = String(v || '').trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return `https://ntfy.sh/${s}`;
  let u = null;
  try { u = new URL(s); } catch { /* not a URL */ }
  if (u && /^https?:$/.test(u.protocol) && u.hostname) return s;
  die(`not an ntfy topic (letters, digits, '-', '_', at most 64) or an http(s) URL: ${s}`);
}

// The destination for --phone pushes; the first use creates a random ntfy.sh topic (the topic
// name is the only secret, so it has to be unguessable).
function ensurePhoneUrl() {
  const url = phoneUrl();
  if (url) return { url, created: false };
  return withHomeFile(configPath(), readConfig, (c) => {
    if (!c.phone_url) c.phone_url = `https://ntfy.sh/collab-${crypto.randomBytes(8).toString('hex')}`;
    return { url: c.phone_url, created: true };
  });
}

function phoneHelp(url) {
  const m = url.match(/^https:\/\/ntfy\.sh\/([^/?#]+)$/);
  return m ? `subscribe to topic '${m[1]}' in the ntfy app (https://ntfy.sh), server ntfy.sh` : `pushes go to ${url}`;
}

// POST the message (ntfy headers; other webhooks just get the text). Runs in a detached child, so
// a slow or unreachable server never delays the command or changes its result.
const PUSH_SCRIPT = "const [u,t,m,p]=process.argv.slice(1);fetch(u,{method:'POST',body:m,headers:{Title:t,Priority:p,Tags:'robot'},signal:AbortSignal.timeout(10000)}).then((r)=>{process.exitCode=r.ok?0:1},()=>{process.exitCode=1})";

function pushPhone(st, msg, { priority = 'default' } = {}) {
  if (!st || !st.options || !st.options.phone) return;
  const url = phoneUrl();
  if (!url) return;
  try {
    const child = spawn(process.execPath, ['-e', PUSH_SCRIPT, url, `collab: ${st.id}`, msg, priority],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* pushes are best effort */ }
}

// --- sounds and speech (task option --sound, or config.json 'sound') ---------------------

// Every event collab can sound: what it means, the full sentence (made to follow a session by ear
// alone) and the short one (the default: just where the collab is). `c` is the event's context
// (soundCtx): c.t is the spoken task name, c.st the task state after the event.
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SOUND_EVENTS = {
  brief: ['a new task starts', (c) => `${c.t}: new task started. ${startLine(c.st)}`, (c) => `${c.t}: new task`],
  'part-start': ['a part of a split task starts', (c) => `${c.t}: part ${c.part.index} of ${c.part.total} started. ${startLine(c.st)}`, (c) => `${c.t}: part ${c.part.index} of ${c.part.total} started`],
  split: ['the implementer split the task into parts', (c) => `${c.t}: split into ${c.part.total} parts.`, (c) => `${c.t}: split into ${c.part.total} parts`],
  plan: ['the implementer handed in a plan', (c) => `${c.t}: plan submitted, plan round ${phaseRound(c.st)}. The reviewer's turn.`, (c) => `${c.t}: plan ready`],
  'plan-changes': ['the reviewer asked for changes to the plan', (c) => `${c.t}: the reviewer requested ${plural(c.n, 'change')} to the plan. The implementer's turn.`, (c) => `${c.t}: plan changes`],
  'plan-approve': ['the plan is approved: the build starts', (c) => `${c.t}: plan approved. The implementer is building it.`, (c) => `${c.t}: plan approved`],
  ready: ['the implementer handed in its work for review', (c) => `${c.t}: ready for review, round ${c.st.round}. The reviewer's turn.`, (c) => `${c.t}: ready, round ${c.st.round}`],
  changes: ['the reviewer asked for changes', (c) => `${c.t}: the reviewer requested ${plural(c.n, 'change')}. The implementer's turn, round ${c.st.round}.`, (c) => `${c.t}: changes, round ${c.st.round}`],
  approve: ['the reviewer approved: the task is done', (c) => `${c.t}: approved. Task done.`, (c) => `${c.t}: approved`],
  'part-done': ['a part of a split task is done', (c) => `${c.t}: part ${c.part.index} of ${c.part.total} done.${c.part.total > c.part.index ? ` ${c.part.total - c.part.index} to go.` : ' All parts done.'}`, (c) => `${c.t}: part ${c.part.index} of ${c.part.total} done`],
  decide: ['you have to choose (an agent asks, or the round limit)', (c) => decideSpeech(c), (c) => `${c.t}: decision needed`],
  // Short in both styles: the full menu was read out once with 'decide'.
  'decide-repeat': ['a decision still waits for you (every 30 s until you answer)', (c) => `${c.t}: your decision is still needed. Answer in the ${c.presenter}'s terminal, or run collab answer.`, (c) => `${c.t}: decision needed`],
  answer: ['your answer to a decision was recorded', (c) => `${c.t}: decision recorded: ${clipSpeech(c.answer, 80)}. Back to the ${c.st.turn}.`, (c) => `${c.t}: answered`],
  escalate: ['the task was escalated: the loop stopped and needs you', (c) => `${c.t}: escalated by the ${c.role}: ${clipSpeech(c.text, 140)}. The loop has stopped and needs you.`, (c) => `${c.t}: escalated`],
  abort: ['the task was aborted', (c) => `${c.t}: aborted. Both agents stop.`, (c) => `${c.t}: aborted`],
  stall: ['the task stalled (no handoff for too long)', (c) => `${c.t}: stalled, no handoff for ${c.mins} minutes. The loop has stopped.`, (c) => `${c.t}: stalled`],
  idle: ['an agent looks unresponsive: stop or keep waiting?', (c) => `${c.t}: ${clipSpeech(c.why, 160)}. Stop or keep waiting? Answer in the ${c.waiter}'s terminal.`, (c) => `${c.t}: the ${quietAgent(c)} is quiet`],
  'check-fail': ["the task's --check failed, so nothing was handed off", (c) => `${c.t}: the check failed, nothing was handed off. The implementer is fixing it.`, (c) => `${c.t}: check failed`],
  confirm: ['a queued task waits for your go-ahead', (c) => `${c.t ? `${c.t}: q` : 'Q'}ueued task ${c.item.id} needs your go-ahead: ${clipSpeech(c.text, 120)}. Answer in the implementer's terminal.`, (c) => `${c.t ? `${c.t}: q` : 'Q'}ueued task ${c.item.id} waiting for you`],
  'agent-waiting': ['an agent CLI waits for you (permission prompt, question, turn ended)', (c) => `${c.t ? `${c.t}: ` : ''}${clipSpeech(c.text, 200)}`, (c) => `${c.t ? `${c.t}: a` : 'A'}n agent is waiting for you`],
  'note-all': ['you added a note for both agents', (c) => `${c.t}: your note for both agents was added.`, (c) => `${c.t}: note added`],
  'note-implementer': ['you added a note for the implementer', (c) => `${c.t}: your note for the implementer was added.`, (c) => `${c.t}: note for the implementer`],
  'note-reviewer': ['you added a note for the reviewer', (c) => `${c.t}: your note for the reviewer was added.`, (c) => `${c.t}: note for the reviewer`],
  'peer-note-implementer': ['the reviewer sent the implementer a note', (c) => `${c.t}: the reviewer sent the implementer a note.`, (c) => `${c.t}: note from the reviewer`],
  'peer-note-reviewer': ['the implementer sent the reviewer a note', (c) => `${c.t}: the implementer sent the reviewer a note.`, (c) => `${c.t}: note from the implementer`],
  'sound-change': ["a task's sound settings were changed ('collab sound use')", (c) => `${c.t}: sound set to ${c.text}`, (c) => `${c.t}: ${c.text}`],
  end: ['the implementer ended the run: all work is done', (c) => `${c.t}: work complete, ${plural(c.n, 'task')}. Run collab show for the final report.`, (c) => `${c.t}: work complete`],
};
const SOUND_MODES = ['voice', 'tones', 'off', 'elevenlabs', 'full'];
const SOUND_STYLES = ['short', 'full'];
// The agent that went quiet: the one holding the turn in 'wait', the implementer after DONE ('join --after').
const quietAgent = (c) => (ROLES.includes(c.st.turn) ? c.st.turn : 'implementer');
// Without the task name (the default: one collab at a time needs none), "dark mode: plan ready"
// becomes "Plan ready".
function sentence(event, c, style, name = true) {
  const text = clipSpeech(SOUND_EVENTS[event][style === 'full' ? 1 : 2](name ? c : { ...c, t: '' }), Infinity);
  return name ? text : text.replace(/^:\s*/, '').replace(/^\p{Ll}/u, (x) => x.toUpperCase());
}

const startLine = (st) => (st.phase === 'plan' ? 'The implementer is writing a plan.' : 'The implementer is working.');
const spokenTask = (id) => String(id || '').replace(/-\d{8}-\d{6}(-\d+)?$/, '').replace(/[-_]+/g, ' ').trim();

// Plain text for the voice: no markdown, no leading dash (a speech CLI would take it as an option),
// clipped at a word boundary.
function clipSpeech(s, max = 300) {
  let t = String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\s-]+/gm, '').replace(/[*_~#|<>]+/g, ' ').replace(/\s+/g, ' ').replace(/([?!…])\s*\./g, '$1')
    .trim().replace(/[.:;,\s]+$/, '').replace(/^-+\s*/, '');
  if ([...t].length > max) t = `${[...t].slice(0, max).join('').replace(/\s+\S*$/, '')}…`;
  return t;
}

// A decision is read out whole: the question (clipped), every option with its number (each
// clipped), and always how to answer.
function decideSpeech(c) {
  const opts = (c.options || []).map((o, i) => `Option ${i + 1}: ${clipSpeech(o, 80)}.`).join(' ');
  return `${c.t}: your decision is needed. ${clipSpeech(c.question, 160)}. ${opts} Answer in the ${c.presenter}'s terminal, or run collab answer with the option number.`;
}

function soundCtx(st, extra = {}) {
  return { t: st ? spokenTask(st.id) : '', st: st || {}, part: (st && st.part) || { index: 1, total: 1 }, ...extra };
}

// {task} {round} {part} {parts} {turn} {role} {count} {question} {options} {text} {quiet} in custom
// sentences ({quiet}: the agent an idle event is about).
function fillSay(tpl, c) {
  const vals = {
    task: c.t, round: c.st.phase ? phaseRound(c.st) : '', part: c.part.index, parts: c.part.total, turn: c.st.turn || '',
    role: c.role || '', count: c.n === undefined ? '' : c.n, question: clipSpeech(c.question, 160),
    options: (c.options || []).map((o, i) => `Option ${i + 1}: ${clipSpeech(o, 80)}.`).join(' '),
    text: clipSpeech(c.text || c.why || c.answer, 200), quiet: quietAgent(c),
  };
  return clipSpeech(String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]) : m)), 1500);
}

// --- platform players -----------------------------------------------------------------------

// COLLAB_SOUND_PLATFORM lets tests build another platform's commands; COLLAB_SOUND_BIN makes
// collab look up players only in that folder (a stub `<name>.js` there runs with node).
const soundPlatform = () => process.env.COLLAB_SOUND_PLATFORM || process.platform;
const soundOs = () => (['darwin', 'win32'].includes(soundPlatform()) ? soundPlatform() : 'linux');
const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const vol01 = (v) => Math.max(0, Math.min(100, Number(v))) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const extOf = (f) => path.extname(String(f)).slice(1).toLowerCase();

// Windows: the file and text go in environment variables, never into the script text.
const PS_WAV = '$p = New-Object System.Media.SoundPlayer $env:COLLAB_SOUND_FILE; $p.PlaySync()';
const PS_MEDIA = [
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Volume = [double]$env:COLLAB_SOUND_VOLUME',
  '$p.Open((New-Object System.Uri $env:COLLAB_SOUND_FILE))',
  '$p.Play()',
  '$n = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 100; $n++ }',
  '$ms = 3000; if ($p.NaturalDuration.HasTimeSpan) { $ms = [Math]::Min($p.NaturalDuration.TimeSpan.TotalMilliseconds, 30000) - $n * 100 }',
  'if ($ms -gt 0) { Start-Sleep -Milliseconds ([int]$ms + 300) }',
  '$p.Close()',
].join('; ');
const PS_SAY = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.Volume = [int]$env:COLLAB_SAY_VOLUME',
  'if ($env:COLLAB_SAY_RATE) { $s.Rate = [int]$env:COLLAB_SAY_RATE }',
  '$s.Speak($env:COLLAB_SAY_TEXT)',
].join('; ');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script];

const TONE_PLAYERS = {
  darwin: [{ bin: 'afplay', exts: ['wav', 'aiff', 'aif', 'mp3', 'm4a', 'aac', 'caf', 'flac'], args: (f, v) => ['-v', String(vol01(v)), f] }],
  win32: [
    { bin: 'powershell', exts: ['wav'], ps: PS_WAV },
    { bin: 'powershell', exts: ['mp3', 'wma', 'm4a', 'aac', 'flac'], ps: PS_MEDIA },
  ],
  linux: [
    { bin: 'pw-play', exts: ['wav', 'ogg', 'oga', 'flac'], args: (f, v) => ['--volume', String(vol01(v)), f] },
    { bin: 'paplay', exts: ['wav', 'ogg', 'oga', 'flac'], args: (f, v) => [`--volume=${Math.round(vol01(v) * 65536)}`, f] },
    { bin: 'aplay', exts: ['wav'], args: (f) => ['-q', f] },
    { bin: 'mpg123', exts: ['mp3'], args: (f, v) => ['-q', '-f', String(Math.round(vol01(v) * 32768)), f] },
    { bin: 'ogg123', exts: ['ogg', 'oga'], args: (f) => ['-q', f] },
    { bin: 'play', exts: ['wav', 'ogg', 'oga', 'flac', 'aiff', 'aif'], args: (f, v) => ['-q', '-v', String(vol01(v)), f] },
    { bin: 'ffplay', exts: ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'wma'], args: (f, v) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(vol01(v) * 100)), f] },
  ],
};
const toneExts = (os = soundOs()) => [...new Set(TONE_PLAYERS[os].flatMap((p) => p.exts))];

// Speech rate is in words per minute (macOS 'say' and espeak use that; the others are mapped).
const SPEECH = {
  darwin: [{ bin: 'say', args: (t, o) => [...(o.rate ? ['-r', String(o.rate)] : []), t] }],
  win32: [{ bin: 'powershell', ps: PS_SAY }],
  linux: [
    { bin: 'spd-say', args: (t, o) => ['-w', '-i', String(clamp(Math.round(o.volume * 2 - 100), -100, 100)), ...(o.rate ? ['-r', String(clamp(Math.round((o.rate - 180) / 2), -100, 100))] : []), t] },
    { bin: 'espeak-ng', args: (t, o) => ['-a', String(Math.round(o.volume * 2)), ...(o.rate ? ['-s', String(o.rate)] : []), t] },
    { bin: 'espeak', args: (t, o) => ['-a', String(Math.round(o.volume * 2)), ...(o.rate ? ['-s', String(o.rate)] : []), t] },
  ],
};
const INSTALL_HINT = {
  tone: { darwin: 'afplay ships with macOS', win32: 'powershell.exe ships with Windows', linux: 'install pipewire (pw-play), pulseaudio-utils (paplay), alsa-utils (aplay) or ffmpeg (ffplay)' },
  speech: { darwin: "'say' ships with macOS", win32: 'Windows PowerShell 5.1 (powershell.exe) with System.Speech ships with Windows', linux: 'install speech-dispatcher (spd-say) or espeak-ng' },
};

function isExecFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32' && !p.endsWith('.js')) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function soundBin(name) {
  const stubs = process.env.COLLAB_SOUND_BIN;
  if (stubs) return [`${name}.js`, name, `${name}.exe`].map((f) => path.join(stubs, f)).find(isExecFile) || '';
  if (process.platform === 'win32' && name === 'powershell') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (isExecFile(sys)) return sys;
  }
  // Only real executables: a .cmd/.bat can't be spawned without a shell.
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) { const p = path.join(dir, name + e); if (isExecFile(p)) return p; }
  }
  return '';
}

const launch = (bin, args, env = {}) => (bin.endsWith('.js') ? { cmd: process.execPath, args: [bin, ...args], env, bin } : { cmd: bin, args, env, bin });

// The command that plays a sound file, or { why } when this machine can't.
function toneCommand(file, volume = 100) {
  const os = soundOs();
  const ext = extOf(file);
  const players = TONE_PLAYERS[os].filter((p) => p.exts.includes(ext));
  if (!players.length) return { why: `${ext ? `.${ext}` : 'this'} files can't be played on ${OS_NAME[os]} (it plays ${toneExts(os).join(', ')})` };
  for (const p of players) {
    const bin = soundBin(p.bin);
    if (!bin) continue;
    if (p.ps) return launch(bin, psArgs(p.ps), { COLLAB_SOUND_FILE: file, COLLAB_SOUND_VOLUME: String(vol01(volume)) });
    return launch(bin, p.args(file, volume));
  }
  return { why: `no player for .${ext} files found (${players.map((p) => p.bin).join(', ')}); ${INSTALL_HINT.tone[os]}` };
}

// The OS's own voice ('system'). ElevenLabs audio is made by the drainer (speakStep) and played
// as a tone, with this as its fallback.
function speechCommand(text, voice = {}, volume = 100) {
  const os = soundOs();
  const engine = voice.engine || 'system';
  const note = engine === 'system' || engine === 'elevenlabs' ? '' : `unknown voice engine '${engine}', using the system voice`;
  const rate = Number.isFinite(Number(voice.rate)) && Number(voice.rate) > 0 ? Math.round(Number(voice.rate)) : 0;
  const o = { volume: clamp(Number(volume), 0, 100), rate };
  for (const p of SPEECH[os]) {
    const bin = soundBin(p.bin);
    if (!bin) continue;
    if (p.ps) {
      return { ...launch(bin, psArgs(p.ps), { COLLAB_SAY_TEXT: text, COLLAB_SAY_VOLUME: String(o.volume), COLLAB_SAY_RATE: rate ? String(clamp(Math.round((rate - 180) / 20), -10, 10)) : '' }), note };
    }
    return { ...launch(bin, p.args(text, o)), note };
  }
  return { why: `no speech engine found (${SPEECH[os].map((p) => p.bin).join(', ')}); ${INSTALL_HINT.speech[os]}`, note };
}

// --- built-in sounds, config and packs --------------------------------------------------------

// The OS's own sounds, grouped so they can be told apart by ear: soft for handoffs, bright for
// milestones, loud for "you're needed", their own for notes. Only files that exist are used.
const SYSTEM_SOUNDS = {
  darwin: {
    dir: () => '/System/Library/Sounds', ext: 'aiff',
    map: {
      brief: 'Blow', 'part-start': 'Submarine', split: 'Bottle', plan: 'Pop', ready: 'Pop', answer: 'Pop',
      'plan-changes': 'Tink', changes: 'Tink', 'plan-approve': 'Glass', approve: 'Hero', 'part-done': 'Morse', end: 'Purr',
      decide: 'Sosumi', 'decide-repeat': 'Sosumi', confirm: 'Sosumi', 'agent-waiting': 'Sosumi', idle: 'Basso', escalate: 'Basso', stall: 'Basso',
      abort: 'Funk', 'check-fail': 'Funk', 'note-all': 'Ping', 'note-implementer': 'Ping', 'note-reviewer': 'Ping',
      'peer-note-implementer': 'Frog', 'peer-note-reviewer': 'Frog', 'sound-change': 'Pop',
    },
  },
  win32: {
    dir: () => path.join(process.env.SystemRoot || 'C:\\Windows', 'Media'), ext: 'wav',
    map: {
      brief: 'Windows Unlock', 'part-start': 'Windows Proximity Notification', split: 'chord', plan: 'Windows Notify System Generic',
      ready: 'Windows Notify System Generic', answer: 'Windows Notify System Generic', 'plan-changes': 'Windows Ding', changes: 'Windows Ding',
      'plan-approve': 'chimes', approve: 'tada', 'part-done': 'Windows Notify Calendar', end: 'tada',
      decide: 'Windows Exclamation', 'decide-repeat': 'Windows Exclamation', confirm: 'Windows Exclamation', 'agent-waiting': 'Windows Exclamation', idle: 'Windows Critical Stop',
      escalate: 'Windows Critical Stop', stall: 'Windows Critical Stop', abort: 'Windows Background', 'check-fail': 'Windows Background',
      'note-all': 'Windows Notify Messaging', 'note-implementer': 'Windows Notify Messaging', 'note-reviewer': 'Windows Notify Messaging',
      'peer-note-implementer': 'Windows Notify Email', 'peer-note-reviewer': 'Windows Notify Email', 'sound-change': 'Windows Notify System Generic',
    },
  },
  linux: {
    dir: () => '/usr/share/sounds/freedesktop/stereo', ext: 'oga',
    map: {
      brief: 'service-login', 'part-start': 'device-added', split: 'device-added', plan: 'message', ready: 'message', answer: 'message',
      'plan-changes': 'bell', changes: 'bell', 'plan-approve': 'dialog-information', approve: 'complete', 'part-done': 'complete', end: 'service-logout',
      decide: 'window-attention', 'decide-repeat': 'window-attention', confirm: 'window-attention', 'agent-waiting': 'window-attention', idle: 'dialog-warning', escalate: 'suspend-error',
      stall: 'suspend-error', abort: 'device-removed', 'check-fail': 'dialog-warning', 'note-all': 'message-new-instant',
      'note-implementer': 'message-new-instant', 'note-reviewer': 'message-new-instant', 'peer-note-implementer': 'message-new-instant',
      'peer-note-reviewer': 'message-new-instant', 'sound-change': 'message',
    },
  },
};

function systemSound(event) {
  const s = SYSTEM_SOUNDS[soundOs()];
  const name = s.map[event];
  if (!name) return '';
  const f = path.join(process.env.COLLAB_SOUND_SYSTEM_DIR || s.dir(), `${name}.${s.ext}`);
  return fs.existsSync(f) ? f : '';
}

function soundConfig() {
  const c = readConfig().sound;
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

const PACK_FILE = 'collab-sounds.json';
const expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
const soundPath = (p, base) => path.resolve(base, expandHome(String(p)));

// A sound pack: a folder with collab-sounds.json ({ name, events }). Never throws.
function readPack(dir) {
  if (!dir) return null;
  const folder = soundPath(dir, COLLAB_HOME);
  const res = { dir: folder, name: '', events: {}, error: '' };
  let raw;
  try { raw = fs.readFileSync(path.join(folder, PACK_FILE), 'utf8'); } catch (e) {
    res.error = e.code === 'ENOENT' ? `${fs.existsSync(folder) ? `no ${PACK_FILE} in` : 'no such folder:'} ${folder}` : `can't read ${path.join(folder, PACK_FILE)}: ${e.message}`;
    return res;
  }
  try {
    const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
    res.name = typeof j.name === 'string' ? j.name : '';
    if (j.events !== undefined && (typeof j.events !== 'object' || !j.events || Array.isArray(j.events))) throw new Error("'events' is not an object");
    res.events = j.events || {};
  } catch (e) {
    res.error = `${path.join(folder, PACK_FILE)} is not valid: ${e.message}`;
  }
  return res;
}

// A mapping value: a file path, null / "" / "none" (silent: no tone and no speech), or
// { file, say } where file null = no tone and say false = no speech.
function soundEntry(v) {
  if (v === null || v === '' || v === 'none' || v === false) return { file: null, say: false };
  if (typeof v === 'string') return { file: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const e = {};
    if (v.file !== undefined) e.file = v.file === '' || v.file === 'none' ? null : v.file;
    if (v.say !== undefined) e.say = v.say === '' ? false : v.say;
    return e;
  }
  return {};
}

const eventGlob = (k) => new RegExp(`^${String(k).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const keyMatches = (k) => Object.keys(SOUND_EVENTS).filter((e) => eventGlob(k).test(e));

// The keys of a mapping that match an event, most specific first: the exact name, then globs by
// their number of literal characters ('*' alone is the weakest).
function matchingKeys(map, event) {
  const score = (k) => (k === event ? Infinity : (k.includes('*') && eventGlob(k).test(event) ? k.replace(/\*/g, '').length : -1));
  return Object.keys(map && typeof map === 'object' ? map : {}).filter((k) => score(k) >= 0).sort((a, b) => score(b) - score(a));
}

// What an event plays: your config.json overrides, then the pack, then the OS's built-in sounds;
// within each, the most specific key first. Tone and sentence are looked up separately, so
// { "ready": { "say": "…" } } keeps the tone a '*' key gives. A missing or unplayable file falls
// through to the next key; the default sentence is used when nothing sets 'say'.
function resolveSound(event, cfg = soundConfig()) {
  const levels = [
    { map: cfg.events, base: COLLAB_HOME, from: 'config' },
  ];
  const pack = readPack(cfg.pack);
  if (pack && !pack.error) levels.push({ map: pack.events, base: pack.dir, from: `pack${pack.name ? ` '${pack.name}'` : ''}` });
  let file;
  let fileFrom = '';
  let say;
  for (const lv of levels) {
    for (const k of matchingKeys(lv.map, event)) {
      const e = soundEntry(lv.map[k]);
      if (file === undefined && e.file !== undefined) {
        if (e.file === null) { file = null; fileFrom = lv.from; } else {
          const f = soundPath(e.file, lv.base);
          if (fs.existsSync(f) && toneExts().includes(extOf(f))) { file = f; fileFrom = lv.from; }
        }
      }
      if (say === undefined && e.say !== undefined) say = e.say;
    }
  }
  if (file === undefined) {
    const f = systemSound(event);
    file = f || null;
    fileFrom = f ? 'built-in' : '';
  }
  return { file, fileFrom, say: say === undefined ? true : say };
}

// A task's own sound settings, each optional (absent = follow config.json): sound (voice | tones |
// off), sound_engine (system | elevenlabs), sound_style (short | full). The older single values
// sound: 'full' / 'elevenlabs' (from --sound=full|elevenlabs) mean voice + that style / engine.
function taskSound(st) {
  const o = (st && st.options) || {};
  const t = {};
  if (o.sound === 'full') { t.sound = 'voice'; t.style = 'full'; } else if (o.sound === 'elevenlabs') { t.sound = 'voice'; t.engine = 'elevenlabs'; } else if (['voice', 'tones', 'off'].includes(o.sound)) t.sound = o.sound;
  if (['system', 'elevenlabs'].includes(o.sound_engine)) t.engine = o.sound_engine;
  if (SOUND_STYLES.includes(o.sound_style)) t.style = o.sound_style;
  return t;
}

// The same as option fields (sound, sound_engine, sound_style), only those that are set.
const SOUND_KEYS = ['sound', 'sound_engine', 'sound_style'];
function soundFields(o) {
  const t = taskSound({ options: o });
  const f = {};
  if (t.sound) f.sound = t.sound;
  if (t.engine) f.sound_engine = t.engine;
  if (t.style) f.sound_style = t.style;
  return f;
}

// How an event of this task sounds: null (silent) or { mode: 'voice' | 'tones', engine, style }.
// On by default. COLLAB_SOUND=0 and 'collab sound off' mute everything, even a task's own
// settings; then the task's settings; then config.json (voice.on: false = tones only).
function soundPrefs(st, cfg = soundConfig(), { ignoreMute = false } = {}) {
  if (!ignoreMute && (process.env.COLLAB_SOUND === '0' || cfg.on === false)) return null;
  const t = taskSound(st);
  if (t.sound === 'off') return null;
  const v = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};
  const mode = t.sound === 'tones' ? 'tones' : t.sound === 'voice' ? 'voice' : v.on === false ? 'tones' : 'voice';
  return { mode, engine: t.engine || (v.engine === 'elevenlabs' ? 'elevenlabs' : 'system'), style: t.style || (v.style === 'full' ? 'full' : 'short'), name: v.name === true };
}
const soundMode = (st, cfg) => { const p = soundPrefs(st, cfg); return p ? p.mode : null; };
const describePrefs = (p) => (!p ? 'silent' : p.mode === 'tones' ? 'tones only'
  : `tones + ${p.style} sentences, ${p.engine === 'elevenlabs' ? 'ElevenLabs voice' : 'system voice'}`);

const soundVolume = (cfg) => (Number.isFinite(Number(cfg.volume)) ? clamp(Number(cfg.volume), 0, 100) : 100);

// The steps (tone, then sentence) that an event plays, or [] for none.
function soundSteps(event, c, prefs, cfg = soundConfig()) {
  const r = resolveSound(event, cfg);
  const steps = [];
  if (r.file) steps.push({ event, tone: r.file });
  if (prefs.mode !== 'tones' && r.say !== false) {
    // Each part of a default sentence is clipped on its own, so the whole is never cut: a decision
    // keeps every option number and the answering instruction.
    const text = typeof r.say === 'string' ? fillSay(r.say, c) : sentence(event, c, prefs.style, prefs.name);
    if (text) steps.push({ event, say: text });
  }
  return steps;
}

// --- the audio queue --------------------------------------------------------------------------

// Commands never play anything themselves: they queue a job and start a detached drainer, which
// plays the jobs one at a time (tone, then sentence), so sounds from several collab processes
// never overlap and a command never waits for audio.
const audioDir = () => path.join(COLLAB_HOME, 'audio');
const audioQueueDir = () => path.join(audioDir(), 'queue');
const SOUND_STALE_MS = envInt('COLLAB_SOUND_STALE_SECS', 120) * 1000;
let audioSeq = 0;

// Queue the events' sounds for a task (st may be null: a run-wide event). Returns whether anything
// was queued. Never throws: sounds are best effort. Callers that change a task call it while they
// still hold the task's lock, so the jobs of one task are queued in the order of its transitions,
// and the job names keep that order (see below). A job bound to a decision ({ decision: seq }) is
// only played while that decision is still pending (see jobLive), and one with an expiry
// ({ expires: ms }) is dropped if it hasn't started by then.
function queueSound(st, events, { decision, expires } = {}) {
  try {
    const cfg = soundConfig();
    const prefs = soundPrefs(st, cfg);
    if (!prefs) return false;
    const steps = events.flatMap(({ event, c }) => soundSteps(event, c, prefs, cfg));
    if (!steps.length) return false;
    const q = audioQueueDir();
    fs.mkdirSync(q, { recursive: true });
    const job = { at: Date.now(), task: st ? st.id : '', steps, volume: soundVolume(cfg), voice: jobVoice(cfg, prefs.engine),
      ...(decision !== undefined ? { decision } : {}), ...(expires !== undefined ? { expires } : {}) };
    const put = (ms, n) => {
      const name = `${String(ms).padStart(15, '0')}-${String(n).padStart(9, '0')}-${process.pid}-${audioSeq++}.json`;
      fs.writeFileSync(path.join(q, `${name}.tmp`), JSON.stringify(job));
      retry(() => fs.renameSync(path.join(q, `${name}.tmp`), path.join(q, name)));
    };
    // A task's jobs are named in the order they are queued, under a lock of their own: the time,
    // never earlier than the task's previous job, then a counter. So events that don't advance the
    // task's seq (a 'sound use', an idle claim) and processes in the same millisecond keep their
    // order, whatever their PIDs.
    const d = st && st.id ? path.join(TASKS, st.id) : '';
    if (d && fs.existsSync(d)) {
      const od = path.join(d, 'audio-order');
      fs.mkdirSync(od, { recursive: true });
      withLock(od, () => {
        const f = path.join(od, 'last.json');
        let last = { ms: 0, n: 0 };
        try { last = { ...last, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { /* first job */ }
        const next = { ms: Math.max(Date.now(), last.ms), n: last.n + 1 };
        put(next.ms, next.n);
        fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(next));
        retry(() => fs.renameSync(`${f}.${process.pid}.tmp`, f));
      });
    } else {
      put(Date.now(), 0);
    }
    const child = spawn(process.execPath, [__filename, 'sound', 'drain'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
const sound = (st, event, extra) => queueSound(st, [{ event, c: soundCtx(st, extra) }]);

// The sounds of a handoff, from the state it led to (one process makes each transition).
const doneSounds = (st, c) => [{ event: 'approve', c }, ...(st.part ? [{ event: 'part-done', c }] : [])];
function handoffSounds(st, role, body) {
  const n = (body.match(/^\s*\d+[.)]\s+\S/gm) || []).length;
  const c = soundCtx(st, { role, n });
  switch (st.status) {
    case 'DECISION': {
      const dec = st.decision;
      return [{ event: 'decide', c: { ...c, question: dec.question, options: dec.options, presenter: decisionPresenter(dec) } }];
    }
    case 'ESCALATED': return [{ event: 'escalate', c: { ...c, text: headline(body) } }];
    case 'DONE': return doneSounds(st, c);
    case 'PLAN_REVIEW': return [{ event: 'plan', c }];
    case 'PLAN_CHANGES': return [{ event: 'plan-changes', c }];
    case 'IMPLEMENTING': return [{ event: 'plan-approve', c }];
    case 'READY_FOR_REVIEW': return [{ event: 'ready', c }];
    case 'CHANGES_REQUESTED': return [{ event: 'changes', c }];
    default: return [];
  }
}

const pendingJobs = () => { try { return fs.readdirSync(audioQueueDir()).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };

// The audio lock, without waiting: null when a live drainer holds it (it plays our job too).
// A dead drainer's lock is only taken over once the tone or speech process it started is gone,
// so a takeover never plays over it.
async function tryAudioLock() {
  const l = path.join(audioDir(), '.lock');
  const me = `${process.pid} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(audioDir(), { recursive: true });
  for (let i = 0; i < 5; i++) {
    try {
      fs.mkdirSync(l);
      fs.writeFileSync(path.join(l, 'owner'), me);
      return { l, me };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const owner = lockOwner(l);
    if (!lockIsStale(l, owner)) return null;
    let child = 0;
    try { child = parseInt(fs.readFileSync(path.join(l, 'child'), 'utf8'), 10); } catch { /* none */ }
    for (let t = 0; child && ownerAlive(String(child)) && t < 900; t++) await sleep(100);
    breakLock(l, owner);
  }
  return null;
}

function runStep(cmd, timeoutMs, lock) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd.cmd, cmd.args, { env: { ...process.env, ...cmd.env }, stdio: 'ignore', windowsHide: true });
    } catch (e) { resolve({ ok: false, why: e.message }); return; }
    if (lock && child.pid) { try { fs.writeFileSync(path.join(lock.l, 'child'), String(child.pid)); } catch { /* best effort */ } }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, why: e.message }); });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (lock) { try { fs.rmSync(path.join(lock.l, 'child'), { force: true }); } catch { /* best effort */ } }
      resolve({ ok: code === 0, why: code === 0 ? '' : (sig ? `stopped (${sig})` : `exit code ${code}`) });
    });
  });
}

// The event name goes along in the environment (handy for a custom player, and for tests).
function stepCommand(step, job) {
  const cmd = step.tone ? toneCommand(step.tone, job.volume) : speechCommand(step.say, job.voice || {}, job.volume);
  return cmd.why ? cmd : { ...cmd, env: { ...cmd.env, COLLAB_SOUND_EVENT: step.event || '' } };
}

// A tone or sentence that did not play leaves a line in audio/problems.json (the last 20), with
// the shell the drainer was started from: an agent's sandbox can allow the tone player and not the
// speech service. 'collab sound' lists them.
const playingFile = () => path.join(audioDir(), 'playing.json');
const problemsFile = () => path.join(audioDir(), 'problems.json');
const readAudioJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeAudioJson(f, v) {
  try {
    fs.mkdirSync(audioDir(), { recursive: true });
    fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(v));
    retry(() => fs.renameSync(`${f}.${process.pid}.tmp`, f));
  } catch { /* best effort */ }
}
function shellName() {
  const e = process.env;
  if (e.CLAUDECODE === '1') return "Claude Code's shell";
  if (e.CODEX_THREAD_ID || e.CODEX_SESSION_ID || e.CODEX_SANDBOX || e.CODEX_SANDBOX_NETWORK_DISABLED) return "Codex's shell";
  if (e.OPENCODE === '1') return "OpenCode's shell";
  return e.COLLAB_AGENT ? "an agent's shell" : 'your own terminal';
}
function soundProblem(p) {
  const list = readAudioJson(problemsFile());
  writeAudioJson(problemsFile(), [...(Array.isArray(list) ? list : []), { at: Date.now(), from: shellName(), ...p }].slice(-20));
}

// The drainer notes which step it is on and what is still to come (audio/playing.json), so one
// that is stopped half-way (its shell or sandbox ended, a crash) doesn't lose the sentence after a
// tone: the next drainer finds the note and plays the rest (see soundDrain). A decision reminder
// plays only before its expiry (the next reminder is due by then: a busy queue or a slow ElevenLabs
// request never plays a cluster of them) and while the decision is pending: both checked right
// before each player starts (jobLive), so also after an ElevenLabs request and before a fallback.
// A step already playing finishes.
const jobLive = (job) => (job.expires === undefined || Date.now() <= job.expires)
  && (job.decision === undefined || decisionPending(job.task, job.decision));
async function playJob(job, lock) {
  const steps = job.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!jobLive(job)) break;
    writeAudioJson(playingFile(), { at: job.at, task: job.task, volume: job.volume, voice: job.voice, event: step.event, say: !!step.say, from: shellName(),
      ...(job.decision !== undefined ? { decision: job.decision } : {}), ...(job.expires !== undefined ? { expires: job.expires } : {}), steps: steps.slice(i + 1) });
    if (step.say) {
      const r = await speakStep(step, job, lock);
      if (r.skipped) break;
      if (r.none || r.failed) soundProblem({ event: step.event, step: 'sentence', why: r.none || r.failed });
      continue;
    }
    const cmd = stepCommand(step, job);
    if (cmd.why) continue;
    if (!jobLive(job)) break;
    const res = await runStep(cmd, 30000, lock);
    if (!res.ok) soundProblem({ event: step.event, step: 'tone', why: res.why });
  }
  try { fs.rmSync(playingFile(), { force: true }); } catch { /* best effort */ }
}

async function soundDrain() {
  for (;;) {
    const lock = await tryAudioLock();
    if (!lock) return;
    try {
      // Left by a drainer that was stopped in the middle of a job: finish what it had not started.
      const cut = readAudioJson(playingFile());
      if (cut) {
        try { fs.rmSync(playingFile(), { force: true }); } catch { /* best effort */ }
        const rest = Array.isArray(cut.steps) ? cut.steps : [];
        const fresh = Date.now() - cut.at <= SOUND_STALE_MS;
        soundProblem({ event: cut.event, step: cut.say ? 'sentence' : 'tone', from: cut.from,
          why: `the process playing it was stopped${rest.length ? (fresh ? '; the rest was played late' : '; the rest was dropped as too old') : ''}` });
        if (rest.length && fresh) await playJob({ ...cut, steps: rest }, lock);
      }
      for (;;) {
        const jobs = pendingJobs();
        if (!jobs.length) break;
        const f = path.join(audioQueueDir(), jobs[0]);
        let job = null;
        try { job = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* unreadable: dropped */ }
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
        // A backlog of old sounds is worse than silence.
        if (job && Date.now() - job.at <= SOUND_STALE_MS) await playJob(job, lock);
      }
    } finally {
      if (lockOwner(lock.l) === lock.me) fs.rmSync(lock.l, { recursive: true, force: true });
    }
    // A job queued after our last look, whose drainer found the lock still held: play it too.
    if (!pendingJobs().length) return;
  }
}

// Observed events (idle, stall, a confirm-first item, an agent CLI waiting) can be seen by
// several processes or retries: only the one whose claim succeeds sounds. Task claims live in
// state.json (never counted as activity), run-wide ones in audio/claims.json. Like queueSound,
// a claim is best effort: if it fails, nothing sounds and the command carries on.
function claimTaskEvent(d, key, onClaim) {
  try { return claimTask(d, key, onClaim); } catch { return false; }
}
function claimTask(d, key, onClaim) {
  return withLock(d, () => {
    let ok = false;
    const st = update(d, (s) => {
      const c = s.audio_claims || [];
      if (c.includes(key)) return;
      ok = true;
      s.audio_claims = [...c, key].slice(-50);
    }, { touch: false });
    return ok && onClaim(st);
  });
}

// Whether the decision with this seq still waits for the user (its reminders play only then).
function decisionPending(id, seq) {
  try {
    const s = readState(path.join(TASKS, id));
    return s.status === 'DECISION' && !!s.decision && s.decision.seq === seq;
  } catch { return false; }
}

// A pending decision is sounded again every DECIDE_REPEAT seconds until the user answers ('decide'
// itself plays at once, from the submit). Driven by the agents' 'wait' polls: reminder k is due k
// intervals after the decision started, and only the process that claims it sounds it, so two
// waiting agents never double it, and a wait started late plays the current reminder, not the
// missed ones. Returns the ms until the next reminder is due (Infinity: none).
function remindDecision(d, st) {
  const dec = st.decision;
  if (!DECIDE_REPEAT || DECIDE_REPEAT < 0 || !dec || dec.seq === undefined) return Infinity;
  const every = DECIDE_REPEAT * 1000;
  const from = Number.isFinite(dec.at) ? dec.at : (st.turn_since || epoch()) * 1000;
  const k = Math.floor((Date.now() - from) / every);
  if (k >= 1 && soundMode(st)) {
    claimTaskEvent(d, `decide-repeat:${dec.seq}:${k}`, (cst) => cst.status === 'DECISION' && cst.decision && cst.decision.seq === dec.seq
      && queueSound(cst, [{ event: 'decide-repeat', c: soundCtx(cst, { question: dec.question, options: dec.options, presenter: decisionPresenter(dec) }) }],
        { decision: dec.seq, expires: from + (k + 1) * every }));
  }
  return from + (k + 1) * every - Date.now();
}

// The reminders must not depend on an agent being in 'wait' at that moment (the asker of a --self
// decision is in its own prompt, the other agent may be between waits or gone): the submit that
// starts a decision also starts a detached 'collab sound remind', which sounds the same claimed
// reminders as the waits for as long as the decision is pending: it exits only once it isn't
// (answer, abort, task removed by 'collab clean'). It starts even while the task is muted, so a
// 'collab sound on' or 'sound use' meanwhile brings the reminders back; only the process-wide
// COLLAB_SOUND=0 (test runs) starts none.
function startReminder(st) {
  try {
    if (!DECIDE_REPEAT || DECIDE_REPEAT < 0 || !st.decision || process.env.COLLAB_SOUND === '0') return;
    const child = spawn(process.execPath, [__filename, 'sound', 'remind', st.id, String(st.decision.seq)], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* best effort, like every sound */ }
}
async function soundRemind(id, seq) {
  if (!id || !Number.isInteger(seq) || !/^[\w.-]+$/.test(id)) die('usage: collab sound remind <task-id> <decision-seq> (started by collab itself)');
  const d = path.join(TASKS, id);
  for (;;) {
    let st;
    try { st = readState(d); } catch { return; }
    if (st.status !== 'DECISION' || !st.decision || st.decision.seq !== seq) return;
    const next = remindDecision(d, st);
    if (!Number.isFinite(next)) return;
    await sleep(Math.max(200, next + 50));
  }
}

function claimHomeEvent(key, windowSecs = Infinity) {
  try { return claimHome(key, windowSecs); } catch { return false; }
}
function claimHome(key, windowSecs) {
  const file = path.join(audioDir(), 'claims.json');
  fs.mkdirSync(audioDir(), { recursive: true });
  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { claims: Array.isArray(j.claims) ? j.claims : [] }; } catch { return { claims: [] }; } };
  return withHomeFile(file, read, (j) => {
    const now = epoch();
    const last = j.claims.filter((c) => c.key === key).pop();
    if (last && now - last.epoch < windowSecs) return false;
    j.claims = [...j.claims.filter((c) => c.key !== key), { key, epoch: now }].slice(-100);
    return true;
  });
}

// --- ElevenLabs voice (opt-in: --sound=elevenlabs, or sound.voice.engine) -------------------------

// Only the drainer calls the API (plus the explicit 'collab sound test' and 'collab sound voices');
// the key is read at call time and never written to a job, a log, the status file or a command line.
const EL_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // a stock premade voice
const EL_DEFAULT_MODEL = 'eleven_flash_v2_5';    // the lowest-latency model
const EL_FORMAT = 'mp3_44100_128';
// ElevenLabs voice_settings, and the config key each one is read from. 'style' is ElevenLabs' style
// exaggeration (a number): in config it is 'style_exaggeration', because sound.voice.style is the
// sentence style (short | full). A number in sound.voice.style (written before that) still counts.
const EL_SETTINGS = ['stability', 'similarity_boost', 'style', 'speed'];
const EL_SETTING_KEYS = { stability: 'stability', similarity_boost: 'similarity_boost', style: 'style_exaggeration', speed: 'speed' };
const numSetting = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && Number.isFinite(Number(x));
const EL_TIMEOUT_MS = () => envInt('COLLAB_ELEVENLABS_TIMEOUT_SECS', 15) * 1000;
const EL_CACHE_MAX_FILES = 300;
const EL_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const elBase = () => (process.env.COLLAB_ELEVENLABS_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const ttsDir = () => path.join(audioDir(), 'tts');
const ttsStatusFile = () => path.join(audioDir(), 'tts-status.json');

// The voice options a job carries: an allowlist, so nothing else in config (e.g. api_key) is copied.
function jobVoice(cfg, eng) {
  const v = cfg.voice && typeof cfg.voice === 'object' && !Array.isArray(cfg.voice) ? cfg.voice : {};
  const engine = eng === 'elevenlabs' ? 'elevenlabs' : 'system';
  const res = { engine };
  if (Number(v.rate) > 0) res.rate = Math.round(Number(v.rate));
  if (engine === 'elevenlabs') {
    res.voice_id = typeof v.voice_id === 'string' && v.voice_id.trim() ? v.voice_id.trim() : EL_DEFAULT_VOICE;
    res.model_id = typeof v.model_id === 'string' && v.model_id.trim() ? v.model_id.trim() : EL_DEFAULT_MODEL;
    const settings = {};
    for (const k of EL_SETTINGS) {
      const x = v[EL_SETTING_KEYS[k]];
      if (numSetting(x)) settings[k] = Number(x);
      else if (k === 'style' && typeof v.style === 'number' && Number.isFinite(v.style)) settings.style = v.style;
    }
    if (Object.keys(settings).length) res.settings = settings;
  }
  return res;
}

function elevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY) return { key: process.env.ELEVENLABS_API_KEY.trim(), from: 'ELEVENLABS_API_KEY' };
  const v = soundConfig().voice;
  if (v && typeof v.api_key === 'string' && v.api_key.trim()) return { key: v.api_key.trim(), from: 'config.json' };
  return { key: '', from: '' };
}

// Everything that changes the generated audio, so two settings never share a cached file.
const ttsCacheFile = (text, voice) => path.join(ttsDir(),
  `${sha256(JSON.stringify([text, voice.voice_id, voice.model_id, EL_SETTINGS.map((k) => (voice.settings || {})[k] ?? null), EL_FORMAT]))}.mp3`);

// Backoff is scoped to the endpoint, the key (as a hash) and the voice and model, so fixing any of
// them takes effect at once.
const ttsScope = (key, voice) => sha256(JSON.stringify([elBase(), sha256(key), voice.voice_id, voice.model_id])).slice(0, 16);
function readTtsStatus() { try { return JSON.parse(fs.readFileSync(ttsStatusFile(), 'utf8')); } catch { return null; } }
function writeTtsStatus(st) {
  try {
    fs.mkdirSync(audioDir(), { recursive: true });
    const tmp = `${ttsStatusFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    retry(() => fs.renameSync(tmp, ttsStatusFile()));
    return true;
  } catch { return false; }
}

// Why a call failed, from the status code or the error code only: never a response body or a raw
// message (either could echo request details).
function ttsFailure(res, err) {
  if (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { reason: `no answer within ${EL_TIMEOUT_MS() / 1000} s`, backoff: 60 };
    const code = (err.cause && err.cause.code) || err.code || 'network error';
    return { reason: `network error (${code})`, backoff: 60 };
  }
  const s = res.status;
  if (s === 401) return { reason: 'HTTP 401 (invalid or missing API key)', http: s, backoff: 600 };
  if (s === 403) return { reason: 'HTTP 403 (the key may not use this voice or model)', http: s, backoff: 600 };
  if (s === 404) return { reason: 'HTTP 404 (unknown voice id or model)', http: s, backoff: 600 };
  if (s === 429) return { reason: 'HTTP 429 (rate limit or character quota reached)', http: s, backoff: 120 };
  if (s >= 500) return { reason: `HTTP ${s} (ElevenLabs server error)`, http: s, backoff: 60 };
  return { reason: `HTTP ${s}`, http: s, backoff: 60 };
}

function pruneTtsCache() {
  try {
    const files = fs.readdirSync(ttsDir()).filter((f) => f.endsWith('.mp3'))
      .map((f) => { const p = path.join(ttsDir(), f); const st = fs.statSync(p); return { p, size: st.size, at: st.mtimeMs }; })
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((n, f) => n + f.size, 0);
    while (files.length > EL_CACHE_MAX_FILES || total > EL_CACHE_MAX_BYTES) {
      const f = files.shift();
      total -= f.size;
      fs.rmSync(f.p, { force: true });
    }
  } catch { /* best effort */ }
}

function ttsCacheSize() {
  try {
    const files = fs.readdirSync(ttsDir()).filter((f) => f.endsWith('.mp3'));
    return { n: files.length, bytes: files.reduce((n, f) => n + fs.statSync(path.join(ttsDir(), f)).size, 0) };
  } catch { return { n: 0, bytes: 0 }; }
}

// The audio file for a sentence: { file, cached } or { why } (then the caller uses the system voice).
async function elevenLabsAudio(text, voice) {
  // No mp3 player here: don't spend a request (and characters) on audio nobody can play.
  const player = toneCommand('speech.mp3');
  if (player.why) return { why: `can't play ElevenLabs audio: ${player.why}` };
  const file = ttsCacheFile(text, voice);
  try {
    if (fs.statSync(file).size > 0) {
      const now = new Date();
      try { fs.utimesSync(file, now, now); } catch { /* best effort */ }
      return { file, cached: true };
    }
  } catch { /* not cached */ }
  const { key } = elevenLabsKey();
  if (!key) return { why: "no ElevenLabs API key (set ELEVENLABS_API_KEY, or run 'collab sound voice key')" };
  const scope = ttsScope(key, voice);
  const last = readTtsStatus();
  if (last && last.scope === scope && last.skip_until && Date.now() < last.skip_until) {
    return { why: `ElevenLabs paused until ${localTime(last.skip_until)} after ${last.reason}` };
  }
  const url = `${elBase()}/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=${EL_FORMAT}`;
  const body = { text, model_id: voice.model_id, ...(voice.settings ? { voice_settings: voice.settings } : {}) };
  let res = null;
  let err = null;
  let audio = null;
  const t0 = Date.now();
  try {
    res = await fetch(url, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(EL_TIMEOUT_MS()),
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    });
    if (res.ok) audio = Buffer.from(await res.arrayBuffer());
  } catch (e) { err = e; }
  const type = res && res.headers.get('content-type') || '';
  if (!err && res && res.ok && !(audio && audio.length && /^audio\//i.test(type))) {
    writeTtsStatus({ scope, at: Date.now(), ok: false, reason: `unexpected answer (${type || 'no content type'}, ${audio ? audio.length : 0} bytes)`, skip_until: Date.now() + 60000 });
    return { why: 'ElevenLabs sent no audio' };
  }
  if (err || !res.ok) {
    const f = ttsFailure(res, err);
    writeTtsStatus({ scope, at: Date.now(), ok: false, reason: f.reason, http: f.http, skip_until: Date.now() + f.backoff * 1000 });
    return { why: `ElevenLabs failed: ${f.reason}` };
  }
  try {
    fs.mkdirSync(ttsDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, audio);
    retry(() => fs.renameSync(tmp, file));
  } catch { return { why: "can't write the ElevenLabs audio cache" }; }
  const ms = Date.now() - t0;
  writeTtsStatus({ scope, at: Date.now(), ok: true, reason: 'ok' });
  pruneTtsCache();
  return { file, cached: false, ms };
}

// A sentence through ElevenLabs, else (any failure, including the player failing) the system voice.
async function speakStep(step, job, lock) {
  if ((job.voice || {}).engine === 'elevenlabs') {
    const r = await elevenLabsAudio(step.say, job.voice);
    // The request takes time: a decision answered meanwhile is not announced after all.
    if (!jobLive(job)) return { skipped: true };
    if (r.file) {
      const cmd = toneCommand(r.file, job.volume);
      if (!cmd.why) {
        const res = await runStep({ ...cmd, env: { ...cmd.env, COLLAB_SOUND_EVENT: step.event || '' } }, 60000, lock);
        if (res.ok) return { engine: 'elevenlabs', cached: r.cached, ms: r.ms };
        return { engine: 'system', why: `the player failed on the ElevenLabs audio (${res.why})`, ...(await systemSpeak(step, job, lock)) };
      }
    }
    return { why: r.why || 'ElevenLabs audio could not be played', ...(await systemSpeak(step, job, lock)) };
  }
  return systemSpeak(step, job, lock);
}

async function systemSpeak(step, job, lock) {
  if (!jobLive(job)) return { engine: 'none', skipped: true };
  const cmd = speechCommand(step.say, { ...(job.voice || {}), engine: 'system' }, job.volume);
  if (cmd.why) return { engine: 'none', none: cmd.why };
  const res = await runStep({ ...cmd, env: { ...cmd.env, COLLAB_SOUND_EVENT: step.event || '' } }, 60000, lock);
  return { engine: 'system', failed: res.ok ? '' : res.why };
}

// Read the key from stdin (hidden when typed at a terminal), never from the command line.
function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let t = '';
    try { t = fs.readFileSync(0, 'utf8'); } catch { /* none */ }
    return Promise.resolve(t.trim());
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let s = '';
    const done = (v) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); out(); resolve(v); };
    const onData = (b) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(s.trim());
        if (ch === '\u0003') return done('');
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

async function listVoices() {
  const { key } = elevenLabsKey();
  if (!key) die("no ElevenLabs API key: set ELEVENLABS_API_KEY, or run 'collab sound voice key'");
  const voices = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    let res;
    try {
      res = await fetch(`${elBase()}/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`,
        { headers: { 'xi-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(EL_TIMEOUT_MS()) });
    } catch (e) { die(`listing voices failed: ${ttsFailure(null, e).reason}`); }
    if (!res.ok) die(`listing voices failed: ${ttsFailure(res, null).reason}`);
    let j;
    try { j = await res.json(); } catch { die('listing voices failed: not a JSON answer'); }
    voices.push(...(Array.isArray(j.voices) ? j.voices : []));
    if (!j.has_more || !j.next_page_token) break;
    token = j.next_page_token;
  }
  return voices;
}

// --- collab sound -------------------------------------------------------------------------------

const SOUND_EXAMPLE = {
  t: 'dark mode', st: { id: 'dark-mode', phase: 'build', round: 2, plan_round: 1, max_rounds: 4, turn: 'implementer' },
  part: { index: 2, total: 3 }, n: 3, role: 'reviewer', question: 'Which theme should be the default?',
  options: ['Follow the system setting (Recommended)', 'Always dark'], presenter: 'implementer',
  text: 'the database credentials are missing', why: 'the reviewer has not handed off for 30 min', waiter: 'implementer',
  item: { id: 4 }, answer: 'option 1', mins: 120,
};
const exampleSentence = (event, style, name) => sentence(event, SOUND_EXAMPLE, style, name);

function withSoundConfig(fn) {
  return withHomeFile(configPath(), readConfig, (c) => {
    if (!c.sound || typeof c.sound !== 'object' || Array.isArray(c.sound)) c.sound = {};
    return fn(c.sound);
  });
}

function soundKey(k) {
  if (!k) die("name an event (or a glob such as 'note-*'): 'collab sound events' lists them");
  if (SOUND_EVENTS[k]) return k;
  if (k.includes('*') && keyMatches(k).length) return k;
  die(`unknown event: ${k} ('collab sound events' lists them)`);
}

function fileWarning(f) {
  const cmd = toneCommand(f);
  return cmd.why ? `warning: ${cmd.why}` : '';
}

function soundProblems(cfg) {
  const lines = [];
  const check = (map, base, where) => {
    for (const [k, v] of Object.entries(map || {})) {
      if (!SOUND_EVENTS[k] && !(k.includes('*') && keyMatches(k).length)) lines.push(`${where}: '${k}' matches no event`);
      const e = soundEntry(v);
      if (typeof e.file === 'string') {
        const f = soundPath(e.file, base);
        if (!fs.existsSync(f)) lines.push(`${where}: ${k}: file not found: ${f}`);
        else if (!toneExts().includes(extOf(f))) lines.push(`${where}: ${k}: .${extOf(f)} can't be played on ${OS_NAME[soundOs()]}`);
      }
      if (e.say !== undefined && e.say !== false && typeof e.say !== 'string') lines.push(`${where}: ${k}: 'say' must be text or false`);
    }
  };
  if (cfg.events !== undefined && (typeof cfg.events !== 'object' || !cfg.events || Array.isArray(cfg.events))) lines.push("config: 'sound.events' is not an object");
  else check(cfg.events, COLLAB_HOME, 'config');
  const pack = readPack(cfg.pack);
  if (pack && pack.error) lines.push(`pack: ${pack.error}`);
  else if (pack) check(pack.events, pack.dir, `pack ${pack.dir}`);
  return lines;
}

function soundStatus() {
  const cfg = soundConfig();
  const os = soundOs();
  let state;
  if (process.env.COLLAB_SOUND === '0') state = 'off (COLLAB_SOUND=0)';
  else if (cfg.on === false) state = "off: muted ('collab sound on' for every task, or remove the mute with 'collab sound unmute')";
  else state = `on for every task: ${describePrefs(soundPrefs(null, cfg))} ('collab sound off' mutes)`;
  out(`sound:   ${state}`);
  out(`voice:   ${cfg.voice && cfg.voice.on === false ? "off by default: tones only ('collab sound voice on' to speak)" : "on ('collab sound voice off' for tones only)"}${cfg.voice && cfg.voice.rate ? `, ${cfg.voice.rate} words/min` : ''}`);
  out(`style:   ${cfg.voice && cfg.voice.style === 'full' ? 'full' : 'short'} sentences ('collab sound voice style short|full'), task name ${cfg.voice && cfg.voice.name === true ? 'said' : "left out ('collab sound voice name on' to say it)"}`);
  out(`volume:  ${soundVolume(cfg)}`);
  const players = [...new Set(TONE_PLAYERS[os].map((p) => p.bin))].filter((b) => soundBin(b));
  out(`players: ${players.length ? `${players.join(', ')} (${OS_NAME[os]} plays ${toneExts(os).join(', ')})` : `none found: ${INSTALL_HINT.tone[os]}`}`);
  const sp = speechCommand('test', cfg.voice || {});
  out(`speech:  ${sp.why ? sp.why : path.basename(sp.bin)}${sp.note ? ` (${sp.note})` : ''}`);
  const jv = jobVoice(cfg, cfg.voice && cfg.voice.engine);
  out(`engine:  ${jv.engine === 'elevenlabs' ? "ElevenLabs ('collab sound voice system' for the system voice)" : "system voice ('collab sound voice elevenlabs' for ElevenLabs)"}`);
  const k = elevenLabsKey();
  const el = jobVoice(cfg, 'elevenlabs');
  const cache = ttsCacheSize();
  out(`elevenlabs: voice ${el.voice_id}, model ${el.model_id}${el.settings ? `, ${JSON.stringify(el.settings)}` : ''}; key ${k.key ? `from ${k.from}` : 'missing'}; cache ${cache.n} file(s), ${(cache.bytes / 1048576).toFixed(1)} MB`);
  const last = readTtsStatus();
  if (last) {
    const ago = fmtDur(Math.max(0, Math.floor((Date.now() - last.at) / 1000)));
    out(`            last call ${ago} ago: ${last.ok ? 'ok' : `failed, ${last.reason}`}${!last.ok && last.skip_until > Date.now() ? `; system voice until ${localTime(last.skip_until)} (changing the key, voice or model retries at once)` : ''}`);
  }
  const pack = readPack(cfg.pack);
  out(`pack:    ${pack ? `${pack.dir}${pack.name ? ` (${pack.name})` : ''}` : 'none'}`);
  out('events:');
  const w = Math.max(...Object.keys(SOUND_EVENTS).map((e) => e.length));
  for (const e of Object.keys(SOUND_EVENTS)) {
    const r = resolveSound(e, cfg);
    const tone = r.file ? `${r.file} (${r.fileFrom})` : (r.fileFrom ? `no tone (${r.fileFrom})` : 'no tone');
    const say = r.say === false ? 'no speech' : (typeof r.say === 'string' ? 'custom speech' : 'speech');
    out(`  ${e.padEnd(w)}  ${tone} · ${say}`);
  }
  const problems = soundProblems(cfg);
  if (problems.length) { out('problems:'); for (const p of problems) out(`  ✗ ${p}`); }
  const recent = (readAudioJson(problemsFile()) || []).slice(-5).reverse();
  if (recent.length) {
    out('not played lately (newest first):');
    for (const p of recent) {
      out(`  ${fmtDur(Math.max(0, Math.floor((Date.now() - p.at) / 1000)))} ago  '${p.event}' ${p.step}: ${p.why} (played from ${p.from})`);
    }
  }
}

// collab [-t ID] sound use <word>...: change the sound of the running task (and so the rest of its
// run), for the user or for an agent the user asked. Never global, never agent activity.
const SOUND_USE = { sound: ['voice', 'tones', 'off'], engine: ['system', 'elevenlabs'], style: ['short', 'full'] };
function soundUse(words) {
  const usage = 'usage: collab [-t ID] sound use <voice | tones | off> [system | elevenlabs] [short | full], or: collab sound use default';
  if (!words.length) die(usage);
  const set = {};
  let reset = false;
  for (const w of words.map((x) => x.toLowerCase())) {
    if (w === 'default') { reset = true; continue; }
    const g = Object.keys(SOUND_USE).find((k) => SOUND_USE[k].includes(w));
    if (!g) die(`unknown sound setting '${w}'. ${usage}`);
    if (set[g] && set[g] !== w) die(`'${set[g]}' and '${w}' contradict each other: pick one`);
    set[g] = w;
  }
  if (reset && Object.keys(set).length) die("'default' clears this task's sound settings: use it on its own");
  // Asking for a voice or a sentence style means wanting to hear it.
  if ((set.engine || set.style) && set.sound && set.sound !== 'voice') die(`'${set.sound}' has no voice, so '${set.engine || set.style}' would change nothing: pick one`);
  if (set.engine || set.style) set.sound = 'voice';
  const d = taskDir();
  const st = withLock(d, () => {
    const s0 = readState(d);
    if (isTerminal(s0.status) && !(s0.status === 'DONE' && !s0.ended)) die(`task already finished (${s0.status}${s0.ended ? ', run ended' : ''})`);
    const ns = update(d, (s) => {
      const o = { ...(s.options || {}) };
      const t = taskSound(s);
      if (reset) {
        delete o.sound; delete o.sound_engine; delete o.sound_style;
      } else {
        // An older combined value becomes the separate fields, so a partial change keeps the rest.
        if (o.sound === 'full' || o.sound === 'elevenlabs') {
          o.sound = t.sound;
          if (t.style) o.sound_style = t.style;
          if (t.engine) o.sound_engine = t.engine;
        }
        if (set.sound) o.sound = set.sound;
        if (set.engine) o.sound_engine = set.engine;
        if (set.style) o.sound_style = set.style;
      }
      s.options = o;
      s.sound_changes = [...(s.sound_changes || []), { what: reset ? 'default' : words.join(' '), by: agentShell() ? 'agent' : 'user', at: nowIso() }].slice(-20);
    }, { touch: false });
    // A short confirmation in the new settings (so mute, off and tones apply to it as to any event).
    queueSound(ns, [{ event: 'sound-change', c: soundCtx(ns, { text: describePrefs(soundPrefs(ns, soundConfig(), { ignoreMute: true })) }) }]);
    return ns;
  });
  const cfg = soundConfig();
  const wanted = soundPrefs(st, cfg, { ignoreMute: true });
  out(`${st.id}: ${describePrefs(wanted)} (from the next event; the rest of the run keeps it)`);
  if (wanted && !soundPrefs(st, cfg)) {
    out(process.env.COLLAB_SOUND === '0'
      ? 'but COLLAB_SOUND=0 is set in this shell, so nothing plays from processes started with it: unset it (or set it to 1) where the agents run'
      : "but sound is muted ('collab sound off'), so nothing plays until you run 'collab sound on'");
  }
  if (wanted && wanted.mode === 'voice' && wanted.engine === 'elevenlabs' && !elevenLabsKey().key) {
    out("note: no ElevenLabs API key (ELEVENLABS_API_KEY, or 'collab sound voice key'), so the system voice speaks until one is set");
  }
}

async function cmdSound(args) {
  const [sub = 'status', ...rest] = args;
  if (sub === 'drain') { await soundDrain(); return; }
  if (sub === 'remind') { await soundRemind(rest[0], parseInt(rest[1], 10)); return; }
  if (sub === 'use') { soundUse(rest); return; }
  if (sub === 'voices') {
    const voices = await listVoices();
    if (!voices.length) { out('no voices on this account'); return; }
    const w = Math.max(...voices.map((x) => String(x.name || '').length));
    for (const x of voices) out(`${String(x.name || '').padEnd(w)}  ${x.voice_id}  ${x.category || ''}`.trimEnd());
    out("Use one: collab sound voice elevenlabs --voice <id>");
    return;
  }
  if (sub === 'cache') {
    if (rest[0] !== 'clear') die('usage: collab sound cache clear');
    const { n } = ttsCacheSize();
    fs.rmSync(ttsDir(), { recursive: true, force: true });
    out(`deleted ${n} cached ElevenLabs sentence(s)`);
    return;
  }
  if (sub === 'status' || sub === 'show') { soundStatus(); return; }
  if (sub === 'events') {
    const w = Math.max(...Object.keys(SOUND_EVENTS).map((e) => e.length));
    const named = !!(soundConfig().voice && soundConfig().voice.name === true);
    for (const [e, [desc]] of Object.entries(SOUND_EVENTS)) {
      out(`${e.padEnd(w)}  ${desc}`);
      out(`${' '.repeat(w)}  short: "${exampleSentence(e, 'short', named)}"`);
      out(`${' '.repeat(w)}  full:  "${exampleSentence(e, 'full', named)}"`);
    }
    out("Map one with 'collab sound set <event|glob> <file>'; globs such as 'note-*' or '*' work too.");
    return;
  }
  if (sub === 'on' || sub === 'off' || sub === 'unmute') {
    withSoundConfig((s) => { if (sub === 'off') s.on = false; else delete s.on; });
    out(sub === 'off' ? "sound: off (muted for every task, whatever it asks; 'collab sound on' to unmute)" : `sound: on for every task: ${describePrefs(soundPrefs(null))}`);
    return;
  }
  if (sub === 'volume') {
    if (!/^\d+$/.test(rest[0] || '') || +rest[0] > 100) die('usage: collab sound volume <0-100>');
    withSoundConfig((s) => { s.volume = +rest[0]; });
    out(`volume: ${+rest[0]}`);
    return;
  }
  if (sub === 'voice') {
    const [v, ...more] = rest;
    if (v === 'on' || v === 'off') {
      withSoundConfig((s) => { s.voice = { ...(s.voice || {}), on: v === 'on' }; });
      out(v === 'on' ? 'voice: on (tones + spoken sentences)' : "voice: off by default (tones only; a task can still ask for a voice: --sound=voice, or 'collab sound use voice')");
      return;
    }
    if (v === 'rate' && more[0] === 'default') {
      withSoundConfig((s) => { if (s.voice) delete s.voice.rate; });
      out('voice rate: the engine default');
      return;
    }
    if (v === 'rate') {
      if (!/^\d+$/.test(more[0] || '') || +more[0] < 80 || +more[0] > 500) die('usage: collab sound voice rate <80-500> (words per minute), or: collab sound voice rate default');
      withSoundConfig((s) => { s.voice = { ...(s.voice || {}), rate: +more[0] }; });
      out(`voice rate: ${+more[0]} words per minute`);
      return;
    }
    if (v === 'name') {
      if (!['on', 'off'].includes(more[0])) die('usage: collab sound voice name <on | off>');
      withSoundConfig((s) => { s.voice = { ...(s.voice || {}), name: more[0] === 'on' }; });
      out(more[0] === 'on' ? 'task name: said at the start of each sentence ("dark mode: plan ready")' : 'task name: left out ("Plan ready")');
      return;
    }
    if (v === 'style') {
      if (!SOUND_STYLES.includes(more[0])) die('usage: collab sound voice style <short | full>');
      withSoundConfig((s) => {
        s.voice = { ...(s.voice || {}) };
        // A number here was ElevenLabs' style exaggeration: keep it under its own key.
        if (typeof s.voice.style === 'number' && s.voice.style_exaggeration === undefined) s.voice.style_exaggeration = s.voice.style;
        s.voice.style = more[0];
      });
      out(more[0] === 'full' ? 'sentences: full (what happened, whose turn, what you need to do)' : "sentences: short (just where the collab is; --sound=full for one task's full sentences)");
      return;
    }
    if (v === 'elevenlabs' || v === 'system') {
      const { opts } = takeOpts(more, { values: { '--voice': 'voice', '--model': 'model' } }, { strict: true });
      withSoundConfig((s) => {
        s.voice = { ...(s.voice || {}), engine: v };
        if (opts.voice) s.voice.voice_id = opts.voice.trim();
        if (opts.model) s.voice.model_id = opts.model.trim();
      });
      if (v === 'system') { out("voice engine: the system voice (a task's --sound=elevenlabs still uses ElevenLabs)"); return; }
      const el = jobVoice(soundConfig(), 'elevenlabs');
      const k = elevenLabsKey();
      out(`voice engine: ElevenLabs (voice ${el.voice_id}, model ${el.model_id})`);
      out(k.key ? `key: from ${k.from}` : "key: missing. Set ELEVENLABS_API_KEY in your shell profile (the agents' shells need it), or run 'collab sound voice key'");
      out('Every spoken sentence (task name, event, decision questions and options, escalation headlines) is sent to ElevenLabs; tones stay local.');
      out("Without a key, offline or on any error, the system voice speaks instead. Try: 'collab sound test decide'; voices: 'collab sound voices'.");
      return;
    }
    if (v === 'key') {
      if (more[0] === '--clear') {
        withSoundConfig((s) => { if (s.voice) delete s.voice.api_key; });
        out('key: removed from config.json');
        return;
      }
      const key = await readSecret('ElevenLabs API key (input hidden): ');
      if (!key || /\s/.test(key)) die('no key given (pipe it on stdin, or paste it at the prompt)');
      withSoundConfig((s) => { s.voice = { ...(s.voice || {}), api_key: key }; });
      out(`key: saved in ${configPath()} in plain text (readable by anyone who can read that file).`);
      out('ELEVENLABS_API_KEY, when set, is used instead. Remove it with: collab sound voice key --clear');
      return;
    }
    die('usage: collab sound voice <on | off | name on|off | style short|full | rate WPM | rate default | system | elevenlabs [--voice ID] [--model ID] | key [--clear]>');
  }
  if (sub === 'set') {
    const key = soundKey(rest[0]);
    if (!rest[1]) die('usage: collab sound set <event|glob> <file | none>');
    let value = null;
    if (rest[1] !== 'none') {
      const f = soundPath(rest.slice(1).join(' '), process.cwd());
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) die(`no such file: ${f}`);
      value = f;
    }
    withSoundConfig((s) => { s.events = { ...(s.events && typeof s.events === 'object' ? s.events : {}), [key]: value }; });
    out(value ? `${key}: ${value}` : `${key}: silent (no tone, no speech)`);
    if (value && fileWarning(value)) out(fileWarning(value));
    if (soundMode(null) === null) out("note: sound is muted ('collab sound on' to unmute).");
    return;
  }
  if (sub === 'unset') {
    const key = rest[0];
    if (!key) die('usage: collab sound unset <event|glob>');
    const had = withSoundConfig((s) => {
      if (!s.events || !(key in s.events)) return false;
      delete s.events[key];
      return true;
    });
    if (!had) die(`config.json has no mapping for '${key}'`);
    out(`${key}: back to the pack / built-in sound`);
    return;
  }
  if (sub === 'pack') {
    if (rest[0] === '--init') {
      if (!rest[1]) die('usage: collab sound pack --init <folder>');
      const dir = soundPath(rest.slice(1).join(' '), process.cwd());
      const file = path.join(dir, PACK_FILE);
      if (fs.existsSync(file)) die(`${file} already exists; edit it, or pick another folder`);
      fs.mkdirSync(dir, { recursive: true });
      const events = {};
      for (const e of Object.keys(SOUND_EVENTS)) events[e] = { file: null, say: exampleSentenceTemplate(e) };
      fs.writeFileSync(file, `${JSON.stringify({ name: path.basename(dir), events }, null, 2)}\n`, { flag: 'wx' });
      out(`created ${file}`);
      out("Put your sound files in that folder, set each event's \"file\" (relative to the folder) and edit or drop its \"say\".");
      out(`Then: collab sound pack "${dir}"`);
      return;
    }
    if (!rest[0]) die('usage: collab sound pack <folder | none> | collab sound pack --init <folder>');
    if (rest[0] === 'none') {
      withSoundConfig((s) => { delete s.pack; });
      out('pack: none');
      return;
    }
    const dir = soundPath(rest.join(' '), process.cwd());
    const pack = readPack(dir);
    if (pack.error) die(pack.error);
    // A missing file refuses the pack (fix the manifest first); unknown events and formats this
    // machine can't play are only warnings (the pack may be meant for another OS too).
    const problems = soundProblems({ pack: dir });
    const missing = problems.filter((p) => /file not found/.test(p));
    if (missing.length) die(`pack not used, ${missing.length} mapped file(s) missing:\n${missing.map((p) => `  ✗ ${p}`).join('\n')}`);
    withSoundConfig((s) => { s.pack = dir; });
    out(`pack: ${dir}${pack.name ? ` (${pack.name})` : ''}`);
    for (const p of problems) out(`  ✗ ${p}`);
    if (!problems.length) out('  every mapped file is there and playable here');
    return;
  }
  if (sub === 'setup') {
    const force = rest.includes('--force');
    const set = [];
    withSoundConfig((s) => {
      s.on = true;
      s.voice = { ...(s.voice || {}), on: s.voice && s.voice.on === false && !force ? false : true };
      s.events = s.events && typeof s.events === 'object' ? s.events : {};
      for (const e of Object.keys(SOUND_EVENTS)) {
        const f = systemSound(e);
        if (!f || (e in s.events && !force)) continue;
        s.events[e] = f;
        set.push(`${e}: ${f}`);
      }
    });
    out('sound: on for every task, with spoken sentences');
    for (const l of set) out(`  ${l}`);
    if (!set.length) out(force ? `  no built-in ${OS_NAME[soundOs()]} sounds found` : '  every event already had a sound (--force replaces them)');
    const sp = speechCommand('test', soundConfig().voice || {});
    if (sp.why) out(`speech: ${sp.why}`);
    if (!TONE_PLAYERS[soundOs()].some((p) => soundBin(p.bin))) out(`players: none found: ${INSTALL_HINT.tone[soundOs()]}`);
    out("Try it: 'collab sound test decide'. Change one: 'collab sound set <event> <file>'. Your own pack: 'collab sound pack --init <folder>'.");
    return;
  }
  if (sub === 'test') {
    const dry = rest.includes('--dry-run');
    const what = rest.filter((a) => !['--dry-run', '--elevenlabs', '--full'].includes(a)).join(' ') || 'approve';
    const cfg = soundConfig();
    let steps;
    const cv = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};
    const prefs = { mode: 'voice', engine: rest.includes('--elevenlabs') || cv.engine === 'elevenlabs' ? 'elevenlabs' : 'system', style: rest.includes('--full') || cv.style === 'full' ? 'full' : 'short', name: cv.name === true };
    if (SOUND_EVENTS[what]) steps = soundSteps(what, SOUND_EXAMPLE, prefs, cfg);
    else {
      const f = soundPath(what, process.cwd());
      if (!fs.existsSync(f)) die(`not an event or a file: ${what} ('collab sound events' lists the events)`);
      steps = [{ tone: f }];
    }
    if (!steps.length) { out(`${what}: silent (no tone, no speech)`); return; }
    const job = { steps, volume: soundVolume(cfg), voice: jobVoice(cfg, prefs.engine) };
    let failed = false;
    for (const step of steps) {
      if (step.say && job.voice.engine === 'elevenlabs') {
        const file = ttsCacheFile(step.say, job.voice);
        const hit = fs.existsSync(file);
        out(`speech "${step.say}": ElevenLabs voice ${job.voice.voice_id}, model ${job.voice.model_id} (${hit ? 'cached' : `not cached: POST ${elBase()}/v1/text-to-speech/${job.voice.voice_id}`})`);
        if (dry) continue;
        const r = await speakStep(step, job, null);
        if (r.engine === 'elevenlabs') out(`  spoken by ElevenLabs (${r.cached ? 'from the cache' : `generated in ${(r.ms / 1000).toFixed(1)} s`})`);
        else if (r.engine === 'system') { out(`  ElevenLabs not used: ${r.why}; the system voice spoke instead${r.failed ? `, but failed: ${r.failed}` : ''}`); failed = true; }
        else { out(`  ElevenLabs not used: ${r.why}; and no system voice: ${r.none}`); failed = true; }
        continue;
      }
      const cmd = stepCommand(step, job);
      const label = step.tone ? `tone ${step.tone}` : `speech "${step.say}"`;
      if (cmd.why) { out(`${label}: not played: ${cmd.why}`); failed = true; continue; }
      if (cmd.note) out(`note: ${cmd.note}`);
      out(`${label}: ${[cmd.cmd, ...cmd.args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      if (dry) { if (Object.keys(cmd.env).length) out(`  env: ${JSON.stringify(cmd.env)}`); continue; }
      const res = await runStep(cmd, step.tone ? 30000 : 60000, null);
      if (!res.ok) { out(`  failed: ${res.why}`); failed = true; }
    }
    if (!dry && soundMode(null, cfg) === null) out("note: sound is muted, so tasks stay silent ('collab sound on' to unmute).");
    if (failed) exit(1);
    return;
  }
  die('usage: collab sound [status | events | setup [--force] | use <voice|tones|off|system|elevenlabs|short|full|default>... | test [event|file] [--dry-run] [--elevenlabs] [--full] | set <event|glob> <file|none> | unset <event|glob> | on | off | unmute | volume N | voice on|off|name on|off|style short|full|rate WPM|system|elevenlabs|key | voices | cache clear | pack <folder|none> | pack --init <folder>]');
}

// The short sentence of an event as a template with {placeholders}, for a new pack's manifest
// ('collab sound events' shows the full ones).
function exampleSentenceTemplate(e) {
  const c = {
    t: '{task}', st: { phase: 'build', round: '{round}', plan_round: '{round}', turn: '{turn}' }, part: { index: '{part}', total: '{parts}' },
    n: '{count}', role: '{role}', question: '{question}', options: [], presenter: 'implementer', text: '{text}', why: '{text}',
    waiter: 'implementer', item: { id: 'N' }, answer: '{text}', mins: 'N',
  };
  if (e === 'idle') return '{task}: the {quiet} is quiet';
  return SOUND_EVENTS[e][2](c);
}

// --- task / state helpers ------------------------------------------------------

function currentId() {
  try { return fs.readFileSync(path.join(COLLAB_HOME, 'current'), 'utf8').trim(); } catch { return ''; }
}

// Default task: the project's newest active task, else its newest one, else the most recent one
// anywhere. So two pairs working in different projects never pick up each other's task.
const projectTaskId = () => latestTask(process.cwd());
function latestTask(dir) {
  const ids = projectTasks(dir);
  const active = ids.filter((id) => { try { return !isTerminal(readState(path.join(TASKS, id)).status); } catch { return false; } });
  return active.slice(-1)[0] || ids.slice(-1)[0] || '';
}
const rawTaskId = () => TASK_OVERRIDE || process.env.COLLAB_TASK || projectTaskId() || currentId();

// The reviewer's claim on a task, so a second reviewer (another pair's, or one started in the wrong
// folder) can't join it: a heartbeat file whose mtime its join, waits, progress and submits refresh.
const reviewerSeenPath = (d) => path.join(d, 'reviewer.seen');
function touchReviewer(d) {
  const f = reviewerSeenPath(d);
  const now = new Date();
  try { fs.utimesSync(f, now, now); } catch { try { fs.writeFileSync(f, ''); } catch { /* best effort */ } }
}
// When the task's reviewer was last active, while its claim is live: recent, or it holds the turn
// and isn't idle. null without a live claim (older tasks have no file).
function liveReviewer(d, st) {
  let seen;
  try { seen = Math.floor(fs.statSync(reviewerSeenPath(d)).mtimeMs / 1000); } catch { return null; }
  return epoch() - seen < IDLE || (st.turn === 'reviewer' && !idleReason(st)) ? seen : null;
}

function taskDir() {
  const id = rawTaskId();
  if (!id) die('no current task (implementer runs: collab init)');
  const d = path.join(TASKS, id);
  if (!fs.existsSync(d)) die(`task not found: ${id}`);
  return d;
}

const statePath = (d) => path.join(d, 'state.json');
// The task's folder for handoff-only files; created on demand (older tasks don't have one).
const scratchDir = (d) => { const s = path.join(d, 'scratch'); fs.mkdirSync(s, { recursive: true }); return s; };
const readState = (d) => retry(() => JSON.parse(fs.readFileSync(statePath(d), 'utf8')));

function writeState(d, st) {
  const tmp = `${statePath(d)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  retry(() => fs.renameSync(tmp, statePath(d)));
}

// update: read-modify-write; touch=false for changes that are not agent activity
// (snooze), so the turn timers keep running. Caller holds the lock.
function update(d, fn, { touch = true } = {}) {
  const st = readState(d);
  fn(st);
  // When the task ended, so its total time stops there (later writes, e.g. 'end', don't move it).
  if (isTerminal(st.status) && !st.finished_epoch) st.finished_epoch = epoch();
  if (touch) {
    st.updated_at = nowIso();
    st.updated_epoch = epoch();
  }
  writeState(d, st);
  return st;
}

// The lock is a directory holding an 'owner' file ("<pid> <token>"). Locks are held for
// milliseconds, so one still there after LOCK_WAIT is stale only if its owner process is gone.
const lockOwner = (l) => { try { return fs.readFileSync(path.join(l, 'owner'), 'utf8').trim(); } catch { return ''; } };

// A process that has exited but that its parent hasn't collected yet (a zombie) still answers a
// signal. A killed detached process stays one for as long as PID 1 takes to collect it, which in a
// container without an init can be forever, so on Linux its state in /proc decides.
function isZombie(pid) {
  if (process.platform !== 'linux') return false;
  try {
    // 'pid (comm) state …': comm may contain spaces and parentheses, so read after the last ')'.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return /^\s*[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 1));
  } catch { return false; }
}

function ownerAlive(owner) {
  const pid = parseInt(owner, 10);
  if (!pid) return false;
  try { process.kill(pid, 0); return !isZombie(pid); } catch (e) { return e.code === 'EPERM'; }
}

function lockIsStale(l, owner) {
  if (owner) return !ownerAlive(owner);
  // No owner file: either being created right now, or its creator died in between.
  try { return Date.now() - fs.statSync(l).mtimeMs > 30000; } catch { return false; }
}

// Move a stale lock out of the way. The rename is atomic, so of several waiters only one
// wins; if the lock changed hands since we looked, put it back.
function breakLock(l, owner) {
  const grave = `${l}.stale-${process.pid}-${Date.now()}`;
  try { fs.renameSync(l, grave); } catch { return; }
  if (lockOwner(grave) === owner) {
    process.stderr.write(`collab: broke stale lock ${l}\n`);
    fs.rmSync(grave, { recursive: true, force: true });
  } else {
    try { fs.renameSync(grave, l); } catch { fs.rmSync(grave, { recursive: true, force: true }); }
  }
}

function withLock(d, fn) {
  const l = path.join(d, '.lock');
  const me = `${process.pid} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(l);
      fs.writeFileSync(path.join(l, 'owner'), me);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_WAIT * 1000) {
        const owner = lockOwner(l);
        if (lockIsStale(l, owner)) breakLock(l, owner);
        start = Date.now();
      } else {
        sleepSync(100);
      }
    }
  }
  try {
    return fn();
  } finally {
    if (lockOwner(l) === me) fs.rmSync(l, { recursive: true, force: true });
  }
}

// --- entries ------------------------------------------------------------------

const entriesDir = (d) => path.join(d, 'entries');
const listEntries = (d) => fs.readdirSync(entriesDir(d)).filter((f) => f.endsWith('.md')).sort();
const seqOf = (f) => parseInt(f, 10);
const roleOf = (f) => f.split('-')[1];
const kindOf = (f) => f.replace(/\.md$/, '').split('-').slice(2).join('-');
const latestEntry = (d) => listEntries(d).slice(-1)[0];
const entriesAfter = (d, seq) => listEntries(d).filter((f) => seqOf(f) > seq);

function addEntry(d, st, role, kind, body) {
  const name = `${pad3(st.seq)}-${role}-${kind}.md`;
  fs.writeFileSync(path.join(entriesDir(d), name), body);
  fs.appendFileSync(path.join(d, 'log.md'),
    `\n---\n## #${pad3(st.seq)} · ${role} · ${kind} · ${isPlan(st) ? 'plan round' : 'round'} ${phaseRound(st)} · ${nowIso()}\n\n${body}\n`);
}

// Notes: `NNN-human-note-<to>.md` (the user) or `NNN-peer-note-<to>.md` (the other agent, with
// `collab note --from <role>`). Their target is all, implementer or reviewer.
const NOTE_RE = /^\d+-(human|peer)-note-(all|implementer|reviewer)\.md$/;
const noteTarget = (f) => { const m = NOTE_RE.exec(f); return m ? m[2] : null; };
const isNoteFor = (f, role) => { const t = noteTarget(f); return t === 'all' || t === role; };

function printEntry(d, name) {
  if (name.includes('-human-note-')) {
    out('!!! HUMAN NOTE — from the user, takes priority over the brief and the other agent !!!');
  } else if (name.includes('-peer-note-')) {
    out('>>> NOTE FROM THE OTHER AGENT — not from the user. Weigh it like a review item; the user\'s instructions come first. <<<');
  }
  out(`----- ${name} -----`);
  process.stdout.write(fs.readFileSync(path.join(entriesDir(d), name), 'utf8'));
  out();
  out('----- end -----');
}

// Notes for <role> it has not been shown yet.
function pendingNotes(d, st, role) {
  const seen = st.seen && Number.isInteger(st.seen[role]) ? st.seen[role] : -1;
  return entriesAfter(d, seen).filter((f) => isNoteFor(f, role));
}

// Notes for <role> its handoff `body` does not acknowledge ("Note #N"). Being shown is not enough:
// output an agent discards (e.g. progress piped to /dev/null) must never lose a note. Tasks from
// before acknowledgements count what they were already shown as handled.
function unackedNotes(d, st, role, body) {
  const base = ackBase(st, role);
  const named = new Set([...String(body).matchAll(/\bnote\s*#\s*0*(\d+)\b/gi)].map((m) => Number(m[1])));
  return entriesAfter(d, base).filter((f) => isNoteFor(f, role) && !named.has(seqOf(f)));
}

// A task from before acknowledgements has no `acked`: its baseline is frozen, for BOTH roles, from
// what each had been shown, before anything advances `seen` again. Notes shown before that stay
// handled (the old rule); every later note must be acknowledged.
function freezeAcked(st) {
  if (st.acked) return;
  const at = (role) => (st.seen && Number.isInteger(st.seen[role]) ? st.seen[role] : -1);
  st.acked = { implementer: at('implementer'), reviewer: at('reviewer') };
}

function ackBase(st, role) {
  if (st.acked) return Number.isInteger(st.acked[role]) ? st.acked[role] : -1;
  return st.seen && Number.isInteger(st.seen[role]) ? st.seen[role] : -1;
}

function markSeen(st, role) {
  freezeAcked(st);
  st.seen = st.seen || {};
  st.seen[role] = st.seq - 1;
}

// Message bodies come from --file (recommended in PowerShell) or stdin.
function readBody(file) {
  let text;
  if (file) {
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
  } else {
    if (process.stdin.isTTY) die('message body must be piped on stdin (e.g. a heredoc) or passed with --file PATH');
    try { text = fs.readFileSync(0, 'utf8'); } catch { text = ''; }
  }
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!/\S/.test(text)) die('message body is empty');
  return text.endsWith('\n') ? text : `${text}\n`;
}

// First meaningful line of a message, without markdown heading marks.
// A handoff's own text, for comparing two of them: without the check line collab appends, or
// trailing whitespace.
// The line cmdSubmit appends to a message after the task's --check passed. It stays in the entry
// (the audit trail), but never counts as part of the message's text or of its last section.
const CHECK_LINE = /\n*> collab: check passed: .*\n*$/;
const stripCheckLine = (t) => t.replace(CHECK_LINE, '');
const handoffText = (t) => stripCheckLine(t).split('\n').map((l) => l.trimEnd()).join('\n').trim();
const headline = (t) => (t.split('\n').find((l) => /\w/.test(l)) || '').replace(/^[#>*\s-]+/, '').trim();

// Numbered options ("1. …" or "2) …") of a decision, in order.
const decisionOptions = (body) => body.split('\n').map((l) => l.match(/^\s*(\d+)[.)]\s+(\S.*)$/)).filter(Boolean).map((m) => m[2].trim());

// --- git snapshot helpers -----------------------------------------------------

// core.quotePath=false: human-readable output (diff, --stat) shows non-ASCII names as they are.
// Listings collab parses use -z instead, which quotes nothing.
function git(cwd, args, env = {}) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat', ...env },
  });
  return { ok: r.status === 0, out: r.stdout || '' };
}

// The repo holding root (if any) plus every repo nested under root up to 3 levels down, so a
// task started at a repo root also sees nested repos it ignores (e.g. AzerothCore's modules/*).
function findRepos(root) {
  const repos = new Set();
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.ok && top.out.trim()) repos.add(path.resolve(top.out.trim()));
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === '.git') { if (dir !== root || !repos.size) repos.add(path.resolve(dir)); continue; }
      if (SKIP_DIRS.has(it.name)) continue;
      if (it.isDirectory() && depth < 3) walk(path.join(dir, it.name), depth + 1);
    }
  };
  walk(root, 1);
  return [...repos].sort();
}

const untrackedFiles = (repo) =>
  zList(git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).out);
// Markdown files git ignores (e.g. in a gitignored plans folder): documents an agent writes there
// would otherwise never show up in collab diff.
const ignoredDocs = (repo) =>
  zList(git(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '*.md']).out);

// The file lists init snapshots (untracked/<n>.txt, <n>-ignored-md.txt) are NUL-delimited with a
// trailing NUL. Older versions wrote one name per line, as git printed it: C-quoted ("...") when
// it had special or non-ASCII characters. readNameList returns null when there is no snapshot.
const writeNameList = (file, list) => fs.writeFileSync(file, list.map((f) => `${f}\0`).join(''));
function readNameList(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (raw.includes('\0')) return zList(raw);
  return raw.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map(unquoteGitPath);
}

// A name as git prints it with core.quotePath: "..." with backslash escapes and octal UTF-8 bytes.
function unquoteGitPath(name) {
  if (name.length < 2 || name[0] !== '"' || name[name.length - 1] !== '"') return name;
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  // Whole code points: with core.quotePath=false a quoted name can hold raw non-BMP characters.
  const body = [...name.slice(1, -1)];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const oct = body.slice(i + 1, i + 4).join('');
    if (/^[0-3][0-7]{2}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; } else if (esc[body[i + 1]] !== undefined) { bytes.push(esc[body[i + 1]]); i += 1; } else bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

// Lockfile patches are long and not reviewed line by line: 'collab diff' lists them but leaves
// their patch out unless --all is given.
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'uv.lock', 'go.sum'];
const isLockfile = (f) => LOCKFILES.includes(path.posix.basename(f.replace(/\\/g, '/')));
const notLockfiles = () => LOCKFILES.map((n) => `:(exclude,glob)**/${n}`);

// Snapshots for 'collab diff --since-review' keep their git objects in the task folder: the repo's
// own objects are read through an alternate, and nothing is written to the repo.
function snapshotEnv(d, idx, repo) {
  const own = path.resolve(repo, digestGit(repo, ['rev-parse', '--git-path', 'objects']).trim());
  const dir = path.join(d, 'objects', String(idx));
  fs.mkdirSync(dir, { recursive: true });
  return { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: own };
}

// A tree object of the repo as it is now (tracked and untracked files, plus the listed ignored
// ones), built on a temporary copy of the index: the worktree, the real index and the repo's
// object store stay untouched. The copy is unsplit (a split index would write a new
// sharedindex.* into the repo) and loses its assume-unchanged / skip-worktree flags, so it holds
// the files on disk, inside the sparse-checkout selection or not; a skip-worktree path that isn't
// on disk keeps its entry.
function snapshotTree(d, r, i, extra = []) {
  const idx = Number.isInteger(r.index) ? r.index : i;
  const index = path.resolve(r.path, digestGit(r.path, ['rev-parse', '--git-path', 'index']).trim());
  fs.mkdirSync(path.join(d, 'digests'), { recursive: true });
  const copy = path.join(d, 'digests', `index-${process.pid}-${idx}-snap.tmp`);
  // Sparse checkout off for the copy too, or 'add -A' skips present files outside the selection.
  const cfg = ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false'];
  const g = (args, input) => digestGit(r.path, [...cfg, ...args], env, input);
  let env;
  try {
    if (fs.existsSync(index)) copyIndex(index, copy);
    env = { ...snapshotEnv(d, idx, r.path), GIT_INDEX_FILE: copy };
    if (fs.existsSync(copy)) {
      g(['update-index', '--no-split-index']);
      const flagged = zList(g(['ls-files', '-v', '-z'])).filter((e) => /^[a-zS] /.test(e))
        .filter((e) => !/^[sS] /.test(e) || fs.existsSync(path.join(r.path, e.slice(2))))
        .map((e) => e.slice(2));
      // One flag per call: with --stdin, update-index applies only one of them.
      for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
        if (flagged.length) g(['update-index', flag, '-z', '--stdin'], flagged.join('\0'));
      }
    }
    g(['add', '-A', ...notLessons(repoIgnoresCase(r.path))]);
    if (extra.length) g(['add', '-f', '--', ...extra]);
    return g(['write-tree']).trim();
  } finally {
    try { fs.rmSync(copy, { force: true }); } catch { /* best effort */ }
  }
}

// --- tree digests ---------------------------------------------------------------
// An approval covers the files the reviewer saw. Per repo: every path changed since the task's base
// (tracked, untracked, new ignored *.md) plus every assume-unchanged / skip-worktree path (git diff
// can't see edits to those), each with a signature of what is on disk now. Read-only: git diff runs
// on a temporary copy of the index (it would refresh the real one), other git calls only read
// (GIT_OPTIONAL_LOCKS=0), no objects are written. Any failure dies, so a check fails closed.
// Paths are keys of null-prototype objects / checked with Object.hasOwn: a file may be '__proto__'.

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const zList = (s) => s.split('\0').filter(Boolean);
const noDigest = (why) => die(`cannot compute the tree digest: ${why}`);

function digestGit(cwd, args, env = {}, input = undefined) {
  const r = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', ...env },
  });
  if (r.status !== 0) noDigest(`'git ${args.join(' ')}' failed in ${cwd}${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`);
  return r.stdout || '';
}

// What is at abs now: content hash (+ exec bit), link target, or a nested repo's checked-out
// commit. A changed directory must be one of the task's repos, whose own map covers its content.
function fileSig(abs, covered) {
  let s;
  try { s = fs.lstatSync(abs); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'absent';
    return noDigest(`${abs}: ${e.message}`);
  }
  try {
    if (s.isSymbolicLink()) return `l:${sha256(fs.readlinkSync(abs))}`;
    if (s.isFile()) return `${process.platform !== 'win32' && (s.mode & 0o111) ? 'x' : 'f'}:${sha256(fs.readFileSync(abs))}`;
  } catch (e) { return noDigest(`${abs}: ${e.message}`); }
  if (s.isDirectory()) {
    if (!covered.has(realDir(abs))) noDigest(`a changed folder is not one of this task's snapshotted repos: ${abs}`);
    return `g:${digestGit(abs, ['rev-parse', 'HEAD']).trim()}`;
  }
  return noDigest(`unsupported file type: ${abs}`);
}

// A private copy of a repo's index for git to read and refresh. It keeps the original's timestamps:
// git treats an entry stat'ed in the same second as the index was written as "racily clean" and
// compares its content, which only works if the copy is as old as the index it copies. With a
// fresh mtime, a same-size edit made in that second would look unchanged.
function copyIndex(index, copy) {
  fs.copyFileSync(index, copy);
  const t = fs.statSync(index);
  fs.utimesSync(copy, t.atime, t.mtime);
}

function treeMap(st, d) {
  const covered = new Set(st.repos.map((r) => realDir(r.path)));
  const repos = st.repos.map((r, i) => {
    const idx = Number.isInteger(r.index) ? r.index : i;
    // git diff refreshes the index it reads (even with GIT_OPTIONAL_LOCKS=0), so it gets a copy.
    const index = path.resolve(r.path, digestGit(r.path, ['rev-parse', '--git-path', 'index']).trim());
    fs.mkdirSync(path.join(d, 'digests'), { recursive: true });
    const copy = path.join(d, 'digests', `index-${process.pid}-${idx}.tmp`);
    let changed;
    try {
      if (fs.existsSync(index)) copyIndex(index, copy);
      changed = digestGit(r.path, ['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules=none', r.base], { GIT_INDEX_FILE: copy });
    } catch (e) {
      if (e instanceof CollabError) throw e;
      noDigest(`cannot copy ${index}: ${e.message}`);
    } finally {
      try { fs.rmSync(copy, { force: true }); } catch { /* best effort */ }
    }
    const paths = new Set(zList(changed));
    for (const f of zList(digestGit(r.path, ['ls-files', '-z', '--others', '--exclude-standard']))) paths.add(f.replace(/\/$/, ''));
    let had = null;
    const snap = readNameList(path.join(d, 'untracked', `${idx}-ignored-md.txt`));
    if (snap) had = new Set(snap);
    if (had) {
      for (const f of zList(digestGit(r.path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '*.md']))) {
        if (!had.has(f)) paths.add(f);
      }
    }
    // 'h path' (assume-unchanged, any lowercase tag) or 'S path' (skip-worktree).
    for (const e of zList(digestGit(r.path, ['ls-files', '-v', '-z']))) if (/^[a-zS] /.test(e)) paths.add(e.slice(2));
    const files = Object.create(null);
    const icase = repoIgnoresCase(r.path);
    for (const f of [...paths].sort()) if (!isLessonsPath(f, icase)) files[f] = fileSig(path.join(r.path, f), covered);
    return { path: r.path, files };
  });
  return { id: sha256(JSON.stringify(repos)), repos };
}

const digestPath = (d, name) => path.join(d, 'digests', `${name}.json`);
function saveMap(d, name, map) {
  fs.mkdirSync(path.join(d, 'digests'), { recursive: true });
  const tmp = `${digestPath(d, name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map));
  retry(() => fs.renameSync(tmp, digestPath(d, name)));
}
const loadMap = (d, name) => { try { return JSON.parse(fs.readFileSync(digestPath(d, name), 'utf8')); } catch { return null; } };

// Paths whose signature differs between two maps: + newly changed, ~ changed again, - back to base.
function mapChanges(from, to) {
  const before = new Map(((from && from.repos) || []).map((r) => [r.path, r.files]));
  const lines = [];
  for (const r of to.repos) {
    const a = before.get(r.path) || {};
    const has = (o, f) => Object.hasOwn(o, f);
    const rows = [...new Set([...Object.keys(a), ...Object.keys(r.files)])].sort()
      .filter((f) => !has(a, f) || !has(r.files, f) || a[f] !== r.files[f])
      .map((f) => `  ${!has(a, f) ? '+' : !has(r.files, f) ? '-' : '~'} ${f}`);
    if (rows.length) lines.push(`${r.path}:`, ...rows);
  }
  return lines.length ? lines : ['  (the set of changed files differs)'];
}

// Newest mtime (ms) of any project file, skipping dependency/build folders.
// Stops early once a file at least as new as stopAt is found; capped so a huge tree can't hang.
function lastFileChange(root, stopAt = Infinity) {
  const stack = [root];
  let visited = 0;
  let newest = 0;
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (++visited > 50000) return newest;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) stack.push(p);
      } else if (it.isFile()) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest) newest = m;
          if (newest >= stopAt) return newest;
        } catch { /* vanished */ }
      }
    }
  }
  return newest;
}

// True if any project file changed in the last QUIET_MINS minutes.
function recentChanges(root) {
  const cutoff = Date.now() - QUIET_MINS * 60 * 1000;
  return lastFileChange(root, cutoff) >= cutoff;
}

// When the current turn started (older state files only have updated_epoch).
const turnStart = (st) => st.turn_since || st.updated_epoch;

// The working agent's latest progress update for the current turn, or null.
function liveProgress(st) {
  const p = st.progress;
  return p && p.role === st.turn && p.epoch >= turnStart(st) ? p : null;
}

// Last sign of life from the agent whose turn it is: the handoff (or answer) that gave it the turn,
// or its progress posts since. Not updated_epoch: notes and the other agent's reads write the
// state too, and must not make an unresponsive agent look alive.
const lastActivity = (st) => Math.max(turnStart(st), (liveProgress(st) || {}).epoch || 0);

// Why the agent whose turn it is looks unresponsive, or ''.
function idleReason(st) {
  if (!ROLES.includes(st.turn)) return ''; // waiting on the user (a decision), not on an agent
  const now = epoch();
  const since = now - lastActivity(st);
  if (since < IDLE || now < (st.snooze_until || 0)) return '';
  if (st.turn === 'implementer' && recentChanges(st.project_dir)) return '';
  let why = `the ${st.turn} has not handed off for ${Math.floor((now - turnStart(st)) / 60)} min`;
  if (liveProgress(st)) why += `, its last progress update was ${Math.floor(since / 60)} min ago`;
  if (st.turn === 'implementer') why += ` and no project file changed in the last ${QUIET_MINS} min`;
  return why;
}

function progressLines(d, st) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(d, 'progress.log'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((p) => p && p.role === st.turn && p.epoch >= turnStart(st));
}

// --- task options -------------------------------------------------------------

// Per-task options, accepted by `init` and `queue add`.
const TASK_OPTS = {
  values: { '--max-rounds': 'max_rounds', '--check': 'check', '--scope': 'scope', '--focus': 'focus', '--branch': 'branch' },
  flags: { '--plan': { plan: true }, '--commit': { commit: true }, '--confirm': { confirm: true }, '--phone': { phone: true } },
  optional: { '--sound': { key: 'sound', known: SOUND_MODES } },
};

function normTaskOpts(o) {
  const res = {};
  if (o.plan) res.plan = true;
  if (o.max_rounds !== undefined) res.max_rounds = toSecs(o.max_rounds, DEFAULT_MAX_ROUNDS);
  if (o.check) res.check = String(o.check).trim();
  if (o.scope) res.scope = String(o.scope).split(',').map((g) => g.trim().replace(/^\.\//, '')).filter(Boolean);
  if (o.focus) res.focus = String(o.focus).trim();
  if (o.branch) res.branch = String(o.branch).trim();
  if (o.commit) res.commit = true;
  if (o.confirm) res.confirm = true;
  if (o.phone) res.phone = true;
  if (o.sound) {
    const m = o.sound === true ? 'voice' : String(o.sound).trim().toLowerCase();
    if (!SOUND_MODES.includes(m)) die(`--sound takes ${SOUND_MODES.join(' or ')} (--sound=tones), not '${o.sound}'`);
    res.sound = m;
  }
  return res;
}

function describeOpts(o = {}) {
  const bits = [];
  if (o.plan) bits.push('plan first');
  if (o.max_rounds) bits.push(`max ${o.max_rounds} rounds`);
  if (o.check) bits.push(`check \`${o.check}\``);
  if (o.scope) bits.push(`scope ${o.scope.join(', ')}`);
  if (o.focus) bits.push(`focus: ${o.focus}`);
  if (o.branch) bits.push(`branch ${o.branch}`);
  if (o.commit) bits.push('commit on DONE');
  if (o.confirm) bits.push('confirm before starting');
  if (o.phone) bits.push('phone notifications');
  if (o.sound || o.sound_engine || o.sound_style) {
    const t = taskSound({ options: o });
    bits.push(t.sound === 'off' ? 'silent' : t.sound === 'tones' ? 'tones only'
      : ['sounds', ...(t.style ? [`${t.style} sentences`] : []), ...(t.engine ? [t.engine === 'elevenlabs' ? 'ElevenLabs voice' : 'system voice'] : [])].join(', '));
  }
  return bits;
}

// Markdown appended to the brief so both agents (and the log) see the task's options.
function optionsSection(o = {}) {
  const lines = [];
  if (o.check) lines.push(`- **Check:** \`${o.check}\` must pass before every handoff. \`collab submit\` runs it and refuses on failure; run \`collab check\` to try it first.`);
  if (o.scope) lines.push(`- **Scope:** only change files matching ${o.scope.map((g) => `\`${g}\``).join(', ')}. \`collab diff\` flags anything outside; the reviewer treats that as blocking unless it's clearly justified.`);
  if (o.focus) lines.push(`- **Review focus:** ${o.focus}. The reviewer looks hardest at this.`);
  if (o.branch) lines.push(`- **Branch:** work on \`${o.branch}\`. Create or switch to it before changing anything.`);
  if (o.commit) lines.push('- **Commit:** when the task is DONE, the implementer commits its changes on the current branch with a message summarising the task. Never push.');
  return lines.length ? `\n## Task options (set by collab)\n${lines.join('\n')}\n` : '';
}

// Normalised absolute path, so the same project always matches (symlinks, /private/tmp, …).
function realDir(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

// Two folders are the same project when one contains the other, so a pair whose agents start
// from a repo root and from a module inside it still share tasks and the queue. Arguments are realDir()s.
function sameProject(a, b) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}

// --- queue ------------------------------------------------------------------------

const queuePath = () => path.join(COLLAB_HOME, 'queue.json');

function readQueue() {
  if (!fs.existsSync(queuePath())) return { next_id: 1, items: [] };
  const q = retry(() => JSON.parse(fs.readFileSync(queuePath(), 'utf8')));
  return { next_id: q.next_id || 1, items: q.items || [] };
}

// Read-modify-write the queue under a lock on COLLAB_HOME.
const withQueue = (fn) => withHomeFile(queuePath(), readQueue, fn);

const forProject = (q, dir) => q.items.filter((it) => sameProject(it.project_dir, realDir(dir)));
const partLabel = (p) => `part ${p.index}/${p.total} of ${p.parent}`;

// A split part that ends without approval holds back its later parts: each one then needs
// the user's go-ahead (the --confirm flow) instead of starting on top of unfinished work.
function holdParts(st) {
  if (!st.part || !isTerminal(st.status) || st.status === 'DONE') return;
  withQueue((q) => {
    for (const it of q.items) {
      if (!it.part || it.part.parent !== st.part.parent || it.part.index <= st.part.index) continue;
      it.options = { ...it.options, confirm: true };
      it.held = `${partLabel(st.part)} (${st.id}) ended ${st.status}`;
    }
  });
}
const queueCount = (dir) => forProject(readQueue(), dir).length;

function queueLine(st) {
  const n = queueCount(st.project_dir);
  return n ? `QUEUE: ${n} more task(s) waiting for this project. Implementer: start the next one ('collab queue next'). Reviewer: run 'collab join --after ${st.id}' to wait for it.` : '';
}

// --- project lessons ----------------------------------------------------------------------

// Knowledge that carries over between tasks of a project: added by the user, or by the agents
// from a '## Lessons' section in a handoff, and put into every later brief of that project.
// They live in the project, in '.collab/lessons.md' (committed, so they travel with the repo):
// one top-level '- ' bullet per lesson, with collab's metadata in a trailing HTML comment. People
// can edit the file by hand; code fences, comments and anything else are left alone.
const LESSON_MAX = 300;        // characters per lesson
const LESSONS_IN_BRIEF = 30;   // newest ones put into a brief
const LESSONS_PER_MESSAGE = 5;
const LESSONS_REL = '.collab/lessons.md';
const LESSONS_HEADER = '# Project lessons\n\n'
  + 'Learned while working on this project. Every new collab task brief includes them (the newest 30).\n'
  + 'One lesson per top-level bullet, at most 300 characters; edit or delete freely. The user\'s current\n'
  + 'instructions and the project\'s own rules (CLAUDE.md / AGENTS.md) come first.\n\n';

// Collab's own lessons file is not part of the work under review: diffs, scope checks and the
// approved-tree digest leave it out, so recording a lesson at a handoff never voids a review.
// A repo whose filesystem ignores case (git's own core.ignorecase) matches it in any case.
const ignoreCase = new Map();
function repoIgnoresCase(repo) {
  if (!ignoreCase.has(repo)) ignoreCase.set(repo, git(repo, ['config', '--bool', 'core.ignorecase']).out.trim() === 'true');
  return ignoreCase.get(repo);
}
const isLessonsPath = (f, icase) => new RegExp('(^|/)\\.collab/lessons\\.md$', icase ? 'i' : '').test(f.replace(/\\/g, '/'));
const notLessons = (icase) => ['--', '.', `:(exclude,glob${icase ? ',icase' : ''})**/${LESSONS_REL}`];

// The on-disk spelling of an existing path's last part: on a case-insensitive filesystem
// '.collab/lessons.md' may be '.Collab/LESSONS.md', which is then kept (same file, by dev + inode).
function onDiskName(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  let names;
  let want;
  try { names = fs.readdirSync(dir); want = fs.statSync(p, { bigint: true }); } catch { return p; }
  if (names.includes(base)) return p;
  for (const n of names) {
    if (n.toLowerCase() !== base.toLowerCase()) continue;
    try {
      const s = fs.statSync(path.join(dir, n), { bigint: true });
      if (s.dev === want.dev && s.ino === want.ino) return path.join(dir, n);
    } catch { /* vanished */ }
  }
  return p;
}

// The project's lessons file: the nearest '.collab/lessons.md' from the folder up to its git
// repo's top level (so a module inside a repo shares the repo's lessons), else a new one at that
// top level. Outside git: the nearest one below the home folder, else one in the folder itself.
function lessonsFile(dir) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const start = realDir(dir);
  const top = git(start, ['rev-parse', '--show-toplevel']).out.trim();
  const root = top ? realDir(top) : null;
  const home = norm(realDir(os.homedir()));
  for (let d = start; ; d = path.dirname(d)) {
    const f = path.join(d, ...LESSONS_REL.split('/'));
    if (fs.existsSync(f)) return onDiskName(path.join(onDiskName(path.dirname(f)), path.basename(f)));
    const up = path.dirname(d);
    if (up === d || (root ? norm(d) === norm(root) : norm(up) === home || norm(d) === home)) break;
  }
  const base = path.join(root || start, '.collab');
  return path.join(fs.existsSync(base) ? onDiskName(base) : base, 'lessons.md');
}

const normLesson = (t) => String(t).replace(/\s+/g, ' ').trim();
const lessonKey = (t) => normLesson(t).toLowerCase().replace(/[.!;:,\s]+$/, '');

// Lessons in the file's lines: top-level bullets (indented lines continue one), outside fenced
// code blocks and multi-line HTML comments. `open` names what the file ends inside of, if anything.
function parseLessons(lines) {
  const raw = [];
  let cur = null;
  let fence = null;
  let comment = false;
  lines.forEach((line, i) => {
    if (fence) {
      const c = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      cur = null;
      return;
    }
    if (comment) {
      if (line.includes('-->')) comment = line.lastIndexOf('<!--') > line.lastIndexOf('-->');
      cur = null;
      return;
    }
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { fence = f[1]; cur = null; return; }
    const m = line.match(/^[-*+]\s+(.*)$/);
    if (m) {
      cur = { raw: m[1], start: i, end: i };
      raw.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      cur.raw += ` ${line.trim()}`;
      cur.end = i;
    } else {
      cur = null;
    }
    if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) {
      // A comment opened on a lesson's own line runs on after it: removing the lesson keeps the
      // opener, so the comment's body never turns into lessons.
      if (cur && cur.end === i) cur.keep = line.slice(line.lastIndexOf('<!--'));
      comment = true;
      cur = null;
    }
  });
  const items = [];
  for (const it of raw) {
    const meta = it.raw.match(/<!--\s*collab:([\s\S]*?)-->/);
    const fields = meta ? `${meta[1]} ` : '';
    const text = normLesson(it.raw.replace(/<!--[\s\S]*?(-->|$)/g, ''));
    if (!text) continue;
    items.push({
      n: items.length + 1, start: it.start, end: it.end, keep: it.keep, text, tooLong: text.length > LESSON_MAX,
      by: (fields.match(/\bby (\S+?)[,\s]/) || [])[1] || '',
      task: (fields.match(/\btask (\S+?)[,\s]/) || [])[1] || '',
    });
  }
  return { items, open: fence ? 'code fence' : comment ? 'HTML comment' : '' };
}

// { exists, eol, lines, items, open }. Only a missing file reads as empty: any other failure is
// an error, so an unreadable file is never taken for an empty one (and replaced).
function readLessons(file) {
  let text = '';
  let exists = true;
  try {
    text = retry(() => fs.readFileSync(file, 'utf8')).replace(/^﻿/, '');
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') die(`cannot read ${file}: ${e.code || e.message}`);
    exists = false;
  }
  const lines = text.split(/\r?\n/);
  return { exists, eol: text.includes('\r\n') ? '\r\n' : '\n', lines, ...parseLessons(lines) };
}

// Read-modify-write the lessons file (under the home lock); fn edits `lines` in place.
function editLessons(file, fn) {
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  return withLock(COLLAB_HOME, () => {
    const l = readLessons(file);
    if (!l.exists) l.lines = LESSONS_HEADER.split('\n');
    while (l.lines.length && l.lines[l.lines.length - 1] === '') l.lines.pop();
    fn(l);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${l.lines.join(l.eol)}${l.eol}`);
    retry(() => fs.renameSync(tmp, file));
    return !l.exists;
  });
}

// The bullets (or numbered items) of a message's '## Lessons' section, continuation lines joined.
function lessonBullets(text) {
  const body = section(text, 'Lessons');
  if (!body) return [];
  const items = [];
  // Lines right under a bullet continue it (wrapped, indented or not); a blank line, a heading or
  // a quote ends it, so later text never joins the lesson.
  let open = false;
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (m) { items.push(m[1]); open = true; } else if (!line.trim() || /^\s*[#>]/.test(line)) open = false;
    else if (open) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.map(normLesson).filter((t) => t && !/^(none|n\/a|-)\.?$/i.test(t));
}

// Store new lessons for a project. Returns { file, created, added: [{ n, text }], known, tooLong, extra }.
// Throws (CollabError) when the file can't be read or ends inside an unclosed fence or comment.
function addLessons(dir, texts, by, task) {
  const res = { file: lessonsFile(dir), created: false, added: [], known: [], tooLong: [], extra: [] };
  const fresh = [];
  for (const t of texts) {
    if (t.length > LESSON_MAX) res.tooLong.push(t);
    else if (fresh.length >= LESSONS_PER_MESSAGE) res.extra.push(t);
    else fresh.push(t);
  }
  if (!fresh.length) return res;
  const isKnown = (l) => { const k = new Set(l.items.map((it) => lessonKey(it.text))); return (t) => k.has(lessonKey(t)); };
  if (fresh.every(isKnown(readLessons(res.file)))) { res.known.push(...fresh); return res; }
  const added = [];
  res.created = editLessons(res.file, (l) => {
    if (l.open) die(`${res.file} ends inside an unclosed ${l.open}: close it, then add the lesson again`);
    const known = isKnown(l);
    const keys = new Set();
    for (const text of fresh) {
      if (known(text) || keys.has(lessonKey(text))) { res.known.push(text); continue; }
      keys.add(lessonKey(text));
      const meta = [`by ${by}`, ...(task ? [`task ${task}`] : []), nowIso().slice(0, 10)].join(', ');
      // A blank line first if the file doesn't end with a bullet, so it isn't joined to a paragraph.
      if (l.lines.length && !/^(?:[-*+]\s|\s+\S)/.test(l.lines[l.lines.length - 1])) l.lines.push('');
      l.lines.push(`- ${text} <!-- collab: ${meta} -->`);
      added.push(text);
    }
  });
  // Report the numbers 'collab lessons' shows, from the file as written.
  const items = readLessons(res.file).items;
  for (const text of added) {
    const it = items.find((x) => lessonKey(x.text) === lessonKey(text));
    res.added.push({ n: it ? it.n : 0, text });
  }
  return res;
}

// The final report's '## Lessons recorded during this run': every lessons file the run's tasks
// used (a repo root and a module in it can each have one), read one by one so an unreadable file
// doesn't hide the others. Numbers are per file.
function runLessons(run) {
  const files = new Map();
  const dirs = [];
  for (const id of run) {
    try {
      const dir = realDir(readState(path.join(TASKS, id)).project_dir);
      dirs.push(dir);
      const f = lessonsFile(dir);
      files.set(f, f);
    } catch { /* task gone */ }
  }
  // Paths are shown from the run's outermost task folder (the run's tasks are one project).
  const base = dirs.sort((a, b) => a.length - b.length)[0] || '';
  const shown = (p) => {
    const rel = path.relative(base, p);
    return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p).split(path.sep).join('/');
  };
  const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
  const parts = [];
  const errors = [];
  for (const file of files.values()) {
    let items;
    try { ({ items } = readLessons(file)); } catch (e) {
      if (!(e instanceof CollabError)) throw e;
      errors.push(`> collab: lessons recorded during this run not listed: ${e.message}`);
      continue;
    }
    const learned = items.filter((it) => run.includes(it.task));
    if (!learned.length) continue;
    parts.push(`### ${shown(file)} (remove with 'collab lessons rm N --dir ${quote(path.dirname(path.dirname(file)))}')\n`
      + `${learned.map((it) => `- #${it.n} (${it.by}) ${it.text}`).join('\n')}`);
  }
  if (!parts.length && !errors.length) return '';
  return '\n## Lessons recorded during this run (collected by collab)\n'
    + 'Every later brief of their project includes them: commit them with the work. Numbers are per file; '
    + 'remove a wrong one with the command shown for its file, or edit the file.\n'
    + `${[...parts, ...errors].join('\n\n')}\n`;
}

// The brief's lessons: { section, file, tooLong, error }. Lessons over the limit (hand-written
// ones) are left out, never shortened; the newest 30 of the rest go in.
function lessonsBrief(dir) {
  const file = lessonsFile(dir);
  let items;
  try { ({ items } = readLessons(file)); } catch (e) { if (e instanceof CollabError) return { section: '', file, tooLong: [], error: e.message }; throw e; }
  const tooLong = items.filter((it) => it.tooLong);
  const ok = items.filter((it) => !it.tooLong);
  if (!ok.length) return { section: '', file, tooLong };
  const shown = ok.slice(-LESSONS_IN_BRIEF);
  const older = ok.length - shown.length;
  const section = `\n## Project lessons (set by collab, from ${LESSONS_REL})\n`
    + 'Learned in earlier tasks of this project. Follow them, and the reviewer checks the work against them. '
    + "The user's current instructions (this brief, notes, answers) and the project's own rules (CLAUDE.md / AGENTS.md) "
    + 'come first: if a lesson contradicts them or is clearly obsolete, say so with evidence instead of following it.\n'
    + `${shown.map((it) => `- #${it.n} ${it.text}`).join('\n')}\n`
    + (older ? `(${older} older lesson(s) not shown: 'collab lessons')\n` : '')
    + (tooLong.length ? `(${tooLong.length} lesson(s) over ${LESSON_MAX} characters left out: shorten them in ${LESSONS_REL})\n` : '');
  return { section, file, tooLong };
}

// --- --check and --scope ---------------------------------------------------------------

// Stop a check and everything it started (a shell's children would outlive a plain kill).
function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

function runCheck(st) {
  const cmd = st.options && st.options.check;
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group on Unix, so killTree reaches the whole group.
    const child = spawn(cmd, {
      cwd: st.project_dir, shell: true, env: process.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (buf) => { output = (output + buf.toString('utf8')).slice(-256 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    let error = null;
    let code = null;
    let done = false;
    let grace = null;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, CHECK_TIMEOUT * 1000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      const secs = Math.round((Date.now() - started) / 1000);
      const tail = output.replace(/\s+$/, '').split('\n').slice(-60).join('\n');
      let why = '';
      if (timedOut) why = `timed out after ${CHECK_TIMEOUT}s`;
      else if (error) why = error.message;
      else if (code !== 0) why = `exit code ${code}`;
      resolve({ ok: !why, cmd, secs, why, tail, output });
    };
    child.on('error', (e) => { error = e; finish(); });
    // 'close' waits for the output pipes; a background process that keeps them open
    // must not hang the handoff, so give up on them shortly after the shell exits.
    child.on('exit', (c) => { code = c; grace = setTimeout(finish, 2000); });
    child.on('close', (c) => { if (code === null) code = c; finish(); });
  });
}

function printCheck(res, d) {
  if (res.ok) {
    out(`CHECK PASSED: \`${res.cmd}\` (${res.secs}s)`);
    return;
  }
  // The whole output (its last 256 KB) is kept: an intermittent failure can still be diagnosed.
  let saved = '';
  if (d) {
    try {
      const file = path.join(scratchDir(d), `check-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      fs.writeFileSync(file, `$ ${res.cmd}\n${res.why}\n\n${res.output || ''}`);
      saved = file;
    } catch { /* best effort */ }
  }
  out(`CHECK FAILED: \`${res.cmd}\` — ${res.why} (${res.secs}s).${saved ? ` Full output: ${saved}` : ''} Last lines:`);
  out(res.tail || '(no output)');
}

function globRegex(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!/[*?]/.test(g)) return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&')}(?:/.*)?$`);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// --- argument parsing ------------------------------------------------------------

// Pulls "--name value" / "--flag" options out of args; returns remaining positionals.
// optional: options whose value is optional ('--sound', '--sound=tones', or '--sound tones' when
// the next word is one of its known values), so a bare flag never eats the slug or the task text.
function takeOpts(args, { values = {}, flags = {}, optional = {} } = {}, { strict = false } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name in optional) {
      const o = optional[name];
      if (eq > 0) opts[o.key] = a.slice(eq + 1);
      else if (o.known.includes(args[i + 1])) opts[o.key] = args[++i];
      else opts[o.key] = true;
    } else if (a in values) {
      if (i + 1 >= args.length) die(`${a} needs a value`);
      opts[values[a]] = args[++i];
    } else if (a in flags) {
      Object.assign(opts, flags[a]);
    } else if (strict && a.startsWith('-') && a.length > 1) {
      die(`unknown option: ${a}`);
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

// --attempt N does nothing but make each retry a different command, so an agent CLI's guard
// against repeated identical tool calls (OpenCode's doom_loop) doesn't fire while waiting.
const waitOpts = { values: { '--timeout': 'timeout', '--attempt': 'attempt' } };
// The command to run again after exit 11, naming the next attempt when this one had --attempt.
const again = (cmd, opts) => (opts.attempt === undefined ? cmd : `${cmd} --attempt ${toSecs(opts.attempt) + 1}`);
const toSecs = (v, def) => {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) die(`invalid number: ${v}`);
  return parseInt(v, 10);
};

// --- commands ------------------------------------------------------------------

function cmdInit(args) {
  const { opts, rest } = takeOpts(args, {
    values: { ...TASK_OPTS.values, '--dir': 'dir', '--file': 'file', '-f': 'file', '--confirmed': 'confirmed' },
    flags: { ...TASK_OPTS.flags, '--force': { force: true }, '--from-queue': { fromQueue: true } },
    optional: TASK_OPTS.optional,
  }, { strict: true });
  const usage = "usage: collab init <slug> [--from-queue] [--plan] [--max-rounds N] [--check CMD] [--scope GLOBS] [--focus TEXT] [--branch NAME] [--commit] [--phone] [--sound[=voice|tones]] [--dir PATH] [--force] (brief on stdin or --file PATH)";
  if (!rest[0]) die(usage);
  const slug = rest[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) die(usage);
  const dir = path.resolve(opts.dir || process.cwd());
  if (!fs.existsSync(dir)) die(`no such directory: ${dir}`);

  // One active task per project; other projects can run their own pair at the same time.
  if (!opts.force) {
    const busy = projectTasks(dir).map((id) => readState(path.join(TASKS, id))).find((t) => !isTerminal(t.status));
    if (busy) die(`task '${busy.id}' is still active in this project (${busy.status}). Finish/abort it or pass --force.`);
  }

  let brief = readBody(opts.file);

  // --from-queue takes the next queued task for this project; flags given here override its options.
  let item = null;
  if (opts.fromQueue) {
    item = withQueue((q) => {
      const i = q.items.findIndex((it) => sameProject(it.project_dir, realDir(dir)));
      if (i < 0) return null;
      // A --confirm task only starts with the user's recorded go-ahead.
      if (q.items[i].options && q.items[i].options.confirm && !(opts.confirmed || '').trim()) {
        die(`queued task #${q.items[i].id} needs the user's go-ahead first: ask them, then pass --confirmed "<their answer>"`);
      }
      return q.items.splice(i, 1)[0];
    });
    if (!item) die(`the queue has no task for ${dir}`);
  }
  const options = { ...(item ? item.options : {}), ...normTaskOpts(opts) };
  delete options.confirm;
  // --phone carries on through a run: the next task after an approved one that wasn't ended.
  // Anything else (an end, an escalation, an abort, a stall) needs a new opt-in.
  const prevId = latestTask(dir);
  const prev = prevId && readState(path.join(TASKS, prevId));
  if (!options.phone && prev && prev.status === 'DONE' && !prev.ended && prev.options && prev.options.phone) options.phone = true;
  // Sound settings, field by field (sound, engine, style): what this init asks for (--sound=…) first;
  // then, for a queued part, the run's latest settings only (a 'sound use' after the split counts, and
  // a field it cleared with 'sound use default' stays cleared), or the part's snapshot when no run is
  // open; for any other queued task its own --sound before the run's; then the config.
  const runOpen = prev && prev.status === 'DONE' && !prev.ended;
  const layers = [normTaskOpts(opts), ...(item && item.part ? [runOpen ? prev.options : item.options] : [item && item.options, runOpen && prev.options])];
  for (const k of SOUND_KEYS) delete options[k];
  for (const layer of layers.map((o) => soundFields(o || {}))) {
    for (const k of SOUND_KEYS) if (options[k] === undefined && layer[k] !== undefined) options[k] = layer[k];
  }
  const phone = options.phone ? ensurePhoneUrl() : null;
  const max = options.max_rounds || DEFAULT_MAX_ROUNDS;
  // The reviewer judges the work against what was asked, not only against the implementer's
  // reading of it: a queued task's own text goes into the brief as it was queued (a split part's
  // text is the implementer's, and its brief already says so).
  const hasRequest = !!(section(brief, 'Request') || '').trim();
  if (item && !item.part && (item.text || '').trim()) {
    brief = `${brief.replace(/\s*$/, '')}\n\n## Queued task, as it was queued (set by collab)\n${item.text.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n`;
  }
  brief += optionsSection(options);
  const lessons = lessonsBrief(dir);
  brief += lessons.section;
  const part = item && item.part;
  if (part) {
    brief += `\n## Part of a split task (set by collab)\nThis is ${partLabel(part)}, split up by the implementer. `
      + 'Only this part is in scope. The other parts are separate tasks with their own reviews, so work they will do is not missing here.\n';
  }

  // Creation order within the project, to the millisecond and strictly increasing, so tasks
  // started in the same second still sort in the order they were created.
  const lastId = projectTasks(dir).slice(-1)[0];
  const createdMs = Math.max(Date.now(), lastId ? taskMeta.get(lastId).created + 1 : 0);
  // A task started in the same second as one with the same slug gets a suffix: reusing that
  // folder would carry the other task's entries over. Creating the folder claims the id.
  const stamp = `${slug}-${localStamp()}`;
  fs.mkdirSync(TASKS, { recursive: true });
  let id = stamp;
  for (let n = 2; ; n++) {
    try { fs.mkdirSync(path.join(TASKS, id)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    id = `${stamp}-${n}`;
  }
  const d = path.join(TASKS, id);
  fs.mkdirSync(entriesDir(d), { recursive: true });
  fs.mkdirSync(path.join(d, 'untracked'), { recursive: true });

  // Snapshot every git repo so the reviewer diffs only what changed during this task
  // (git stash create captures the dirty working tree without touching it).
  const repos = [];
  for (const r of findRepos(dir)) {
    const base = git(r, ['stash', 'create']).out.trim() || git(r, ['rev-parse', 'HEAD']).out.trim();
    if (!base) continue;
    const list = untrackedFiles(r).sort();
    writeNameList(path.join(d, 'untracked', `${repos.length}.txt`), list);
    const docs = ignoredDocs(r).sort();
    writeNameList(path.join(d, 'untracked', `${repos.length}-ignored-md.txt`), docs);
    repos.push({ index: repos.length, path: r, base });
  }

  const plan = !!options.plan;
  const now = nowIso();
  const ep = epoch();
  const st = {
    id, project_dir: dir, repos,
    phase: plan ? 'plan' : 'build', status: plan ? 'PLANNING' : 'IMPLEMENTING',
    turn: 'implementer', round: 1, plan_round: 1, max_rounds: max, seq: 0,
    seen: { implementer: 0, reviewer: -1 }, acked: { implementer: -1, reviewer: -1 },
    created_at: now, created_epoch: ep, created_ms: createdMs, updated_at: now, updated_epoch: ep, updated_by: 'implementer',
    turn_since: ep, options,
  };
  if (item) st.queue_item = item.id;
  if (part) st.part = part;
  fs.writeFileSync(path.join(d, 'log.md'), `# collab task: ${id}\nproject: ${dir}\n`);
  addEntry(d, st, 'implementer', 'brief', brief);
  st.seq = 1;
  if (item && item.options && item.options.confirm) {
    addEntry(d, st, 'human', 'confirm', `The user approved starting queued task #${item.id}: "${opts.confirmed.trim()}"\n`);
    st.seq = 2;
  }
  // Queued before the task can be seen, so no later event of it sorts first.
  sound(st, part ? 'part-start' : 'brief');
  writeState(d, st);
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  fs.writeFileSync(path.join(COLLAB_HOME, 'current'), `${id}\n`);

  out(`task:    ${id}`);
  out(`project: ${dir}`);
  out(`repos snapshotted: ${repos.length}`);
  out(`max rounds: ${max}`);
  out(`phase:   ${st.phase}`);
  if (describeOpts(options).length) out(`options: ${describeOpts(options).join(' · ')}`);
  if (lessons.error) out(`lessons: ${lessons.error}; the brief has none`);
  if (lessons.tooLong.length) {
    out(`lessons: ${lessons.tooLong.map((it) => `#${it.n}`).join(', ')} over ${LESSON_MAX} characters, left out of the brief: shorten them in ${lessons.file}`);
  }
  if (phone) out(`phone:   ${phone.created ? 'NEW, tell the user: ' : ''}${phoneHelp(phone.url)}`);
  if (!hasRequest && !item) out("request: the brief has no '## Request' section (the user's own words). Send them to the reviewer now: collab -t " + id + ' note --from implementer "<the request, word for word>"');
  if (item) out(`from queue: #${item.id}${part ? ` (${partLabel(part)})` : ''} (${queueCount(dir)} more waiting for this project)`);
  out(`state:   ${d}`);
  out(`scratch: ${scratchDir(d)}  (message drafts, notes, logs: never in the project)`);
  out(`reviewer: /collab review ${id}  (Codex: $collab review ${id}; OpenCode: "use the collab skill to review task ${id}"): tell the user, so the reviewer joins this task`);
  if (plan) out("Next: write a plan (no code yet), then 'collab submit implementer plan' with it on stdin.");
  else out("Next: implement, then 'collab submit implementer ready' with your summary on stdin.");
}

// The task a bare 'join' takes: this folder's project's newest active (else newest) task. A parent
// folder of several projects with active tasks is ambiguous: the user picks one with -t.
function joinableTask(dir) {
  const active = projectTasks(dir).filter((id) => { try { return !isTerminal(readState(path.join(TASKS, id)).status); } catch { return false; } });
  const dirs = new Set(active.map((id) => realDir(readState(path.join(TASKS, id)).project_dir)));
  if (dirs.size > 1) {
    die(`several projects under this folder have an active task; pick yours with 'collab -t <task-id> join', or start from its project folder:\n${
      active.map((id) => `  ${id}  ${readState(path.join(TASKS, id)).project_dir}`).join('\n')}`);
  }
  return latestTask(dir);
}

// --after <task-id>: the reviewer just finished that task and waits for the implementer's next
// one. Then the newest task of that project decides: a new active task is joined, `collab end`
// on it stops the reviewer too (exit 10), and a long silence after DONE asks the user (exit 13).
async function cmdJoin(args) {
  const { opts } = takeOpts(args, { values: { ...waitOpts.values, '--after': 'after' }, flags: { '--force': { force: true } } });
  const timeout = toSecs(opts.timeout, 540);
  toSecs(opts.attempt);
  const start = epoch();
  let projectDir = '';
  if (opts.after) {
    const ad = path.join(TASKS, opts.after);
    if (!fs.existsSync(statePath(ad))) die(`task not found: ${opts.after}`);
    projectDir = readState(ad).project_dir;
  }
  // A pinned task (-t, $COLLAB_TASK) or this folder's project, never another project's task.
  const pinned = TASK_OVERRIDE || process.env.COLLAB_TASK;
  if (pinned && !opts.after && !fs.existsSync(statePath(path.join(TASKS, pinned)))) die(`task not found: ${pinned}`);
  for (;;) {
    const id = projectDir ? latestTask(projectDir) : pinned || joinableTask(process.cwd());
    const d = id && path.join(TASKS, id);
    if (d && fs.existsSync(statePath(d))) {
      const st = readState(d);
      if (!isTerminal(st.status)) {
        // Check and claim under the task lock, so two reviewers joining at once can't both get in.
        withLock(d, () => {
          const seen = !opts.force && liveReviewer(d, readState(d));
          if (seen) {
            die(`task ${id} (project ${st.project_dir}) already has a reviewer, last active ${fmtDur(Math.max(0, epoch() - seen))} ago. `
              + "To review another pair's task, start the reviewer from that project's folder or with 'collab -t <task-id> join'. "
              + `If that reviewer is gone, take over with 'collab -t ${id} join --force'.`);
          }
          touchReviewer(d);
        });
        out(`joined task: ${id}`);
        out(`project:     ${st.project_dir}`);
        out(`status:      ${st.status} (turn: ${st.turn}, ${roundLabel(st)})`);
        out(`scratch:     ${scratchDir(d)}  (message drafts, notes, logs: never in the project)`);
        printEntry(d, listEntries(d)[0]);
        return;
      }
      if (projectDir && st.ended) {
        out(`WORK COMPLETE: the implementer ended the run after ${id}.`);
        printEntry(d, listEntries(d).find((f) => seqOf(f) === st.ended.seq));
        exit(EXIT_TERMINAL);
      }
      if (projectDir && st.status !== 'DONE') {
        out(`TASK FINISHED: ${st.status} (${id}) — the queue is paused until the user decides.`);
        printEntry(d, latestEntry(d));
        exit(EXIT_TERMINAL);
      }
      if (projectDir && epoch() - st.updated_epoch >= IDLE && epoch() >= (st.snooze_until || 0)) {
        const why = `the implementer has neither started a new task nor ended the run for ${Math.floor((epoch() - st.updated_epoch) / 60)} min since ${id} was approved`;
        const sounded = soundMode(st) && claimTaskEvent(d, `join-idle:${st.updated_epoch}:${st.snooze_until || 0}`,
          (cst) => sound(cst, 'idle', { why, waiter: 'reviewer' }));
        notify(`${id}: ${why} — stop or keep waiting?`, { silent: !!sounded });
        pushPhone(st, `${why}. Stop or keep waiting?`, { priority: 'high' });
        out(`OTHER AGENT LOOKS UNRESPONSIVE: ${why}.`);
        out(`Ask the user: stop here, or keep waiting ('collab -t ${id} snooze [MIN]', default 30)?`);
        exit(EXIT_IDLE);
      }
    }
    if (epoch() - start >= timeout) {
      out(`no active task yet (waited ${fmtDur(epoch() - start)}). This is normal: the implementer may still be writing the brief.`);
      out(`Run '${again(`collab join${opts.after ? ` --after ${opts.after}` : ''}`, opts)}' again right away. Keep waiting; don't end your turn.`);
      exit(EXIT_TIMEOUT);
    }
    await sleep(POLL * 1000);
  }
}

// '1. [blocking] …' items of a review, each with its continuation lines (up to a blank line, the
// next numbered item or a heading).
function blockingItems(text) {
  const items = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^\s*\d+[.)]\s/.test(line) || /^\s*#/.test(line) || !line.trim()) {
      cur = /^\s*\d+[.)]\s*\[blocking\]/i.test(line) ? [line.trimEnd()] : null;
      if (cur) items.push(cur);
    } else if (cur) {
      cur.push(line.trimEnd());
    }
  }
  return items.map((l) => l.join('\n'));
}

const oneLine = (t, n) => { const s = t.replace(/\s+/g, ' ').trim(); return [...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s; };

// The reviewer's notes to the implementer since its last review verdict (a decision it asked
// isn't one), each with the implementer's latest 'Note #N' line about it. The reviewer has the
// notes in full already: one line each.
function noteReplies(d, files) {
  const last = files.filter((f) => roleOf(f) === 'reviewer' && ['changes', 'approve'].includes(kindOf(f))).pop();
  // Only handoffs acknowledge notes; a decide, escalate or split that mentions one is no reply.
  const handoffs = files.filter((f) => roleOf(f) === 'implementer' && ['plan', 'ready'].includes(kindOf(f))).reverse();
  return files.filter((f) => f.includes('-peer-note-implementer') && (!last || seqOf(f) > seqOf(last))).map((f) => {
    const seq = seqOf(f);
    const text = fs.readFileSync(path.join(entriesDir(d), f), 'utf8').replace(/^From: .*\n/, '');
    const re = new RegExp(`\\bnote\\s*#\\s*0*${seq}\\b`, 'i');
    let reply = null;
    for (const h of handoffs.filter((e) => seqOf(e) > seq)) {
      const line = fs.readFileSync(path.join(entriesDir(d), h), 'utf8').split('\n').find((l) => re.test(l));
      if (line) { reply = `#${pad3(seqOf(h))}: ${oneLine(line.replace(/^[\s>*-]+/, ''), 200)}`; break; }
    }
    return { seq, text: oneLine(text, 160), reply };
  });
}

// What the reviewer gets besides the latest messages: the blocking items of the current phase's
// earlier reviews, and (in a --plan task's build phase) which entry is the approved plan. The
// entry that approved the plan (plan_approved_seq: the reviewer's approve, or the user's answer at
// the round limit; for older tasks, the first reviewer approve) splits the phases.
function reviewRecap(d, st) {
  const files = listEntries(d);
  // The entry that approved the plan (the reviewer's approve, or the user's answer at the round
  // limit) separates the phases; tasks from before plan_approved_seq only had the reviewer's.
  const approve = Number.isInteger(st.plan_approved_seq) ? st.plan_approved_seq
    : (files.filter((f) => roleOf(f) === 'reviewer' && kindOf(f) === 'approve').map(seqOf)[0] ?? null);
  const build = !isPlan(st);
  const inPhase = files.filter((f) => approve === null || (build ? seqOf(f) > approve : seqOf(f) < approve));
  const lines = [];
  const rounds = inPhase.filter((f) => roleOf(f) === 'reviewer' && kindOf(f) === 'changes');
  const found = rounds.map((f, i) => ({ f, i, items: blockingItems(fs.readFileSync(path.join(entriesDir(d), f), 'utf8')) }))
    .filter((r) => r.items.length);
  if (found.length) {
    lines.push('----- earlier blocking items (from collab): check each is resolved in intent, not just in wording -----');
    for (const r of found) lines.push(`${build ? '' : 'plan '}round ${r.i + 1} (#${pad3(seqOf(r.f))}):`, ...r.items);
    lines.push('----- end -----');
  }
  const notes = noteReplies(d, files);
  if (notes.length) {
    lines.push('----- your notes since your last review (from collab): check each fix in the code, not just its acknowledgement -----');
    for (const n of notes) lines.push(`Note #${n.seq}: ${n.text}`, `   → ${n.reply || 'not acknowledged yet'}`);
    lines.push('----- end -----');
  }
  if (build && (st.review_trees || []).length >= 2) {
    lines.push(`changes since your last review: 'collab -t ${st.id} diff --since-review' (the whole task: 'collab -t ${st.id} diff')`);
  }
  if (build && approve !== null) {
    const plan = files.filter((f) => roleOf(f) === 'implementer' && kindOf(f) === 'plan' && seqOf(f) < approve).pop();
    if (plan) lines.push(`approved plan: #${pad3(seqOf(plan))} (read it with 'collab -t ${st.id} show ${seqOf(plan)}'). Review the build against it too.`);
  }
  return lines;
}

// Line diff (LCS) of a and b as [op, line] pairs, op ' ', '-' or '+'; null when too large to compute.
function lineDiff(a, b) {
  const n = a.length; const m = b.length;
  if ((n + 1) * (m + 1) > 4e6) return null;
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { ops.push(['+', b[j]]); j++; }
    else { ops.push(['-', a[i]]); i++; }
  }
  return ops;
}

// Hunks of a line diff with `ctx` lines of context, each labelled with the heading above it.
function diffHunks(ops, ctx = 2) {
  const keep = new Set();
  ops.forEach(([op], k) => { if (op !== ' ') for (let c = k - ctx; c <= k + ctx; c++) keep.add(c); });
  const lines = [];
  let heading = null; let newLine = 0; let prev = -2;
  ops.forEach(([op, line], k) => {
    if (op !== '-') newLine++;
    if (op !== '-' && /^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, '').trim();
    if (keep.has(k)) {
      if (k !== prev + 1) lines.push(`@@ line ${newLine}${heading ? `, under "${heading}"` : ''}`);
      lines.push(`${op} ${line}`);
      prev = k;
    }
  });
  return lines;
}

// A revised plan reaches the reviewer as the changes since the previous plan, which it has
// already reviewed, unless they are most of it. Returns false when the entry must be printed whole.
function printPlanDelta(d, st, f) {
  if (roleOf(f) !== 'implementer' || kindOf(f) !== 'plan') return false;
  const prev = listEntries(d).filter((e) => roleOf(e) === 'implementer' && kindOf(e) === 'plan' && seqOf(e) < seqOf(f)).pop();
  if (!prev) return false;
  const read = (e) => fs.readFileSync(path.join(entriesDir(d), e), 'utf8');
  const body = read(f);
  const ops = lineDiff(read(prev).replace(/\n+$/, '').split('\n'), body.replace(/\n+$/, '').split('\n'));
  if (!ops) return false;
  const hunks = diffHunks(ops);
  if (hunks.join('\n').length > body.length * 0.6) return false;
  out(`>>> REVISED PLAN: only the changes since plan #${pad3(seqOf(prev))}, which you reviewed ('-' removed, '+' added).`
    + ` Full text: 'collab -t ${st.id} show ${seqOf(f)}'. <<<`);
  out(`----- ${f} (changes since #${pad3(seqOf(prev))}) -----`);
  for (const l of hunks.length ? hunks : ['(no changes)']) out(l);
  out('----- end -----');
  return true;
}

async function cmdWait(args) {
  const { opts, rest } = takeOpts(args, waitOpts);
  const role = rest[0];
  if (!ROLES.includes(role)) die('usage: collab wait <implementer|reviewer> [--timeout SECS] [--attempt N]');
  const other = role === 'implementer' ? 'reviewer' : 'implementer';
  const timeout = toSecs(opts.timeout, 540);
  toSecs(opts.attempt);
  const start = epoch();
  const d = taskDir();
  for (;;) {
    if (role === 'reviewer') touchReviewer(d);
    const st = readState(d);
    if (isTerminal(st.status)) {
      out(`TASK FINISHED: ${st.status} (${isPlan(st) ? 'plan round' : 'round'} ${phaseRound(st)})`);
      printEntry(d, latestEntry(d));
      if (st.status === 'DONE' && queueLine(st)) out(queueLine(st));
      exit(EXIT_TERMINAL);
    }
    if (st.turn === role) {
      // Everything since my last own entry (the other agent's message plus notes for me), and
      // notes for me I haven't been shown yet even if they came before that entry (e.g. before
      // a split or a decide). Never a note for the other role. Picked and marked seen under one
      // lock, before printing, so neither a note arriving meanwhile nor a reader that closes the
      // pipe early can lose one.
      const visible = (f) => !noteTarget(f) || isNoteFor(f, role);
      let fresh;
      withLock(d, () => update(d, (s) => {
        const all = listEntries(d);
        const mine = all.filter((f) => roleOf(f) === role).slice(-1)[0];
        const since = entriesAfter(d, mine ? seqOf(mine) : -1).filter(visible);
        const pending = s.seen && Number.isInteger(s.seen[role]) ? pendingNotes(d, s, role) : [];
        fresh = [...new Set([...pending, ...since])].sort((a, b) => seqOf(a) - seqOf(b));
        if (!fresh.length) fresh = all.filter(visible).slice(-1);
        markSeen(s, role);
      }));
      out(`YOUR TURN (${role}) — status: ${st.status}, ${roundLabel(st)}`);
      out(`project: ${st.project_dir}`);
      for (const f of fresh) if (!(role === 'reviewer' && printPlanDelta(d, st, f))) printEntry(d, f);
      if (role === 'reviewer') for (const l of reviewRecap(d, st)) out(l);
      return;
    }
    // A decision for the user: exactly one agent presents it, so the user answers in one place.
    // The asker with --self, else the other agent; the round-limit menu goes to the implementer.
    // The presenter is shown the options once; the other agent just waits. No idle or stall meanwhile.
    if (st.status === 'DECISION') {
      const dec = st.decision || {};
      const presenter = decisionPresenter(dec);
      if (presenter === role && !dec.self && !(dec.shown || {})[role]) {
        withLock(d, () => update(d, (s) => { if (s.decision) s.decision.shown = { ...s.decision.shown, [role]: true }; }, { touch: false }));
        out(`DECISION NEEDED: ${dec.kind === 'limit' ? 'the round limit is reached' : `the ${dec.role} asks the user to choose`}. Show the user the options below, then record`);
        out(`their choice with 'collab -t ${st.id} answer <N | text>' and go back to waiting.`);
        printEntry(d, listEntries(d).find((f) => seqOf(f) === dec.seq));
        exit(EXIT_DECISION);
      }
      // Every waiting agent can sound the reminder (one claim each); poll in time for the next one.
      const next = remindDecision(d, st);
      if (epoch() - start >= timeout) {
        if (presenter === role) out(`still waiting — the user has not answered the ${dec.kind === 'limit' ? 'round-limit' : `${dec.role}'s`} question yet ('collab answer <N | text>'). Run '${again(`collab wait ${role}`, opts)}' again.`);
        else out(`still waiting — the ${presenter} presents the ${dec.kind === 'limit' ? 'round-limit' : `${dec.role}'s`} question to the user; don't ask the user about it yourself. Run '${again(`collab wait ${role}`, opts)}' again.`);
        exit(EXIT_TIMEOUT);
      }
      await sleep(Math.min(POLL * 1000, Math.max(200, next + 50)));
      continue;
    }
    const idle = idleReason(st);
    if (idle) {
      // One sound per idle episode: a handoff, a progress update, a file change or a snooze starts a new one.
      const sounded = soundMode(st) && claimTaskEvent(d, `idle:${st.turn}:${lastActivity(st)}:${st.snooze_until || 0}:${
        st.turn === 'implementer' ? Math.floor(lastFileChange(st.project_dir) / 60000) : 0}`,
      (cst) => sound(cst, 'idle', { why: idle, waiter: role }));
      notify(`${st.id}: ${idle} — stop or keep waiting?`, { silent: !!sounded });
      pushPhone(st, `${idle}. Stop or keep waiting?`, { priority: 'high' });
      out(`OTHER AGENT LOOKS UNRESPONSIVE: ${idle}.`);
      out("Ask the user: stop the task ('collab abort') or keep waiting ('collab snooze [MIN]', default 30)?");
      exit(EXIT_IDLE);
    }
    if (epoch() - lastActivity(st) >= STALL && epoch() >= (st.snooze_until || 0)) {
      // Only the process that makes the task STALLED sounds it.
      let sounded = false;
      const sst = withLock(d, () => {
        let stalled = false;
        const ns = update(d, (s) => {
          if (isTerminal(s.status)) return;
          s.status = 'STALLED'; s.turn = 'none'; s.updated_by = 'collab'; stalled = true;
        });
        sounded = stalled && sound(ns, 'stall', { mins: Math.floor(STALL / 60) });
        return ns;
      });
      holdParts(sst);
      notify(`${st.id}: STALLED (no handoff for ${Math.floor(STALL / 60)} min)`, { silent: !!sounded });
      pushPhone(st, `STALLED: no handoff for ${Math.floor(STALL / 60)} min`, { priority: 'high' });
      out(`TASK FINISHED: STALLED — the other agent has not handed off for ${Math.floor(STALL / 60)} min`);
      exit(EXIT_TERMINAL);
    }
    if (epoch() - start >= timeout) {
      const p = liveProgress(st);
      const info = p
        ? `latest ${st.turn} progress: "${p.text}" (${fmtDur(epoch() - p.epoch)} ago)`
        : `no progress update from the ${st.turn} yet (turn started ${fmtDur(epoch() - turnStart(st))} ago)`;
      out(`still waiting — status: ${st.status}, turn: ${st.turn}; ${info}. Run '${again(`collab wait ${role}`, opts)}' again.`);
      exit(EXIT_TIMEOUT);
    }
    await sleep(POLL * 1000);
  }
}

// The reviewer's changes go back to the implementer for another round.
function requestChanges(s) {
  if ((s.phase || 'build') === 'plan') { s.status = 'PLAN_CHANGES'; s.plan_round = (s.plan_round || 1) + 1; } else { s.status = 'CHANGES_REQUESTED'; s.round += 1; }
  s.turn = 'implementer';
}

// The one agent that shows a decision to the user: the asker with --self, the implementer for the
// round limit, otherwise the agent that didn't ask.
function decisionPresenter(dec) {
  if (dec.kind === 'limit') return 'implementer';
  if (dec.self) return dec.role;
  return dec.role === 'implementer' ? 'reviewer' : 'implementer';
}

// The round counter and limit of the task's current phase: the plan phase counts its own rounds
// (plan_round) against its own limit (plan_max_rounds, which only the round-limit answer sets).
const isPlan = (st) => (st.phase || 'build') === 'plan';
const phaseRound = (st) => (isPlan(st) ? st.plan_round || 1 : st.round);
const phaseMax = (st) => (isPlan(st) ? st.plan_max_rounds || st.max_rounds : st.max_rounds);
const roundLabel = (st) => `${isPlan(st) ? 'plan round' : 'round'} ${phaseRound(st)}/${phaseMax(st)}`;

const limitOptions = (plan) => [
  'Give them 2 more rounds: the implementer gets this review (Recommended)',
  plan ? 'Approve the plan as it is (start the build)' : 'Approve the task as it is',
  'Stop the task (escalate; queued tasks wait for you)',
];

// The plan is approved (by the reviewer, or by the user at the round limit): the build starts.
// plan_approved_seq is the entry that approved it, the boundary between the two phases.
function approvePlan(s) {
  s.phase = 'build'; s.status = 'IMPLEMENTING'; s.turn = 'implementer'; s.round = 1; s.plan_approved_seq = s.seq;
}

function transition(st, role, kind) {
  const phase = st.phase || 'build';
  const max = phaseMax(st);
  const bad = `invalid: '${role} ${kind}' in ${phase} phase`;
  const escalate = () => ({ apply: (s) => { s.status = 'ESCALATED'; s.turn = 'none'; } });
  // Out of rounds: the user decides (limitOptions) instead of the task just stopping.
  const limit = (what) => ({ apply: (s) => { s.decision = { role, status: s.status, turn: s.turn, kind: 'limit' }; s.status = 'DECISION'; s.turn = 'human'; }, limit: what });
  switch (`${phase}:${role}:${kind}`) {
    case 'plan:implementer:plan':
      return { apply: (s) => { s.status = 'PLAN_REVIEW'; s.turn = 'reviewer'; } };
    case 'plan:reviewer:approve':
      return { apply: approvePlan };
    case 'plan:reviewer:changes':
      if ((st.plan_round || 1) + 1 > max) return limit(`${max} plan rounds`);
      return { apply: requestChanges };
    case 'build:implementer:ready':
      return { apply: (s) => { s.status = 'READY_FOR_REVIEW'; s.turn = 'reviewer'; } };
    case 'build:reviewer:changes':
      if (st.round + 1 > max) return limit(`${max} review rounds`);
      return { apply: requestChanges };
    case 'build:reviewer:approve':
      return { apply: (s) => { s.status = 'DONE'; s.turn = 'none'; } };
    case 'plan:implementer:ready':
      return die(`${bad} — submit your plan with 'collab submit implementer plan' first`);
    default:
      if (ROLES.includes(role) && kind === 'escalate') return escalate();
      // A question for the user; the turn comes back to the asker once they answer.
      if (ROLES.includes(role) && kind === 'decide') {
        return { apply: (s) => { s.decision = { role, status: s.status, turn: s.turn }; s.status = 'DECISION'; s.turn = 'human'; } };
      }
      return die(`${bad} (plan phase: implementer plan|decide|escalate, reviewer changes|approve|decide|escalate; build phase: implementer ready|decide|escalate, reviewer changes|approve|decide|escalate)`);
  }
}

function refuseUnacked(d, pending) {
  const nums = pending.map((f) => `Note #${seqOf(f)}`).join(', ');
  out(`NOT SUBMITTED: ${nums} ${pending.length > 1 ? 'are' : 'is'} not acknowledged in your message. Handle each, add a line`);
  out("'Note #N — what you did' (under ## Review responses), then submit again with your full, updated message.");
  for (const f of pending) printEntry(d, f);
  exit(EXIT_NOTES);
}

async function cmdSubmit(args) {
  const { opts, rest } = takeOpts(args, { values: { '--file': 'file', '-f': 'file' }, flags: { '--self': { self: true }, '--rereviewed': { rereviewed: true } } });
  const [role, kind] = rest;
  const d = taskDir();
  if (role === 'reviewer') touchReviewer(d);
  let body = readBody(opts.file);
  const options = kind === 'decide' ? decisionOptions(body) : [];
  if (kind === 'decide' && options.length < 2) die("a decision needs at least 2 numbered options ('1. …', '2. …'), one per line");
  // The verdict must match the review: no blocking items in an approve, something to address in changes.
  if (role === 'reviewer' && kind === 'approve' && /^\s*\d+[.)]\s*\[blocking\]/im.test(body)) {
    die("an approve can't contain [blocking] items: submit 'changes' instead (or drop/reword items you only restate as resolved)");
  }
  if (role === 'reviewer' && kind === 'changes' && !/^\s*\d+[.)]\s+\S/m.test(body)) {
    die("changes needs numbered items ('1. …') for the implementer to address");
  }

  const pre = readState(d);
  // A build review only costs a round for something that must change: should-fix items and nits
  // alone go into an approve instead (plan feedback stays untagged).
  if (role === 'reviewer' && kind === 'changes' && (pre.phase || 'build') === 'build' && !isTerminal(pre.status)
      && !/^\s*\d+[.)]\s*\[blocking\]/im.test(body)) {
    die("a build 'changes' needs at least one numbered [blocking] item ('1. [blocking] path:line — problem → what to do'). "
      + "With only [should-fix] items or nits, submit 'approve' and list them there (what the user should still know goes under '## For the user')");
  }
  // A plan or build handoff identical to the previous one is a stale file (e.g. a failed write),
  // never a revision: refuse it before the check runs, so it can't spend a review round.
  if (role === 'implementer' && (kind === 'plan' || kind === 'ready') && pre.turn === role && !isTerminal(pre.status)) {
    const prev = listEntries(d).filter((f) => roleOf(f) === role && kindOf(f) === kind).pop();
    if (prev && handoffText(fs.readFileSync(path.join(entriesDir(d), prev), 'utf8')) === handoffText(body)) {
      die(`this ${kind} is identical to your previous one (#${pad3(seqOf(prev))}), so nothing was submitted.`
        + ' If writing the message file failed, write it again, then submit the updated message.');
    }
  }
  // Notes are checked before the check runs, so a refused handoff never spends a check run.
  // An escalation never waits on notes, and a decision doesn't count as handling them: they
  // stay pending for the next real handoff.
  const acks = kind !== 'escalate' && kind !== 'decide';
  if (acks && pre.turn === role && !isTerminal(pre.status)) {
    const pending = unackedNotes(d, pre, role, body);
    if (pending.length) {
      withLock(d, () => update(d, (s) => markSeen(s, role)));
      refuseUnacked(d, pending);
    }
  }
  // A build handoff says what was verified and what wasn't (see SKILL.md), before the check runs.
  if (role === 'implementer' && kind === 'ready' && (pre.phase || 'build') === 'build') {
    const missing = closeoutMissing(body);
    if (missing.length) {
      const near = closeoutNearMisses(body, missing);
      const hint = near.length ? `; found ${near.join(', ')}: each label must be followed directly by its colon, e.g. 'Verified: (logs in x) …'` : '';
      die(`a ready needs a '## Closeout' section with the labels ${missing.map((l) => `'${l}:'`).join(', ')} (write 'none' where nothing applies)${hint}`);
    }
  }

  // The task's --check must pass before the implementer hands off its work.
  if (role === 'implementer' && kind === 'ready' && (pre.phase || 'build') === 'build' && pre.turn === role
      && !isTerminal(pre.status) && pre.options && pre.options.check) {
    const res = await runCheck(pre);
    if (!res.ok) {
      out('NOT SUBMITTED: the task check failed. Fix it and submit again (or escalate if it cannot pass).');
      printCheck(res, d);
      sound(pre, 'check-fail');
      exit(EXIT_CHECK);
    }
    body += `\n\n> collab: check passed: \`${res.cmd}\` (${res.secs}s)\n`;
  }

  // Build-phase handoffs bind the review to the tree: 'ready' records what the reviewer is shown
  // (after the check, so its artefacts are included), and the reviewer's verdict must still match
  // it: an 'approve' covers exactly that tree, and a 'changes' shows that the reviewer (who never
  // edits project files) left it as it was.
  const verdict = role === 'reviewer' && (kind === 'approve' || kind === 'changes');
  if (opts.rereviewed && !verdict) die("--rereviewed only goes with 'submit reviewer approve' or 'submit reviewer changes'");
  let tree = null;
  if ((pre.phase || 'build') === 'build' && pre.turn === role && !isTerminal(pre.status) && pre.repos && pre.repos.length
      && ((role === 'implementer' && kind === 'ready') || (verdict && pre.review_digest))) {
    tree = treeMap(pre, d);
  }
  // What the reviewer is shown at this handoff, so the next round can diff only what changed since
  // ('collab diff --since-review'). Optional: a failed snapshot never blocks the handoff.
  // A failed one is recorded as missing (repos: null), so the next round falls back to the full diff.
  let snap = null;
  if (tree && role === 'implementer' && kind === 'ready') {
    let repos = null;
    try {
      repos = pre.repos.map((r, i) => ({ path: r.path, tree: snapshotTree(d, r, i, newIgnoredDocs(d, r, i)) }));
    } catch { /* recorded as missing */ }
    snap = { repos };
  }

  const result = withLock(d, () => {
    const st = readState(d);
    if (isTerminal(st.status)) die(`task already finished (${st.status})`);
    if (kind !== 'escalate' && st.turn !== role) die(`not your turn (${role}); current turn: ${st.turn}, status: ${st.status}`);

    // Every note for this agent since its last handoff must be acknowledged ("Note #N") in it.
    // Checked again here: a note can arrive while the check runs.
    if (acks) {
      const pending = unackedNotes(d, st, role, body);
      if (pending.length) {
        update(d, (s) => markSeen(s, role));
        return { pending };
      }
    }

    const t = transition(st, role, kind);
    // The tree changed since the review: refuse, and remember the tree as it is now, so an
    // approve --rereviewed after inspecting the listed files covers exactly that tree.
    const bound = tree && st.review_digest && verdict;
    const binding = bound && kind === 'approve';
    if (bound && tree.id !== st.review_digest && !(opts.rereviewed && tree.id === st.pending_digest)) {
      const since = opts.rereviewed && st.pending_digest ? 'pending' : 'review';
      const changes = mapChanges(loadMap(d, since), tree);
      saveMap(d, 'pending', tree);
      update(d, (s) => { s.pending_digest = tree.id; }, { touch: false });
      return { stale: { since, changes } };
    }
    // A 'changes --rereviewed' over a changed tree tells the implementer which files moved under it.
    if (bound && kind === 'changes' && tree.id !== st.review_digest) {
      body += `\n\n> collab: project files changed during this review, after your handoff (not reverted; the reviewer looked at them):\n${
        mapChanges(loadMap(d, 'review'), tree).map((l) => `> ${l}`).join('\n')}\n`;
    }
    if (tree && kind === 'ready') saveMap(d, 'review', tree);
    if (binding) saveMap(d, 'approved', tree);
    const question = t.limit ? `Round limit reached (${t.limit}) and the reviewer still requests changes. What now?` : headline(body);
    const limitOpts = t.limit && limitOptions(isPlan(st));
    if (t.limit) body += `\n\n## ${question}\n${limitOpts.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n`;
    addEntry(d, st, role, kind, body);
    const nst = update(d, (s) => {
        t.apply(s);
        if (tree && kind === 'ready') { s.review_digest = tree.id; delete s.pending_digest; }
        if (snap) s.review_trees = [...(s.review_trees || []), { seq: s.seq, repos: snap.repos }].slice(-2);
        if (binding) s.approved_digest = tree.id;
        if (s.decision && s.decision.seq === undefined) {
          Object.assign(s.decision, { seq: s.seq, question, options: t.limit ? limitOpts : options, self: !!opts.self && !t.limit, shown: {}, at: Date.now() });
        }
        freezeAcked(s);
        if (acks) s.acked = { ...s.acked, [role]: s.seq };
        s.seq += 1; s.updated_by = role; s.turn_since = epoch();
      });
    return { st: nst, sounded: queueSound(nst, handoffSounds(nst, role, body)) };
  });

  if (result.pending) refuseUnacked(d, result.pending);
  if (result.stale) {
    const again = result.stale.since === 'pending';
    const marks = ' (+ newly changed, ~ changed again, - back to its base content):';
    if (kind === 'approve') {
      out(`NOT APPROVED: the tree changed since ${again ? 'your approve was refused' : "the implementer's handoff"}${marks}`);
      for (const l of result.stale.changes) out(l);
      out("Look at these files (collab diff, or read them). If the review still holds, approve again with "
        + `'collab -t ${pre.id} submit reviewer approve --rereviewed'; if they matter, submit 'changes'.`);
    } else {
      out(`NOT SUBMITTED: project files changed during your review, since ${again ? 'your changes was refused' : "the implementer's handoff"}${marks}`);
      for (const l of result.stale.changes) out(l);
      out("The reviewer never edits project files. Undo your own edits and delete what your test runs left behind, then submit again.");
      out(`If a change isn't yours to undo (the user's edit, the implementer still writing), check it against your review, then run 'collab -t ${pre.id} submit reviewer changes --rereviewed'.`);
    }
    exit(EXIT_TREE);
  }
  const st = result.st;
  out(`submitted: ${role} ${kind} -> ${st.status} (turn: ${st.turn}, ${roundLabel(st)})`);
  const { sounded } = result;
  // The handoff is done: a lessons problem is reported, never turned into a failed submit.
  const bullets = kind === 'decide' ? [] : lessonBullets(body);
  let res = null;
  try {
    if (bullets.length) res = addLessons(st.project_dir, bullets, role, st.id);
  } catch (e) {
    if (!(e instanceof CollabError)) throw e;
    out(`lessons not recorded: ${e.message}`);
  }
  if (res) {
    if (res.added.length) out(`lessons recorded: ${res.added.map((it) => `#${it.n}`).join(', ')} in ${res.file} (put into later briefs of this project)`);
    if (res.created) out(`created ${res.file}: it belongs to the project, commit it with the work`);
    if (res.known.length) out(`lessons already known, not added again: ${res.known.length}`);
    for (const t of res.tooLong) out(`lesson not recorded (over ${LESSON_MAX} characters): ${[...t].slice(0, 60).join('')}…`);
    if (res.extra.length) out(`lessons not recorded (at most ${LESSONS_PER_MESSAGE} per message): ${res.extra.length}`);
  }
  if (role === 'reviewer' && kind === 'approve' && st.status === 'DONE' && !st.approved_digest) {
    out('note: no reviewed tree was recorded for this task (no git repos, or started before collab recorded them), so this approval is not bound to the files.');
  }
  if (st.status === 'DECISION') {
    const dec = st.decision;
    notify(`${st.id}: your decision is needed — ${dec.question}`, { silent: sounded });
    startReminder(st);
    pushPhone(st, `Decision needed: ${dec.question}`, { priority: 'high' });
    if (dec.kind === 'limit') out(`${dec.question} The user decides; the implementer presents the options, don't ask the user yourself. Run 'collab -t ${st.id} wait ${role}': it returns with the outcome.`);
    else if (dec.self) out(`Ask the user now, then record their choice with 'collab -t ${st.id} answer <N | text>'; the turn comes back to you.`);
    else out(`The other agent presents it to the user (or the user runs 'collab answer <N | text>'); don't ask the user yourself. Run 'collab -t ${st.id} wait ${role}': it returns with the answer.`);
    return;
  }
  notify(`${st.id}: ${st.status}`, { silent: sounded });
  if (st.status === 'ESCALATED') pushPhone(st, `Escalated by the ${role}: ${headline(body)}`, { priority: 'high' });
  holdParts(st);
  if (st.status === 'DONE' && queueLine(st)) out(queueLine(st));
  if (isTerminal(st.status)) exit(EXIT_TERMINAL);
}

// An agent running `collab note` would otherwise be recorded as the user: agents pass --from.
function agentShell() {
  const e = process.env;
  // Claude Code sets CLAUDECODE=1 in its shells; Codex sets CODEX_THREAD_ID / CODEX_SESSION_ID in
  // every session (its sandbox variables only when sandboxed); OpenCode sets OPENCODE=1 in its own
  // process, which its shells inherit. COLLAB_AGENT=1 marks any other agent.
  return e.CLAUDECODE === '1' || e.OPENCODE === '1' || !!e.COLLAB_AGENT || !!e.CODEX_THREAD_ID || !!e.CODEX_SESSION_ID
    || !!e.CODEX_SANDBOX || !!e.CODEX_SANDBOX_NETWORK_DISABLED;
}

function cmdNote(args) {
  const { opts, rest } = takeOpts(args, {
    values: { '--to': 'to', '--file': 'file', '-f': 'file', '--from': 'from' },
    flags: {
      '--implementer': { to: 'implementer' }, '-i': { to: 'implementer' }, '--reviewer': { to: 'reviewer' }, '-r': { to: 'reviewer' },
      '--as-user': { asUser: true },
    },
  });
  if (opts.from && !ROLES.includes(opts.from)) die('--from must be implementer or reviewer');
  if (opts.from && opts.asUser) die('--from and --as-user exclude each other');
  if (!opts.from && !opts.asUser && agentShell()) {
    die('collab note records a note FROM THE USER. An agent passes its role: collab note --from reviewer "…"'
      + ' (it reaches the other agent, labelled as yours). If you are the user typing inside an agent session, add --as-user.');
  }
  const other = opts.from === 'implementer' ? 'reviewer' : 'implementer';
  const to = opts.from ? (opts.to || other) : (opts.to || 'all');
  if (!['all', ...ROLES].includes(to)) die('--to must be implementer or reviewer');
  if (opts.from && to !== other) die(`a note from the ${opts.from} goes to the ${other}`);
  const d = taskDir();
  const text = rest.join(' ');
  let body = text && !opts.file ? `${text}\n` : readBody(opts.file);
  if (opts.from) body = `From: the ${opts.from} (mid-turn feedback; not from the user)\n\n${body}`;

  const res = withLock(d, () => {
    const st = readState(d);
    if (isTerminal(st.status)) die(`task already finished (${st.status}) — start a new task instead`);
    const seq = st.seq;
    addEntry(d, st, opts.from ? 'peer' : 'human', `note-${to}`, body);
    const nst = update(d, (s) => { s.seq += 1; s.updated_by = opts.from || 'human'; });
    sound(nst, `${opts.from ? 'peer-' : ''}note-${to}`);
    return { seq, turn: nst.turn };
  });
  out(`note #${res.seq} ${opts.from ? `from the ${opts.from} ` : ''}added for ${to} (turn: ${res.turn}). It is delivered at that agent's`
    + " next turn start or progress update, and its next handoff is refused until it acknowledges 'Note #" + res.seq + "'.");
}

function cmdProgress(args) {
  let text = args.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) die('usage: collab progress "what you are doing now"');
  if ([...text].length > 200) text = `${[...text].slice(0, 199).join('')}…`;
  const d = taskDir();
  const res = withLock(d, () => {
    const st = readState(d);
    if (isTerminal(st.status)) die(`task already finished (${st.status})`);
    if (!ROLES.includes(st.turn)) die('no agent has the turn');
    const p = { role: st.turn, round: st.round, text, at: nowIso(), epoch: epoch() };
    if (st.turn === 'reviewer') touchReviewer(d);
    fs.appendFileSync(path.join(d, 'progress.log'), `${JSON.stringify(p)}\n`);
    // Notes that arrived mid-turn are handed over right away instead of at the next submit.
    const pending = pendingNotes(d, st, st.turn);
    update(d, (s) => { s.progress = p; if (pending.length) markSeen(s, st.turn); }, { touch: false });
    return { p, pending };
  });
  out(`progress (${res.p.role}): ${res.p.text}`);
  if (res.pending.length) {
    out("Note(s) arrived during your turn. Handle each and acknowledge it as 'Note #N — …' in your next handoff (it is refused otherwise):");
    for (const f of res.pending) printEntry(d, f);
  }
}

async function cmdCheck() {
  const d = taskDir();
  const st = readState(d);
  if (!st.options || !st.options.check) {
    out('This task has no check command (add one with --check "…" on init or queue add).');
    return;
  }
  const res = await runCheck(st);
  printCheck(res, d);
  if (!res.ok) exit(EXIT_CHECK);
}

function cmdQueue(args) {
  const [sub = 'list', ...rest] = args;
  const firstLine = (t) => t.split('\n').find((l) => l.trim()) || '';
  const show = (it) => {
    const bits = [...(it.part ? [partLabel(it.part)] : []), ...describeOpts(it.options)];
    return `#${it.id}  [${path.basename(it.project_dir)}]  ${[...firstLine(it.text)].slice(0, 70).join('')}${bits.length ? `\n        ${bits.join(' · ')}` : ''}`;
  };

  if (sub === 'list') {
    const q = readQueue();
    if (!q.items.length) { out('the queue is empty'); return; }
    const here = realDir(process.cwd());
    out(`queue: ${q.items.length} task(s)`);
    q.items.forEach((it, i) => out(`${sameProject(it.project_dir, here) ? '*' : ' '} ${String(i + 1).padStart(2)}. ${show(it)}`));
    out('(* = this project; the implementer takes the first task for its own project)');
    return;
  }

  if (sub === 'add') {
    const { opts, rest: words } = takeOpts(rest, {
      values: { ...TASK_OPTS.values, '--dir': 'dir', '--file': 'file', '-f': 'file' },
      flags: { ...TASK_OPTS.flags, '--first': { first: true } },
      optional: TASK_OPTS.optional,
    }, { strict: true });
    const dir = path.resolve(opts.dir || process.cwd());
    if (!fs.existsSync(dir)) die(`no such directory: ${dir}`);
    const text = words.length && !opts.file ? `${words.join(' ')}\n` : readBody(opts.file);
    const res = withQueue((q) => {
      const item = { id: q.next_id, added_at: nowIso(), project_dir: realDir(dir), text, options: normTaskOpts(opts) };
      q.next_id += 1;
      if (opts.first) q.items.unshift(item); else q.items.push(item);
      return { item, position: q.items.indexOf(item) + 1, waiting: forProject(q, dir).length };
    });
    out(`queued #${res.item.id} at position ${res.position} (${res.waiting} waiting for ${path.basename(dir)})`);
    return;
  }

  if (sub === 'next') {
    const { opts } = takeOpts(rest, { values: { '--dir': 'dir' } });
    const dir = path.resolve(opts.dir || process.cwd());
    const items = forProject(readQueue(), dir);
    if (!items.length) {
      out(`the queue has no task for ${dir}`);
      exit(EXIT_EMPTY);
    }
    const it = items[0];
    out(`NEXT QUEUED TASK #${it.id} (1 of ${items.length} for this project)`);
    out(`project: ${it.project_dir}`);
    if (it.part) out(`split:   ${partLabel(it.part)} (queued by the implementer; don't split it again)`);
    out(`options: ${describeOpts(it.options).join(' · ') || 'none'}`);
    if (it.held) out(`HELD: ${it.held}, so this part may build on unfinished work.`);
    if (it.options && it.options.confirm) {
      out('CONFIRM FIRST: ask the user before starting this task (start / skip / stop).');
      // The phone hears about it when the run has --phone on (the same rule as carrying --phone on
      // in init), or when the queued task itself has it (e.g. the first task of a run).
      const prevId = latestTask(dir);
      const prev = prevId && readState(path.join(TASKS, prevId));
      const msg = `Queued task #${it.id} needs your go-ahead: ${headline(it.text)}`;
      if (prev && prev.status === 'DONE' && !prev.ended && prev.options && prev.options.phone) pushPhone(prev, msg, { priority: 'high' });
      else if (it.options && it.options.phone) pushPhone({ id: `queued task #${it.id}`, options: it.options }, msg, { priority: 'high' });
      // The same for sounds, once per queued item however often 'queue next' shows it.
      const sst = prev && prev.status === 'DONE' && !prev.ended ? prev : { id: '', options: it.options || {} };
      if (soundMode(sst) && claimHomeEvent(`confirm:${it.id}`)) sound(sst, 'confirm', { item: it, text: headline(it.text) });
    }
    out('----- task -----');
    process.stdout.write(it.text.endsWith('\n') ? it.text : `${it.text}\n`);
    out('----- end -----');
    out("Start it with 'collab init <slug> --from-queue' (brief on stdin); skip it with 'collab queue skip'.");
    return;
  }

  if (sub === 'skip') {
    const { opts } = takeOpts(rest, { values: { '--dir': 'dir' } });
    const dir = path.resolve(opts.dir || process.cwd());
    const it = withQueue((q) => {
      const i = q.items.findIndex((x) => sameProject(x.project_dir, realDir(dir)));
      return i < 0 ? null : q.items.splice(i, 1)[0];
    });
    if (!it) { out(`the queue has no task for ${dir}`); exit(EXIT_EMPTY); }
    out(`skipped #${it.id}: ${firstLine(it.text)}`);
    return;
  }

  // The implementer splits its current task: part 1 stays this task, the rest are queued
  // right after it with the same options. Only once, before the first handoff.
  if (sub === 'split') {
    const { opts } = takeOpts(rest, { values: { '--file': 'file', '-f': 'file', '--reason': 'reason' } }, { strict: true });
    const parts = readBody(opts.file).split(/^[ \t]*=== *part *===[ \t]*$/im).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) die("queue split needs at least 2 parts, separated by '=== part ===' lines (on stdin or --file)");
    const d = taskDir();
    const res = withLock(d, () => {
      const st = readState(d);
      if (isTerminal(st.status)) die(`task already finished (${st.status})`);
      if (st.turn !== 'implementer') die(`not your turn (implementer); current turn: ${st.turn}, status: ${st.status}`);
      if (st.part) die(`this task is already ${partLabel(st.part)}; a part can't be split again`);
      if (listEntries(d).some((f) => roleOf(f) === 'implementer' && ['plan', 'ready'].includes(kindOf(f)))) {
        die('too late to split: you already handed off. Split only before your first plan or ready.');
      }
      const total = parts.length;
      const options = { ...(st.options || {}) };
      delete options.confirm;
      const queued = withQueue((q) => {
        const dir = realDir(st.project_dir);
        const at = q.items.findIndex((it) => sameProject(it.project_dir, dir));
        const items = parts.slice(1).map((text, i) => ({
          id: q.next_id + i, added_at: nowIso(), added_by: 'implementer', project_dir: dir,
          text: `${text}\n`, options, part: { index: i + 2, total, parent: st.id },
        }));
        q.next_id += items.length;
        q.items.splice(at < 0 ? q.items.length : at, 0, ...items);
        return items;
      });
      const body = [
        `## Task split into ${total} parts`,
        ...(opts.reason ? ['', `Why: ${opts.reason.trim()}`] : []),
        '', 'This task now covers **part 1 only**:', '', parts[0], '',
        "Queued as separate tasks, each with its own review. Don't flag their work as missing here:",
        ...queued.map((it) => `- #${it.id} part ${it.part.index}/${total}: ${firstLine(it.text)}`),
        '',
      ].join('\n');
      addEntry(d, st, 'implementer', 'split', body);
      const sst = update(d, (s) => { s.seq += 1; s.part = { index: 1, total, parent: st.id }; s.updated_by = 'implementer'; });
      queueSound(sst, [{ event: 'split', c: soundCtx(sst) }, { event: 'part-start', c: soundCtx(sst) }]);
      return { total, queued };
    });
    out(`split into ${res.total} parts: this task is part 1; queued ${res.queued.map((it) => `#${it.id}`).join(', ')} next for this project`);
    return;
  }

  const position = (v, n) => {
    if (!/^\d+$/.test(v || '') || +v < 1 || +v > n) die(`no queue position ${v === undefined ? '' : v} (see 'collab queue')`);
    return +v - 1;
  };

  if (sub === 'rm') {
    const it = withQueue((q) => q.items.splice(position(rest[0], q.items.length), 1)[0]);
    out(`removed #${it.id}: ${firstLine(it.text)}`);
    return;
  }

  if (sub === 'move') {
    const it = withQueue((q) => {
      const from = position(rest[0], q.items.length);
      const to = position(rest[1], q.items.length);
      const [x] = q.items.splice(from, 1);
      q.items.splice(to, 0, x);
      return x;
    });
    out(`moved #${it.id} to position ${rest[1]}`);
    return;
  }

  if (sub === 'clear') {
    const { opts } = takeOpts(rest, { flags: { '--all': { all: true } } });
    const here = realDir(process.cwd());
    const n = withQueue((q) => {
      const before = q.items.length;
      q.items = opts.all ? [] : q.items.filter((it) => !sameProject(it.project_dir, here));
      return before - q.items.length;
    });
    out(`removed ${n} task(s) ${opts.all ? 'from the queue' : `for ${path.basename(here)}`}`);
    return;
  }

  die('usage: collab queue [list | add [options] "task" | next | skip | split [--reason TEXT] | rm N | move N M | clear [--all]]');
}

function cmdLessons(args) {
  const { opts, rest: [sub = 'list', ...words] } = takeOpts(args, { values: { '--dir': 'dir' } });
  const dir = path.resolve(opts.dir || process.cwd());
  const file = lessonsFile(dir);
  if (sub === 'list') {
    const { items } = readLessons(file);
    if (!items.length) { out(`no lessons yet (${file})`); return; }
    out(`${items.length} lesson(s) in ${file}${items.length > LESSONS_IN_BRIEF ? ` (the newest ${LESSONS_IN_BRIEF} go into briefs)` : ''}`);
    for (const it of items) {
      const by = it.by ? `  (${it.by}${it.task ? `, ${it.task}` : ''})` : '';
      if (it.tooLong) out(`#${String(it.n).padEnd(4)} (over ${LESSON_MAX} characters, not put into briefs: shorten it) ${[...it.text].slice(0, 60).join('')}…${by}`);
      else out(`#${String(it.n).padEnd(4)} ${it.text}${by}`);
    }
    return;
  }
  if (sub === 'add') {
    const text = normLesson(words.join(' '));
    if (!text) die('usage: collab lessons add "text"');
    if (text.length > LESSON_MAX) die(`a lesson is at most ${LESSON_MAX} characters (got ${text.length})`);
    const res = addLessons(dir, [text], 'user', null);
    if (!res.added.length) { out('already known for this project, not added'); return; }
    out(`added lesson #${res.added[0].n} to ${res.file}`);
    if (res.created) out(`created ${res.file}: commit it to share the lessons with everyone working on this project`);
    return;
  }
  if (sub === 'rm') {
    if (!words.length || words.some((w) => !/^\d+$/.test(w))) die('usage: collab lessons rm N [N…]');
    const ns = [...new Set(words.map(Number))];
    // Numbers are positions in the file, so either all of them are removed or none.
    const gone = [];
    editLessons(file, (l) => {
      const missing = ns.filter((n) => !l.items.some((it) => it.n === n));
      if (missing.length) die(`no lesson ${missing.map((n) => `#${n}`).join(', ')} in ${file} ('collab lessons' lists them)`);
      const drop = l.items.filter((it) => ns.includes(it.n)).sort((x, y) => y.start - x.start);
      for (const it of drop) l.lines.splice(it.start, it.end - it.start + 1, ...(it.keep ? [it.keep] : []));
      gone.push(...drop.reverse().map((it) => it.text));
    });
    for (const t of gone) out(`removed: ${t}`);
    return;
  }
  die('usage: collab lessons [add "text" | rm N…] [--dir PATH]');
}

// The text of a "waiting for you" event from an agent CLI: a Claude Code Notification hook
// (JSON on stdin: message, cwd), a Codex PermissionRequest hook (JSON on stdin: tool_input, cwd)
// or Codex `notify` (JSON as the argument: type, cwd, last-assistant-message).
function waitingEvent(j) {
  const clip = (t) => { const s = normLesson(t || ''); return s.length > 140 ? `${[...s].slice(0, 140).join('')}…` : s; };
  if (j.hook_event_name === 'PermissionRequest') {
    const ti = j.tool_input || {};
    return `Codex needs your approval: ${clip(ti.description || ti.command || j.tool_name || 'a tool call')}`;
  }
  if (j.type === 'agent-turn-complete') return `Codex stopped and is waiting for you: ${clip(j['last-assistant-message']) || 'its turn ended'}`;
  // Claude Code's own questions fire no Notification: a PreToolUse hook on AskUserQuestion sends them.
  if (j.tool_name === 'AskUserQuestion') {
    const qs = ((j.tool_input || {}).questions || []).map((q) => q && q.question).filter(Boolean);
    return `Claude asks: ${clip(qs[0]) || 'a question'}${qs.length > 1 ? ` (+${qs.length - 1} more)` : ''}`;
  }
  if (j.message) return clip(j.message);
  return '';
}

// collab phone send: push "waiting for you" from outside collab (agent CLI hooks), but only for
// the project's --phone task while its run is going on. Never fails a hook: problems go to stderr.
function phoneSend(args) {
  const { opts, rest } = takeOpts(args, { values: { '--dir': 'dir' } });
  let text = rest.join(' ').trim();
  let dir = opts.dir;
  let json = null;
  try { if (/^\s*\{/.test(text)) json = JSON.parse(text); } catch { /* plain text */ }
  if (!text && !process.stdin.isTTY) {
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    try { json = JSON.parse(input); } catch { text = input.trim(); }
  }
  if (json) {
    text = waitingEvent(json);
    dir = dir || json.cwd;
  }
  const skip = (why) => { process.stderr.write(`collab phone send: not sent (${why})\n`); };
  if (!text) return skip('no message');
  const id = latestTask(path.resolve(dir || process.cwd()));
  const d = id && path.join(TASKS, id);
  let st = null;
  try { st = d && readState(d); } catch { /* none */ }
  const running = st && (!isTerminal(st.status) || (st.status === 'DONE' && !st.ended));
  // Sounds don't need --phone: a running --sound task (or any running task after 'collab sound on')
  // hears it, once a minute at most per task and message. Outside a running task, nothing sounds.
  // During a decision, the presenting agent's own question (AskUserQuestion) and Claude's "waiting
  // for your input" stay silent: 'decide' and its reminders already say the user is needed. A
  // permission prompt still sounds.
  const asking = !!json && (json.tool_name === 'AskUserQuestion' || json.notification_type === 'idle_prompt'
    || /waiting for your input/i.test(String(json.message || '')));
  if (running && !(st.status === 'DECISION' && asking) && soundMode(st) && claimHomeEvent(`agent-waiting:${st.id}:${text}`, 60)) sound(st, 'agent-waiting', { text });
  if (!running) return skip('no collab task running in this project');
  if (!(st.options && st.options.phone)) return skip("this task wasn't started with --phone");
  if (!phoneUrl()) return skip("no destination: 'collab phone set <topic|url>'");
  // The same event again within a minute (a burst of prompts) is pushed once.
  const sent = path.join(d, 'phone-sent.json');
  try {
    const last = JSON.parse(fs.readFileSync(sent, 'utf8'));
    if (last.text === text && epoch() - last.epoch < 60) return skip('sent the same a moment ago');
  } catch { /* first one */ }
  try { fs.writeFileSync(sent, JSON.stringify({ text, epoch: epoch() })); } catch { /* best effort */ }
  pushPhone(st, `Waiting for you: ${text}`, { priority: 'high' });
  process.stderr.write(`collab phone send: sent for ${st.id}\n`);
}

async function cmdPhone(args) {
  const [sub = 'show', ...rest] = args;
  if (sub === 'show') {
    const url = phoneUrl();
    if (!url) { out("phone notifications aren't set up. Start a task with --phone (a private ntfy topic is created), or run 'collab phone set <topic|url>'."); return; }
    out(`phone: ${phoneHelp(url)}${process.env.COLLAB_PHONE_URL ? ' (from COLLAB_PHONE_URL)' : ''}`);
    out('Only tasks started with --phone (and the rest of their run) push to it.');
    return;
  }
  if (sub === 'set') {
    if (!rest[0]) die('usage: collab phone set <ntfy-topic | url>');
    const url = phoneTarget(rest[0]);
    withHomeFile(configPath(), readConfig, (c) => { c.phone_url = url; });
    out(`phone: ${phoneHelp(url)}`);
    if (process.env.COLLAB_PHONE_URL) out('note: COLLAB_PHONE_URL is set and overrides this.');
    return;
  }
  if (sub === 'test') {
    const url = phoneUrl();
    if (!url) die("phone notifications aren't set up: 'collab phone set <topic|url>' first");
    let res;
    try {
      res = await fetch(url, { method: 'POST', body: 'Test notification from collab', headers: { Title: 'collab', Tags: 'robot' }, signal: AbortSignal.timeout(10000) });
    } catch (e) {
      die(`push to ${url} failed: ${(e.cause && (e.cause.message || e.cause.code)) || e.message}`);
    }
    if (!res.ok) die(`push to ${url} failed: HTTP ${res.status}`);
    out(`sent a test notification to ${url}`);
    return;
  }
  if (sub === 'send') {
    try { phoneSend(rest); } catch (e) { process.stderr.write(`collab phone send: not sent (${e.message})\n`); }
    return;
  }
  die('usage: collab phone [set <topic|url> | test | send ["message"] [--dir PATH]]');
}

function cmdSnooze(args) {
  const mins = args[0] === undefined ? '30' : args[0];
  if (!/^\d+$/.test(mins)) die('usage: collab snooze [MINUTES]');
  const d = taskDir();
  withLock(d, () => update(d, (s) => { s.snooze_until = epoch() + parseInt(mins, 10) * 60; }, { touch: false }));
  out(`snoozed: no unresponsive-agent prompt or stall for the next ${mins} min`);
}

function taskIds() {
  if (!fs.existsSync(TASKS)) return [];
  return fs.readdirSync(TASKS).filter((id) => fs.existsSync(statePath(path.join(TASKS, id)))).sort();
}

async function cmdClean(args) {
  const { opts, rest } = takeOpts(args, {
    values: { '--older-than': 'days' },
    flags: { '--dry-run': { dry: true }, '-n': { dry: true }, '--yes': { yes: true }, '-y': { yes: true } },
  });
  if (rest.length) die('usage: collab clean [--older-than DAYS] [--dry-run] [--yes]');
  const days = toSecs(opts.days, 0);
  const now = epoch();
  const victims = [];
  let active = 0;
  for (const id of taskIds()) {
    const st = readState(path.join(TASKS, id));
    if (!isTerminal(st.status)) { active += 1; continue; }
    if (now - st.updated_epoch < days * 86400) continue;
    victims.push(id);
    out(`  ${id.padEnd(45)} ${st.status.padEnd(10)} ${fmtDur(now - st.updated_epoch)} ago`);
  }
  // Drafts written before a task existed (briefs, queue texts): kept for a day, then cleaned too.
  let drafts = [];
  try {
    drafts = fs.readdirSync(DRAFTS).map((f) => path.join(DRAFTS, f))
      .filter((p) => Date.now() - fs.statSync(p).mtimeMs > Math.max(days, 1) * 86400000);
  } catch { /* no drafts folder */ }
  if (drafts.length) out(`  ${drafts.length} draft file(s) in ${DRAFTS} older than ${Math.max(days, 1)} day(s)`);
  if (!victims.length && !drafts.length) { out(`nothing to clean (${active} active task(s) kept)`); return; }
  out(`${victims.length} finished task(s) above; ${active} active task(s) are never touched.`);
  if (opts.dry) { out('(dry run — nothing deleted)'); return; }
  if (!opts.yes) {
    if (!process.stdin.isTTY) die('not a terminal — re-run with --yes to confirm');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((r) => rl.question('Delete them? [y/N] ', r));
    rl.close();
    if (!/^(y|yes)$/i.test(ans.trim())) { out('cancelled'); return; }
  }
  const cur = currentId();
  for (const id of victims) {
    fs.rmSync(path.join(TASKS, id), { recursive: true, force: true });
    if (id === cur) fs.rmSync(path.join(COLLAB_HOME, 'current'), { force: true });
  }
  for (const p of drafts) fs.rmSync(p, { recursive: true, force: true });
  out(`deleted ${victims.length} task(s)${drafts.length ? ` and ${drafts.length} draft file(s)` : ''}`);
}

// Where agents keep files that only exist for the handoff (message drafts, notes, logs), so they
// never end up in the project or the system temp folder: the task's own scratch folder (deleted
// with the task), or the shared drafts folder while no task is active yet (e.g. for a brief).
function cmdScratch() {
  const id = TASK_OVERRIDE || process.env.COLLAB_TASK || latestTask(process.cwd());
  const d = id && path.join(TASKS, id);
  if (d && fs.existsSync(statePath(d)) && (TASK_OVERRIDE || !isTerminal(readState(d).status))) {
    out(scratchDir(d));
    return;
  }
  fs.mkdirSync(DRAFTS, { recursive: true });
  out(DRAFTS);
}

// New *.md files git ignores since init (none for tasks from before those were snapshotted).
function newIgnoredDocs(d, r, i) {
  const idx = Number.isInteger(r.index) ? r.index : i;
  const icase = repoIgnoresCase(r.path);
  const snap = readNameList(path.join(d, 'untracked', `${idx}-ignored-md.txt`));
  if (!snap) return [];
  const had = new Set(snap);
  return ignoredDocs(r.path).filter((f) => !had.has(f) && !isLessonsPath(f, icase)).sort();
}

// The first 400 lines of a new file, or a one-line note for a binary one.
function printNewFile(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { out('(unreadable)'); return; }
  if (buf.subarray(0, 8000).includes(0)) { out(`(binary, ${buf.length} bytes)`); return; }
  const head = buf.toString('utf8').split('\n').slice(0, 400).join('\n');
  process.stdout.write(!head || head.endsWith('\n') ? head : `${head}\n`);
}

function cmdDiff(args) {
  const stat = args.includes('--stat');
  const all = args.includes('--all');
  const sinceReview = args.includes('--since-review');
  const bad = args.find((a) => !['--stat', '--all', '--since-review'].includes(a));
  if (bad) die(`unknown option: ${bad} (usage: collab diff [--stat] [--since-review] [--all])`);
  const d = taskDir();
  const st = readState(d);
  if (!st.repos || !st.repos.length) {
    out(`No git repos in ${st.project_dir} — rely on the file list in the implementer's summary.`);
    return;
  }
  // The handoff the reviewer last reviewed: the one before the current handoff.
  const trees = st.review_trees || [];
  let prev = sinceReview && trees.length >= 2 ? trees[trees.length - 2] : null;
  if (sinceReview && !prev) out('no earlier review snapshot for this task: showing the full task diff.');
  if (prev && !prev.repos) {
    out(`no snapshot of the reviewed handoff #${pad3(prev.seq)}: showing the full task diff.`);
    prev = null;
  }
  const omitted = [];
  const touched = [];
  const unchanged = [];
  for (const [i, r] of st.repos.entries()) {
    const idx = Number.isInteger(r.index) ? r.index : i;
    const icase = repoIgnoresCase(r.path);
    const skipLocks = all ? [] : notLockfiles();
    const before = readNameList(path.join(d, 'untracked', `${idx}.txt`)) || [];
    const known = new Set(before);
    const fresh = untrackedFiles(r.path).filter((f) => !known.has(f) && !isLessonsPath(f, icase)).sort();
    const docs = newIgnoredDocs(d, r, i);
    // Compare canonical paths: on Windows git and Node can spell the same folder differently
    // (8.3 short names like RUNNER~1, or different letter case).
    const rel = (f) => path.relative(realDir(st.project_dir), path.join(realDir(r.path), f)).split(path.sep).join('/');
    const names = zList(git(r.path, ['diff', '--name-only', '-z', r.base, ...notLessons(icase)]).out);
    for (const f of [...names, ...fresh, ...docs]) touched.push(rel(f));

    const old = prev && (prev.repos.find((p) => p.path === r.path) || {}).tree;
    if (prev) {
      // Only what changed since the reviewed handoff, new untracked files included.
      if (!old) { out(`=== ${r.path}: not in the earlier review snapshot, see 'collab diff'`); continue; }
      let now;
      let env;
      try { now = snapshotTree(d, r, i, docs); env = snapshotEnv(d, idx, r.path); } catch (e) {
        if (!(e instanceof CollabError)) throw e;
        out(`=== ${r.path}: ${e.message}; see 'collab diff'`);
        continue;
      }
      const sr = git(r.path, ['diff', '--stat', old, now, ...notLessons(icase)], env);
      // A missing or unreadable snapshot must not read as "nothing changed".
      if (!sr.ok) { out(`=== ${r.path}: the earlier review snapshot can't be read, see 'collab diff'`); continue; }
      const changed = sr.out.replace(/\n+$/, '');
      if (!changed) { unchanged.push(r.path); continue; }
      out(`=== ${r.path} (since review handoff #${pad3(prev.seq)})`);
      out(changed);
      if (!stat) {
        const files = zList(git(r.path, ['diff', '--name-only', '-z', old, now, ...notLessons(icase)], env).out);
        if (!all) omitted.push(...files.filter(isLockfile));
        process.stdout.write(git(r.path, ['--no-pager', 'diff', old, now, ...notLessons(icase), ...skipLocks], env).out);
      }
      out();
      continue;
    }

    const changed = git(r.path, ['diff', '--stat', r.base, ...notLessons(icase)]).out.replace(/\n+$/, '');
    if (!changed && !fresh.length && !docs.length) continue;
    out(`=== ${r.path} (since ${r.base.slice(0, 10)})`);
    if (changed) out(changed);
    if (fresh.length) {
      out('new untracked files:');
      for (const f of fresh) out(`  ${f}`);
    }
    if (docs.length) {
      out('new documents git ignores (*.md):');
      for (const f of docs) out(`  ${f}`);
    }
    if (!stat) {
      if (!all) omitted.push(...names.filter(isLockfile));
      process.stdout.write(git(r.path, ['--no-pager', 'diff', r.base, ...notLessons(icase), ...skipLocks]).out);
      for (const f of [...fresh, ...docs]) {
        out(`+++ new file: ${f}`);
        if (!all && isLockfile(f)) { omitted.push(f); out('(lockfile, content omitted)'); continue; }
        printNewFile(path.join(r.path, f));
      }
    }
    out();
  }
  if (unchanged.length) out(`no changes since review handoff #${pad3(prev.seq)} in: ${unchanged.join(', ')}`);
  if (omitted.length) out(`lockfile patches omitted: ${[...new Set(omitted)].join(', ')} ('collab diff --all' shows them)`);
  const scope = st.options && st.options.scope;
  if (scope && scope.length) {
    const res = scope.map(globRegex);
    const outside = touched.filter((f) => !res.some((re) => re.test(f)));
    if (outside.length) {
      out(`⚠ OUTSIDE SCOPE (${scope.join(', ')}):`);
      for (const f of outside) out(`  ${f}`);
    } else if (touched.length) {
      out(`scope: all changes are inside ${scope.join(', ')}`);
    }
  }
}

// Before committing an approved task: is the tree still the one the reviewer approved?
function cmdVerify() {
  const d = taskDir();
  const st = readState(d);
  if (!st.repos || !st.repos.length) {
    out(`No git repos in ${st.project_dir}: nothing to verify.`);
    return;
  }
  if (!st.approved_digest) die(`no approved tree recorded for ${st.id} (approved before collab recorded digests, or not approved yet)`);
  const tree = treeMap(st, d);
  if (tree.id === st.approved_digest) {
    out(`verified: the tree matches what was approved in ${st.id}`);
    return;
  }
  out(`TREE CHANGED since ${st.id} was approved (+ newly changed, ~ changed again, - back to its base content):`);
  for (const l of mapChanges(loadMap(d, 'approved'), tree)) out(l);
  out("Don't commit: tell the user what changed after the approval.");
  exit(EXIT_TREE);
}

function cmdStatus() {
  const d = taskDir();
  const st = readState(d);
  out(`task:    ${st.id}`);
  out(`project: ${st.project_dir}`);
  out(`status:  ${st.status}`);
  out(`turn:    ${st.turn}`);
  out(`round:   ${isPlan(st) ? 'plan ' : ''}${phaseRound(st)}/${phaseMax(st)}`);
  out(`updated: ${st.updated_at} by ${st.updated_by}`);
  out(`latest:  ${latestEntry(d)}`);
  if (describeOpts(st.options).length) out(`options: ${describeOpts(st.options).join(' · ')}`);
  out(`sound:   ${describePrefs(soundPrefs(st))}`);
  out(`queue:   ${queueCount(st.project_dir)} waiting for this project`);
  out(`folder:  ${d}`);
}

function cmdShow(args) {
  const d = taskDir();
  if (args[0] !== undefined) {
    if (!/^\d+$/.test(args[0])) die(`no entry #${args[0]}`);
    const f = listEntries(d).find((e) => seqOf(e) === parseInt(args[0], 10));
    if (!f) die(`no entry #${args[0]}`);
    printEntry(d, f);
  } else {
    printEntry(d, latestEntry(d));
  }
}

function cmdList() {
  const ids = taskIds();
  if (!ids.length) { out('no tasks'); return; }
  const cur = currentId();
  for (const id of ids) {
    const st = readState(path.join(TASKS, id));
    out(`${id === cur ? '*' : ' '} ${st.id}  ${st.status}  ${roundLabel(st)}  ${st.project_dir}`);
  }
}

function cmdAbort() {
  const d = taskDir();
  const st = withLock(d, () => {
    const ns = update(d, (s) => { s.status = 'ABORTED'; s.turn = 'none'; s.updated_by = 'human'; });
    sound(ns, 'abort');
    return ns;
  });
  holdParts(st);
  out(`aborted ${st.id}`);
}

// Records the user's answer to a pending decision and hands the turn back to the agent that asked.
// "N" (optionally followed by more text) picks option N; anything else is a free-form answer.
function cmdAnswer(args) {
  const { opts, rest } = takeOpts(args, { values: { '--file': 'file', '-f': 'file' } });
  const d = taskDir();
  const text = rest.join(' ').trim();
  const raw = (text && !opts.file ? text : readBody(opts.file)).trim();
  let treeErr = null;
  let spoken = '';
  const st = withLock(d, () => {
    const s0 = readState(d);
    if (s0.status !== 'DECISION' || !s0.decision) die(`no decision is pending (status: ${s0.status})`);
    const dec = s0.decision;
    const m = raw.match(/^(\d+)(?:[.):](?!\d)|(?=\s|$))\s*([\s\S]*)$/);
    const pick = m && dec.options && dec.options[parseInt(m[1], 10) - 1];
    const answer = pick ? `Option ${m[1]}: ${pick}${m[2].trim() ? `\n\n${m[2].trim()}` : ''}` : raw;
    spoken = pick ? `option ${m[1]}, ${pick}` : raw;
    // Round limit: 2 approves (the plan in the plan phase, else the task), 3 stops, 1 or the user's
    // own words: 2 more rounds of the current phase, with this review.
    const n = dec.kind === 'limit' ? (pick ? parseInt(m[1], 10) : 1) : 0;
    const plan = isPlan(s0);
    // Approving the task as it is binds the files as they are now, in the same write as DONE, so
    // no one ever sees a DONE task without its approved tree ('collab verify').
    let tree = null;
    if (n === 2 && !plan && s0.repos && s0.repos.length) {
      try {
        tree = treeMap(s0, d);
        saveMap(d, 'approved', tree);
      } catch (e) {
        if (!(e instanceof CollabError)) throw e;
        treeErr = e.message;
      }
    }
    addEntry(d, s0, 'human', 'answer', `## User decision\n${answer}\n\n> question (#${pad3(dec.seq)}, ${dec.role}): ${dec.question}\n`);
    const ns = update(d, (s) => {
      s.status = dec.status;
      s.turn = dec.turn;
      if (n === 2 && plan) approvePlan(s);
      else if (n === 2) { s.status = 'DONE'; s.turn = 'none'; if (tree) s.approved_digest = tree.id; }
      else if (n === 3) { s.status = 'ESCALATED'; s.turn = 'none'; }
      else if (n === 1) {
        requestChanges(s);
        if (plan) s.plan_max_rounds = phaseMax(s) + 2; else s.max_rounds += 2;
      }
      delete s.decision;
      s.seq += 1; s.updated_by = 'human'; s.turn_since = epoch();
    });
    // The answer's outcome is the event: a round-limit approval or stop sounds like one.
    const c = soundCtx(ns, { role: 'user', answer: spoken });
    if (ns.status === 'DONE') queueSound(ns, doneSounds(ns, c));
    else if (ns.status === 'ESCALATED') sound(ns, 'escalate', { role: 'user', text: 'you chose to stop at the round limit' });
    else if (n === 2 && plan) sound(ns, 'plan-approve');
    else queueSound(ns, [{ event: 'answer', c }]);
    return ns;
  });
  holdParts(st);
  out(isTerminal(st.status) ? `answer recorded; the task is ${st.status}` : `answer recorded; back to the ${st.turn} (status: ${st.status})`);
  if (treeErr) {
    out(`collab: ${treeErr}`);
    out("no verified approval was recorded: 'collab verify' will not pass for this task.");
  }
  if (st.status === 'DONE' && queueLine(st)) out(queueLine(st));
}

// Decisions of the given tasks, as markdown: the user's answers, and the "## Decisions taken"
// sections in which the agents note judgment calls they made themselves.
// Body of the '## <heading>' section of a message, up to the next '## ' heading (null if absent).
function section(text, heading) {
  const m = stripCheckLine(text).match(new RegExp(`^##[ \\t]+${heading}[ \\t]*\\n([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, 'im'));
  return m ? m[1].trim() : null;
}

// [name, the label as required, the label's words alone (for a near miss like 'Verified (x):')]
const CLOSEOUT_LABELS = [['Verified', /^verified\s*:/, /^verified\b/],
  ['Attempted, blocked', /^attempted[\s,/-]*blocked\s*:/, /^attempted\b/],
  ['Deferred', /^deferred\s*:/, /^deferred\b/], ['Not claimed', /^not\s+claimed\s*:/, /^not\s+claimed\b/]];

// The lines of a message's '## Closeout', without list markers, quotes and bold/italic marks:
// `norm` (lowercased) for matching, `raw` (trimmed) for quoting back.
function closeoutLines(text) {
  return (section(text, 'Closeout') || '').split('\n').map((l) => {
    const raw = l.replace(/[*_]/g, '').replace(/^\s*(?:[-+>]\s*)*/, '');
    return { raw: raw.trim(), norm: raw.toLowerCase() };
  });
}

// Labels missing from a message's '## Closeout' (all of them if it has none). List markers,
// quotes and bold/italic marks around a label are fine.
function closeoutMissing(text) {
  const lines = closeoutLines(text);
  return CLOSEOUT_LABELS.filter(([, re]) => !lines.some((l) => re.test(l.norm))).map(([name]) => name);
}

// For each missing label, the first '## Closeout' line that starts with the label's words but
// doesn't follow them directly with a colon (e.g. 'Verified (logs in x):'), quoted for the refusal.
function closeoutNearMisses(text, missing) {
  const lines = closeoutLines(text);
  const out = [];
  for (const [name, , loose] of CLOSEOUT_LABELS) {
    if (!missing.includes(name)) continue;
    const hit = lines.find((l) => loose.test(l.norm));
    if (hit) out.push(`'${hit.raw.length > 40 ? `${hit.raw.slice(0, 40)}…` : hit.raw}'`);
  }
  return out;
}

// The closeout of each task's last build-phase ready, and the '## For the user' briefing of the
// reviewer's approve after it (a plan approval comes before any ready, so it never counts).
function collectCloseouts(ids) {
  const closeouts = [];
  const briefings = [];
  for (const id of ids) {
    const d = path.join(TASKS, id);
    const files = listEntries(d);
    const ready = files.filter((f) => roleOf(f) === 'implementer' && kindOf(f) === 'ready').pop();
    if (!ready) continue;
    const text = fs.readFileSync(path.join(entriesDir(d), ready), 'utf8');
    const closeout = section(text, 'Closeout');
    closeouts.push(`### ${id}\n${closeout || 'no structured closeout recorded for this task'}`);
    const approve = files.find((f) => roleOf(f) === 'reviewer' && kindOf(f) === 'approve' && seqOf(f) > seqOf(ready));
    const brief = approve && section(fs.readFileSync(path.join(entriesDir(d), approve), 'utf8'), 'For the user');
    if (brief && !/^(none|n\/a|-)\.?$/i.test(brief)) briefings.push(`### ${id}\n${brief}`);
  }
  return { closeouts, briefings };
}

function collectDecisions(ids) {
  const found = [];
  for (const id of ids) {
    const d = path.join(TASKS, id);
    for (const f of listEntries(d)) {
      const text = fs.readFileSync(path.join(entriesDir(d), f), 'utf8');
      if (roleOf(f) === 'human' && kindOf(f) === 'answer') {
        found.push(`### ${id} · #${pad3(seqOf(f))} user decision\n${text.replace(/^## User decision\n/, '').trim()}`);
        continue;
      }
      if (!ROLES.includes(roleOf(f))) continue;
      const body = section(text, 'Decisions taken');
      if (body && !/^(none|n\/a|-)\.?$/i.test(body)) found.push(`### ${id} · #${pad3(seqOf(f))} ${roleOf(f)} ${kindOf(f)}\n${body}`);
    }
  }
  return found;
}

// The implementer ends the whole run once everything the user asked for is done. It marks the
// project's latest (DONE) task, so a reviewer waiting in 'join --after' stops too, and collects
// the decisions both agents took instead of escalating since the previous run ended.
function cmdEnd(args) {
  const { opts } = takeOpts(args, { values: { '--file': 'file', '-f': 'file' } }, { strict: true });
  const d = taskDir();
  const pre = readState(d);
  const latest = latestTask(pre.project_dir);
  if (latest !== pre.id) die(`${pre.id} is not the latest task for this project (${latest})`);
  const ids = projectTasks(pre.project_dir).filter((id) => id !== pre.id).concat(pre.id);
  if (pre.status !== 'DONE') {
    die(isTerminal(pre.status)
      ? `${pre.id} ended ${pre.status}: report to the user instead, 'collab end' only follows an approved task`
      : `${pre.id} is still ${pre.status}: finish it first`);
  }
  if (pre.ended) die(`the run already ended after ${pre.id}`);
  // Queued tasks that would start on their own mean the work isn't done. Ones that wait for the
  // user's go-ahead (--confirm, or held after an earlier part failed) stay queued for later.
  const queued = forProject(readQueue(), pre.project_dir);
  const waiting = queued.filter((it) => !(it.options && it.options.confirm));
  if (waiting.length) die(`${waiting.length} queued task(s) still waiting for this project: start them, or remove them with 'collab queue skip' / 'queue rm'`);
  let body = readBody(opts.file);
  if (queued.length) {
    body += `\n## Left in the queue for your go-ahead\n${queued.map((it) => `- #${it.id}: ${headline(it.text)}`).join('\n')}\n`;
  }

  const prev = ids.slice(0, -1).map((id) => readState(path.join(TASKS, id))).reduce((at, t, i) => (t.ended ? i : at), -1);
  const run = ids.slice(prev + 1);
  const decisions = collectDecisions(run);
  const { closeouts, briefings } = collectCloseouts(run);
  body += `\n## Closeouts (collected by collab)\n${closeouts.length ? closeouts.join('\n\n') : 'none'}\n`;
  if (briefings.length) body += `\n## For the user, from the reviewer (collected by collab)\n${briefings.join('\n\n')}\n`;
  body += `\n## Decisions recorded during this run (collected by collab)\n${decisions.length ? decisions.join('\n\n') : 'none'}\n`;
  body += runLessons(run);
  body += `\n> collab: run ended after ${run.length} task(s): ${run.join(', ')}\n`;

  let endSounded = false;
  const st = withLock(d, () => {
    const s0 = readState(d);
    if (s0.ended) die(`the run already ended after ${s0.id}`);
    addEntry(d, s0, 'implementer', 'end', body);
    const ns = update(d, (s) => { s.ended = { seq: s.seq, at: nowIso(), epoch: epoch() }; s.seq += 1; s.updated_by = 'implementer'; });
    endSounded = sound(ns, 'end', { n: run.length });
    return ns;
  });
  notify(`${st.id}: work complete`, { silent: endSounded });
  pushPhone(st, `Work complete: ${run.length} task(s). 'collab show' has the final report.`, { priority: 'high' });
  out(`ended the run after ${st.id}: ${run.length} task(s), ${decisions.length} recorded decision(s)${queued.length ? `, ${queued.length} queued task(s) left for the user's go-ahead` : ''}. A reviewer in 'join --after' stops now.`);
}

// --- watch ------------------------------------------------------------------

// Task ids that belong to the same project folder, oldest first. A task's project and
// creation time never change, so each state file is read once per process, not on every poll.
const taskMeta = new Map();
function projectTasks(dir) {
  const want = realDir(dir);
  const metas = [];
  for (const id of taskIds()) {
    if (!taskMeta.has(id)) {
      try {
        const t = readState(path.join(TASKS, id));
        // Older tasks have no created_ms: they count from the start of their second.
        taskMeta.set(id, { id, dir: realDir(t.project_dir), created: t.created_ms || (t.created_epoch || 0) * 1000 });
      } catch { continue; }
    }
    metas.push(taskMeta.get(id));
  }
  return metas.filter((m) => sameProject(m.dir, want))
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

// Fit coloured segments into a fixed width: [[text, colour], ...] -> string of exactly `width` columns.
function fitSegments(parts, width, reset) {
  let left = width;
  let res = '';
  for (const [text, color] of parts) {
    if (left <= 0) break;
    const chars = [...text].slice(0, left);
    left -= chars.length;
    res += `${color || ''}${chars.join('')}${color ? reset : ''}`;
  }
  return res + ' '.repeat(Math.max(0, left));
}

// Word-wrap text to `width` columns; words longer than a line are split.
function wrapText(text, width) {
  const lines = [];
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const indent = (line.match(/^\s*/) || [''])[0].replace(/\t/g, '  ');
    let cur = '';
    for (const word of line.replace(/\t/g, '  ').trim().split(/ +/)) {
      if (!word) continue;
      const candidate = cur ? `${cur} ${word}` : `${indent}${word}`;
      if ([...candidate].length <= width) { cur = candidate; continue; }
      if (cur) lines.push(cur);
      // The word starts a new line either way, so it keeps the line's indent.
      let rest = [...`${indent}${word}`];
      while (rest.length > width) { lines.push(rest.slice(0, width).join('')); rest = rest.slice(width); }
      cur = rest.join('');
    }
    lines.push(cur);
  }
  return lines;
}

// Cut a line that may contain colour codes to `width` visible columns.
function clipAnsi(str, width) {
  let seen = 0;
  let res = '';
  for (let i = 0; i < str.length;) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { res += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(str.codePointAt(i));
    if (seen >= width) { if (res.includes('\x1b[')) res += '\x1b[0m'; break; }
    res += ch;
    seen += 1;
    i += ch.length;
  }
  return res;
}

// One frame of `collab watch`. view = { sel, follow, scroll, fileChange } (mutated to keep
// selection and scroll in range); returns the lines to draw.
function renderWatch(view, cols, rows, { color = true, keys = true, pad = true } = {}) {
  const c = (code) => (color ? `\x1b[${code}m` : '');
  const B = c(1), D = c(2), R = c(0), G = c(32), Y = c(33), RD = c(31), CY = c(36), MG = c(35), INV = c(7);
  const roleColor = (r) => (r === 'implementer' ? CY : r === 'reviewer' ? MG : Y);
  const id = view.pinned || rawTaskId();
  const d = id && path.join(TASKS, id);
  if (!d || !fs.existsSync(statePath(d))) return [`${B}collab watch${R} — no task yet, waiting for 'collab init'…`];
  if (view.task !== id) Object.assign(view, { task: id, sel: 0, follow: true, scroll: 0, lastCount: 0 });

  const st = readState(d);
  // Tasks of the same project, oldest first, for ←/→ switching.
  view.siblings = projectTasks(st.project_dir);
  const pos = view.siblings.indexOf(st.id);
  const now = epoch();
  const created = st.created_epoch || Math.floor(fs.statSync(d).birthtimeMs / 1000);
  const active = !isTerminal(st.status);
  // A finished task's total stops when it ended (older state files: its last update).
  const endedAt = active ? now : (st.finished_epoch || st.updated_epoch);
  let sc = CY;
  if (st.status === 'DONE') sc = G;
  else if (['ESCALATED', 'STALLED', 'ABORTED'].includes(st.status)) sc = RD;
  else if (['CHANGES_REQUESTED', 'PLAN_CHANGES', 'DECISION'].includes(st.status)) sc = Y;

  // Header
  const lines = [];
  const waiting = queueCount(st.project_dir);
  const taskPos = view.siblings.length > 1 ? `  ${D}task ${pos + 1}/${view.siblings.length}${view.pinned ? ' (←→)' : ''}${R}` : '';
  const partPos = st.part ? `  ${Y}part ${st.part.index}/${st.part.total}${R}` : '';
  lines.push(`${B}collab watch${R}  ${st.id}${partPos}${taskPos}  ${sc}${B}${st.status}${R}  ${roundLabel(st)}${waiting ? `  ${Y}queue: ${waiting} waiting${R}` : ''}  ${D}total ${fmtDur(endedAt - created)} · ${localTime(Date.now())}${R}`);
  lines.push(`${D}project${R} ${st.project_dir}`);
  const live = active ? liveProgress(st) : null;
  if (st.status === 'DECISION') {
    const dec = st.decision || {};
    lines.push(`${Y}${B}?  your decision:${R}${Y} ${dec.question || ''} — ${(dec.options || []).map((o, i) => `${i + 1}. ${o}`).join('  ')}${R}`);
    lines.push(`${D}asked by the ${dec.role} ${fmtDur(now - turnStart(st))} ago · answer with: collab answer <N | text>${R}`);
  } else if (active) {
    let verb = st.turn === 'reviewer' ? 'reviewing' : 'implementing';
    if (['PLANNING', 'PLAN_CHANGES'].includes(st.status)) verb = 'planning';
    if (st.status === 'PLAN_REVIEW') verb = 'reviewing the plan';
    const bits = [`${roleColor(st.turn)}${B}${st.turn}${R} is ${verb} for ${fmtDur(now - turnStart(st))}`];
    bits.push(live ? `⟳ ${live.text} ${D}(${fmtDur(now - live.epoch)} ago)${R}` : `${D}no progress update yet${R}`);
    if (view.fileChange) bits.push(`${D}last file change ${fmtDur(Math.max(0, Math.floor((Date.now() - view.fileChange) / 1000)))} ago${R}`);
    lines.push(bits.join('  ·  '));
    const idle = idleReason(st);
    if (idle) lines.push(`${RD}${B}⚠  looks unresponsive:${R}${RD} ${idle} — collab abort / collab snooze${R}`);
  } else {
    lines.push(`${D}finished at ${localTime(endedAt * 1000)}${R}`);
  }
  const rule = `${D}${'─'.repeat(cols)}${R}`;
  lines.push(rule);

  // Items: every entry, plus a live "now" row while an agent is working
  const items = listEntries(d).map((f) => {
    const p = path.join(entriesDir(d), f);
    const first = fs.readFileSync(p, 'utf8').split('\n').find((l) => !/^\s*(#|$|---)/.test(l)) || '';
    return { file: f, seq: f.split('-')[0], time: localTime(fs.statSync(p).mtimeMs), role: roleOf(f), kind: kindOf(f), preview: first.replace(/^[-*\s]+/, '') };
  });
  const entryCount = items.length;
  if (active && ROLES.includes(st.turn)) {
    items.push({
      live: true, seq: 'now', time: localTime((live ? live.epoch : turnStart(st)) * 1000), role: st.turn,
      kind: 'in progress', preview: live ? `⟳ ${live.text}` : '(no progress update yet)',
    });
  }
  if (view.follow || view.sel >= items.length) view.sel = entryCount - 1;
  if (view.follow && entryCount !== view.lastCount) view.scroll = 0;
  view.lastCount = entryCount;
  view.sel = Math.max(0, Math.min(view.sel, items.length - 1));

  // Timeline window around the selection
  const footerRows = 1;
  const budget = rows - lines.length - footerRows - 2; // rule + detail header
  const listH = Math.max(1, Math.min(items.length, Math.max(3, Math.floor(budget * 0.35))));
  const start = Math.max(0, Math.min(view.sel - Math.floor(listH / 2), items.length - listH));
  for (let i = start; i < start + listH; i++) {
    const it = items[i];
    const selected = i === view.sel;
    const prefix = selected ? '▶ ' : '  ';
    const parts = [
      [`${prefix}${it.seq.padEnd(4)}${it.time}  `, ''],
      [`${it.role.padEnd(12)}`, selected ? '' : roleColor(it.role)],
      [`${it.kind.padEnd(17)}`, ''],
      [it.preview, selected ? '' : D],
    ];
    const row = fitSegments(parts, cols, R);
    lines.push(selected && color ? `${INV}${row.replace(/\x1b\[[0-9;]*m/g, '')}${R}` : row);
  }
  lines.push(rule);

  // Detail pane for the selected step
  const it = items[view.sel];
  let body;
  let title;
  if (it.live) {
    const log = progressLines(d, st);
    title = `now · ${it.role} · in progress since ${localTime(turnStart(st) * 1000)}`;
    body = log.length
      ? log.map((p) => `${localTime(p.epoch * 1000)}  ${p.text}`)
      : ['(no progress updates yet — agents post one at each step with `collab progress`)'];
  } else {
    title = `#${it.seq} · ${it.role} · ${it.kind} · ${it.time}`;
    body = wrapText(fs.readFileSync(path.join(entriesDir(d), it.file), 'utf8'), Math.max(10, cols - 1));
  }
  const bodyH = Math.max(1, rows - lines.length - 1 - footerRows);
  const maxScroll = Math.max(0, body.length - bodyH);
  view.scroll = Math.max(0, Math.min(view.scroll, maxScroll));
  view.page = bodyH;
  const range = body.length > bodyH ? `  [${view.scroll + 1}-${Math.min(body.length, view.scroll + bodyH)}/${body.length}]` : '';
  lines.push(`${roleColor(it.role)}${B}${title}${R}${D}${range}${R}`);
  for (const l of body.slice(view.scroll, view.scroll + bodyH)) lines.push([...l].slice(0, cols).join(''));
  while (pad && lines.length < rows - footerRows) lines.push('');
  const flash = view.flash && view.flash.until > Date.now() ? `${G}${view.flash.text}${R}  ` : '';
  lines.push(keys
    ? `${flash}${D}↑↓ step · ←→ task · space/b scroll · g/G first/latest · f follow: ${view.follow ? 'on' : 'off'} · c copy id · q quit${R}`
    : `${D}steer: collab note "…"  ·  stop: collab abort${R}`);
  return lines.slice(0, rows).map((l) => clipAnsi(l, cols));
}

// Puts text on the system clipboard; falls back to OSC 52 (the terminal's clipboard, also over ssh).
function copyText(text) {
  const tools = process.platform === 'darwin' ? [['pbcopy']]
    : process.platform === 'win32' ? [['clip']]
      : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
  for (const [cmd, ...args] of tools) {
    const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000, windowsHide: true });
    if (!r.error && r.status === 0) return true;
  }
  if (!process.stdout.isTTY) return false;
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  return true;
}

async function cmdWatch(args) {
  const { opts } = takeOpts(args, { values: { '--interval': 'interval' }, flags: { '--once': { once: true } } });
  const interval = toSecs(opts.interval, 2);
  const view = { sel: 0, follow: true, scroll: 0, fileChange: 0, pinned: TASK_OVERRIDE || null };
  let fileChecked = 0;
  const refreshFileChange = () => {
    if (Date.now() - fileChecked < 5000) return;
    fileChecked = Date.now();
    const id = view.pinned || rawTaskId();
    try {
      const st = id && readState(path.join(TASKS, id));
      view.fileChange = st && !isTerminal(st.status) ? lastFileChange(st.project_dir) : 0;
    } catch { view.fileChange = 0; }
  };

  if (opts.once) {
    refreshFileChange();
    for (const l of renderWatch(view, process.stdout.columns || envInt('COLUMNS', 100), process.stdout.rows || envInt('LINES', 40), { color: !!process.stdout.isTTY, keys: false, pad: false })) out(l);
    return;
  }

  // Full-screen alternate buffer, redrawn in place (like top): no scrollback spam,
  // and the terminal is restored exactly as it was on exit.
  const interactive = !!process.stdin.isTTY;
  const draw = () => {
    const rows = process.stdout.rows || 40;
    const cols = process.stdout.columns || 100;
    let lines;
    try { lines = renderWatch(view, cols, rows, { color: !!process.stdout.isTTY, keys: interactive }); } catch (e) { lines = [`collab watch: ${e.message}`]; }
    process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
  };
  const quit = () => {
    if (interactive) { try { process.stdin.setRawMode(false); } catch { /* not a tty */ } }
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.stdout.on('resize', draw);

  if (interactive) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (str, key = {}) => {
      const k = key.name || str;
      if ((key.ctrl && k === 'c') || k === 'q' || k === 'escape') return quit();
      const page = Math.max(1, (view.page || 10) - 1);
      switch (k) {
        case 'up': case 'k': view.sel -= 1; view.follow = false; view.scroll = 0; break;
        case 'down': case 'j': view.sel += 1; view.follow = false; view.scroll = 0; break;
        case 'home': case 'g': view.sel = key.shift ? Infinity : 0; view.follow = !!key.shift; view.scroll = 0; break;
        case 'end': view.follow = true; view.scroll = 0; break;
        case 'left': case 'right': case 'h': case 'l': {
          // Switch between tasks of this project; reaching the newest one follows the current task again.
          const list = view.siblings || [];
          const i = list.indexOf(view.task);
          const j = i + (k === 'left' || k === 'h' ? -1 : 1);
          if (i < 0 || j < 0 || j >= list.length) return undefined;
          view.pinned = j === list.length - 1 && list[j] === rawTaskId() ? null : list[j];
          break;
        }
        case 'f': view.follow = !view.follow; view.scroll = 0; break;
        case 'c': if (view.task) view.flash = { text: `${copyText(view.task) ? 'copied' : 'could not copy'} ${view.task}`, until: Date.now() + 2500 }; break;
        case 'space': case 'pagedown': view.scroll += page; break;
        case 'b': case 'pageup': view.scroll -= page; break;
        default: return undefined;
      }
      if (str === 'G') { view.follow = true; view.scroll = 0; }
      return draw();
    });
  }

  for (;;) {
    refreshFileChange();
    draw();
    await sleep(interval * 1000);
  }
}

// --- help -------------------------------------------------------------------

function usage() {
  const tty = process.stdout.isTTY;
  const c = (code) => (tty ? `\x1b[${code}m` : '');
  const B = c(1), D = c(2), C = c(36), R = c(0);
  out(`${B}collab${R} — autonomous implementer ⇄ reviewer loop between two coding agents

${B}FOR YOU (the human)${R}
  ${C}watch${R} [--interval S]        Interactive dashboard: steps (↑↓), tasks (←→), live progress
  ${C}note${R} "text" [-i | -r]       Steer a running task (default: both agents;
                              -i/--implementer or -r/--reviewer for just one).
                              Agents: --from <role> (to the other agent, never
                              as the user). Each note must be acknowledged as
                              "Note #N" in its target's next handoff
  ${C}status${R}                      One-shot summary of the current task
  ${C}log${R}                         Full history: brief, summaries, reviews, notes
  ${C}show${R} [N]                    Print entry #N (default: the latest one)
  ${C}diff${R} [--stat] [--all]       What changed in the project since the task started
                              (lockfile patches omitted: --all shows them;
                              --since-review: only what changed since the last review)
  ${C}list${R}                        All tasks (* = current) with status and round
  ${C}abort${R}                       Stop the current task; both agents exit their loop
  ${C}answer${R} <N | text>           Answer a pending decision (option N, or your own words)
  ${C}queue${R}                       List queued tasks (* = this project)
  ${C}queue add${R} [options] "task"  Queue a task; the implementer starts it after the current one
  ${C}queue rm${R}|${C}move${R}|${C}clear${R}         Edit the queue: rm N, move N M, clear [--all]
  ${C}lessons${R} [add "…" | rm N]    Project lessons put into every new brief (agents add them too)
  ${C}phone${R} [set T|test|send]     Where --phone tasks push to (ntfy topic or URL); test; send (hooks)
  ${C}sound${R} [setup|test|set|pack…] Sounds and spoken updates at every step (on by default; 'collab
                              sound off' mutes; 'collab sound use …' changes the running task)
  ${C}snooze${R} [MIN]                Keep waiting on a slow agent (no idle prompt for MIN, default 30)
  ${C}clean${R} [--older-than D] [-n] Delete finished tasks and old drafts (asks first; -n dry run, -y no prompt)
  ${C}path${R}                        Folder holding the current task's files
  ${C}help${R}                        This screen

${B}TASK OPTIONS${R} ${D}(for queue add, init, or /collab implement …)${R}
  --plan                      Reviewer approves a plan before any code
  --check "npm test"          Must pass before every handoff (collab runs it)
  --scope "src/auth/**"       Files the task may change; collab diff flags the rest
  --focus "security"          What the reviewer should look at hardest
  --branch feat/x             Work on this branch
  --commit                    Commit when DONE (never pushes)
  --confirm                   Ask you before this queued task starts
  --phone                     Push to your phone when you're needed (see 'collab phone')
  --sound[=tones|off|full|elevenlabs]
                              Sound for this run (on by default): tones only, silent, full
                              sentences, or spoken by ElevenLabs
  --max-rounds N · --first    Round limit · put it at the front of the queue

${B}USED BY THE AGENTS${R} ${D}(the skill runs these for you)${R}
  ${C}init${R} <slug> [options] [--from-queue [--confirmed "answer"]]
                              Start a task (brief on stdin or --file)
  ${C}queue next${R} · ${C}queue skip${R}     Show / drop the next queued task for this project
  ${C}queue split${R} [--reason TEXT] Implementer: split the current task (parts on stdin, separated
                              by '=== part ===' lines); part 1 stays, the rest queue next
  ${C}check${R}                       Run the task's --check command
  ${C}verify${R}                      Implementer: is the tree still the approved one? (before a --commit commit)
  ${C}scratch${R}                     Folder for message drafts, notes and logs (the task's own, or
                              a shared drafts folder before 'init'); never write them in the project
  ${C}join${R} [--after ID] [--force]   Reviewer: wait until a task exists in this folder's project (or
                              the -t task), print its brief; with --after (the task it just
                              finished), stop when the run ends. Refused when the task already
                              has a live reviewer; --force takes over from a dead one
  ${C}end${R}                         Implementer: the whole request is done; ends the run for both
                              (final report on stdin or --file)
  ${C}wait${R} <implementer|reviewer> Block until it's that agent's turn (or the task ends)
                              join and wait take --timeout SECS (default 540) and --attempt N
                              (no effect; agents raise it on each retry so loop guards don't fire)
  ${C}progress${R} "text"             Post what you're doing now (shown to the other side)
  ${C}submit${R} implementer <plan|ready|decide|escalate>
  ${C}submit${R} reviewer <changes|approve|decide|escalate> [--rereviewed]
                              Hand off the turn (message on stdin or --file PATH); decide asks
                              the user to pick a numbered option (--self: I ask them myself)

${B}START A SESSION${R}
  Claude Code:  /collab implement   ·  /collab review     ${D}(add --plan to plan first)${R}
  Codex:        $collab implement   ·  $collab review
  OpenCode:     "use the collab skill to implement …"  ·  "… to review task <id>"

${D}Options: -t <task-id> targets another task · state lives in ~/.collab/tasks/
Exit codes: 0 ok · 10 finished · 11 wait timed out · 12 note not acknowledged · 13 other agent idle · 14 check failed · 15 queue empty · 16 decision for the user · 17 tree changed since review/approval · 1 error${R}`);
}

// --- main -------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit, join: cmdJoin, wait: cmdWait, submit: cmdSubmit, note: cmdNote,
  snooze: cmdSnooze, progress: cmdProgress, queue: cmdQueue, check: cmdCheck, clean: cmdClean, watch: cmdWatch, diff: cmdDiff, verify: cmdVerify, status: cmdStatus,
  show: cmdShow, list: cmdList, abort: cmdAbort, end: cmdEnd, answer: cmdAnswer, scratch: cmdScratch,
  lessons: cmdLessons, phone: cmdPhone, sound: cmdSound,
  log: () => process.stdout.write(fs.readFileSync(path.join(taskDir(), 'log.md'), 'utf8')),
  path: () => out(taskDir()),
};

async function main(argv) {
  let args = argv;
  if (args[0] === '-t') {
    if (!args[1]) die('-t needs a task id');
    TASK_OVERRIDE = args[1];
    args = args.slice(2);
  }
  const [cmd = 'help', ...rest] = args;
  if (['help', '-h', '--help'].includes(cmd)) return usage();
  const fn = COMMANDS[cmd];
  if (!fn) { usage(); exit(1); }
  return fn(rest);
}

// A reader that closes the pipe early (e.g. `collab log | head`) is not an error.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode || 0);
  throw e;
});

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ExitCode) {
    process.exitCode = e.code;
  } else if (e instanceof CollabError) {
    process.stderr.write(`collab: ${e.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`collab: unexpected error: ${e.stack || e}\n`);
    process.exitCode = 1;
  }
});
