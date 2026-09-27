#!/usr/bin/env node
// collab — turn-based implementer/reviewer handoff between two coding agents
// (e.g. Claude Code and Codex CLI) through a shared state folder in ~/.collab.
//
// Exit codes: 0 ok / your turn, 1 error, 10 task finished (DONE, ESCALATED,
// ABORTED, STALLED), 11 wait timed out (not your turn yet — just run it again),
// 12 submit refused because the user added a note during your turn,
// 13 the other agent looks unresponsive — ask the user whether to stop or keep waiting,
// 14 submit refused because the task's --check command failed, 15 the queue is empty.
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
const CHECK_TIMEOUT = envInt('COLLAB_CHECK_TIMEOUT', 1800); // --check commands time out after 30 min
const LOCK_WAIT = envInt('COLLAB_LOCK_SECS', 10);      // wait this long before checking a lock's owner (tests lower it)

const EXIT_TERMINAL = 10;
const EXIT_TIMEOUT = 11;
const EXIT_NOTES = 12;
const EXIT_IDLE = 13;
const EXIT_CHECK = 14;
const EXIT_EMPTY = 15;

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

// Default task: the newest one for the project folder we're in, else the most recent one anywhere.
// So two pairs working in different projects never pick up each other's task.
const projectTaskId = () => projectTasks(process.cwd()).slice(-1)[0] || '';
const rawTaskId = () => TASK_OVERRIDE || process.env.COLLAB_TASK || projectTaskId() || currentId();

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

// The lock is a directory holding an 'owner' file ("<pid> <token>"). Locks are held for
// milliseconds, so one still there after LOCK_WAIT is stale only if its owner process is gone.
const lockOwner = (l) => { try { return fs.readFileSync(path.join(l, 'owner'), 'utf8').trim(); } catch { return ''; } };

function ownerAlive(owner) {
  const pid = parseInt(owner, 10);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
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

// --- task options -------------------------------------------------------------

// Per-task options, accepted by `init` and `queue add`.
const TASK_OPTS = {
  values: { '--max-rounds': 'max_rounds', '--check': 'check', '--scope': 'scope', '--focus': 'focus', '--branch': 'branch' },
  flags: { '--plan': { plan: true }, '--commit': { commit: true }, '--confirm': { confirm: true } },
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

// --- queue ------------------------------------------------------------------------

const queuePath = () => path.join(COLLAB_HOME, 'queue.json');

function readQueue() {
  if (!fs.existsSync(queuePath())) return { next_id: 1, items: [] };
  const q = retry(() => JSON.parse(fs.readFileSync(queuePath(), 'utf8')));
  return { next_id: q.next_id || 1, items: q.items || [] };
}

// Read-modify-write the queue under a lock on COLLAB_HOME.
function withQueue(fn) {
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  return withLock(COLLAB_HOME, () => {
    const q = readQueue();
    const res = fn(q);
    const tmp = `${queuePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`);
    retry(() => fs.renameSync(tmp, queuePath()));
    return res;
  });
}

const forProject = (q, dir) => q.items.filter((it) => it.project_dir === realDir(dir));
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

function queueLine(dir) {
  const n = queueCount(dir);
  return n ? `QUEUE: ${n} more task(s) waiting for this project. Implementer: start the next one ('collab queue next'). Reviewer: run 'collab join' to wait for it.` : '';
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
      resolve({ ok: !why, cmd, secs, why, tail });
    };
    child.on('error', (e) => { error = e; finish(); });
    // 'close' waits for the output pipes; a background process that keeps them open
    // must not hang the handoff, so give up on them shortly after the shell exits.
    child.on('exit', (c) => { code = c; grace = setTimeout(finish, 2000); });
    child.on('close', (c) => { if (code === null) code = c; finish(); });
  });
}

