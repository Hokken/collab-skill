#!/usr/bin/env node
// collab — turn-based implementer/reviewer handoff between two coding agents
// (e.g. Claude Code and Codex CLI) through a shared state folder in ~/.collab.
//
// Exit codes: 0 ok / your turn, 1 error, 10 task finished (DONE, ESCALATED,
// ABORTED, STALLED), 11 wait timed out (not your turn yet — just run it again),
// 12 submit refused because the user added a note during your turn,
// 13 the other agent looks unresponsive — ask the user whether to stop or keep waiting.
//
// Zero dependencies; runs on macOS, Linux and Windows (Node >= 18).
'use strict';

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
const POLL = envInt('COLLAB_POLL_SECS', 5);
const STALL = envInt('COLLAB_STALL_SECS', 7200);       // 2 h without a handoff => STALLED
const IDLE = envInt('COLLAB_IDLE_SECS', 1800);         // 30 min without a handoff => ask the user
const QUIET_MINS = envInt('COLLAB_QUIET_MINS', 10);    // ...and no project file changed for this long
const DEFAULT_MAX_ROUNDS = envInt('COLLAB_MAX_ROUNDS', 4);

const EXIT_TERMINAL = 10;
const EXIT_TIMEOUT = 11;
const EXIT_NOTES = 12;
const EXIT_IDLE = 13;

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

function notify(msg) {
  process.stderr.write('\x07');
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
    run('osascript', ['-e', `display notification "${m}" with title "collab" sound name "Glass"`]);
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

// --- task / state helpers ------------------------------------------------------

function currentId() {
  try { return fs.readFileSync(path.join(COLLAB_HOME, 'current'), 'utf8').trim(); } catch { return ''; }
}

const rawTaskId = () => TASK_OVERRIDE || process.env.COLLAB_TASK || currentId();

function taskDir() {
  const id = rawTaskId();
  if (!id) die('no current task (implementer runs: collab init)');
  const d = path.join(TASKS, id);
  if (!fs.existsSync(d)) die(`task not found: ${id}`);
  return d;
}

const statePath = (d) => path.join(d, 'state.json');
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
  if (touch) {
    st.updated_at = nowIso();
    st.updated_epoch = epoch();
  }
  writeState(d, st);
  return st;
}

function withLock(d, fn) {
  const l = path.join(d, '.lock');
  let start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(l);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 10000) {
        process.stderr.write(`collab: breaking stale lock ${l}\n`);
        try { fs.rmdirSync(l); } catch { /* someone else did */ }
        start = Date.now();
      } else {
        sleepSync(100);
      }
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(l); } catch { /* already gone */ }
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
    `\n---\n## #${pad3(st.seq)} · ${role} · ${kind} · round ${st.round} · ${nowIso()}\n\n${body}\n`);
}

function printEntry(d, name) {
  if (name.includes('-human-note-')) {
    out('!!! HUMAN NOTE — from the user, takes priority over the brief and the other agent !!!');
  }
  out(`----- ${name} -----`);
  process.stdout.write(fs.readFileSync(path.join(entriesDir(d), name), 'utf8'));
  out();
  out('----- end -----');
}

// Human notes for <role> it has not been shown yet.
function pendingNotes(d, st, role) {
  const seen = st.seen && Number.isInteger(st.seen[role]) ? st.seen[role] : -1;
  const re = new RegExp(`-human-note-(all|${role})\\.md$`);
  return entriesAfter(d, seen).filter((f) => re.test(f));
}

function markSeen(st, role) {
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

// --- git snapshot helpers -----------------------------------------------------

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat' },
  });
  return { ok: r.status === 0, out: r.stdout || '' };
}

function findRepos(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.ok && top.out.trim()) return [path.resolve(top.out.trim())];
  const repos = [];
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === 'node_modules') continue;
      if (it.name === '.git') { repos.push(dir); continue; }
      if (it.isDirectory() && depth < 3) walk(path.join(dir, it.name), depth + 1);
    }
  };
  walk(root, 1);
  return repos.sort();
}

const untrackedFiles = (repo) =>
  git(repo, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);

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

// Last sign of life from the agent whose turn it is: a handoff/update or a progress post.
const lastActivity = (st) => Math.max(st.updated_epoch, (liveProgress(st) || {}).epoch || 0);

