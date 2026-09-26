'use strict';
// Run with: node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'collab.js');

function sandbox(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const env = {
    ...process.env, COLLAB_HOME: home, COLLAB_POLL_SECS: '1', COLLAB_NOTIFY: '0',
    COLLAB_TASK: '', ...extraEnv,
  };
  const run = (args, { input, cwd = project, env: more = {} } = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd, input: input === undefined ? '' : input, encoding: 'utf8', env: { ...env, ...more },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const taskDir = () => run(['path']).out.trim();
  const state = () => JSON.parse(fs.readFileSync(path.join(taskDir(), 'state.json'), 'utf8'));
  return { root, home, project, run, taskDir, state };
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('happy path: init, join, turns, changes, approve', () => {
  const s = sandbox();
  let r = s.run(['init', 'Test Task!', '--max-rounds', '3'], { input: 'Goal: do it\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /task: +test-task-\d{8}-\d{6}/);

  r = s.run(['join', '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /joined task: test-task-/);
  assert.match(r.out, /000-implementer-brief\.md/);

  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^YOUR TURN \(implementer\)/);

  r = s.run(['submit', 'reviewer', 'approve'], { input: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.err, /not your turn \(reviewer\)/);

  r = s.run(['submit', 'implementer', 'ready'], { input: 'summary v1' });
  assert.equal(r.code, 0);
  assert.match(r.out, /submitted: implementer ready -> READY_FOR_REVIEW \(turn: reviewer, round 1\/3\)/);

  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /summary v1/);
  assert.match(r.out, /000-implementer-brief/, 'first reviewer turn shows the brief too');

  r = s.run(['submit', 'reviewer', 'changes'], { input: '1. fix X' });
  assert.equal(r.code, 0);
  assert.equal(s.state().round, 2);

  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /1\. fix X/);
  assert.doesNotMatch(r.out, /summary v1/);

  s.run(['submit', 'implementer', 'ready'], { input: 'fixed' });
  r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 10);
  assert.match(r.out, /-> DONE/);

  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.equal(r.code, 10);
  assert.match(r.out, /TASK FINISHED: DONE/);

  const log = s.run(['log']).out;
  assert.match(log, /## #004 · reviewer · approve · round 2 ·/);
  assert.equal(s.run(['status']).code, 0);
  assert.match(s.run(['show', '1']).out, /summary v1/);
  assert.match(s.run(['list']).out, /^\* test-task-.*DONE {2}round 2\/3/m);
});

test('init refuses while a task is active unless --force', () => {
  const s = sandbox();
  s.run(['init', 'a'], { input: 'b' });
  let r = s.run(['init', 'b'], { input: 'b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /still active/);
  r = s.run(['init', 'b', '--force'], { input: 'b' });
  assert.equal(r.code, 0);
});

test('max rounds escalates without overflowing the round counter', () => {
  const s = sandbox();
  s.run(['init', 'mr', '--max-rounds', '2'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: 'c1' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  const r = s.run(['submit', 'reviewer', 'changes'], { input: 'c2' });
  assert.equal(r.code, 10);
  assert.equal(s.state().status, 'ESCALATED');
  assert.equal(s.state().round, 2);
  assert.match(s.run(['show']).out, /max rounds \(2\) reached — escalated to the human/);
});

test('diff across nested repos ignores pre-existing changes', () => {
  const s = sandbox();
  const a = path.join(s.project, 'a');
  const b = path.join(s.project, 'nested', 'b');
  gitRepo(a);
  gitRepo(b);
  fs.appendFileSync(path.join(a, 'f.txt'), 'pre-existing dirty\n');
  fs.writeFileSync(path.join(b, 'old-untracked.txt'), 'old\n');
  let r = s.run(['init', 'diff'], { input: 'b' });
  assert.match(r.out, /repos snapshotted: 2/);

  fs.appendFileSync(path.join(a, 'f.txt'), 'two\n');
  fs.writeFileSync(path.join(b, 'new.txt'), 'brand new\n');
  r = s.run(['diff']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\+two/);
  assert.doesNotMatch(r.out, /\+pre-existing dirty/);
  assert.match(r.out, /new untracked files:\n {2}new\.txt/);
  assert.doesNotMatch(r.out, /old-untracked/);
  assert.match(r.out, /\+\+\+ new file: new\.txt\nbrand new/);

  r = s.run(['diff', '--stat']);
  assert.match(r.out, /f\.txt \| 1 \+/);
  assert.doesNotMatch(r.out, /brand new/);
});

test('diff without git repos points to the summary', () => {
  const s = sandbox();
  s.run(['init', 'nogit'], { input: 'b' });
  assert.match(s.run(['diff']).out, /No git repos/);
});

test('notes: gate, routing and finished tasks', () => {
  const s = sandbox();
  s.run(['init', 'notes'], { input: 'brief' });
  let r = s.run(['note', 'also', 'handle', 'empty', 'strings']);
  assert.match(r.out, /note #1 added for all/);

  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 12);
  assert.match(r.out, /NOT SUBMITTED/);
  assert.match(r.out, /!!! HUMAN NOTE[\s\S]*also handle empty strings/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v2' }).code, 0);

  s.run(['note', '-r', 'check perf']);
  s.run(['note', '--implementer', 'impl only']);
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /check perf/);
  assert.doesNotMatch(r.out, /impl only/);
  assert.equal(s.run(['submit', 'reviewer', 'changes'], { input: 'fix' }).code, 0, 'implementer-only note does not gate the reviewer');

  s.run(['note', '--to', 'reviewer', 'reviewer note during impl turn']);
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /impl only/);
  assert.doesNotMatch(r.out, /reviewer note during impl turn/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'fixed' }).code, 0);

  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /reviewer note during impl turn/);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10);
  r = s.run(['note', 'late']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already finished/);
});

test('plan mode', () => {
  const s = sandbox();
  let r = s.run(['init', 'plan', '--plan', '--max-rounds', '3'], { input: 'b' });
  assert.match(r.out, /phase: +plan/);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.err, /submit your plan/);
  assert.match(s.run(['submit', 'implementer', 'plan'], { input: 'p1' }).out, /PLAN_REVIEW/);
  assert.match(s.run(['submit', 'reviewer', 'changes'], { input: 'rethink' }).out, /PLAN_CHANGES/);
  assert.match(s.run(['wait', 'implementer', '--timeout', '1']).out, /rethink/);
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  r = s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });
  assert.equal(r.code, 0);
  assert.equal(s.state().status, 'IMPLEMENTING');
  assert.equal(s.state().phase, 'build');
  s.run(['submit', 'implementer', 'ready'], { input: 'built' });
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ship' }).code, 10);
});