function printCheck(res) {
  if (res.ok) {
    out(`CHECK PASSED: \`${res.cmd}\` (${res.secs}s)`);
    return;
  }
  out(`CHECK FAILED: \`${res.cmd}\` — ${res.why} (${res.secs}s). Last lines of output:`);
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
    values: { ...TASK_OPTS.values, '--dir': 'dir', '--file': 'file', '-f': 'file', '--confirmed': 'confirmed' },
    flags: { ...TASK_OPTS.flags, '--force': { force: true }, '--from-queue': { fromQueue: true } },
  }, { strict: true });
  const usage = "usage: collab init <slug> [--from-queue] [--plan] [--max-rounds N] [--check CMD] [--scope GLOBS] [--focus TEXT] [--branch NAME] [--commit] [--dir PATH] [--force] (brief on stdin or --file PATH)";
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
      const i = q.items.findIndex((it) => it.project_dir === realDir(dir));
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
  const max = options.max_rounds || DEFAULT_MAX_ROUNDS;
  brief += optionsSection(options);
  const part = item && item.part;
  if (part) {
    brief += `\n## Part of a split task (set by collab)\nThis is ${partLabel(part)}, split up by the implementer. `
      + 'Only this part is in scope. The other parts are separate tasks with their own reviews, so work they will do is not missing here.\n';
  }

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

  const plan = !!options.plan;
  const now = nowIso();
  const ep = epoch();
  const st = {
    id, project_dir: dir, repos,
    phase: plan ? 'plan' : 'build', status: plan ? 'PLANNING' : 'IMPLEMENTING',
    turn: 'implementer', round: 1, plan_round: 1, max_rounds: max, seq: 0,
    seen: { implementer: 0, reviewer: -1 },
    created_at: now, created_epoch: ep, updated_at: now, updated_epoch: ep, updated_by: 'implementer',
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
  writeState(d, st);
  fs.mkdirSync(COLLAB_HOME, { recursive: true });
  fs.writeFileSync(path.join(COLLAB_HOME, 'current'), `${id}\n`);

  out(`task:    ${id}`);
  out(`project: ${dir}`);
  out(`repos snapshotted: ${repos.length}`);
  out(`max rounds: ${max}`);
  out(`phase:   ${st.phase}`);
  if (describeOpts(options).length) out(`options: ${describeOpts(options).join(' · ')}`);
  if (item) out(`from queue: #${item.id}${part ? ` (${partLabel(part)})` : ''} (${queueCount(dir)} more waiting for this project)`);
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
      out(`no active task yet (waited ${fmtDur(epoch() - start)}). This is normal: the implementer may still be writing the brief.`);
      out("Run 'collab join' again right away. Keep waiting; don't end your turn.");
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
      if (st.status === 'DONE' && queueLine(st.project_dir)) out(queueLine(st.project_dir));
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
      holdParts(withLock(d, () => update(d, (s) => { s.status = 'STALLED'; s.turn = 'none'; s.updated_by = 'collab'; })));
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

async function cmdSubmit(args) {
  const { opts, rest } = takeOpts(args, { values: { '--file': 'file', '-f': 'file' } });
  const [role, kind] = rest;
  const d = taskDir();
  let body = readBody(opts.file);

  // The task's --check must pass before the implementer hands off its work.
  const pre = readState(d);
  if (role === 'implementer' && kind === 'ready' && (pre.phase || 'build') === 'build' && pre.turn === role
      && !isTerminal(pre.status) && pre.options && pre.options.check) {
    const res = await runCheck(pre);
    if (!res.ok) {
      out('NOT SUBMITTED: the task check failed. Fix it and submit again (or escalate if it cannot pass).');
      printCheck(res);
      exit(EXIT_CHECK);
    }
    body += `\n\n> collab: check passed: \`${res.cmd}\` (${res.secs}s)\n`;
  }

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
  holdParts(st);
  if (st.status === 'DONE' && queueLine(st.project_dir)) out(queueLine(st.project_dir));
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

async function cmdCheck() {
  const d = taskDir();
  const st = readState(d);
  if (!st.options || !st.options.check) {
    out('This task has no check command (add one with --check "…" on init or queue add).');
    return;
  }
  const res = await runCheck(st);
  printCheck(res);
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
    q.items.forEach((it, i) => out(`${it.project_dir === here ? '*' : ' '} ${String(i + 1).padStart(2)}. ${show(it)}`));
    out('(* = this project; the implementer takes the first task for its own project)');
    return;
  }

  if (sub === 'add') {
    const { opts, rest: words } = takeOpts(rest, {
      values: { ...TASK_OPTS.values, '--dir': 'dir', '--file': 'file', '-f': 'file' },
      flags: { ...TASK_OPTS.flags, '--first': { first: true } },
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
    if (it.options && it.options.confirm) out('CONFIRM FIRST: ask the user before starting this task (start / skip / stop).');
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
      const i = q.items.findIndex((x) => x.project_dir === realDir(dir));
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
        const at = q.items.findIndex((it) => it.project_dir === dir);
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
      update(d, (s) => { s.seq += 1; s.part = { index: 1, total, parent: st.id }; s.updated_by = 'implementer'; });
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
      q.items = opts.all ? [] : q.items.filter((it) => it.project_dir !== here);
      return before - q.items.length;
    });
    out(`removed ${n} task(s) ${opts.all ? 'from the queue' : `for ${path.basename(here)}`}`);
    return;
  }

  die('usage: collab queue [list | add [options] "task" | next | skip | split [--reason TEXT] | rm N | move N M | clear [--all]]');
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
  const touched = [];
  for (const [i, r] of st.repos.entries()) {
    const idx = Number.isInteger(r.index) ? r.index : i;
    const changed = git(r.path, ['diff', '--stat', r.base]).out.replace(/\n+$/, '');
    let before = [];
    try { before = fs.readFileSync(path.join(d, 'untracked', `${idx}.txt`), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
    const known = new Set(before);
    const fresh = untrackedFiles(r.path).filter((f) => !known.has(f)).sort();
    // Compare canonical paths: on Windows git and Node can spell the same folder differently
    // (8.3 short names like RUNNER~1, or different letter case).
    const rel = (f) => path.relative(realDir(st.project_dir), path.join(realDir(r.path), f)).split(path.sep).join('/');
    for (const f of git(r.path, ['diff', '--name-only', r.base]).out.split('\n').filter(Boolean)) touched.push(rel(f));
    for (const f of fresh) touched.push(rel(f));
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
  if (describeOpts(st.options).length) out(`options: ${describeOpts(st.options).join(' · ')}`);
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
    out(`${id === cur ? '*' : ' '} ${st.id}  ${st.status}  round ${st.round}/${st.max_rounds}  ${st.project_dir}`);
  }
}

function cmdAbort() {
  const d = taskDir();
  const st = withLock(d, () => update(d, (s) => { s.status = 'ABORTED'; s.turn = 'none'; s.updated_by = 'human'; }));
  holdParts(st);
  out(`aborted ${st.id}`);
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
        taskMeta.set(id, { id, dir: realDir(t.project_dir), created: t.created_epoch || 0 });
      } catch { continue; }
    }
    metas.push(taskMeta.get(id));
  }
  return metas.filter((m) => m.dir === want)
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
      let rest = [...`${cur ? indent : ''}${word}`];
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
  let sc = CY;
  if (st.status === 'DONE') sc = G;
  else if (['ESCALATED', 'STALLED', 'ABORTED'].includes(st.status)) sc = RD;
  else if (['CHANGES_REQUESTED', 'PLAN_CHANGES'].includes(st.status)) sc = Y;

  // Header
  const lines = [];
  const waiting = queueCount(st.project_dir);
  const taskPos = view.siblings.length > 1 ? `  ${D}task ${pos + 1}/${view.siblings.length}${view.pinned ? ' (←→)' : ''}${R}` : '';
  const partPos = st.part ? `  ${Y}part ${st.part.index}/${st.part.total}${R}` : '';
  lines.push(`${B}collab watch${R}  ${st.id}${partPos}${taskPos}  ${sc}${B}${st.status}${R}  round ${st.round}/${st.max_rounds}${waiting ? `  ${Y}queue: ${waiting} waiting${R}` : ''}  ${D}total ${fmtDur(now - created)} · ${localTime(Date.now())}${R}`);
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
    ? `${D}↑↓ step · ←→ task · space/b scroll · g/G first/latest · f follow: ${view.follow ? 'on' : 'off'} · q quit${R}`
    : `${D}steer: collab note "…"  ·  stop: collab abort${R}`);
  return lines.slice(0, rows).map((l) => clipAnsi(l, cols));
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
                              -i/--implementer or -r/--reviewer for just one)
  ${C}status${R}                      One-shot summary of the current task
  ${C}log${R}                         Full history: brief, summaries, reviews, notes
  ${C}show${R} [N]                    Print entry #N (default: the latest one)
  ${C}diff${R} [--stat]               What changed in the project since the task started
  ${C}list${R}                        All tasks (* = current) with status and round
  ${C}abort${R}                       Stop the current task; both agents exit their loop
  ${C}queue${R}                       List queued tasks (* = this project)
  ${C}queue add${R} [options] "task"  Queue a task; the implementer starts it after the current one
  ${C}queue rm${R}|${C}move${R}|${C}clear${R}         Edit the queue: rm N, move N M, clear [--all]
  ${C}snooze${R} [MIN]                Keep waiting on a slow agent (no idle prompt for MIN, default 30)
  ${C}clean${R} [--older-than D] [-n] Delete finished tasks (asks first; -n = dry run, -y = no prompt)
  ${C}path${R}                        Folder holding the current task's files
  ${C}help${R}                        This screen