// Why the agent whose turn it is looks unresponsive, or ''.
function idleReason(st) {
  const now = epoch();
  const since = now - lastActivity(st);
  if (since < IDLE || now < (st.snooze_until || 0)) return '';
  if (st.turn === 'implementer' && recentChanges(st.project_dir)) return '';
  let why = `the ${st.turn} has not handed off for ${Math.floor((now - st.updated_epoch) / 60)} min`;
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

// --- argument parsing ------------------------------------------------------------

// Pulls "--name value" / "--flag" options out of args; returns remaining positionals.
function takeOpts(args, { values = {}, flags = {} } = {}, { strict = false } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a in values) {
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

const timeoutOpt = { values: { '--timeout': 'timeout' } };
const toSecs = (v, def) => {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) die(`invalid number: ${v}`);
  return parseInt(v, 10);
};

// --- commands ------------------------------------------------------------------

function cmdInit(args) {
  const { opts, rest } = takeOpts(args, {
    values: { '--max-rounds': 'max', '--dir': 'dir', '--file': 'file', '-f': 'file' },
    flags: { '--force': { force: true }, '--plan': { plan: true } },
  }, { strict: true });
  const usage = "usage: collab init <slug> [--plan] [--max-rounds N] [--dir PATH] [--force] (brief on stdin or --file PATH)";
  if (!rest[0]) die(usage);
  const slug = rest[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) die(usage);
  const max = toSecs(opts.max, DEFAULT_MAX_ROUNDS);
  const dir = path.resolve(opts.dir || process.cwd());
  if (!fs.existsSync(dir)) die(`no such directory: ${dir}`);

  const cur = currentId();
  if (cur && fs.existsSync(statePath(path.join(TASKS, cur))) && !opts.force) {
    const st = readState(path.join(TASKS, cur));
    if (!isTerminal(st.status)) die(`task '${cur}' is still active (${st.status}). Finish/abort it or pass --force.`);
  }

  const brief = readBody(opts.file);
  const id = `${slug}-${localStamp()}`;
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
    fs.writeFileSync(path.join(d, 'untracked', `${repos.length}.txt`), list.length ? `${list.join('\n')}\n` : '');
    repos.push({ index: repos.length, path: r, base });
  }

  const plan = !!opts.plan;
  const now = nowIso();
  const ep = epoch();
  const st = {
    id, project_dir: dir, repos,
    phase: plan ? 'plan' : 'build', status: plan ? 'PLANNING' : 'IMPLEMENTING',
    turn: 'implementer', round: 1, plan_round: 1, max_rounds: max, seq: 0,
    seen: { implementer: 0, reviewer: -1 },
    created_at: now, created_epoch: ep, updated_at: now, updated_epoch: ep, updated_by: 'implementer',
    turn_since: ep,
  };
  fs.writeFileSync(path.join(d, 'log.md'), `# collab task: ${id}\nproject: ${dir}\n`);
  addEntry(d, st, 'implementer', 'brief', brief);
  st.seq = 1;
  writeState(d, st);
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  fs.writeFileSync(path.join(COLLAB_HOME, 'current'), `${id}\n`);

  out(`task:    ${id}`);
  out(`project: ${dir}`);
  out(`repos snapshotted: ${repos.length}`);
  out(`max rounds: ${max}`);
  out(`phase:   ${st.phase}`);
  out(`state:   ${d}`);
  if (plan) out("Next: write a plan (no code yet), then 'collab submit implementer plan' with it on stdin.");
  else out("Next: implement, then 'collab submit implementer ready' with your summary on stdin.");
}

async function cmdJoin(args) {
  const { opts } = takeOpts(args, timeoutOpt);
  const timeout = toSecs(opts.timeout, 540);
  const start = epoch();
  for (;;) {
    const id = rawTaskId();
    const d = id && path.join(TASKS, id);
    if (d && fs.existsSync(statePath(d))) {
      const st = readState(d);
      if (!isTerminal(st.status)) {
        out(`joined task: ${id}`);
        out(`project:     ${st.project_dir}`);
        out(`status:      ${st.status} (turn: ${st.turn}, round ${st.round}/${st.max_rounds})`);
        printEntry(d, listEntries(d)[0]);
        return;
      }
    }
    if (epoch() - start >= timeout) {
      out("no active task yet — run 'collab join' again");
      exit(EXIT_TIMEOUT);
    }
    await sleep(POLL * 1000);
  }
}

