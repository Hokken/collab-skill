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
  const idle = s.run(['join', '--timeout', '1']);
  assert.equal(idle.code, 11);
  assert.match(idle.out, /run 'collab join' again right away.*don't end your turn/i);
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
  // Generous idle limit and a single-pass wait, so slow CI machines can't turn "fresh" into "stale".
  const s = sandbox({ COLLAB_IDLE_SECS: '4', COLLAB_QUIET_MINS: '1' });
  s.run(['init', 'slow'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  await pause(4500);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13, 'silent reviewer looks unresponsive');
  s.run(['progress', 'still reviewing, big diff']);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '0']).code, 11, 'a fresh progress post counts as activity');
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

  s.run(['progress', 'a very long progress update '.repeat(8)]);
  s.run(['note', 'word '.repeat(40)]);
  const narrow = s.run(['watch', '--once'], { env: { COLUMNS: '60', LINES: '30' } }).out;
  for (const line of narrow.split('\n')) assert.ok([...line].length <= 60, `line wider than 60: ${line}`);
  assert.doesNotMatch(narrow, /wor\nd/, 'wraps at spaces, not inside words');
});

test('queue: add, list, next, skip, rm, move, clear and per-project filtering', () => {
  const s = sandbox();
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  assert.equal(s.run(['queue', 'next']).code, 15, 'empty queue');
  let r = s.run(['queue', 'add', '--check', 'npm test', '--commit', 'first task']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued #1 at position 1 \(1 waiting/);
  s.run(['queue', 'add', '--dir', other, 'task for another project']);
  s.run(['queue', 'add', '--plan', '--confirm', 'second task']);
  s.run(['queue', 'add', '--first', 'urgent task']);

  r = s.run(['queue']);
  assert.match(r.out, /queue: 4 task/);
  assert.match(r.out, /\* {2}1\. #4 .*urgent task/);
  assert.match(r.out, / {3}3\. #2 +\[other\] +task for another project/);
  assert.match(r.out, /check `npm test` · commit on DONE/);

  r = s.run(['queue', 'next']);
  assert.match(r.out, /^NEXT QUEUED TASK #4 \(1 of 3 for this project\)/);
  assert.match(r.out, /----- task -----\nurgent task\n----- end -----/);
  assert.match(s.run(['queue', 'skip']).out, /skipped #4: urgent task/);

  s.run(['queue', 'move', '3', '1']);
  r = s.run(['queue', 'next']);
  assert.match(r.out, /#3 .*\n[\s\S]*CONFIRM FIRST/, 'moved the confirm task to the front');
  assert.match(s.run(['queue', 'rm', '1']).out, /removed #3: second task/);
  assert.equal(s.run(['queue', 'rm', '9']).code, 1);

  assert.match(s.run(['queue', 'next', '--dir', other]).out, /task for another project/);
  assert.match(s.run(['queue', 'clear']).out, /removed 1 task\(s\) for project/);
  assert.match(s.run(['queue']).out, /#2 +\[other\]/, 'clear only touches this project');
  assert.match(s.run(['queue', 'clear', '--all']).out, /removed 1 task/);
  assert.match(s.run(['queue']).out, /the queue is empty/);
});

test('init --from-queue pops the task and applies its options', () => {
  const s = sandbox();
  s.run(['queue', 'add', '--plan', '--max-rounds', '2', '--focus', 'security', '--branch', 'feat/x', '--scope', 'src/**', 'queued job']);
  s.run(['queue', 'add', 'later job']);
  let r = s.run(['init', 'job', '--from-queue', '--focus', 'performance'], { input: '## Goal\nqueued job, as a brief\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /phase: +plan/);
  assert.match(r.out, /options: plan first · max 2 rounds · scope src\/\*\* · focus: performance · branch feat\/x/);
  assert.match(r.out, /from queue: #1 \(1 more waiting/);
  const st = s.state();
  assert.equal(st.max_rounds, 2);
  assert.equal(st.queue_item, 1);
  assert.equal(st.options.focus, 'performance', 'explicit flags override the queued options');
  const brief = s.run(['show', '0']).out;
  assert.match(brief, /## Task options \(set by collab\)/);
  assert.match(brief, /\*\*Branch:\*\* work on `feat\/x`/);
  assert.match(s.run(['queue', 'next']).out, /later job/);
  s.run(['abort']);
  s.run(['queue', 'clear']);
  r = s.run(['init', 'none', '--from-queue'], { input: 'b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /the queue has no task/);
});

test('--confirm tasks need the recorded go-ahead, which lands in the timeline', () => {
  const s = sandbox();
  s.run(['queue', 'add', '--confirm', 'risky migration']);
  let r = s.run(['init', 'mig', '--from-queue'], { input: 'b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /needs the user's go-ahead first/);
  assert.match(s.run(['queue', 'next']).out, /risky migration/, 'still queued after the refusal');
  r = s.run(['init', 'mig', '--from-queue', '--confirmed', 'Start'], { input: 'b' });
  assert.equal(r.code, 0, r.err);
  assert.match(s.run(['show', '1']).out, /001-human-confirm\.md[\s\S]*approved starting queued task #1: "Start"/);
  assert.equal(s.state().seq, 2);
  assert.match(s.run(['watch', '--once']).out, /001 .*human .*confirm/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0, 'a confirm entry is not a note and does not gate');
});

test('--check must pass before the implementer hands off', () => {
  const s = sandbox();
  const flag = path.join(s.project, 'pass.flag');
  const check = `node -e "process.exit(require('fs').existsSync('pass.flag') ? 0 : 3)"`;
  s.run(['init', 'chk', '--check', check], { input: 'b' });
  let r = s.run(['check']);
  assert.equal(r.code, 14);
  assert.match(r.out, /CHECK FAILED: .* exit code 3/);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 14);
  assert.match(r.out, /^NOT SUBMITTED: the task check failed/);
  assert.equal(s.state().status, 'IMPLEMENTING');

  fs.writeFileSync(flag, '');
  assert.match(s.run(['check']).out, /CHECK PASSED/);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(s.run(['show']).out, /collab: check passed: `node -e/);
  assert.equal(s.run(['submit', 'reviewer', 'escalate'], { input: 'x' }).code, 10);
  assert.match(s.run(['-t', s.state().id, 'status']).out, /options: check `node -e/);
});

test('a --check that times out is stopped with everything it started', async () => {
  const s = sandbox({ COLLAB_CHECK_TIMEOUT: '1' });
  // The shell has to stay around for the '&&', so node is its child, not the shell itself.
  const check = `node -e "setTimeout(() => require('fs').writeFileSync('late.flag', 'x'), 3000)" && echo done`;
  s.run(['init', 'slow', '--check', check], { input: 'b' });
  const r = s.run(['check']);
  assert.equal(r.code, 14);
  assert.match(r.out, /CHECK FAILED: .* timed out after 1s/);
  await pause(3500);
  assert.ok(!fs.existsSync(path.join(s.project, 'late.flag')), 'the grandchild was stopped too');
});

test('a stale lock is broken only when its owner is gone', () => {
  const s = sandbox({ COLLAB_LOCK_SECS: '1' });
  s.run(['init', 'lock'], { input: 'b' });
  const lock = path.join(s.taskDir(), '.lock');
  // Owned by a live process (this test runner): never broken, so the note times out.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} live`);
  let r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'collab.js'), 'note', 'hi'], {
    cwd: s.project, encoding: 'utf8', timeout: 4000,
    env: { ...process.env, COLLAB_HOME: s.home, COLLAB_NOTIFY: '0', COLLAB_TASK: '', COLLAB_LOCK_SECS: '1' },
  });
  assert.ok(r.error && r.error.code === 'ETIMEDOUT', 'still waiting on a live owner');
  assert.ok(fs.existsSync(lock));
  // Owned by a process that is gone: broken after the wait, and the note goes through.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(path.join(lock, 'owner'), `${dead} gone`);
  r = s.run(['note', 'hi']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /broke stale lock/);
  assert.ok(!fs.existsSync(lock), 'the note released its own lock');
});

test('--scope flags changes outside the allowed files', () => {
  const s = sandbox();
  gitRepo(s.project);
  fs.mkdirSync(path.join(s.project, 'src', 'auth'), { recursive: true });
  s.run(['init', 'scoped', '--scope', 'src/auth/**, README.md'], { input: 'b' });
  fs.writeFileSync(path.join(s.project, 'src', 'auth', 'login.js'), 'x\n');
  fs.writeFileSync(path.join(s.project, 'README.md'), 'readme\n');
  let r = s.run(['diff', '--stat']);
  assert.match(r.out, /scope: all changes are inside src\/auth\/\*\*, README\.md/);
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'outside\n');
  r = s.run(['diff', '--stat']);
  assert.match(r.out, /⚠ OUTSIDE SCOPE \(src\/auth\/\*\*, README\.md\):\n {2}f\.txt/);
  assert.doesNotMatch(r.out, / {2}src\/auth\/login\.js\n.*OUTSIDE/);
});

test('queue split: part 1 stays, the rest queue next with the options, once and only up front', () => {
  const s = sandbox();
  s.run(['queue', 'add', 'user task already queued']);
  s.run(['init', 'big', '--check', 'node -e 0', '--branch', 'feat/x'], { input: 'the whole job' });
  const id = s.state().id;
  const parts = 'refactor the parser\n=== part ===\nadd the new syntax\nwith tests\n=== Part ===\nupdate the docs\n';

  assert.match(s.run(['queue', 'split'], { input: 'just one part' }).err, /at least 2 parts/);
  let r = s.run(['queue', 'split', '--reason', 'three independent changes'], { input: parts });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /split into 3 parts: this task is part 1; queued #2, #3/);
  assert.deepEqual(s.state().part, { index: 1, total: 3, parent: id });

  const entry = s.run(['show', '1']).out;
  assert.match(entry, /001-implementer-split\.md/);
  assert.match(entry, /Why: three independent changes/);
  assert.match(entry, /part 1 only[\s\S]*refactor the parser/);
  assert.match(entry, /#2 part 2\/3: add the new syntax\n- #3 part 3\/3: update the docs/);
  assert.match(s.run(['watch', '--once']).out, /^collab watch +big-\S+ +part 1\/3 +IMPLEMENTING/);

  r = s.run(['queue']);
  assert.match(r.out, /1\. #2 .*add the new syntax\n +part 2\/3 of big-\S+ · check `node -e 0` · branch feat\/x/);
  assert.match(r.out, /3\. #1 .*user task already queued/, 'parts go ahead of the user\'s queued tasks');

  assert.match(s.run(['queue', 'split'], { input: parts }).err, /already part 1\/3/, 'only once');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /000-implementer-brief[\s\S]*001-implementer-split[\s\S]*v1/, 'the reviewer sees the split');
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });

  r = s.run(['queue', 'next']);
  assert.match(r.out, /NEXT QUEUED TASK #2[\s\S]*split: +part 2\/3 of big-/);
  r = s.run(['init', 'syntax', '--from-queue'], { input: 'brief for part 2' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /from queue: #2 \(part 2\/3 of big-/);
  assert.deepEqual(s.state().part, { index: 2, total: 3, parent: id });
  assert.equal(s.state().options.check, 'node -e 0', 'parts inherit the options');
  assert.match(s.run(['show', '0']).out, /## Part of a split task[\s\S]*part 2\/3 of big-/);
  assert.match(s.run(['queue', 'split'], { input: parts }).err, /a part can't be split again/);
});

test('queue split is refused after the first handoff and on the reviewer\'s turn', () => {
  const s = sandbox();
  s.run(['init', 'late'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  const parts = 'a\n=== part ===\nb\n';
  assert.match(s.run(['queue', 'split'], { input: parts }).err, /not your turn \(implementer\)/);
  s.run(['submit', 'reviewer', 'changes'], { input: '1. fix' });
  assert.match(s.run(['queue', 'split'], { input: parts }).err, /too late to split/);
  assert.match(s.run(['queue']).out, /the queue is empty/);
});

test('a split part that ends early holds its later parts for the user', () => {
  const s = sandbox();
  s.run(['init', 'big'], { input: 'b' });
  s.run(['queue', 'split'], { input: 'one\n=== part ===\ntwo\n=== part ===\nthree\n' });
  s.run(['submit', 'implementer', 'escalate'], { input: 'blocked' });
  const r = s.run(['queue', 'next']);
  assert.match(r.out, /HELD: part 1\/3 of big-\S+ \(big-\S+\) ended ESCALATED/);
  assert.match(r.out, /CONFIRM FIRST/);
  assert.match(s.run(['init', 'two', '--from-queue'], { input: 'b' }).err, /needs the user's go-ahead/);
  assert.equal(s.run(['init', 'two', '--from-queue', '--confirmed', 'go on'], { input: 'b' }).code, 0);
});

test('pairs in different projects keep to their own task', () => {
  const s = sandbox();
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  assert.equal(s.run(['init', 'here'], { input: 'brief here' }).code, 0);
  let r = s.run(['init', 'there'], { input: 'brief there', cwd: other });
  assert.equal(r.code, 0, 'another project can start its own task');
  assert.match(s.run(['join', '--timeout', '1']).out, /joined task: here-/);
  assert.match(s.run(['join', '--timeout', '1'], { cwd: other }).out, /joined task: there-/);
  assert.match(s.run(['status']).out, /task: +here-/, 'unpinned commands follow the project');
  r = s.run(['init', 'again'], { input: 'b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /still active in this project/);
});

test('DONE tells both agents when more queued tasks are waiting', () => {
  const s = sandbox();
  s.run(['queue', 'add', 'next one']);
  s.run(['init', 'q1'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 10);
  assert.match(r.out, /^QUEUE: 1 more task\(s\) waiting for this project/m);
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /TASK FINISHED: DONE[\s\S]*QUEUE: 1 more/);
  s.run(['queue', 'clear']);
  assert.doesNotMatch(s.run(['wait', 'implementer', '--timeout', '1']).out, /QUEUE:/);
});

test('watch shows the task position within its project and -t pins an older task', () => {
  const s = sandbox();
  s.run(['init', 'one'], { input: 'first brief' });
  const one = s.state().id;
  s.run(['abort']);
  s.run(['init', 'two'], { input: 'second brief' });
  assert.match(s.run(['watch', '--once']).out, /collab watch {2}two-\S+ {2}task 2\/2 /);
  const r = s.run(['-t', one, 'watch', '--once']);
  assert.match(r.out, /collab watch {2}one-\S+ {2}task 1\/2 \(←→\)/);
  assert.match(r.out, /first brief/);
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