test('escalate is allowed out of turn', () => {
  const s = sandbox();
  s.run(['init', 'esc'], { input: 'b' });
  const r = s.run(['submit', 'reviewer', 'escalate'], { input: 'unclear brief' });
  assert.equal(r.code, 10);
  assert.equal(s.state().status, 'ESCALATED');
});

test('idle detection, snooze and stall', async () => {
  const s = sandbox({ COLLAB_IDLE_SECS: '2', COLLAB_QUIET_MINS: '1' });
  fs.writeFileSync(path.join(s.project, 'a.txt'), 'x');
  s.run(['init', 'idle'], { input: 'b' });
  await pause(2500);
  let r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 11, 'recent file change means the implementer is still busy');

  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(path.join(s.project, 'a.txt'), old, old);
  r = s.run(['wait', 'reviewer', '--timeout', '3']);
  assert.equal(r.code, 13);
  assert.match(r.out, /^OTHER AGENT LOOKS UNRESPONSIVE: the implementer has not handed off/);

  assert.match(s.run(['snooze', '1']).out, /snoozed/);
  assert.equal(s.run(['wait', 'reviewer', '--timeout', '1']).code, 11);

  const t = sandbox({ COLLAB_STALL_SECS: '2' });
  t.run(['init', 'stall'], { input: 'b' });
  await pause(2500);
  r = t.run(['wait', 'reviewer', '--timeout', '3']);
  assert.equal(r.code, 10);
  assert.match(r.out, /STALLED/);
  assert.equal(t.state().status, 'STALLED');
});