async function cmdWait(args) {
  const { opts, rest } = takeOpts(args, timeoutOpt);
  const role = rest[0];
  if (!ROLES.includes(role)) die('usage: collab wait <implementer|reviewer> [--timeout SECS]');
  const other = role === 'implementer' ? 'reviewer' : 'implementer';
  const timeout = toSecs(opts.timeout, 540);
  const start = epoch();
  const d = taskDir();
  for (;;) {
    const st = readState(d);
    if (isTerminal(st.status)) {
      out(`TASK FINISHED: ${st.status} (round ${st.round})`);
      printEntry(d, latestEntry(d));
      exit(EXIT_TERMINAL);
    }
    if (st.turn === role) {
      // Everything since my last own entry: the other agent's message plus any human notes.
      // Mark it seen before printing, so a reader that closes the pipe early can't lose that.
      const mine = listEntries(d).filter((f) => roleOf(f) === role).slice(-1)[0];
      let fresh = entriesAfter(d, mine ? seqOf(mine) : -1).filter((f) => !f.endsWith(`-human-note-${other}.md`));
      if (!fresh.length) fresh = [latestEntry(d)];
      withLock(d, () => update(d, (s) => markSeen(s, role)));
      out(`YOUR TURN (${role}) — status: ${st.status}, round ${st.round}/${st.max_rounds}`);
      out(`project: ${st.project_dir}`);
      for (const f of fresh) printEntry(d, f);
      return;
    }
    const idle = idleReason(st);
    if (idle) {
      notify(`${st.id}: ${idle} — stop or keep waiting?`);
      out(`OTHER AGENT LOOKS UNRESPONSIVE: ${idle}.`);
      out("Ask the user: stop the task ('collab abort') or keep waiting ('collab snooze [MIN]', default 30)?");
      exit(EXIT_IDLE);
    }
    if (epoch() - lastActivity(st) >= STALL && epoch() >= (st.snooze_until || 0)) {
      withLock(d, () => update(d, (s) => { s.status = 'STALLED'; s.turn = 'none'; s.updated_by = 'collab'; }));
      notify(`${st.id}: STALLED (no handoff for ${Math.floor(STALL / 60)} min)`);
      out(`TASK FINISHED: STALLED — the other agent has not handed off for ${Math.floor(STALL / 60)} min`);
      exit(EXIT_TERMINAL);
    }
    if (epoch() - start >= timeout) {
      const p = liveProgress(st);
      const info = p
        ? `latest ${st.turn} progress: "${p.text}" (${fmtDur(epoch() - p.epoch)} ago)`
        : `no progress update from the ${st.turn} yet (turn started ${fmtDur(epoch() - turnStart(st))} ago)`;
      out(`still waiting — status: ${st.status}, turn: ${st.turn}; ${info}. Run 'collab wait ${role}' again.`);
      exit(EXIT_TIMEOUT);
    }
    await sleep(POLL * 1000);
  }
}

function transition(st, role, kind) {
  const phase = st.phase || 'build';
  const max = st.max_rounds;
  const bad = `invalid: '${role} ${kind}' in ${phase} phase`;
  const escalate = (why) => ({ apply: (s) => { s.status = 'ESCALATED'; s.turn = 'none'; }, note: why });
  switch (`${phase}:${role}:${kind}`) {
    case 'plan:implementer:plan':
      return { apply: (s) => { s.status = 'PLAN_REVIEW'; s.turn = 'reviewer'; } };
    case 'plan:reviewer:approve':
      return { apply: (s) => { s.phase = 'build'; s.status = 'IMPLEMENTING'; s.turn = 'implementer'; s.round = 1; } };
    case 'plan:reviewer:changes':
      if ((st.plan_round || 1) + 1 > max) return escalate(`max plan rounds (${max}) reached`);
      return { apply: (s) => { s.status = 'PLAN_CHANGES'; s.turn = 'implementer'; s.plan_round = (s.plan_round || 1) + 1; } };
    case 'build:implementer:ready':
      return { apply: (s) => { s.status = 'READY_FOR_REVIEW'; s.turn = 'reviewer'; } };
    case 'build:reviewer:changes':
      if (st.round + 1 > max) return escalate(`max rounds (${max}) reached`);
      return { apply: (s) => { s.status = 'CHANGES_REQUESTED'; s.turn = 'implementer'; s.round += 1; } };
    case 'build:reviewer:approve':
      return { apply: (s) => { s.status = 'DONE'; s.turn = 'none'; } };
    case 'plan:implementer:ready':
      return die(`${bad} — submit your plan with 'collab submit implementer plan' first`);
    default:
      if (ROLES.includes(role) && kind === 'escalate') return escalate('');
      return die(`${bad} (plan phase: implementer plan|escalate, reviewer changes|approve|escalate; build phase: implementer ready|escalate, reviewer changes|approve|escalate)`);
  }
}

