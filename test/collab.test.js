'use strict';
// Run with: node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'collab.js');

const CLOSEOUT = '## Closeout\nVerified: none\nAttempted, blocked: none\nDeferred: none\nNot claimed: none\n';

function sandbox(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const env = {
    ...process.env, COLLAB_HOME: home, COLLAB_POLL_SECS: '1', COLLAB_NOTIFY: '0',
    COLLAB_TASK: '', ...extraEnv,
  };
  // A build 'ready' needs a closeout; tests that aren't about it get a minimal one (raw: send as is).
  const run = (args, { input, cwd = project, env: more = {}, raw = false } = {}) => {
    const ready = args.join(' ').includes('submit implementer ready') && !args.includes('--file');
    if (ready && !raw && typeof input === 'string' && !/^## Closeout/m.test(input)) input += `\n${CLOSEOUT}`;
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

test('the round limit asks the user: more rounds, approve, or stop', () => {
  const s = sandbox();
  const toLimit = (slug) => {
    s.run(['init', slug, '--max-rounds', '2'], { input: 'b' });
    s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
    s.run(['submit', 'reviewer', 'changes'], { input: '1. c1' });
    s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
    return s.run(['submit', 'reviewer', 'changes'], { input: '1. still broken' });
  };
  let r = toLimit('a-more');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Round limit reached \(2 review rounds\)[\s\S]*exit 16/);
  assert.equal(s.state().status, 'DECISION');
  assert.equal(s.state().round, 2, 'no round counter overflow');
  for (const role of ['implementer', 'reviewer']) {
    r = s.run(['wait', role, '--timeout', '1']);
    assert.equal(r.code, 16, `${role} can show the menu`);
    assert.match(r.out, /round limit is reached[\s\S]*1\. still broken[\s\S]*1\. Give them 2 more rounds[\s\S]*3\. Stop the task/);
  }
  assert.match(s.run(['answer', '1.']).out, /back to the implementer \(status: CHANGES_REQUESTED\)/);
  assert.equal(s.state().round, 3);
  assert.equal(s.state().max_rounds, 4);
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /1\. still broken[\s\S]*Option 1: Give them 2 more rounds/);
  s.run(['abort']);

  toLimit('b-approve');
  r = s.run(['answer', '2']);
  assert.match(r.out, /the task is DONE/);
  assert.equal(s.run(['wait', 'reviewer', '--timeout', '1']).code, 10);

  toLimit('c-stop');
  assert.match(s.run(['answer', '3']).out, /the task is ESCALATED/);

  toLimit('d-words');
  s.run(['answer', 'fix only the crash, then approve']);
  assert.equal(s.state().status, 'CHANGES_REQUESTED', 'own words: more rounds, with the words passed on');
  assert.match(s.run(['wait', 'implementer', '--timeout', '1']).out, /fix only the crash, then approve/);
  s.run(['abort']);

  s.run(['init', 'e-plan', '--plan', '--max-rounds', '1'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. rethink' });
  assert.match(s.state().decision.question, /1 plan rounds/);
  s.run(['answer', '1']);
  assert.equal(s.state().status, 'PLAN_CHANGES');
  assert.equal(s.state().plan_round, 2);
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

test('diff leaves out lockfile patches and binary file bodies unless --all', () => {
  const s = sandbox();
  gitRepo(s.project);
  s.run(['init', 'locks'], { input: 'b' });
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'two\n');
  fs.writeFileSync(path.join(s.project, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  fs.writeFileSync(path.join(s.project, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  let r = s.run(['diff']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\+two/);
  assert.match(r.out, /\+\+\+ new file: blob\.bin\n\(binary, 4 bytes\)/);
  assert.match(r.out, /new file: package-lock\.json\n\(lockfile, content omitted\)/);
  assert.doesNotMatch(r.out, /lockfileVersion/);
  assert.match(r.out, /lockfile patches omitted: package-lock\.json \('collab diff --all'/);

  r = s.run(['diff', '--all']);
  assert.match(r.out, /lockfileVersion/);
  assert.doesNotMatch(r.out, /lockfile patches omitted/);
  assert.equal(s.run(['diff', '--bogus']).code, 1);
});

test('diff --since-review shows only what changed since the reviewed handoff', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = (...a) => spawnSync('git', a, { cwd: s.project, encoding: 'utf8' }).stdout;
  s.run(['init', 'rounds', '--scope', 'f.txt,b.txt'], { input: 'b' });
  const id = s.state().id;
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'round one\n');
  fs.writeFileSync(path.join(s.project, 'out.txt'), 'outside\n');
  s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r1' });

  let r = s.run(['-t', id, 'diff', '--since-review']);
  assert.match(r.out, /no earlier review snapshot/);
  assert.match(r.out, /\+round one/);

  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] more' });
  const objects0 = g('count-objects', '-v');
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'round two\n');
  fs.writeFileSync(path.join(s.project, 'b.txt'), 'brand new\n');
  r = s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r2' });
  assert.equal(r.code, 0, r.err);
  assert.equal(s.state().review_trees.length, 2);

  r = s.run(['-t', id, 'diff', '--since-review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /since review handoff #001/);
  assert.match(r.out, /\+round two/);
  assert.match(r.out, /\+brand new/);
  assert.doesNotMatch(r.out, /\+round one/);
  assert.doesNotMatch(r.out, /\+outside/);
  // The scope check still covers the whole task.
  assert.match(r.out, /OUTSIDE SCOPE[^]*out\.txt/);
  // The full diff still has everything; the real index and the worktree are untouched.
  assert.match(s.run(['-t', id, 'diff']).out, /\+round one[^]*\+round two/);
  assert.equal(g('diff', '--cached', '--name-only'), '');
  assert.equal(g('count-objects', '-v'), objects0, 'snapshot objects stay in the task folder');
  assert.match(g('status', '--porcelain'), /\?\? b\.txt/);

  r = s.run(['-t', id, 'wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /diff --since-review/);

  // Nothing changed since the handoff: said so, not an empty output.
  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] again' });
  s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r3' });
  r = s.run(['-t', id, 'diff', '--since-review']);
  assert.match(r.out, /no changes since review handoff #00\d in: /);
  // A lost snapshot never reads as "nothing changed".
  fs.rmSync(path.join(s.taskDir(), 'objects'), { recursive: true, force: true });
  fs.appendFileSync(path.join(s.project, 'b.txt'), 'later\n');
  r = s.run(['-t', id, 'diff', '--since-review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /(can't be read|cannot compute)[^\n]*see 'collab diff'/);
  assert.doesNotMatch(r.out, /no changes since/);
});

test('diff --since-review falls back to the full diff when the reviewed handoff has no snapshot', () => {
  const s = sandbox();
  gitRepo(s.project);
  s.run(['init', 'gap'], { input: 'b' });
  const id = s.state().id;
  const f = path.join(s.project, 'f.txt');
  const objects = path.join(s.taskDir(), 'objects');
  const round = (text, input) => {
    fs.writeFileSync(f, text);
    assert.equal(s.run(['-t', id, 'submit', 'implementer', 'ready'], { input }).code, 0);
  };
  round('A\n', 'r1');
  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] x' });
  // The snapshot of round 2 fails (objects/ is a file), the handoff still goes through.
  fs.rmSync(objects, { recursive: true, force: true });
  fs.writeFileSync(objects, 'not a folder');
  round('B\n', 'r2');
  assert.equal(s.state().review_trees.at(-1).repos, null);
  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] y' });
  fs.rmSync(objects, { force: true });
  // Back to A: diffing against round 1 would hide the B -> A change the reviewer hasn't seen.
  round('A\n', 'r3');
  const r = s.run(['-t', id, 'diff', '--since-review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no snapshot of the reviewed handoff #00\d: showing the full task diff/);
  assert.doesNotMatch(r.out, /no changes since/);
  assert.match(r.out, /\+A/);
});

test('diff --since-review sees files behind index flags and never writes a split index', () => {
  const s = sandbox();
  gitRepo(s.project);
  fs.writeFileSync(path.join(s.project, 'k.txt'), 'k\n');
  const g = (...a) => spawnSync('git', a, { cwd: s.project, encoding: 'utf8' });
  g('add', 'k.txt');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'k');
  g('config', 'core.splitIndex', 'true');
  g('update-index', '--split-index');
  const shared = () => fs.readdirSync(path.join(s.project, '.git')).filter((n) => n.startsWith('sharedindex.')).sort();
  s.run(['init', 'flags'], { input: 'b' });
  const id = s.state().id;
  fs.writeFileSync(path.join(s.project, 'f.txt'), 'round1\n');
  fs.writeFileSync(path.join(s.project, 'new.txt'), 'n\n');
  const before = shared();
  assert.equal(s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r1' }).code, 0);
  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] x' });
  assert.deepEqual(shared(), before);
  g('update-index', '--assume-unchanged', 'f.txt');
  g('update-index', '--skip-worktree', 'k.txt');
  const flags = g('ls-files', '-v').stdout;
  fs.writeFileSync(path.join(s.project, 'f.txt'), 'round2\n');
  fs.writeFileSync(path.join(s.project, 'k.txt'), 'k2\n');
  const before2 = shared();
  assert.equal(s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r2' }).code, 0);
  const r = s.run(['-t', id, 'diff', '--since-review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /-round1\n\+round2/);
  assert.match(r.out, /-k\n\+k2/);
  // collab wrote no shared index and left the real index flags alone.
  assert.deepEqual(shared(), before2);
  assert.ok(before.length >= 1, 'the repo uses a split index');
  assert.equal(g('ls-files', '-v').stdout, flags);
});

test('diff --since-review sees present files outside a sparse checkout, not absent ones as deleted', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = (...a) => spawnSync('git', a, { cwd: s.project, encoding: 'utf8' });
  for (const dir of ['keep', 'omit', 'gone']) {
    fs.mkdirSync(path.join(s.project, dir));
    fs.writeFileSync(path.join(s.project, dir, 'file'), `${dir}\n`);
  }
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'dirs');
  assert.equal(g('sparse-checkout', 'init', '--cone').status, 0);
  assert.equal(g('sparse-checkout', 'set', 'keep').status, 0);
  assert.ok(!fs.existsSync(path.join(s.project, 'omit')), 'sparse checkout removed omit/');
  s.run(['init', 'sparse'], { input: 'b' });
  const id = s.state().id;
  fs.writeFileSync(path.join(s.project, 'keep', 'file'), 'keep 1\n');
  assert.equal(s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r1' }).code, 0);
  s.run(['-t', id, 'submit', 'reviewer', 'changes'], { input: '1. [blocking] x' });
  fs.mkdirSync(path.join(s.project, 'omit'));
  fs.writeFileSync(path.join(s.project, 'omit', 'file'), 'changed\n');
  assert.equal(s.run(['-t', id, 'submit', 'implementer', 'ready'], { input: 'r2' }).code, 0);
  const r = s.run(['-t', id, 'diff', '--since-review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /-omit\n\+changed/);
  assert.doesNotMatch(r.out, /gone\/file/);
  assert.doesNotMatch(r.out, /keep\/file/);
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
  assert.equal(s.run(['submit', 'reviewer', 'changes'], { input: '1. fix' }).code, 0, 'implementer-only note does not gate the reviewer');

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
  assert.match(s.run(['submit', 'reviewer', 'changes'], { input: '1. rethink' }).out, /PLAN_CHANGES/);
  assert.match(s.run(['wait', 'implementer', '--timeout', '1']).out, /rethink/);
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  r = s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });
  assert.equal(r.code, 0);
  assert.equal(s.state().status, 'IMPLEMENTING');
  assert.equal(s.state().phase, 'build');
  s.run(['submit', 'implementer', 'ready'], { input: 'built' });
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ship' }).code, 10);
});

test('the reviewer verdict must match its items', () => {
  const s = sandbox();
  const refused = (kind, input, re) => {
    const before = s.state();
    const r = s.run(['submit', 'reviewer', kind], { input });
    assert.equal(r.code, 1, `${kind} refused: ${input}`);
    assert.match(r.err, re);
    const after = s.state();
    assert.equal(after.status, before.status, 'status unchanged');
    assert.equal(after.seq, before.seq, 'no entry written');
    assert.equal(fs.readdirSync(path.join(s.taskDir(), 'entries')).length, before.seq);
  };
  s.run(['init', 'verdict', '--plan'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p1' });
  refused('approve', '## Verdict: approved\n1. [blocking] step 2 is missing\n', /\[blocking\] items/);
  refused('changes', 'rethink the whole thing', /numbered items/);
  assert.equal(s.run(['submit', 'reviewer', 'changes'], { input: '2) rethink step 2' }).code, 0);
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok\n1. [nit] wording' }).code, 0, 'nits are fine in an approve');

  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  refused('approve', 'looks good\n  2) [Blocking] races on Windows\n', /\[blocking\] items/);
  refused('changes', '## Verdict: changes requested\n- a bullet is not a numbered item\n', /numbered items/);
  assert.equal(s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] fix the race' }).code, 0);
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: '## Verdict: approved\n## Nits\n- naming\n' }).code, 10);
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
  fs.writeFileSync(f, `﻿## Résumé — done → ok\r\nline two\r\n${CLOSEOUT.replace(/\n/g, '\r\n')}`);
  s.run(['init', 'utf'], { input: 'b' });
  const r = s.run(['submit', 'implementer', 'ready', '--file', f]);
  assert.equal(r.code, 0, r.err);
  const entry = fs.readFileSync(path.join(s.taskDir(), 'entries', '001-implementer-ready.md'), 'utf8');
  assert.equal(entry, `## Résumé — done → ok\nline two\n${CLOSEOUT}`);

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

test('watch: a finished task\'s total time stops when it ended', async () => {
  const s = sandbox();
  s.run(['init', 'timer'], { input: 'b' });
  approveCurrent(s);
  const st = s.state();
  assert.ok(st.finished_epoch >= st.created_epoch, 'finish time recorded');
  const before = s.run(['watch', '--once']).out.match(/total (\S+)/)[1];
  await pause(2200);
  s.run(['end'], { input: 'done' });
  const r = s.run(['watch', '--once']).out;
  assert.equal(r.match(/total (\S+)/)[1], before, 'total frozen, even after a later write (end)');
  assert.match(r, /finished at \d\d:\d\d:\d\d/);
  assert.equal(s.state().finished_epoch, st.finished_epoch);
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

// Finish the current task: implementer ready, reviewer approve (with an optional review body).
function approveCurrent(s, review = 'ok', summary = 'v1') {
  s.run(['submit', 'implementer', 'ready'], { input: summary });
  return s.run(['submit', 'reviewer', 'approve'], { input: review });
}

test('join --after follows the run to the next task and stops when the implementer ends it', () => {
  const s = sandbox();
  s.run(['init', 'a-stage'], { input: 'stage 0' });
  const a = s.state().id;
  assert.equal(approveCurrent(s, '## Verdict: approved\n## Decisions taken\n- kept the old cooldown (safest)\n').code, 10);

  let r = s.run(['join', '--after', a, '--timeout', '1']);
  assert.equal(r.code, 11, 'DONE without end: keep waiting for the next task');
  assert.ok(r.out.includes(`collab join --after ${a}' again`), r.out);

  s.run(['init', 'b-stage'], { input: 'stage 1 brief' });
  const b = s.state().id;
  r = s.run(['join', '--after', a, '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /joined task: b-stage-[\s\S]*stage 1 brief/);

  assert.match(s.run(['-t', b, 'end'], { input: 'all done' }).err, /still IMPLEMENTING/);
  assert.match(s.run(['-t', a, 'end'], { input: 'all done' }).err, /not the latest task/);
  approveCurrent(s);
  s.run(['queue', 'add', 'one more']);
  assert.match(s.run(['-t', b, 'end'], { input: 'all done' }).err, /1 queued task\(s\) still waiting/);
  s.run(['queue', 'clear']);
  // A task waiting for the user's go-ahead (they said stop) doesn't block the end; it stays queued.
  s.run(['queue', 'add', '--confirm', 'Low priority: persona tweaks']);

  r = s.run(['-t', b, 'end'], { input: '## Final report\nstages 0 and 1 shipped\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ended the run after b-stage-\S+: 2 task\(s\), 1 recorded decision\(s\), 1 queued task\(s\) left for the user's go-ahead/);
  assert.match(s.run(['queue', 'next']).out, /persona tweaks/, 'still queued for later');
  s.run(['queue', 'clear']);
  assert.match(s.run(['-t', b, 'end'], { input: 'again' }).err, /already ended/);

  r = s.run(['join', '--after', b, '--timeout', '1']);
  assert.equal(r.code, 10);
  assert.match(r.out, /^WORK COMPLETE/);
  assert.match(r.out, /stages 0 and 1 shipped/);
  assert.match(r.out, /## Left in the queue for your go-ahead\n- #\d+: Low priority: persona tweaks/);
  assert.match(r.out, /### a-stage-\S+ · #002 reviewer approve\n- kept the old cooldown \(safest\)/);
  assert.match(r.out, /run ended after 2 task\(s\)/);

  // A new run only collects its own decisions.
  s.run(['init', 'c-next'], { input: 'new request' });
  approveCurrent(s);
  r = s.run(['end'], { input: 'done' });
  assert.match(r.out, /1 task\(s\), 0 recorded decision/);
});

test('join --after: unresponsive implementer after DONE, snooze, and a paused queue', async () => {
  const s = sandbox({ COLLAB_IDLE_SECS: '2' });
  s.run(['init', 'idle-run'], { input: 'b' });
  const a = s.state().id;
  approveCurrent(s);
  await pause(2500);
  let r = s.run(['join', '--after', a, '--timeout', '3']);
  assert.equal(r.code, 13);
  assert.match(r.out, /^OTHER AGENT LOOKS UNRESPONSIVE: the implementer has neither started a new task nor ended the run/);
  s.run(['-t', a, 'snooze', '1']);
  assert.equal(s.run(['join', '--after', a, '--timeout', '1']).code, 11);

  s.run(['init', 'stopped'], { input: 'b' });
  s.run(['abort']);
  r = s.run(['join', '--after', a, '--timeout', '1']);
  assert.equal(r.code, 10);
  assert.match(r.out, /TASK FINISHED: ABORTED/);
});

test('decide: the user picks an option, the turn returns to the asker, and the end report lists it', async () => {
  const s = sandbox({ COLLAB_IDLE_SECS: '1', COLLAB_STALL_SECS: '1' });
  s.run(['init', 'dec'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.match(s.run(['submit', 'reviewer', 'decide'], { input: 'Which way?\n1. only one' }).err, /at least 2 numbered options/);
  assert.match(s.run(['answer', '1']).err, /no decision is pending/);

  const q = '## Drop stale replies or strip the snapshot?\n1. Strip the snapshot (Recommended)\n2) Keep it and drop stale replies\n';
  let r = s.run(['submit', 'reviewer', 'decide'], { input: q });
  assert.equal(r.code, 0, r.err);
  assert.equal(s.state().status, 'DECISION');
  assert.equal(s.state().turn, 'human');
  assert.deepEqual(s.state().decision.options, ['Strip the snapshot (Recommended)', 'Keep it and drop stale replies']);
  assert.equal(s.state().round, 1, 'a decision is not a review round');
  assert.match(s.run(['progress', 'x']).err, /no agent has the turn/);

  await pause(2200);
  r = s.run(['wait', 'implementer', '--timeout', '2']);
  assert.equal(r.code, 16, 'the other agent shows the options');
  assert.match(r.out, /^DECISION NEEDED: the reviewer asks the user to choose/);
  assert.match(r.out, /2\) Keep it and drop stale replies/);
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.equal(r.code, 11, 'shown once, and no idle or stall while the user decides');
  assert.match(r.out, /has not answered/);
  assert.equal(s.run(['wait', 'reviewer', '--timeout', '1']).code, 11, 'the asker waits for the answer');
  assert.equal(s.state().status, 'DECISION');
  assert.match(s.run(['watch', '--once']).out, /your decision: Drop stale replies or strip the snapshot\?/);

  r = s.run(['answer', '1', 'and', 'document', 'it']);
  assert.match(r.out, /back to the reviewer \(status: READY_FOR_REVIEW\)/);
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Option 1: Strip the snapshot \(Recommended\)\n\nand document it/);
  assert.equal(s.state().max_rounds, 4, 'an ordinary decision leaves the rounds alone');

  s.run(['submit', 'reviewer', 'changes'], { input: '1. strip it' });
  approveCurrent(s, 'ok', 'v2');
  r = s.run(['end'], { input: 'done' });
  assert.equal(r.code, 0, r.err);
  const entries = path.join(s.taskDir(), 'entries');
  const end = fs.readFileSync(path.join(entries, fs.readdirSync(entries).find((f) => f.endsWith('-implementer-end.md'))), 'utf8');
  assert.match(end, /user decision\nOption 1: Strip the snapshot/);
});

test('decide --self: the asker presents the options, so the other agent keeps waiting', () => {
  const s = sandbox();
  s.run(['init', 'self'], { input: 'b' });
  const r = s.run(['submit', 'implementer', 'decide', '--self'], { input: 'Pick\n1. a\n2. b\n' });
  assert.match(r.out, /Ask the user now/);
  assert.equal(s.run(['wait', 'reviewer', '--timeout', '1']).code, 11);
  assert.match(s.run(['answer', 'neither, do c']).out, /back to the implementer \(status: IMPLEMENTING\)/);
  assert.match(fs.readFileSync(path.join(s.taskDir(), 'log.md'), 'utf8'), /## User decision\nneither, do c/);
});

test('a repo root and a folder inside it are the same project; nested repos are snapshotted', () => {
  const s = sandbox();
  gitRepo(s.project);
  fs.writeFileSync(path.join(s.project, '.gitignore'), 'modules/\n');
  const mod = path.join(s.project, 'modules', 'mod-x');
  gitRepo(mod);

  let r = s.run(['init', 'from-root'], { input: 'b' });
  assert.match(r.out, /repos snapshotted: 2/);
  fs.appendFileSync(path.join(mod, 'f.txt'), 'module change\n');
  assert.match(s.run(['diff', '--stat']).out, /mod-x[\s\S]*f\.txt/, 'changes in the ignored nested repo show up');

  // Documents written into a gitignored folder show up too, but not ones that were already there.
  fs.mkdirSync(path.join(s.project, 'plans'), { recursive: true });
  fs.appendFileSync(path.join(s.project, '.gitignore'), 'plans/\n');
  fs.writeFileSync(path.join(s.project, 'plans', 'old.PLAN.md'), 'old');
  s.run(['abort']);
  s.run(['init', 'docs'], { input: 'b' });
  fs.writeFileSync(path.join(s.project, 'plans', 'handoff-r1.md'), 'draft');
  fs.writeFileSync(path.join(s.project, 'plans', 'notes.txt'), 'not markdown');
  r = s.run(['diff']);
  assert.match(r.out, /new documents git ignores \(\*\.md\):\n {2}plans\/handoff-r1\.md\n/);
  assert.match(r.out, /\+\+\+ new file: plans\/handoff-r1\.md\ndraft/);
  assert.doesNotMatch(r.out, /old\.PLAN\.md|notes\.txt/);
  s.run(['abort']);

  r = s.run(['init', 'from-module'], { input: 'module brief', cwd: mod });
  assert.equal(r.code, 0, r.err);
  assert.match(s.run(['init', 'other'], { input: 'b' }).err, /from-module-\S+' is still active in this project/);
  r = s.run(['join', '--timeout', '1']);
  assert.match(r.out, /joined task: from-module-[\s\S]*module brief/, 'reviewer at the root finds it');

  s.run(['queue', 'add', 'queued at the root']);
  assert.match(s.run(['queue', 'next'], { cwd: mod }).out, /queued at the root/);
  const sibling = path.join(s.root, 'elsewhere');
  fs.mkdirSync(sibling);
  assert.equal(s.run(['queue', 'next'], { cwd: sibling }).code, 15, 'unrelated folders stay separate');
});

test('scratch: drafts folder before init, the task folder after, cleaned with the task', () => {
  const s = sandbox();
  const drafts = path.join(s.home, 'drafts');
  assert.equal(s.run(['scratch']).out.trim(), drafts, 'no task yet: shared drafts folder');
  assert.ok(fs.existsSync(drafts));

  let r = s.run(['init', 'scr'], { input: 'b' });
  const scratch = path.join(s.taskDir(), 'scratch');
  assert.ok(r.out.includes(`scratch: ${scratch}`), r.out);
  assert.ok(fs.existsSync(scratch));
  assert.ok(s.run(['join', '--timeout', '1']).out.includes(`scratch:     ${scratch}`));
  assert.equal(s.run(['scratch']).out.trim(), scratch, 'active task: its own folder');
  const id = s.state().id;
  s.run(['abort']);
  assert.equal(s.run(['scratch']).out.trim(), drafts, 'finished task: back to drafts');
  assert.equal(s.run(['-t', id, 'scratch']).out.trim(), scratch, '-t: that task, finished or not');

  const old = path.join(drafts, 'old-brief.md');
  const fresh = path.join(drafts, 'fresh-brief.md');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(fresh, 'x');
  const past = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(old, past, past);
  r = s.run(['clean', '-y']);
  assert.match(r.out, /deleted 1 task\(s\) and 1 draft file\(s\)/);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh), 'only drafts older than a day go');
  assert.match(s.run(['clean', '-y']).out, /nothing to clean/);
});

// --- approval bound to the reviewed tree ------------------------------------------

const gitIn = (dir) => (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });

test('approve is refused when the tree changed since ready; --rereviewed covers only the refused tree', () => {
  const s = sandbox();
  gitRepo(s.project);
  const f = path.join(s.project, 'f.txt');
  s.run(['init', 'bind'], { input: 'b' });
  fs.appendFileSync(f, 'two\n');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  assert.ok(s.state().review_digest);

  fs.appendFileSync(f, 'three\n');
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 17, r.out + r.err);
  assert.match(r.out, /NOT APPROVED: the tree changed since the implementer's handoff[\s\S]*~ f\.txt/);
  assert.equal(s.state().status, 'READY_FOR_REVIEW');
  assert.ok(s.state().pending_digest);

  s.run(['diff']);
  s.run(['diff', '--stat']);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 17, 'diff does not clear the refusal');

  fs.appendFileSync(f, 'four\n');
  r = s.run(['submit', 'reviewer', 'approve', '--rereviewed'], { input: 'ok' });
  assert.equal(r.code, 17, 'changed again after the refusal');
  assert.match(r.out, /since your approve was refused[\s\S]*~ f\.txt/);

  r = s.run(['submit', 'reviewer', 'approve', '--rereviewed'], { input: 'ok' });
  assert.equal(r.code, 10, r.out + r.err);
  assert.equal(s.state().status, 'DONE');
  assert.match(s.run(['verify']).out, /verified/);

  fs.writeFileSync(path.join(s.project, 'late.txt'), 'x\n');
  r = s.run(['verify']);
  assert.equal(r.code, 17);
  assert.match(r.out, /TREE CHANGED[\s\S]*\+ late\.txt/);
  fs.rmSync(path.join(s.project, 'late.txt'));
  const g = gitIn(s.project);
  g('add', '-A');
  g('commit', '-qm', 'approved work');
  assert.equal(s.run(['verify']).code, 0, 'committing the approved tree keeps it verified');
  assert.equal(s.run(['submit', 'implementer', 'ready', '--rereviewed'], { input: 'x' }).code, 1);
});

test('the digest covers untracked files, new ignored docs and assume-unchanged / skip-worktree paths', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = gitIn(s.project);
  const p = (f) => path.join(s.project, f);
  fs.writeFileSync(p('.gitignore'), 'notes/\n');
  fs.writeFileSync(p('skip.txt'), 'skip\n');
  fs.writeFileSync(p('assume.txt'), 'assume\n');
  g('add', '.gitignore', 'skip.txt', 'assume.txt');
  g('commit', '-qm', 'more');
  g('update-index', '--skip-worktree', 'skip.txt');
  g('update-index', '--assume-unchanged', 'assume.txt');
  fs.writeFileSync(p('old-untracked.txt'), 'old\n');
  fs.mkdirSync(p('notes'));

  const cases = [
    ['untracked file created', () => fs.writeFileSync(p('new.txt'), 'n\n'), /\+ new\.txt/],
    ['pre-existing untracked file edited', () => fs.appendFileSync(p('old-untracked.txt'), 'more\n'), /~ old-untracked\.txt/],
    ['new ignored doc edited', () => fs.appendFileSync(p('notes/plan.md'), 'edit\n'), /~ notes\/plan\.md/, () => fs.writeFileSync(p('notes/plan.md'), 'plan\n')],
    ['skip-worktree file edited', () => fs.appendFileSync(p('skip.txt'), 'edit\n'), /~ skip\.txt/],
    ['assume-unchanged file edited', () => fs.appendFileSync(p('assume.txt'), 'edit\n'), /~ assume\.txt/],
  ];
  for (const [name, mutate, re, before] of cases) {
    s.run(['init', 'cover'], { input: 'b' });
    if (before) before();
    assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0, name);
    mutate();
    const r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
    assert.equal(r.code, 17, `${name}: ${r.out}${r.err}`);
    assert.match(r.out, re, name);
    s.run(['abort']);
  }
});

test('the digest never writes to the git index or object store, even after a stat-only change', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = gitIn(s.project);
  const idx = path.join(s.project, '.git', 'index');
  s.run(['init', 'readonly'], { input: 'b' });
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(s.project, 'f.txt'), later, later);
  fs.writeFileSync(path.join(s.project, 'new.txt'), 'n\n');
  const index0 = fs.readFileSync(idx);
  const objects0 = g('count-objects', '-v').stdout;
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10);
  assert.equal(s.run(['verify']).code, 0);
  assert.ok(fs.readFileSync(idx).equals(index0), 'index is byte-identical');
  assert.equal(g('count-objects', '-v').stdout, objects0, 'no objects written');
});

test('a nested repo counts by its checked-out commit and its own content; uncovered ones fail closed', () => {
  const s = sandbox();
  gitRepo(s.project);
  const mod = path.join(s.project, 'mod');
  gitRepo(mod);
  const gm = gitIn(mod);
  s.run(['init', 'nested'], { input: 'b' });
  gm('commit', '-q', '--allow-empty', '-m', 'B');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  gm('commit', '-q', '--allow-empty', '-m', 'C (same tree as B)');
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 17, r.out + r.err);
  assert.match(r.out, /~ mod/);
  s.run(['abort']);

  s.run(['init', 'nested-dirty'], { input: 'b' });
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  fs.appendFileSync(path.join(mod, 'f.txt'), 'dirty\n');
  r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 17);
  assert.match(r.out, /mod:\n {2}\+ f\.txt/);
  s.run(['abort']);

  s.run(['init', 'uncovered'], { input: 'b' });
  gitRepo(path.join(s.project, 'late-repo'));
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot compute the tree digest: a changed folder is not one of this task's snapshotted repos/);
  assert.equal(s.state().status, 'IMPLEMENTING');
});

test('a file named __proto__ is covered during review and after approval', () => {
  const s = sandbox();
  gitRepo(s.project);
  const proto = path.join(s.project, '__proto__');
  fs.writeFileSync(proto, 'a\n');
  s.run(['init', 'proto'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  fs.writeFileSync(proto, 'b\n');
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 17, r.out + r.err);
  assert.match(r.out, /~ __proto__/);
  assert.equal(s.run(['submit', 'reviewer', 'approve', '--rereviewed'], { input: 'ok' }).code, 10);
  fs.writeFileSync(proto, 'c\n');
  r = s.run(['verify']);
  assert.equal(r.code, 17);
  assert.match(r.out, /~ __proto__/);
});

test('a tracked gitlink counts even when git config ignores submodule changes', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = gitIn(s.project);
  const mod = path.join(s.project, 'mod');
  gitRepo(mod);
  const gm = gitIn(mod);
  g('add', 'mod');
  g('commit', '-qm', 'add gitlink');
  g('config', 'diff.ignoreSubmodules', 'all');
  g('config', 'submodule.mod.ignore', 'all');
  s.run(['init', 'gitlink'], { input: 'b' });
  assert.match(s.run(['status']).out, /gitlink/);
  gm('commit', '-q', '--allow-empty', '-m', 'B');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
  gm('commit', '-q', '--allow-empty', '-m', 'C (same tree as B)');
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 17, r.out + r.err);
  assert.match(r.out, /~ mod/);
  assert.equal(s.run(['submit', 'reviewer', 'approve', '--rereviewed'], { input: 'ok' }).code, 10);
  gm('commit', '-q', '--allow-empty', '-m', 'D');
  r = s.run(['verify']);
  assert.equal(r.code, 17, r.out + r.err);
  assert.match(r.out, /~ mod/);
});

test('the reviewer gets earlier blocking items of its phase and the approved plan', () => {
  const s = sandbox();
  const reviewerWait = () => s.run(['wait', 'reviewer', '--timeout', '1']).out;
  s.run(['init', 'recap'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  let out = reviewerWait();
  assert.doesNotMatch(out, /earlier blocking items|approved plan/, 'round 1: nothing to recap, no plan');
  s.run(['submit', 'reviewer', 'changes'], {
    input: '## Verdict: changes requested\n1. [blocking] parser.ts:12 — null deref\n   → guard it before use\n2. [should-fix] rename b\n## Nits\n- spacing\n',
  });
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1) [Blocking] still racy on Windows\n\nunrelated prose\n' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v3' });
  out = reviewerWait();
  assert.match(out, /----- earlier blocking items \(from collab\)[^\n]*\nround 1 \(#002\):\n1\. \[blocking\] parser\.ts:12 — null deref\n {3}→ guard it before use\nround 2 \(#004\):\n1\) \[Blocking\] still racy on Windows\n----- end -----/);
  assert.doesNotMatch(out, /rename b|spacing|unrelated prose|approved plan/);

  s.run(['abort']);
  s.run(['init', 'planned', '--plan'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'plan v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] step 3 is missing' });
  s.run(['submit', 'implementer', 'plan'], { input: 'plan v2' });
  out = reviewerWait();
  assert.match(out, /plan round 1 \(#002\):\n1\. \[blocking\] step 3 is missing/);
  assert.doesNotMatch(out, /approved plan/);
  s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });
  s.run(['submit', 'implementer', 'ready'], { input: 'built' });
  out = reviewerWait();
  assert.doesNotMatch(out, /earlier blocking items/, 'plan-phase blockers stay in the plan phase');
  const id = s.state().id;
  assert.ok(out.includes(`approved plan: #003 (read it with 'collab -t ${id} show 3')`), out);
});

test('a build ready needs a closeout with all four labels', () => {
  const s = sandbox();
  const ready = (input) => s.run(['submit', 'implementer', 'ready'], { input, raw: true });
  s.run(['init', 'closeout', '--plan'], { input: 'b' });
  assert.equal(s.run(['submit', 'implementer', 'plan'], { input: 'plan without closeout', raw: true }).code, 0, 'plans are not checked');
  s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });

  const before = s.state();
  let r = ready('## Summary\ndid it\n## How to verify\nnpm test\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /'## Closeout' section with the labels 'Verified:', 'Attempted, blocked:', 'Deferred:', 'Not claimed:'/);
  r = ready('## Summary\nx\n## Closeout\nVerified: npm test, 12 pass\nDeferred: none\n## Decisions taken\nNot claimed: outside the section\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /labels 'Attempted, blocked:', 'Not claimed:'/);
  assert.equal(s.state().seq, before.seq, 'nothing written');
  assert.equal(s.state().status, 'IMPLEMENTING');

  r = ready('## Summary\nx\n## Closeout\n- **Verified:** npm test, 12 pass\n- Attempted-blocked: none\n> _Deferred_: docs, tracked in #12\n**NOT CLAIMED:** Windows\n');
  assert.equal(r.code, 0, r.err);
  assert.equal(s.state().status, 'READY_FOR_REVIEW');
});

test('the summary template in SKILL.md passes the closeout check as written', () => {
  const s = sandbox();
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const tpl = skill.match(/using this summary:\n {3}```\n([\s\S]*?)\n {3}```/);
  assert.ok(tpl, 'template found');
  s.run(['init', 'template'], { input: 'b' });
  const r = s.run(['submit', 'implementer', 'ready'], { input: tpl[1].replace(/^ {3}/gm, ''), raw: true });
  assert.equal(r.code, 0, r.err);
});

test('collab end collects each task\'s last closeout and the reviewer\'s briefing for the user', () => {
  const s = sandbox();
  const closeout = (v) => `## Closeout\nVerified: ${v}\nAttempted, blocked: none\nDeferred: none\nNot claimed: perf\n`;
  s.run(['init', 'a-task'], { input: 'b' });
  const a = s.state().id;
  s.run(['submit', 'implementer', 'ready'], { input: `## Summary\nv1\n${closeout('first try')}` });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] fix x' });
  s.run(['submit', 'implementer', 'ready'], { input: `## Summary\nv2\n${closeout('npm test, 40 pass')}` });
  s.run(['submit', 'reviewer', 'approve'], { input: '## Verdict: approved\n## For the user\n- try a 2 GB file by hand\n## Nits\n- naming\n' });

  // An older task: its ready predates closeouts (the entry is rewritten as such a task wrote it).
  s.run(['init', 'b-old'], { input: 'b' });
  const b = s.state().id;
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  fs.writeFileSync(path.join(s.taskDir(), 'entries', '001-implementer-ready.md'), '## Summary\nold style\n## How to verify\nnpm test\n');
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });

  // A planned task the user approved at the round limit: its only approve is the plan's.
  s.run(['init', 'c-limit', '--plan', '--max-rounds', '1'], { input: 'b' });
  const c = s.state().id;
  s.run(['submit', 'implementer', 'plan'], { input: 'p' });
  s.run(['submit', 'reviewer', 'approve'], { input: '## Verdict: plan ok\n## For the user\nPLAN BRIEFING\n' });
  s.run(['submit', 'implementer', 'ready'], { input: `## Summary\nc\n${closeout('c checks')}` });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] still wrong' });
  s.run(['answer', '2']);
  assert.equal(s.state().status, 'DONE');

  assert.equal(s.run(['end'], { input: '## Final report\nall done\n' }).code, 0);
  const report = s.run(['show']).out;
  const at = (str) => { const i = report.indexOf(str); assert.ok(i >= 0, `missing: ${str}\n${report}`); return i; };
  assert.ok(at('## Closeouts (collected by collab)') < at('## For the user, from the reviewer (collected by collab)'));
  assert.ok(at('## For the user, from the reviewer') < at('## Decisions recorded during this run'));
  assert.match(report, new RegExp(`### ${a}\\nVerified: npm test, 40 pass\\n`));
  assert.doesNotMatch(report, /first try/, 'only the last ready counts');
  assert.match(report, new RegExp(`### ${b}\\nno structured closeout recorded for this task`));
  assert.match(report, new RegExp(`### ${c}\\nVerified: c checks`));
  assert.match(report, new RegExp(`## For the user, from the reviewer \\(collected by collab\\)\\n### ${a}\\n- try a 2 GB file by hand\\n\\n## Decisions`));
  assert.doesNotMatch(report, /PLAN BRIEFING|naming/);
});

test('symlinks are signed by their target', { skip: process.platform === 'win32' }, () => {
  const s = sandbox();
  gitRepo(s.project);
  const link = path.join(s.project, 'link');
  s.run(['init', 'link'], { input: 'b' });
  fs.symlinkSync('f.txt', link);
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  fs.unlinkSync(link);
  fs.symlinkSync('elsewhere.txt', link);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 17);
});

test('tasks without a recorded digest, plan approvals, no repos and the round-limit override', () => {
  const s = sandbox();
  s.run(['init', 'norepo'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  let r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 10);
  assert.match(r.out, /not bound to the files/);
  assert.match(s.run(['verify']).out, /nothing to verify/);

  gitRepo(s.project);
  s.run(['init', 'old'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  const sp = path.join(s.taskDir(), 'state.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete st.review_digest;
  fs.writeFileSync(sp, JSON.stringify(st));
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'edit\n');
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10, 'old state approves as before');
  r = s.run(['verify']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no approved tree recorded/);

  s.run(['init', 'planned', '--plan', '--max-rounds', '1'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p' });
  fs.appendFileSync(path.join(s.project, 'f.txt'), 'during plan review\n');
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' }).code, 0, 'plan approvals are not bound');
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. fix it' });
  assert.equal(s.state().status, 'DECISION');
  r = s.run(['answer', '2']);
  assert.match(r.out, /the task is DONE/);
  assert.equal(s.run(['verify']).code, 0, 'the user-approved tree is recorded');
});

// --- project lessons ---------------------------------------------------------------

const lessonsMd = (dir) => path.join(dir, '.collab', 'lessons.md');

test('lessons: .collab/lessons.md in the project; add, list, rm, hand edits and the length limit', () => {
  const s = sandbox();
  const sub = path.join(s.project, 'module');
  const other = path.join(s.root, 'other');
  fs.mkdirSync(sub);
  fs.mkdirSync(other);
  assert.match(s.run(['lessons']).out, /no lessons yet/);
  let r = s.run(['lessons', 'add', 'Run', 'npm', 'test', 'before', 'handing', 'off.']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /added lesson #1 to .*lessons\.md\ncreated .*commit it/);
  assert.match(fs.readFileSync(lessonsMd(s.project), 'utf8'),
    /^# Project lessons\n\n[\s\S]*\n\n- Run npm test before handing off\. <!-- collab: by user, \d{4}-\d\d-\d\d -->\n$/);
  assert.match(s.run(['lessons', 'add', 'run npm test  before handing off']).out, /already known/);
  r = s.run(['lessons', 'add', 'Use path.join, never string concatenation']);
  assert.match(r.out, /#2/);
  assert.doesNotMatch(r.out, /created/);
  r = s.run(['lessons', 'add', 'x'.repeat(301)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /at most 300 characters \(got 301\)/);
  assert.equal(s.run(['lessons', 'add', 'x'.repeat(300)]).code, 0, 'exactly the limit is fine');

  r = s.run(['lessons'], { cwd: sub });
  assert.match(r.out, /#1 +Run npm test before handing off\. +\(user\)[\s\S]*#2 /, 'a folder inside the project shares them');
  assert.ok(!fs.existsSync(lessonsMd(sub)));
  assert.match(s.run(['lessons'], { cwd: other }).out, /no lessons/, 'unrelated folders do not');
  assert.equal(s.run(['lessons', 'add', 'other project lesson'], { cwd: other }).code, 0);
  assert.ok(fs.existsSync(lessonsMd(other)));

  // Numbers are positions: all of them are removed, or none.
  r = s.run(['lessons', 'rm', '3', '9']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no lesson #9/);
  assert.match(s.run(['lessons']).out, /#3 +x{300}/);
  assert.match(s.run(['lessons', 'rm', '3']).out, /removed: x{300}/);
  assert.match(s.run(['lessons'], { cwd: other }).out, /other project lesson/);
  assert.equal(s.run(['lessons', 'rm', 'x']).code, 1);
  assert.equal(s.run(['lessons', 'bogus']).code, 1);

  // People edit the file by hand: their bullets count, the rest of the file is left alone.
  fs.appendFileSync(lessonsMd(s.project), '\nSome notes for the team.\n\n- Hand-written lesson\n  that goes on here\n');
  r = s.run(['lessons']);
  assert.match(r.out, /#3 +Hand-written lesson that goes on here\n/);
  s.run(['lessons', 'add', 'after the hand edit']);
  s.run(['lessons', 'rm', '1']);
  const md = fs.readFileSync(lessonsMd(s.project), 'utf8');
  assert.match(md, /^# Project lessons\n[\s\S]*\n- Use path\.join[^\n]*\n\nSome notes for the team\.\n\n- Hand-written lesson\n  that goes on here\n- after the hand edit <!-- collab: by user/);
  assert.doesNotMatch(md, /npm test/);

  // CRLF files stay CRLF.
  fs.writeFileSync(lessonsMd(other), '# Lessons\r\n\r\n- one\r\n');
  s.run(['lessons', 'add', 'two'], { cwd: other });
  assert.match(fs.readFileSync(lessonsMd(other), 'utf8'), /^# Lessons\r\n\r\n- one\r\n- two <!-- collab: by user, [\d-]+ -->\r\n$/);
});

test("lessons: agents record them from handoffs, briefs carry them, end lists the run's", () => {
  const s = sandbox();
  s.run(['lessons', 'add', 'Keep collab.js dependency-free']);
  s.run(['init', 'first'], { input: 'b' });
  assert.match(fs.readFileSync(path.join(s.taskDir(), 'entries', '000-implementer-brief.md'), 'utf8'),
    /## Project lessons \(set by collab, from \.collab\/lessons\.md\)\n[^\n]*current instructions[^\n]*\n- #1 Keep collab\.js dependency-free\n/);

  // A refused submit records nothing.
  let r = s.run(['submit', 'reviewer', 'changes'], { input: '## Lessons\n- refused lesson\n' });
  assert.equal(r.code, 1);
  s.run(['note', '-i', 'please also do Y']);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1\n## Lessons\n- note-refused lesson\n' });
  assert.equal(r.code, 12);
  assert.doesNotMatch(s.run(['lessons']).out, /refused lesson/);

  const long = `- ${'y'.repeat(301)}`;
  r = s.run(['submit', 'implementer', 'ready'], {
    input: `v1\n${CLOSEOUT}## Lessons\n- Tests on Windows need\n  forward slashes in globs\n- keep collab.js dependency-free.\n${long}\n- none\n`,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lessons recorded: #2 in .*lessons\.md/);
  assert.match(r.out, /already known, not added again: 1/);
  assert.match(r.out, /lesson not recorded \(over 300 characters\): y{60}…/);
  r = s.run(['submit', 'reviewer', 'changes'], { input: `1. fix\n## Lessons\n${[1, 2, 3, 4, 5, 6].map((n) => `${n}. lesson ${n}`).join('\n')}\n` });
  assert.match(r.out, /lessons recorded: #3, #4, #5, #6, #7 [\s\S]*at most 5 per message\): 1/);
  r = s.run(['lessons']);
  assert.match(r.out, /#2 +Tests on Windows need forward slashes in globs +\(implementer, first-/);
  assert.match(r.out, /#7 +lesson 5 +\(reviewer, first-/);
  assert.doesNotMatch(r.out, /lesson 6|none|y{10}/);
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });

  // The next brief has them; the brief keeps the newest 30.
  for (let i = 8; i <= 32; i++) s.run(['lessons', 'add', `bulk lesson ${i}`]);
  s.run(['init', 'second'], { input: 'b' });
  const brief = fs.readFileSync(path.join(s.taskDir(), 'entries', '000-implementer-brief.md'), 'utf8');
  assert.doesNotMatch(brief, /#1 Keep/);
  assert.match(brief, /- #3 lesson 1\n[\s\S]*- #32 bulk lesson 32\n\(2 older lesson\(s\) not shown: 'collab lessons'\)/);
  s.run(['lessons', 'rm', '5']);
  approveCurrent(s);
  r = s.run(['end'], { input: 'done' });
  assert.equal(r.code, 0, r.err);
  const report = s.run(['show']).out;
  assert.match(report, /## Lessons recorded during this run \(collected by collab\)\n.*commit them.*\n### \.collab\/lessons\.md \(remove with 'collab lessons rm N --dir [^']+'\)\n- #2 \(implementer\) Tests on Windows/);
  assert.match(report, /- #6 \(reviewer\) lesson 5/);
  assert.doesNotMatch(report, /bulk lesson|lesson 3\b/, "only lessons from the run's tasks, and not removed ones");
});

test('lessons: the file never counts as a project change (diff, scope, approval, verify)', () => {
  const s = sandbox();
  gitRepo(s.project);
  const sub = path.join(s.project, 'src');
  fs.mkdirSync(sub);
  s.run(['init', 'git-lessons', '--scope', 'src/**'], { input: 'b' });
  fs.writeFileSync(path.join(sub, 'a.js'), 'x\n');
  let r = s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- from the implementer\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created .*lessons\.md: it belongs to the project, commit it/);
  assert.ok(fs.existsSync(lessonsMd(s.project)), 'at the repo top level');

  r = s.run(['diff']);
  assert.doesNotMatch(r.out, /lessons\.md|OUTSIDE SCOPE/);
  assert.match(r.out, /src\/a\.js[\s\S]*scope: all changes are inside src\/\*\*/);

  // A lesson recorded from a subfolder goes to the same file; approving after it still works.
  s.run(['lessons', 'add', 'added during the review'], { cwd: sub });
  r = s.run(['submit', 'reviewer', 'approve'], { input: `ok\n## Lessons\n- from the reviewer\n` });
  assert.equal(r.code, 10, r.out + r.err);
  assert.equal(s.state().status, 'DONE');
  assert.equal(s.run(['verify']).code, 0);
  assert.equal(s.run(['lessons']).out.match(/^#\d/gm).length, 3);
});

// --- phone notifications -------------------------------------------------------------

// A local stand-in for ntfy that records each push (hang: accept but never answer).
async function pushServer({ hang = false } = {}) {
  const http = require('http');
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ title: req.headers.title, priority: req.headers.priority, body });
      if (!hang) res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/topic`;
  // Pushes come from detached processes, a little after the command returns.
  const until = async (n, ms = 10000) => {
    const t = Date.now();
    while (got.length < n && Date.now() - t < ms) await pause(50);
    return got;
  };
  const close = () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); };
  return { got, url, until, close };
}

test('phone: only --phone tasks push, ordinary handoffs never do, end does', async () => {
  const p = await pushServer();
  try {
    const s = sandbox({ COLLAB_PHONE_URL: p.url });
    s.run(['init', 'a-quiet'], { input: 'b' });
    s.run(['submit', 'implementer', 'decide', '--self'], { input: 'Pick\n1. a\n2. b\n' });
    s.run(['answer', '1']);
    approveCurrent(s);

    let r = s.run(['init', 'b-loud', '--phone'], { input: 'b' });
    assert.ok(r.out.includes(`pushes go to ${p.url}`), r.out);
    assert.match(r.out, /options: .*phone notifications/);
    s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
    s.run(['submit', 'reviewer', 'changes'], { input: '1. fix' });
    s.run(['progress', 'fixing']);
    approveCurrent(s);
    assert.equal(s.state().status, 'DONE');
    r = s.run(['end'], { input: 'all done' });
    assert.equal(r.code, 0, r.err);
    await p.until(1);
    await pause(1000);
    assert.equal(p.got.length, 1, JSON.stringify(p.got));
    assert.match(p.got[0].title, /^collab: b-loud-/);
    assert.match(p.got[0].body, /^Work complete: 2 task\(s\)/);
  } finally { p.close(); }
});

test('phone: decisions, the round limit, escalations and a confirm-first queued task push', async () => {
  const p = await pushServer();
  try {
    const s = sandbox({ COLLAB_PHONE_URL: p.url });
    s.run(['init', 'ask', '--phone'], { input: 'b' });
    s.run(['submit', 'implementer', 'decide'], { input: '## Which storage?\n1. json\n2. sqlite\n' });
    let got = await p.until(1);
    assert.equal(got[0].body, 'Decision needed: Which storage?');
    assert.equal(got[0].priority, 'high');
    s.run(['answer', '1']);
    s.run(['abort']);

    s.run(['init', 'limit', '--phone', '--max-rounds', '1'], { input: 'b' });
    s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
    s.run(['submit', 'reviewer', 'changes'], { input: '1. still broken' });
    assert.equal(s.state().status, 'DECISION');
    got = await p.until(2);
    assert.match(got[1].body, /^Decision needed: Round limit reached/);
    s.run(['answer', '3']);

    s.run(['init', 'esc', '--phone'], { input: 'b' });
    s.run(['submit', 'reviewer', 'escalate'], { input: 'Missing credentials for the API\n' });
    got = await p.until(3);
    assert.equal(got[2].body, 'Escalated by the reviewer: Missing credentials for the API');

    // Confirm-first: pushed while a --phone run continues (its last task approved, not ended).
    s.run(['init', 'run', '--phone'], { input: 'b' });
    approveCurrent(s);
    s.run(['queue', 'add', '--confirm', 'Run the DB migration']);
    assert.match(s.run(['queue', 'next']).out, /CONFIRM FIRST/);
    got = await p.until(4);
    assert.match(got[3].body, /^Queued task #1 needs your go-ahead: Run the DB migration/);
  } finally { p.close(); }
});

test('phone: unresponsive agents and stalls push', async () => {
  const p = await pushServer();
  try {
    const s = sandbox({ COLLAB_PHONE_URL: p.url, COLLAB_IDLE_SECS: '2', COLLAB_QUIET_MINS: '0' });
    s.run(['init', 'idle', '--phone'], { input: 'b' });
    await pause(2500);
    let r = s.run(['wait', 'reviewer', '--timeout', '3']);
    assert.equal(r.code, 13, r.out);
    let got = await p.until(1);
    assert.match(got[0].body, /^the implementer has not handed off .*Stop or keep waiting\?$/);

    const id = s.state().id;
    approveCurrent(s);
    await pause(2500);
    r = s.run(['join', '--after', id, '--timeout', '3']);
    assert.equal(r.code, 13, r.out);
    got = await p.until(2);
    assert.match(got[1].body, /^the implementer has neither started a new task nor ended the run/);

    const t = sandbox({ COLLAB_PHONE_URL: p.url, COLLAB_STALL_SECS: '2' });
    t.run(['init', 'stall', '--phone'], { input: 'b' });
    await pause(2500);
    assert.equal(t.run(['wait', 'reviewer', '--timeout', '3']).code, 10);
    got = await p.until(3);
    assert.match(got[2].body, /^STALLED/);
  } finally { p.close(); }
});

test('phone: --phone carries on only through an approved run that was not ended', async () => {
  const s = sandbox({ COLLAB_PHONE_URL: 'http://127.0.0.1:9/never' });
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  const phone = () => !!(s.state().options || {}).phone;

  s.run(['init', 'a', '--phone'], { input: 'b' });
  approveCurrent(s);
  s.run(['init', 'b'], { input: 'b' });
  assert.ok(phone(), 'the next task of the run inherits it');
  const r = s.run(['init', 'x'], { input: 'b', cwd: other });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /phone/, 'not another project');
  approveCurrent(s);
  s.run(['end'], { input: 'done' });
  s.run(['init', 'c'], { input: 'b' });
  assert.ok(!phone(), 'not after end');

  // A sandbox each, so the finished task is surely the project's latest one.
  const finishes = {
    ABORTED: (u) => u.run(['abort']),
    ESCALATED: (u) => u.run(['submit', 'implementer', 'escalate'], { input: 'blocked' }),
  };
  for (const [status, finish] of Object.entries(finishes)) {
    const u = sandbox({ COLLAB_PHONE_URL: 'http://127.0.0.1:9/never' });
    u.run(['init', 'd', '--phone'], { input: 'b' });
    finish(u);
    assert.equal(u.state().status, status);
    u.run(['init', 'e'], { input: 'b' });
    assert.ok(!(u.state().options || {}).phone, `not after ${status}`);
  }

  const t = sandbox({ COLLAB_PHONE_URL: 'http://127.0.0.1:9/never', COLLAB_STALL_SECS: '1' });
  t.run(['init', 'a', '--phone'], { input: 'b' });
  await pause(1500);
  assert.equal(t.run(['wait', 'reviewer', '--timeout', '2']).code, 10);
  assert.equal(t.state().status, 'STALLED');
  t.run(['init', 'b'], { input: 'b' });
  assert.ok(!(t.state().options || {}).phone, 'not after STALLED');
});

test('phone: set, show, test, and the first --phone creates a private topic', async () => {
  const s = sandbox({ COLLAB_PHONE_URL: '' });
  assert.match(s.run(['phone']).out, /aren't set up/);
  assert.equal(s.run(['phone', 'test']).code, 1);
  let r = s.run(['init', 'first', '--phone'], { input: 'b' });
  const m = r.out.match(/phone: +NEW, tell the user: subscribe to topic '(collab-[0-9a-f]{16})' in the ntfy app/);
  assert.ok(m, r.out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).phone_url, `https://ntfy.sh/${m[1]}`);
  approveCurrent(s);
  r = s.run(['init', 'second'], { input: 'b' });
  assert.match(r.out, new RegExp(`phone: +subscribe to topic '${m[1]}'`), 'same topic, not a new one');
  assert.match(s.run(['phone']).out, new RegExp(m[1]));

  assert.equal(s.run(['phone', 'set', 'bad topic!']).code, 1);
  assert.match(s.run(['phone', 'set', 'my_topic-1']).out, /topic 'my_topic-1'/);
  assert.match(s.run(['phone', 'set', 'https://push.example.com/t']).out, /pushes go to https:\/\/push\.example\.com\/t/);

  const p = await pushServer();
  try {
    // spawnSync would block this process's server, so the test push runs asynchronously.
    const { spawn } = require('child_process');
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, 'phone', 'test'], { env: { ...process.env, COLLAB_HOME: s.home, COLLAB_PHONE_URL: p.url } });
      c.on('exit', resolve);
    });
    assert.equal(code, 0);
    assert.equal(p.got[0].body, 'Test notification from collab');
  } finally { p.close(); }
  r = s.run(['phone', 'test'], { env: { COLLAB_PHONE_URL: 'http://127.0.0.1:9/closed' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /push to http:\/\/127\.0\.0\.1:9\/closed failed/);
});

test('phone: a slow or unreachable server never delays or changes a handoff', async () => {
  const p = await pushServer({ hang: true });
  try {
    for (const url of [p.url, 'http://127.0.0.1:9/closed']) {
      const s = sandbox({ COLLAB_PHONE_URL: url });
      s.run(['init', 'slow', '--phone'], { input: 'b' });
      const t = Date.now();
      const r = s.run(['submit', 'implementer', 'decide'], { input: 'Pick\n1. a\n2. b\n' });
      assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
      assert.equal(r.code, 0, r.err);
      assert.equal(s.state().status, 'DECISION');
      assert.equal(s.run(['answer', '2']).code, 0);
    }
    await p.until(1);
    assert.equal(p.got.length, 1, 'the hanging server did receive its push');
  } finally { p.close(); }
});

test('tasks created in the same second keep their creation order (phone inheritance, queue push)', async () => {
  // Make every task of the sandbox look created in the same second, so only created_ms orders them.
  const tie = (s) => {
    for (const id of fs.readdirSync(path.join(s.home, 'tasks'))) {
      const f = path.join(s.home, 'tasks', id, 'state.json');
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      st.created_epoch = 1700000000;
      fs.writeFileSync(f, JSON.stringify(st));
    }
  };
  const phone = (s) => !!(s.state().options || {}).phone;
  const env = { COLLAB_PHONE_URL: 'http://127.0.0.1:9/never' };

  // A newer task that ended without approval (slug sorting before the approved one) stops the run.
  const setStatus = (s, status) => {
    const f = path.join(s.taskDir(), 'state.json');
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(st, { status, turn: 'none' });
    fs.writeFileSync(f, JSON.stringify(st));
  };
  for (const status of ['ABORTED', 'ESCALATED', 'STALLED']) {
    const s = sandbox(env);
    s.run(['init', 'z-prior', '--phone'], { input: 'b' });
    approveCurrent(s);
    s.run(['init', 'a-later'], { input: 'b' });
    setStatus(s, status);
    tie(s);
    s.run(['init', 'c-fresh'], { input: 'b' });
    assert.ok(!phone(s), `not after a newer ${status} task`);
  }

  // A newer task whose run was ended stops it too.
  let s = sandbox(env);
  s.run(['init', 'z-prior', '--phone'], { input: 'b' });
  approveCurrent(s);
  s.run(['init', 'a-later'], { input: 'b' });
  approveCurrent(s);
  assert.equal(s.run(['end'], { input: 'done' }).code, 0);
  tie(s);
  s.run(['init', 'c-fresh'], { input: 'b' });
  assert.ok(!phone(s), 'not after the newer task ended the run');

  // And a newer approved --phone task carries on, even though an older one sorts after it.
  s = sandbox(env);
  s.run(['init', 'z-prior'], { input: 'b' });
  approveCurrent(s);
  s.run(['init', 'a-later', '--phone'], { input: 'b' });
  approveCurrent(s);
  tie(s);
  s.run(['queue', 'add', '--confirm', 'later']);
  const p = await pushServer();
  try {
    s.run(['queue', 'next'], { env: { COLLAB_PHONE_URL: p.url } });
    assert.match((await p.until(1))[0]?.body || '', /needs your go-ahead/, 'the queue push follows the newest task too');
  } finally { p.close(); }
  s.run(['init', 'c-fresh', '--from-queue', '--confirmed', 'go'], { input: 'b' });
  assert.ok(phone(s), 'inherited from the newest task');


  // Older tasks without created_ms still sort by their creation second.
  const t = sandbox();
  t.run(['init', 'a-old'], { input: 'b' });
  approveCurrent(t);
  t.run(['init', 'z-old'], { input: 'b' });
  approveCurrent(t);
  for (const [slug, epoch] of [['a-old', 1700000100], ['z-old', 1700000000]]) {
    const id = fs.readdirSync(path.join(t.home, 'tasks')).find((n) => n.startsWith(slug));
    const f = path.join(t.home, 'tasks', id, 'state.json');
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete st.created_ms;
    st.created_epoch = epoch;
    fs.writeFileSync(f, JSON.stringify(st));
  }
  assert.match(t.run(['path']).out, /a-old-/, 'the later creation second wins');
});

test('phone set rejects malformed URLs; lessons --dir lists another folder', () => {
  const s = sandbox({ COLLAB_PHONE_URL: '' });
  for (const bad of ['http://[invalid', 'http://', 'https://host:99999/t', 'ftp://host/t', 'http//host']) {
    const r = s.run(['phone', 'set', bad]);
    assert.equal(r.code, 1, bad);
    assert.ok(!fs.existsSync(path.join(s.home, 'config.json')), `nothing saved for ${bad}`);
  }
  assert.equal(s.run(['phone', 'set', 'http://ntfy.home.lan:8080/collab']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).phone_url, 'http://ntfy.home.lan:8080/collab');

  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  s.run(['lessons', 'add', '--dir', other, 'only over there']);
  let r = s.run(['lessons', '--dir', other]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /only over there/);
  r = s.run(['lessons', 'list', '--dir', other]);
  assert.match(r.out, /only over there/);
  assert.match(s.run(['lessons']).out, /no lessons/);
});

test('lessons: hand-written lessons over the limit stay in the file but never reach a brief', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.project, '.collab'));
  const md = `# L\n\n- ${'z'.repeat(12000)}\n- long\n${'  more words here\n'.repeat(30)}- fine one\n`;
  fs.writeFileSync(lessonsMd(s.project), md);
  let r = s.run(['init', 'long'], { input: 'b' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lessons: #1, #2 over 300 characters, left out of the brief: shorten them in .*lessons\.md/);
  const brief = fs.readFileSync(path.join(s.taskDir(), 'entries', '000-implementer-brief.md'), 'utf8');
  assert.ok(brief.length < 1500, `brief is ${brief.length} chars`);
  assert.match(brief, /- #3 fine one\n\(2 lesson\(s\) over 300 characters left out: shorten them in \.collab\/lessons\.md\)/);
  assert.equal(fs.readFileSync(lessonsMd(s.project), 'utf8'), md, 'the file is left as it is');
  r = s.run(['lessons']);
  assert.match(r.out, /#1 +\(over 300 characters, not put into briefs: shorten it\) z{60}…\n#2 +\(over 300 characters[^\n]*\) long more words here/);
  assert.match(r.out, /#3 +fine one/);
  assert.match(s.run(['lessons', 'rm', '1']).out, /removed: z+/);
  assert.match(s.run(['lessons']).out, /^#1 +\(over 300[\s\S]*#2 +fine one/m);
});

test('lessons: numbers skip empty bullets and agree between add, list and rm', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.project, '.collab'));
  fs.writeFileSync(lessonsMd(s.project), '- first\n- <!-- comment only -->\n-   \n- second\n');
  assert.match(s.run(['lessons', 'add', 'third']).out, /added lesson #3 /);
  assert.match(s.run(['lessons']).out, /^#1 +first\n#2 +second\n#3 +third  \(user\)$/m);
  assert.match(s.run(['lessons', 'rm', '3']).out, /removed: third/);
  assert.equal(fs.readFileSync(lessonsMd(s.project), 'utf8'), '- first\n- <!-- comment only -->\n-   \n- second\n');
});

test('lessons: code fences and HTML comments are never lessons, and an unclosed one blocks appending', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.project, '.collab'));
  const md = '# L\n\n```md\n- an example, not a lesson\n```\n\n<!--\n- commented out\n-->\n\n~~~~\n- tilde example\n~~~\n~~~~\n- real one\n';
  fs.writeFileSync(lessonsMd(s.project), md);
  let r = s.run(['lessons']);
  assert.match(r.out, /^1 lesson\(s\)[^\n]*\n#1 +real one$/m);
  s.run(['init', 'fences'], { input: 'b' });
  const brief = fs.readFileSync(path.join(s.taskDir(), 'entries', '000-implementer-brief.md'), 'utf8');
  assert.match(brief, /- #1 real one\n/);
  assert.doesNotMatch(brief, /example|commented out/);
  s.run(['lessons', 'rm', '1']);
  assert.equal(fs.readFileSync(lessonsMd(s.project), 'utf8'), md.replace('- real one\n', ''), 'examples and comments untouched');

  // A file ending inside an unclosed fence: nothing is appended (it would be invisible).
  const open = '- kept\n\n```\n- inside the fence\n';
  fs.writeFileSync(lessonsMd(s.project), open);
  r = s.run(['lessons', 'add', 'new one']);
  assert.equal(r.code, 1);
  assert.match(r.err, /ends inside an unclosed code fence/);
  r = s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- from a handoff\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /submitted: implementer ready[\s\S]*lessons not recorded: .*ends inside an unclosed code fence/);
  fs.writeFileSync(lessonsMd(s.project), '- kept\n<!-- open comment\n');
  assert.match(s.run(['lessons', 'add', 'new one']).err, /unclosed HTML comment/);
  assert.equal(fs.readFileSync(lessonsMd(s.project), 'utf8'), '- kept\n<!-- open comment\n');
  assert.match(s.run(['lessons']).out, /#1 +kept/);
});

test('lessons: an unreadable file is an error, never read as empty or replaced', () => {
  const s = sandbox();
  fs.mkdirSync(lessonsMd(s.project), { recursive: true }); // a folder where the file should be
  let r = s.run(['lessons']);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read .*lessons\.md: EISDIR/);
  assert.equal(s.run(['lessons', 'add', 'x']).code, 1);
  r = s.run(['init', 'broken'], { input: 'b' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lessons: cannot read .*; the brief has none/);
  r = s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- from a handoff\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lessons not recorded: cannot read/);
  r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 10);
  r = s.run(['end'], { input: 'done' });
  assert.equal(r.code, 0, r.err);
  assert.match(s.run(['show']).out, /lessons recorded during this run not listed: cannot read/);
  assert.ok(fs.statSync(lessonsMd(s.project)).isDirectory(), 'nothing replaced it');
});

// Whether the sandbox's filesystem ignores case (NTFS, default APFS) or not (Linux, case-sensitive APFS).
function ignoresCase(dir) {
  fs.writeFileSync(path.join(dir, 'case-probe'), '');
  const res = fs.existsSync(path.join(dir, 'CASE-PROBE'));
  fs.rmSync(path.join(dir, 'case-probe'));
  return res;
}

test('lessons: a case variant is the lessons file only where the filesystem ignores case', () => {
  const s = sandbox();
  gitRepo(s.project);
  const g = (...a) => spawnSync('git', a, { cwd: s.project, encoding: 'utf8' });
  const commit = () => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'); };
  fs.mkdirSync(path.join(s.project, 'src'));
  fs.mkdirSync(path.join(s.project, '.Collab'));
  const variant = path.join(s.project, '.Collab', 'LESSONS.md');
  fs.writeFileSync(variant, '- tracked lesson\n');
  commit();
  const names = () => fs.readdirSync(path.join(s.project)).filter((n) => /^\.collab$/i.test(n))
    .flatMap((d) => fs.readdirSync(path.join(s.project, d)).map((n) => `${d}/${n}`)).sort();

  s.run(['init', 'case', '--scope', 'src/**'], { input: 'b' });
  fs.writeFileSync(path.join(s.project, 'src', 'a.js'), 'x\n');
  let r = s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- from the implementer\n` });
  assert.equal(r.code, 0, r.err);

  if (ignoresCase(s.root)) {
    // The variant is the lessons file: edited under its own name, and never part of the review.
    assert.deepEqual(names(), ['.Collab/LESSONS.md']);
    assert.match(fs.readFileSync(variant, 'utf8'), /^- tracked lesson\n- from the implementer <!-- collab: by implementer/);
    s.run(['lessons', 'add', 'added during the review'], { cwd: path.join(s.project, 'src') });
    r = s.run(['diff']);
    assert.doesNotMatch(r.out, /LESSONS|OUTSIDE SCOPE/i);
    r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok\n## Lessons\n- from the reviewer\n' });
    assert.equal(r.code, 10, r.out + r.err);
    assert.equal(s.run(['verify']).code, 0);
    assert.equal(s.run(['lessons']).out.match(/^#\d/gm).length, 4);
  } else {
    // A different file: a new .collab/lessons.md is created beside it, and the variant is reviewed.
    assert.deepEqual(names(), ['.Collab/LESSONS.md', '.collab/lessons.md']);
    assert.equal(fs.readFileSync(variant, 'utf8'), '- tracked lesson\n');
    fs.writeFileSync(variant, '- edited\n');
    r = s.run(['diff']);
    assert.match(r.out, /\.Collab\/LESSONS\.md/);
    assert.match(r.out, /OUTSIDE SCOPE[\s\S]*\.Collab\/LESSONS\.md/);
    assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 17, 'a change to it voids the review');
  }
});

test('lessons: removing a lesson keeps a comment it opens, so hidden text stays hidden', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.project, '.collab'));
  const md = ['- first lesson <!-- explanatory comment', '- hidden example, not a lesson', '-->',
    '- second lesson', '- third', '  continues <!-- note on a continuation', '- hidden two', '-->', ''].join('\r\n');
  fs.writeFileSync(lessonsMd(s.project), md);
  assert.match(s.run(['lessons']).out, /^#1 +first lesson\r?\n#2 +second lesson\r?\n#3 +third continues$/m);
  assert.match(s.run(['lessons', 'rm', '1']).out, /removed: first lesson$/m);
  assert.match(s.run(['lessons']).out, /^2 lesson\(s\)[^\n]*\n#1 +second lesson\n#2 +third continues$/m);
  assert.match(s.run(['lessons', 'rm', '2']).out, /removed: third continues$/m);
  assert.equal(fs.readFileSync(lessonsMd(s.project), 'utf8'), ['<!-- explanatory comment', '- hidden example, not a lesson', '-->',
    '- second lesson', '<!-- note on a continuation', '- hidden two', '-->', ''].join('\r\n'));
  s.run(['init', 'after-rm'], { input: 'b' });
  const brief = fs.readFileSync(path.join(s.taskDir(), 'entries', '000-implementer-brief.md'), 'utf8');
  assert.match(brief, /- #1 second lesson\n/);
  assert.doesNotMatch(brief, /hidden|#2/);
});

test('lessons: the final report covers every lessons file the run used', () => {
  const run = (moduleFile) => {
    const s = sandbox();
    const mod = path.join(s.project, 'module');
    fs.mkdirSync(path.join(mod, '.collab'), { recursive: true });
    if (moduleFile === 'broken') fs.mkdirSync(lessonsMd(mod));
    else fs.writeFileSync(lessonsMd(mod), '# Module lessons\n\n- older module lesson\n');
    s.run(['init', 'a-root'], { input: 'b' });
    s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- ROOT_RUN_LESSON\n- ROOT_REMOVED\n` });
    s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
    s.run(['init', 'b-module'], { input: 'b', cwd: mod });
    const r = s.run(['submit', 'implementer', 'ready'], { input: `v1\n${CLOSEOUT}## Lessons\n- MODULE_RUN_LESSON\n`, cwd: mod });
    s.run(['submit', 'reviewer', 'approve'], { input: 'ok', cwd: mod });
    s.run(['lessons', 'rm', '2']);
    assert.equal(s.run(['end'], { input: 'done', cwd: mod }).code, 0);
    return { s, mod, r, report: s.run(['show'], { cwd: mod }).out };
  };

  let { report, mod } = run('ok');
  assert.match(report, /ended after 2 task\(s\)|run ended after 2 task\(s\)/);
  assert.match(report, /### \.collab\/lessons\.md \(remove with 'collab lessons rm N --dir [^']+'\)\n- #1 \(implementer\) ROOT_RUN_LESSON\n/);
  assert.match(report, new RegExp(`### module/\\.collab/lessons\\.md \\(remove with 'collab lessons rm N --dir [^']*module'\\)\\n- #2 \\(implementer\\) MODULE_RUN_LESSON\\n`));
  assert.doesNotMatch(report, /ROOT_REMOVED|older module lesson/);
  assert.ok(mod);

  // An unreadable module file is reported and doesn't hide the root's lessons.
  const broken = run('broken');
  assert.match(broken.r.out, /lessons not recorded: cannot read/);
  assert.match(broken.report, /### \.collab\/lessons\.md[^\n]*\n- #1 \(implementer\) ROOT_RUN_LESSON\n/);
  assert.match(broken.report, /> collab: lessons recorded during this run not listed: cannot read .*module/);
});

test('phone send: agent hooks push "waiting for you", only for a running --phone task, and never fail', async () => {
  const p = await pushServer();
  try {
    const s = sandbox({ COLLAB_PHONE_URL: p.url });
    const send = (input, args = [], cwd) => s.run(['phone', 'send', ...args], { input, cwd });
    const claude = (message, type = 'permission_prompt') => JSON.stringify({
      session_id: 'x', cwd: s.project, hook_event_name: 'Notification', message, notification_type: type,
    });

    let r = send(claude('Claude needs your permission to use Bash'));
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'nothing on stdout: hooks may read it');
    assert.match(r.err, /not sent \(no collab task running in this project\)/);
    s.run(['init', 'plain'], { input: 'b' });
    assert.match(send(claude('Claude needs your permission to use Bash')).err, /not sent \(this task wasn't started with --phone\)/);
    s.run(['abort']);

    s.run(['init', 'away', '--phone'], { input: 'b' });
    // Claude Code Notification hook: JSON on stdin; the hook's cwd picks the project.
    r = send(claude('Claude needs your permission to use Bash'), [], s.root);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.match(r.err, /sent for away-/);
    let got = await p.until(1);
    assert.equal(got[0].body, 'Waiting for you: Claude needs your permission to use Bash');
    assert.equal(got[0].priority, 'high');
    assert.match(got[0].title, /^collab: away-/);
    assert.match(send(claude('Claude needs your permission to use Bash')).err, /not sent \(sent the same a moment ago\)/);

    // Codex PermissionRequest hook (stdin) and Codex notify (JSON argument).
    send(JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: s.project, tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Delete the build folder' } }));
    got = await p.until(2);
    assert.equal(got[1].body, 'Waiting for you: Codex needs your approval: Delete the build folder');
    send('', [JSON.stringify({ type: 'agent-turn-complete', cwd: s.project, 'last-assistant-message': 'Which database should I use?' })]);
    got = await p.until(3);
    assert.equal(got[2].body, 'Waiting for you: Codex stopped and is waiting for you: Which database should I use?');
    // Plain text, with --dir.
    send('', ['--dir', s.project, 'Please', 'look', 'at', 'the', 'terminal'], s.root);
    got = await p.until(4);
    assert.equal(got[3].body, 'Waiting for you: Please look at the terminal');

    // Between tasks of the run it still sends; after the run ends it doesn't.
    approveCurrent(s);
    send('', ['between tasks']);
    await p.until(5);
    s.run(['end'], { input: 'done' });
    await p.until(6); // the 'Work complete' push
    r = send(claude('Claude is waiting for your input'));
    assert.match(r.err, /no collab task running/);
    assert.equal(send('not json and no task').code, 0);
    assert.match(send('').err, /no message/);
    await pause(800);
    assert.equal(p.got.length, 6, JSON.stringify(p.got.map((g) => g.body)));
  } finally { p.close(); }
});

test('phone: Claude Code questions (PreToolUse AskUserQuestion) and a first confirm-first task with --phone push', async () => {
  const p = await pushServer();
  try {
    const s = sandbox({ COLLAB_PHONE_URL: p.url });
    // The first queued task of a run: no earlier task, the item itself has --phone.
    s.run(['queue', 'add', '--confirm', '--phone', 'Run the DB migration']);
    assert.match(s.run(['queue', 'next']).out, /CONFIRM FIRST/);
    let got = await p.until(1);
    assert.equal(got[0].body, 'Queued task #1 needs your go-ahead: Run the DB migration');
    assert.equal(got[0].title, 'collab: queued task #1');
    s.run(['queue', 'add', '--confirm', 'No phone for this one']);
    s.run(['queue', 'rm', '1']);
    s.run(['queue', 'next']);

    s.run(['init', 'ask', '--phone'], { input: 'b' });
    const ask = JSON.stringify({
      session_id: 'x', cwd: s.project, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which database?', header: 'DB', options: [] }, { question: 'Which port?' }] },
    });
    const r = s.run(['phone', 'send'], { input: ask });
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'no hook decision: the question shows as usual');
    got = await p.until(2);
    assert.equal(got[1].body, 'Waiting for you: Claude asks: Which database? (+1 more)');
    await pause(800);
    assert.equal(p.got.length, 2, JSON.stringify(p.got.map((g) => g.body)));
  } finally { p.close(); }
});