test('clean only removes finished tasks', () => {
  const s = sandbox();
  s.run(['init', 'first'], { input: 'b' });
  s.run(['abort']);
  const firstDir = s.taskDir();
  s.run(['init', 'second'], { input: 'b' });
  let r = s.run(['clean', '-n']);
  assert.match(r.out, /first-.*ABORTED/);
  assert.match(r.out, /dry run/);
  assert.ok(fs.existsSync(firstDir));
  r = s.run(['clean']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--yes/);
  r = s.run(['clean', '-y']);
  assert.match(r.out, /deleted 1 task/);
  assert.ok(!fs.existsSync(firstDir));
  assert.match(s.run(['list']).out, /second-.*IMPLEMENTING/);
  assert.match(s.run(['clean']).out, /nothing to clean \(1 active/);

  s.run(['abort']);
  s.run(['clean', '-y']);
  assert.ok(!fs.existsSync(path.join(s.home, 'current')), 'current is removed with its task');
});

test('join waits for a new task when the current one is finished', () => {
  const s = sandbox();
  s.run(['init', 'old'], { input: 'b' });
  s.run(['abort']);
  assert.equal(s.run(['join', '--timeout', '1']).code, 11);
  s.run(['init', 'new'], { input: 'fresh brief' });
  const r = s.run(['join', '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /fresh brief/);
});

test('-t pins a task even when current moves', () => {
  const s = sandbox();
  s.run(['init', 'one'], { input: 'b' });
  const one = s.state().id;
  s.run(['init', 'two', '--force'], { input: 'b' });
  const r = s.run(['-t', one, 'submit', 'implementer', 'ready'], { input: 'x' });
  assert.equal(r.code, 0);
  assert.match(s.run(['-t', one, 'status']).out, /READY_FOR_REVIEW/);
  assert.match(s.run(['status']).out, /IMPLEMENTING/);
});

test('--file bodies keep UTF-8 and normalise CRLF and BOM', () => {
  const s = sandbox();
  const f = path.join(s.root, 'msg.md');
  fs.writeFileSync(f, '﻿## Résumé — done → ok\r\nline two\r\n');
  s.run(['init', 'utf'], { input: 'b' });
  const r = s.run(['submit', 'implementer', 'ready', '--file', f]);
  assert.equal(r.code, 0, r.err);
  const entry = fs.readFileSync(path.join(s.taskDir(), 'entries', '001-implementer-ready.md'), 'utf8');
  assert.equal(entry, '## Résumé — done → ok\nline two\n');

  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: '   \n' }).code, 1, 'empty body refused');
});

test('state written by the bash version (no phase/seen/plan_round) still works', () => {
  const s = sandbox();
  const id = 'legacy-20260101-000000';
  const d = path.join(s.home, 'tasks', id);
  fs.mkdirSync(path.join(d, 'entries'), { recursive: true });
  fs.mkdirSync(path.join(d, 'untracked'), { recursive: true });
  fs.writeFileSync(path.join(d, 'entries', '000-implementer-brief.md'), 'old brief\n');
  fs.writeFileSync(path.join(d, 'log.md'), '# collab task\n');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({
    id, project_dir: s.project, repos: [], status: 'IMPLEMENTING', turn: 'implementer', round: 1,
    max_rounds: 4, seq: 1, created_at: 'x', updated_at: 'x', updated_epoch: now, updated_by: 'implementer',
  }));
  fs.writeFileSync(path.join(s.home, 'current'), `${id}\n`);
  assert.equal(s.run(['status']).code, 0);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  assert.match(s.run(['wait', 'reviewer', '--timeout', '1']).out, /v1/);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10);
});