function cmdSubmit(args) {
  const { opts, rest } = takeOpts(args, { values: { '--file': 'file', '-f': 'file' } });
  const [role, kind] = rest;
  const d = taskDir();
  let body = readBody(opts.file);

  const result = withLock(d, () => {
    const st = readState(d);
    if (isTerminal(st.status)) die(`task already finished (${st.status})`);
    if (kind !== 'escalate' && st.turn !== role) die(`not your turn (${role}); current turn: ${st.turn}, status: ${st.status}`);

    // A note the user added during this turn must be handled before handing off.
    if (kind !== 'escalate') {
      const pending = pendingNotes(d, st, role);
      if (pending.length) {
        update(d, (s) => markSeen(s, role));
        return { pending };
      }
    }

    const t = transition(st, role, kind);
    if (t.note) body += `\n\n> collab: ${t.note} — escalated to the human.\n`;
    addEntry(d, st, role, kind, body);
    return {
      st: update(d, (s) => { t.apply(s); s.seq += 1; s.updated_by = role; s.turn_since = epoch(); }),
    };
  });

  if (result.pending) {
    out('NOT SUBMITTED: the user added note(s) during your turn. Address them, then submit again with your full, updated message.');
    for (const f of result.pending) printEntry(d, f);
    exit(EXIT_NOTES);
  }
  const st = result.st;
  out(`submitted: ${role} ${kind} -> ${st.status} (turn: ${st.turn}, round ${st.round}/${st.max_rounds})`);
  notify(`${st.id}: ${st.status}`);
  if (isTerminal(st.status)) exit(EXIT_TERMINAL);
}

function cmdNote(args) {
  const { opts, rest } = takeOpts(args, {
    values: { '--to': 'to', '--file': 'file', '-f': 'file' },
    flags: { '--implementer': { to: 'implementer' }, '-i': { to: 'implementer' }, '--reviewer': { to: 'reviewer' }, '-r': { to: 'reviewer' } },
  });
  const to = opts.to || 'all';
  if (!['all', ...ROLES].includes(to)) die('--to must be implementer or reviewer');
  const d = taskDir();
  const text = rest.join(' ');
  const body = text && !opts.file ? `${text}\n` : readBody(opts.file);

  const res = withLock(d, () => {
    const st = readState(d);
    if (isTerminal(st.status)) die(`task already finished (${st.status}) — start a new task instead`);
    const seq = st.seq;
    addEntry(d, st, 'human', `note-${to}`, body);
    const nst = update(d, (s) => { s.seq += 1; s.updated_by = 'human'; });
    return { seq, turn: nst.turn };
  });
  out(`note #${res.seq} added for ${to} (turn: ${res.turn}). It is delivered at that agent's next turn start, or blocks its next handoff until handled.`);
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
    fs.appendFileSync(path.join(d, 'progress.log'), `${JSON.stringify(p)}\n`);
    // Notes that arrived mid-turn are handed over right away instead of at the next submit.
    const pending = pendingNotes(d, st, st.turn);
    update(d, (s) => { s.progress = p; if (pending.length) markSeen(s, st.turn); }, { touch: false });
    return { p, pending };
  });
  out(`progress (${res.p.role}): ${res.p.text}`);
  if (res.pending.length) {
    out('The user added note(s) during your turn. Handle them before you hand off:');
    for (const f of res.pending) printEntry(d, f);
  }
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
  if (!victims.length) { out(`nothing to clean (${active} active task(s) kept)`); return; }
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
  out(`deleted ${victims.length} task(s)`);
}