${B}TASK OPTIONS${R} ${D}(for queue add, init, or /Collab implement …)${R}
  --plan                      Reviewer approves a plan before any code
  --check "npm test"          Must pass before every handoff (collab runs it)
  --scope "src/auth/**"       Files the task may change; collab diff flags the rest
  --focus "security"          What the reviewer should look at hardest
  --branch feat/x             Work on this branch
  --commit                    Commit when DONE (never pushes)
  --confirm                   Ask you before this queued task starts
  --max-rounds N · --first    Round limit · put it at the front of the queue

${B}USED BY THE AGENTS${R} ${D}(the skill runs these for you)${R}
  ${C}init${R} <slug> [options] [--from-queue [--confirmed "answer"]]
                              Start a task (brief on stdin or --file)
  ${C}queue next${R} · ${C}queue skip${R}     Show / drop the next queued task for this project
  ${C}queue split${R} [--reason TEXT] Implementer: split the current task (parts on stdin, separated
                              by '=== part ===' lines); part 1 stays, the rest queue next
  ${C}check${R}                       Run the task's --check command
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
Exit codes: 0 ok · 10 finished · 11 wait timed out · 12 new note · 13 other agent idle · 14 check failed · 15 queue empty · 1 error${R}`);
}

// --- main -------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit, join: cmdJoin, wait: cmdWait, submit: cmdSubmit, note: cmdNote,
  snooze: cmdSnooze, progress: cmdProgress, queue: cmdQueue, check: cmdCheck, clean: cmdClean, watch: cmdWatch, diff: cmdDiff, status: cmdStatus,
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