test('output piped into a reader that exits early does not crash or lose state', { skip: process.platform === 'win32' }, () => {
  const s = sandbox();
  s.run(['init', 'pipe'], { input: 'b' });
  s.run(['note', 'a note for everyone']);
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1 (note handled)' });
  const big = 'line\n'.repeat(20000);
  s.run(['note', '-r', big]);
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" wait reviewer --timeout 1 | head -1`], {
    cwd: s.project, encoding: 'utf8', env: { ...process.env, COLLAB_HOME: s.home, COLLAB_NOTIFY: '0' },
  });
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^YOUR TURN/);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10, 'notes shown before the pipe closed count as seen');
});

test('progress: attribution, notes hand-over, wait output and finished tasks', () => {
  const s = sandbox();
  s.run(['init', 'prog'], { input: 'b' });
  const before = s.state();
  let r = s.run(['progress', 'reading', 'the', 'brief']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^progress \(implementer\): reading the brief/);
  assert.equal(s.state().progress.role, 'implementer');
  assert.equal(s.state().updated_at, before.updated_at, 'progress is not a handoff');
  assert.equal(s.state().seq, before.seq, 'progress adds no timeline entry');

  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 11);
  assert.match(r.out, /^still waiting — .*latest implementer progress: "reading the brief" \(\d+s ago\)/);

  s.run(['note', '-i', 'use 2 decimals']);
  r = s.run(['progress', 'writing code']);
  assert.match(r.out, /HUMAN NOTE[\s\S]*use 2 decimals/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0, 'a note shown via progress no longer blocks the submit');

  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /no progress update from the reviewer yet/);
  assert.match(s.run(['progress', 'reviewing diff']).out, /progress \(reviewer\)/);
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  r = s.run(['progress', 'late']);
  assert.equal(r.code, 1);
  assert.equal(s.run(['progress']).code, 1, 'empty progress refused');
});

test('progress keeps a slow agent from looking unresponsive', async () => {
  const s = sandbox({ COLLAB_IDLE_SECS: '2', COLLAB_QUIET_MINS: '1' });
  s.run(['init', 'slow'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  await pause(2500);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13, 'silent reviewer looks unresponsive');
  s.run(['progress', 'still reviewing, big diff']);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '1']).code, 11, 'a fresh progress post counts as activity');
});

test('watch --once renders every step, the live row and the selected step', () => {
  const s = sandbox();
  s.run(['init', 'dash', '--plan'], { input: '## Goal\nbuild the thing' });
  s.run(['submit', 'implementer', 'plan'], { input: '## Approach\nplain module' });
  s.run(['submit', 'reviewer', 'approve'], { input: '## Verdict: approved\nfine' });
  s.run(['progress', 'running tests']);
  const r = s.run(['watch', '--once'], { env: { COLUMNS: '100', LINES: '30' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /IMPLEMENTING/);
  assert.match(r.out, /implementer is implementing for .*⟳ running tests/);
  assert.match(r.out, /000 .*brief .*build the thing/);
  assert.match(r.out, /now .*in progress .*⟳ running tests/);
  assert.match(r.out, /▶ 002 .*reviewer .*approve/, 'follows the latest entry by default');
  assert.match(r.out, /#002 · reviewer · approve[\s\S]*## Verdict: approved\nfine/, 'full content of the selected step');
});

test('help and unknown commands', () => {
  const s = sandbox();
  let r = s.run(['help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /FOR YOU \(the human\)/);
  r = s.run(['bogus']);
  assert.equal(r.code, 1);
  assert.match(r.out, /USED BY THE AGENTS/);
  assert.equal(s.run(['wait', 'nobody']).code, 1);
});