function cmdDiff(args) {
  const stat = args[0] === '--stat';
  const d = taskDir();
  const st = readState(d);
  if (!st.repos || !st.repos.length) {
    out(`No git repos in ${st.project_dir} — rely on the file list in the implementer's summary.`);
    return;
  }
  for (const [i, r] of st.repos.entries()) {
    const idx = Number.isInteger(r.index) ? r.index : i;
    const changed = git(r.path, ['diff', '--stat', r.base]).out.replace(/\n+$/, '');
    let before = [];
    try { before = fs.readFileSync(path.join(d, 'untracked', `${idx}.txt`), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
    const known = new Set(before);
    const fresh = untrackedFiles(r.path).filter((f) => !known.has(f)).sort();
    if (!changed && !fresh.length) continue;
    out(`=== ${r.path} (since ${r.base.slice(0, 10)})`);
    if (changed) out(changed);
    if (fresh.length) {
      out('new untracked files:');
      for (const f of fresh) out(`  ${f}`);
    }
    if (!stat) {
      process.stdout.write(git(r.path, ['--no-pager', 'diff', r.base]).out);
      for (const f of fresh) {
        out(`+++ new file: ${f}`);
        try {
          const head = fs.readFileSync(path.join(r.path, f), 'utf8').split('\n').slice(0, 400).join('\n');
          process.stdout.write(!head || head.endsWith('\n') ? head : `${head}\n`);
        } catch { out('(unreadable)'); }
      }
    }
    out();
  }
}

function cmdStatus() {
  const d = taskDir();
  const st = readState(d);
  out(`task:    ${st.id}`);
  out(`project: ${st.project_dir}`);
  out(`status:  ${st.status}`);
  out(`turn:    ${st.turn}`);
  out(`round:   ${st.round}/${st.max_rounds}`);
  out(`updated: ${st.updated_at} by ${st.updated_by}`);
  out(`latest:  ${latestEntry(d)}`);
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
    out(`${id === cur ? '*' : ' '} ${st.id}  ${st.status}  round ${st.round}/${st.max_rounds}  ${st.project_dir}`);
  }
}

function cmdAbort() {
  const d = taskDir();
  const st = withLock(d, () => update(d, (s) => { s.status = 'ABORTED'; s.turn = 'none'; s.updated_by = 'human'; }));
  out(`aborted ${st.id}`);
}

// --- watch ------------------------------------------------------------------

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

function wrapText(text, width) {
  const lines = [];
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const chars = [...line.replace(/\t/g, '  ')];
    if (!chars.length) { lines.push(''); continue; }
    for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''));
  }
  return lines;
}

// One frame of `collab watch`. view = { sel, follow, scroll, fileChange } (mutated to keep
// selection and scroll in range); returns the lines to draw.
function renderWatch(view, cols, rows, { color = true, keys = true, pad = true } = {}) {
  const c = (code) => (color ? `\x1b[${code}m` : '');
  const B = c(1), D = c(2), R = c(0), G = c(32), Y = c(33), RD = c(31), CY = c(36), MG = c(35), INV = c(7);
  const roleColor = (r) => (r === 'implementer' ? CY : r === 'reviewer' ? MG : Y);
  const id = rawTaskId();
  const d = id && path.join(TASKS, id);
  if (!d || !fs.existsSync(statePath(d))) return [`${B}collab watch${R} — no task yet, waiting for 'collab init'…`];
  if (view.task !== id) Object.assign(view, { task: id, sel: 0, follow: true, scroll: 0, lastCount: 0 });

  const st = readState(d);
  const now = epoch();
  const created = st.created_epoch || Math.floor(fs.statSync(d).birthtimeMs / 1000);
  const active = !isTerminal(st.status);
  let sc = CY;
  if (st.status === 'DONE') sc = G;
  else if (['ESCALATED', 'STALLED', 'ABORTED'].includes(st.status)) sc = RD;
  else if (['CHANGES_REQUESTED', 'PLAN_CHANGES'].includes(st.status)) sc = Y;

  // Header
  const lines = [];
  lines.push(`${B}collab watch${R}  ${st.id}  ${sc}${B}${st.status}${R}  round ${st.round}/${st.max_rounds}  ${D}total ${fmtDur(now - created)} · ${localTime(Date.now())}${R}`);
  lines.push(`${D}project${R} ${st.project_dir}`);
  const live = active ? liveProgress(st) : null;
  if (active) {
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
    lines.push(`${D}finished${R}`);
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
  if (active) {
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
  lines.push(keys
    ? `${D}↑↓/jk step · space/b scroll · g/G first/latest · f follow: ${view.follow ? 'on' : 'off'} · q quit${R}`
    : `${D}steer: collab note "…"  ·  stop: collab abort${R}`);
  return lines.slice(0, rows);
}

async function cmdWatch(args) {
  const { opts } = takeOpts(args, { values: { '--interval': 'interval' }, flags: { '--once': { once: true } } });
  const interval = toSecs(opts.interval, 2);
  const view = { sel: 0, follow: true, scroll: 0, fileChange: 0 };
  let fileChecked = 0;
  const refreshFileChange = () => {
    if (Date.now() - fileChecked < 5000) return;
    fileChecked = Date.now();
    const id = rawTaskId();
    try {
      const st = id && readState(path.join(TASKS, id));
      view.fileChange = st && !isTerminal(st.status) ? lastFileChange(st.project_dir) : 0;
    } catch { view.fileChange = 0; }
  };

  if (opts.once) {
    refreshFileChange();
    for (const l of renderWatch(view, process.stdout.columns || 100, process.stdout.rows || 40, { color: !!process.stdout.isTTY, keys: false, pad: false })) out(l);
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
        case 'f': view.follow = !view.follow; view.scroll = 0; break;
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
  ${C}watch${R} [--interval S]        Interactive dashboard: browse every step (↑↓), live progress
  ${C}note${R} "text" [-i | -r]      Steer a running task (default: both agents;
                              -i/--implementer or -r/--reviewer for just one)
  ${C}status${R}                      One-shot summary of the current task
  ${C}log${R}                         Full history: brief, summaries, reviews, notes
  ${C}show${R} [N]                    Print entry #N (default: the latest one)
  ${C}diff${R} [--stat]               What changed in the project since the task started
  ${C}list${R}                        All tasks (* = current) with status and round
  ${C}abort${R}                       Stop the current task; both agents exit their loop
  ${C}snooze${R} [MIN]                Keep waiting on a slow agent (no idle prompt for MIN, default 30)
  ${C}clean${R} [--older-than D] [-n] Delete finished tasks (asks first; -n = dry run, -y = no prompt)
  ${C}path${R}                        Folder holding the current task's files
  ${C}help${R}                        This screen

${B}USED BY THE AGENTS${R} ${D}(the skill runs these for you)${R}
  ${C}init${R} <slug> [--plan] [--max-rounds N]
                              Start a task (brief on stdin or --file); --plan = plan approved first
  ${C}join${R}                        Reviewer: wait until a task exists, print its brief
  ${C}wait${R} <implementer|reviewer> Block until it's that agent's turn (or the task ends)
  ${C}progress${R} "text"             Post what you're doing now (shown to the other side)
  ${C}submit${R} implementer <plan|ready|escalate>
  ${C}submit${R} reviewer <changes|approve|escalate>
                              Hand off the turn (message on stdin or --file PATH)

${B}START A SESSION${R}
  Claude Code:  /Collab implement   ·  /Collab review     ${D}(add --plan to plan first)${R}
  Codex:        $Collab implement   ·  $Collab review

${D}Options: -t <task-id> targets another task · state lives in ~/.collab/tasks/
Exit codes: 0 ok · 10 finished · 11 wait timed out (re-run) · 12 new note · 13 other agent idle · 1 error${R}`);
}

// --- main -------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit, join: cmdJoin, wait: cmdWait, submit: cmdSubmit, note: cmdNote,
  snooze: cmdSnooze, progress: cmdProgress, clean: cmdClean, watch: cmdWatch, diff: cmdDiff, status: cmdStatus,
  show: cmdShow, list: cmdList, abort: cmdAbort,
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
