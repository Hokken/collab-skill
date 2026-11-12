'use strict';
// Run with: node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'collab.js');

// The tests act as the user unless a test sets an agent marker itself.
const NO_AGENT = { CLAUDECODE: '', COLLAB_AGENT: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '', OPENCODE: '' };

// Tests never reach the real ElevenLabs API, even when the developer's shell has a key.
const NO_ELEVENLABS = { ELEVENLABS_API_KEY: '', COLLAB_ELEVENLABS_URL: 'http://127.0.0.1:9' };

const CLOSEOUT = '## Closeout\nVerified: none\nAttempted, blocked: none\nDeferred: none\nNot claimed: none\n';

function sandbox(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const env = {
    ...process.env, COLLAB_HOME: home, COLLAB_POLL_SECS: '1', COLLAB_NOTIFY: '0', COLLAB_SOUND: '0',
    COLLAB_TASK: '', ...NO_AGENT, ...NO_ELEVENLABS, ...extraEnv,
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

test('pairs stay apart: join takes only its own project, and one reviewer per task', () => {
  const s = sandbox();
  const [a, b, empty] = ['a', 'b', 'empty'].map((n) => path.join(s.project, n));
  for (const dir of [a, b, empty]) fs.mkdirSync(dir);
  const init = (cwd, slug) => {
    const r = s.run(['init', slug], { input: 'b', cwd });
    assert.match(r.out, new RegExp(`^reviewer: /collab review ${slug}-\\S+ {2}\\(Codex: \\$collab review ${slug}-`, 'm'));
    return r.out.match(/^task:\s+(\S+)/m)[1];
  };
  const ta = init(a, 'task-a');
  const tb = init(b, 'task-b');

  let r = s.run(['join', '--timeout', '1'], { cwd: empty });
  assert.equal(r.code, 11, "a folder without tasks waits; it never falls back to another project's last task");
  r = s.run(['join', '--timeout', '1'], { cwd: s.project });
  assert.equal(r.code, 1, 'a parent folder of two active projects is ambiguous');
  assert.match(r.err, /several projects[\s\S]*task-a-[\s\S]*task-b-/);
  assert.match(s.run(['-t', 'nope', 'join', '--timeout', '1']).err, /task not found: nope/);

  r = s.run(['join', '--timeout', '1'], { cwd: a });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`joined task: ${ta}`));
  r = s.run(['join', '--timeout', '1'], { cwd: a });
  assert.equal(r.code, 1, 'a second reviewer is refused');
  assert.match(r.err, new RegExp(`task ${ta} \\(project [^)]*\\) already has a reviewer, last active \\d+s ago[\\s\\S]*collab -t ${ta} join --force`));
  assert.equal(s.run(['-t', ta, 'join', '--force', '--timeout', '1']).code, 0, '--force takes over');
  assert.match(s.run(['-t', tb, 'join', '--timeout', '1']).out, new RegExp(`joined task: ${tb}`), '-t pairs with that task');

  // The reviewer's waits keep its claim fresh.
  const seen = path.join(s.home, 'tasks', ta, 'reviewer.seen');
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(seen, old, old);
  s.run(['-t', ta, 'wait', 'reviewer', '--timeout', '1']);
  assert.ok(Date.now() - fs.statSync(seen).mtimeMs < 60e3, 'wait refreshes the claim');
});

test('two reviewers joining at once: exactly one gets the task', async () => {
  const s = sandbox();
  s.run(['init', 'race'], { input: 'b' });
  const env = { ...process.env, COLLAB_HOME: s.home, COLLAB_POLL_SECS: '1', COLLAB_NOTIFY: '0', COLLAB_TASK: '', ...NO_AGENT };
  const join = () => new Promise((resolve) => {
    const c = require('child_process').spawn(process.execPath, [CLI, 'join', '--timeout', '1'], { cwd: s.project, env, stdio: 'ignore' });
    c.on('close', resolve);
  });
  for (let i = 0; i < 3; i++) {
    fs.rmSync(path.join(s.taskDir(), 'reviewer.seen'), { force: true });
    const codes = (await Promise.all([join(), join()])).sort();
    assert.deepEqual(codes, [0, 1], `attempt ${i + 1}`);
  }
});

test('a stale reviewer claim lets a new reviewer join', async () => {
  const s = sandbox({ COLLAB_IDLE_SECS: '1' });
  s.run(['init', 'stale'], { input: 'b' });
  assert.equal(s.run(['join', '--timeout', '1']).code, 0);
  await pause(1500);
  const r = s.run(['join', '--timeout', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /joined task: stale-/);
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
  assert.match(r.out, /Round limit reached \(2 review rounds\)[\s\S]*the implementer presents the options, don't ask the user yourself/);
  assert.equal(s.state().status, 'DECISION');
  assert.equal(s.state().round, 2, 'no round counter overflow');
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 11, 'only the implementer presents the menu');
  assert.match(r.out, /the implementer presents the round-limit question to the user; don't ask the user about it yourself/);
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.equal(r.code, 16, 'the implementer shows the menu');
  assert.match(r.out, /round limit is reached[\s\S]*1\. still broken[\s\S]*1\. Give them 2 more rounds[\s\S]*3\. Stop the task/);
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

test('the round limit in the plan phase: approve starts the build, more rounds stay in the plan', () => {
  const s = sandbox();
  gitRepo(s.project);
  const toPlanLimit = (slug) => {
    s.run(['init', slug, '--plan', '--max-rounds', '1'], { input: 'b' });
    s.run(['submit', 'implementer', 'plan'], { input: 'p1' });
    return s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] plan step 2 is wrong' });
  };

  // Approve the plan as it is: the build starts, nothing is DONE.
  let r = toPlanLimit('a-plan-approve');
  assert.match(r.out, /DECISION \(turn: human, plan round 1\/1\)/);
  assert.match(s.state().decision.options[1], /Approve the plan as it is/);
  r = s.run(['answer', '2']);
  assert.match(r.out, /back to the implementer \(status: IMPLEMENTING\)/);
  let st = s.state();
  assert.equal(st.phase, 'build');
  assert.equal(st.status, 'IMPLEMENTING');
  assert.equal(st.turn, 'implementer');
  assert.equal(st.round, 1);
  assert.equal(st.max_rounds, 1, 'the build keeps its own limit');
  assert.equal(st.plan_approved_seq, 3, 'the answer entry approved the plan');
  // The reviewer's recap: the approved plan is named, plan-phase items don't count as build rounds.
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  let out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, /approved plan: #001/);
  assert.doesNotMatch(out, /earlier blocking items|plan step 2/);
  assert.match(s.run(['status']).out, /round: {3}1\/1/);
  s.run(['abort']);

  // Two more plan rounds: only the plan limit grows.
  toPlanLimit('b-plan-more');
  s.run(['answer', '1']);
  st = s.state();
  assert.equal(st.status, 'PLAN_CHANGES');
  assert.equal(st.plan_max_rounds, 3);
  assert.equal(st.max_rounds, 1);
  assert.match(s.run(['status']).out, /round: {3}plan 2\/3/);
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });
  assert.equal(s.state().plan_approved_seq, 5, "the reviewer's approve is the boundary too");
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  r = s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] build bug' });
  assert.equal(s.state().status, 'DECISION', 'the build limit is still 1');
  assert.match(s.state().decision.options[1], /Approve the task as it is/);

  // Approve the task as it is: DONE and the approved tree land in the same write.
  r = s.run(['answer', '2']);
  assert.match(r.out, /the task is DONE/);
  assert.ok(s.state().approved_digest, 'DONE carries its approved tree');
  assert.equal(s.run(['verify']).code, 0);

  // The tree can't be computed: the answer is still recorded, without a verified approval.
  s.run(['init', 'c-no-tree', '--max-rounds', '1'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] x' });
  const sp = path.join(s.taskDir(), 'state.json');
  st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  st.repos[0].base = '0'.repeat(40);
  fs.writeFileSync(sp, JSON.stringify(st));
  r = s.run(['answer', '2']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /the task is DONE[\s\S]*cannot compute the tree digest[\s\S]*no verified approval was recorded/);
  assert.equal(s.state().status, 'DONE');
  assert.equal(s.state().approved_digest, undefined);
  assert.equal(s.run(['verify']).code, 1);
});

test("wait shows a note that came before the role's own last entry, and never the other role's", () => {
  const s = sandbox();
  const count = (out, f) => out.split(`----- ${f} -----`).length - 1;
  const ack = (n) => `## Summary\nx\n## Review responses\nNote #${n} — done\n`;

  // 2a: a note before a split, which shows no notes.
  s.run(['init', 'a-split'], { input: 'b' });
  s.run(['note', '--as-user', '--implementer', 'use port 8080']);
  assert.equal(s.run(['queue', 'split'], { input: 'p1\n=== part ===\np2' }).code, 0);
  let out = s.run(['wait', 'implementer', '--timeout', '1']).out;
  assert.equal(count(out, '001-human-note-implementer.md'), 1, out);
  out = s.run(['wait', 'implementer', '--timeout', '1']).out;
  assert.equal(count(out, '001-human-note-implementer.md'), 0, 'shown once');
  assert.match(out, /----- 002-implementer-split\.md -----/, 'nothing new: the latest visible entry');
  assert.equal(s.run(['progress', 'x']).out.includes('8080'), false);
  // Being shown is not acknowledging: the ready still needs Note #1.
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: '## Summary\nx\n' }).code, 12);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: ack(1) }).code, 0);
  s.run(['abort']);
  s.run(['queue', 'rm', '1']);

  // 2a: a note before a decide the user answered.
  s.run(['init', 'b-decide'], { input: 'b' });
  s.run(['note', '--as-user', '--implementer', 'NOTE-B']);
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## Which?\n1. A (Recommended)\n2. B\n' });
  s.run(['answer', '1']);
  out = s.run(['wait', 'implementer', '--timeout', '1']).out;
  assert.equal(count(out, '001-human-note-implementer.md'), 1, out);
  assert.equal(count(out, '003-human-answer.md'), 1);
  assert.ok(out.indexOf('001-human-note') < out.indexOf('003-human-answer'), 'in order');
  s.run(['abort']);

  // 2b: a note only for the reviewer never reaches the implementer's wait.
  s.run(['init', 'c-private'], { input: 'b' });
  s.run(['note', '--as-user', '--reviewer', 'SECRET reviewer check']);
  out = s.run(['wait', 'implementer', '--timeout', '1']).out;
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /----- 000-implementer-brief\.md -----/);
  s.run(['abort']);

  // 6: a decide that mentions a reviewer note is not the implementer's reply to it.
  s.run(['init', 'd-replies'], { input: 'b' });
  s.run(['note', '--from', 'reviewer', 'check the parser'], { env: { COLLAB_AGENT_SHELL: '' } });
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## About Note #1, A or B?\n1. A (Recommended)\n2. B\n' });
  s.run(['answer', '1']);
  s.run(['submit', 'implementer', 'ready'], { input: ack(1) });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] more' });
  // The reviewer's next recap lists notes since its last review: send another one.
  s.run(['note', '--from', 'reviewer', 'and the lexer']);
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## Note #6 first?\n1. Yes (Recommended)\n2. No\n' });
  s.run(['answer', '1']);
  s.run(['submit', 'implementer', 'ready'], { input: '## Summary\nv2\n## Review responses\n1. Fixed\nNote #6 — handled the lexer too\n' });
  // The protocol always puts an acknowledging ready last, so plant a later non-handoff entry that
  // mentions the note: only plan/ready entries count as replies.
  fs.writeFileSync(path.join(s.taskDir(), 'entries', '010-implementer-decide.md'), '## Note #6 again?\n1. WRONG reply\n');
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.doesNotMatch(out, /→ #010/);
  assert.match(out, /Note #6: and the lexer\n {3}→ #009: Note #6 — handled the lexer too/, out);
});

test("the check-passed line never leaks into a message's sections", () => {
  const s = sandbox();
  gitRepo(s.project);
  const CO = '## Closeout\nVerified: ran it\nAttempted, blocked: none\nDeferred: none\nNot claimed: none\n';
  const task = (slug, msg) => {
    s.run(['init', slug, '--check', 'node -e 0'], { input: 'b' });
    const r = s.run(['submit', 'implementer', 'ready'], { input: msg, raw: true });
    assert.equal(r.code, 0, r.err);
    const entry = fs.readFileSync(path.join(s.taskDir(), 'entries', '001-implementer-ready.md'), 'utf8');
    assert.match(entry, /> collab: check passed: `node -e 0`.*\n$/, 'the entry keeps the line');
    assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10);
  };
  // Lessons last; a wrapped line joins the bullet, a quote and text after a blank line don't.
  task('a-lessons', `## Summary\nx\n${CO}## Lessons\n- Keep paths normalised\n  before comparing\n> an aside\n\nnot a lesson\n`);
  const lessons = fs.readFileSync(lessonsMd(s.project), 'utf8');
  assert.match(lessons, /^- Keep paths normalised before comparing <!-- collab:/m);
  assert.doesNotMatch(lessons, /check passed|an aside|not a lesson/);
  // Decisions taken last, saying none.
  task('b-none', `## Summary\nx\n${CO}## Decisions taken\nnone\n`);
  // Closeout last; a quoted check line in the middle of a message is the agent's own text.
  task('c-closeout', `## Summary\nx\n## Decisions taken\n- kept the old API\n> collab: check passed: quoted by me\n${CO}`);

  assert.equal(s.run(['end'], { input: '## Final report\ndone\n' }).code, 0);
  const report = s.run(['show']).out;
  const part = (from, to) => report.slice(report.indexOf(from), to ? report.indexOf(to) : undefined);
  const closeouts = part('## Closeouts (collected by collab)', '## Decisions recorded');
  const decisions = part('## Decisions recorded', '## Lessons recorded');
  const recorded = part('## Lessons recorded', '> collab: run ended');
  assert.match(closeouts, /c-closeout[^\n]*\nVerified: ran it\n[\s\S]*Not claimed: none/);
  assert.doesNotMatch(closeouts, /check passed: `node/);
  assert.doesNotMatch(decisions, /b-none/, "a trailing 'none' is not a decision");
  assert.match(decisions, /kept the old API\n> collab: check passed: quoted by me/);
  assert.doesNotMatch(decisions, /check passed: `node/);
  assert.match(recorded, /Keep paths normalised before comparing\n/);
  assert.doesNotMatch(recorded, /check passed/);
});

test('a build-phase recap without plan_approved_seq (older tasks) uses the reviewer approve', () => {
  const s = sandbox();
  s.run(['init', 'legacy-plan', '--plan'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] plan item' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'plan ok' });
  const sp = path.join(s.taskDir(), 'state.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete st.plan_approved_seq;
  fs.writeFileSync(sp, JSON.stringify(st));
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] build item' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  const out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, /approved plan: #003/);
  assert.match(out, /round 1 \(#006\):\n1\. \[blocking\] build item/);
  assert.doesNotMatch(out, /plan item/);
});

test('non-ASCII and special file names: diff, scope, snapshots and since-review', () => {
  const s = sandbox();
  const p = s.project;
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: p, encoding: 'utf8' });
  const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(p, f)), { recursive: true }); fs.writeFileSync(path.join(p, f), text); };
  gitRepo(p);
  put('src/café.js', 'old café\n');
  put('.gitignore', 'plans/\n');
  g('add', '.'); g('commit', '-qm', 'more');
  put('plans/résumé.md', 'pre-existing ignored doc\n');
  put('src/déjà.js', 'pre-existing untracked\n');
  s.run(['init', 'names', '--scope', 'src/**,plans/**'], { input: 'b' });
  const snap = (n) => path.join(s.taskDir(), 'untracked', n);
  assert.equal(fs.readFileSync(snap('0.txt'), 'utf8'), 'src/déjà.js\0', 'raw names, NUL-delimited');
  assert.equal(fs.readFileSync(snap('0-ignored-md.txt'), 'utf8'), 'plans/résumé.md\0');

  put('src/café.js', 'new café, longer\n');
  put('src/über.js', 'hello über\n');
  put('plans/nouveau-é.md', 'new doc\n');
  let out = s.run(['diff']).out;
  assert.match(out, /\+new café, longer/);
  assert.match(out, /hello über/);
  assert.match(out, /plans\/nouveau-é\.md/);
  assert.doesNotMatch(out, /OUTSIDE SCOPE|unreadable|résumé|déjà|\\303/);
  assert.match(s.run(['diff', '--stat']).out, /src\/café\.js/);

  // --since-review needs two build handoffs.
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] more' });
  put('src/über.js', 'hello über, again\n');
  s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  out = s.run(['diff', '--since-review']).out;
  assert.match(out, /src\/über\.js/);
  assert.match(out, /\+hello über, again/);
  assert.doesNotMatch(out, /OUTSIDE SCOPE|café|\\303/);

  // Snapshots written by earlier versions: one git-quoted name per line.
  fs.writeFileSync(snap('0.txt'), '"src/d\\303\\251j\\303\\240.js"\n');
  fs.writeFileSync(snap('0-ignored-md.txt'), '"plans/r\\303\\251sum\\303\\251.md"\n');
  out = s.run(['diff']).out;
  assert.doesNotMatch(out, /déjà|résumé/, 'legacy quoted snapshots still match');
  assert.match(out, /plans\/nouveau-é\.md/);
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(s.run(['verify']).code, 0, 'the approval digest reads the legacy ignored-md list too');
});

test('file names with quotes and newlines round-trip through the init snapshot', { skip: process.platform === 'win32' }, () => {
  const s = sandbox();
  gitRepo(s.project);
  fs.writeFileSync(path.join(s.project, '"quoted".txt'), 'q\n');
  fs.writeFileSync(path.join(s.project, 'new\nline.txt'), 'n\n');
  s.run(['init', 'odd-names'], { input: 'b' });
  fs.writeFileSync(path.join(s.project, '"other".txt'), 'o\n');
  let out = s.run(['diff']).out;
  assert.match(out, /"other"\.txt/);
  assert.doesNotMatch(out, /"quoted"|new\nline/, 'pre-existing names are known');

  // A legacy (newline) snapshot written with core.quotePath=false: raw emoji inside a quoted name.
  fs.writeFileSync(path.join(s.project, 'emoji-😀\t.txt'), 'e\n');
  fs.writeFileSync(path.join(s.taskDir(), 'untracked', '0.txt'), '"emoji-😀\\t.txt"\n"\\"quoted\\".txt"\n"new\\nline.txt"\n');
  out = s.run(['diff']).out;
  assert.doesNotMatch(out, /emoji|"quoted"|new\nline/, 'legacy quoted names decode whole code points');
  assert.match(out, /"other"\.txt/);
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

test('a same-size edit in the same second as the index write is not missed', (t) => {
  const sec = (f) => Math.floor(fs.statSync(f).mtimeMs / 1000);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // f.txt is written, committed and edited to the same size within one second, then handed off.
  // Returns the sandbox, or null when the machine was too slow to hit that window.
  const racyReady = () => {
    const s = sandbox();
    sleep(1005 - (Date.now() % 1000));
    gitRepo(s.project); // f.txt = 'one\n', added and committed: the index is written now
    s.run(['init', 'racy'], { input: 'b' });
    const f = path.join(s.project, 'f.txt');
    fs.writeFileSync(f, 'two\n');
    if (sec(f) !== sec(path.join(s.project, '.git', 'index'))) return null;
    assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
    sleep(1100); // from here on, a fresh copy of the index is clearly newer than the edit
    return s;
  };
  const tries = (fn) => { for (let i = 0; i < 4; i++) { const s = racyReady(); if (s) { fn(s); return true; } } return false; };

  // The approval digest, taken later, sees the same tree as the handoff.
  const a = tries((s) => {
    const r = s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
    assert.equal(r.code, 10, `approve sees the edit the handoff saw:\n${r.out}`);
    assert.equal(s.run(['verify']).code, 0);
  });
  // The next handoff's tree too: nothing changed since the first one.
  const b = tries((s) => {
    s.run(['submit', 'reviewer', 'changes'], { input: '1. [blocking] again' });
    assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v2, nothing changed' }).code, 0);
    const r = s.run(['diff', '--since-review']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no changes since review handoff #001 in: /, `the second tree still has the edit:\n${r.out}`);
    assert.doesNotMatch(r.out, /f\.txt/);
  });
  if (!a || !b) t.skip(`could not hit the same-second window on this machine (approve ${a}, since-review ${b})`);
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

const noteNum = (r) => Number(/note #(\d+)/.exec(r.out)[1]);

test('a decision is never refused for notes, and does not acknowledge them', () => {
  const s = sandbox();
  s.run(['init', 'ask-with-notes'], { input: 'b' });
  const n = noteNum(s.run(['note', '--from', 'reviewer', 'early finding']));
  const acked = s.state().acked.implementer;
  let r = s.run(['submit', 'implementer', 'decide', '--self'], { input: 'Which?\n1. a\n2. b\n' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(s.state().status, 'DECISION');
  assert.equal(s.state().acked.implementer, acked, 'a decision acknowledges nothing');
  s.run(['answer', '1']);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 12, 'the note still gates the next real handoff');
  assert.match(r.out, new RegExp(`Note #${n} is not acknowledged`));
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${n} — fixed` }).code, 0);
  // The reviewer's side: its decision goes through with the user's note pending, its review doesn't.
  const u = noteNum(s.run(['note', '--reviewer', 'look at X']));
  assert.equal(s.run(['submit', 'reviewer', 'decide', '--self'], { input: 'Which?\n1. a\n2. b\n' }).code, 0);
  s.run(['answer', '2']);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 12);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: `ok, Note #${u} checked` }).code, 10);
});

test('unacknowledged notes refuse a handoff before the check runs, and a note sent during the check still does', () => {
  const s = sandbox();
  // The check counts its runs and, on its first one only, has the reviewer send a note mid-check.
  fs.writeFileSync(path.join(s.project, 'check.js'), [
    "const fs = require('fs');",
    "fs.appendFileSync('runs', 'x');",
    "if (fs.readFileSync('runs', 'utf8').length === 2) {",
    `  require('child_process').execFileSync(process.execPath, [${JSON.stringify(CLI)}, 'note', '--from', 'reviewer', 'sent during the check']);`,
    '}',
  ].join('\n'));
  const runs = () => { try { return fs.readFileSync(path.join(s.project, 'runs'), 'utf8').length; } catch { return 0; } };
  s.run(['init', 'early-notes', '--check', 'node check.js'], { input: 'b' });
  const n = noteNum(s.run(['note', '--from', 'reviewer', 'before the handoff']));
  let r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 12);
  assert.match(r.out, new RegExp(`Note #${n} is not acknowledged`));
  assert.equal(runs(), 0, 'the check did not run');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${n} — done`, raw: true }).code, 1, 'closeout is still enforced');
  r = s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${n} — done` });
  assert.equal(runs(), 1);
  assert.equal(r.code, 0, r.out + r.err);
  s.run(['submit', 'reviewer', 'changes'], { input: '1. fix' });
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  assert.equal(runs(), 2, 'the check ran and sent its note');
  assert.equal(r.code, 12, 'the locked re-check catches the note sent while the check ran');
  assert.match(r.out, /sent during the check/);
  const late = s.state().seq - 1;
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v2\nNote #${late} — done` }).code, 0);
  assert.equal(runs(), 3);
});

test('notes: gate, routing and finished tasks', () => {
  const s = sandbox();
  s.run(['init', 'notes'], { input: 'brief' });
  let r = s.run(['note', 'also', 'handle', 'empty', 'strings']);
  assert.match(r.out, /note #1 added for all/);
  const n1 = noteNum(r);

  r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 12);
  assert.match(r.out, /NOT SUBMITTED: Note #1 is not acknowledged/);
  assert.match(r.out, /!!! HUMAN NOTE[\s\S]*also handle empty strings/);
  r = s.run(['submit', 'implementer', 'ready'], { input: 'v2' });
  assert.equal(r.code, 12, 'shown is not handled: still refused until acknowledged');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v2\n## Review responses\nNote #${n1} — done` }).code, 0);

  const nr = noteNum(s.run(['note', '-r', 'check perf']));
  s.run(['note', '--implementer', 'impl only']);
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /check perf/);
  assert.doesNotMatch(r.out, /impl only/);
  assert.equal(s.run(['submit', 'reviewer', 'changes'], { input: `1. fix\nnote #${nr}: checked; Note #${n1}: seen` }).code, 0, 'implementer-only note does not gate the reviewer (a note for all does)');

  const nrr = noteNum(s.run(['note', '--to', 'reviewer', 'reviewer note during impl turn']));
  r = s.run(['wait', 'implementer', '--timeout', '1']);
  assert.match(r.out, /impl only/);
  assert.doesNotMatch(r.out, /reviewer note during impl turn/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'fixed' }).code, 12, 'the implementer-only note needs its acknowledgement');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `fixed\nNote #${nr + 1} — done` }).code, 0);

  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.match(r.out, /reviewer note during impl turn/);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: `ok (Note #${nrr} considered)` }).code, 10);
  r = s.run(['note', 'late']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already finished/);
});

test('notes from an agent: labelled as its own, routed to the other agent, never as the user', () => {
  const s = sandbox();
  s.run(['init', 'peer'], { input: 'brief' });
  // An agent shell may not record a note as the user's.
  let r = s.run(['note', 'looks wrong'], { env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /--from reviewer/);
  r = s.run(['note', 'from me, the user', '--as-user'], { env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 0, r.err);
  const user = noteNum(r);
  r = s.run(['note', '--from', 'reviewer', 'preliminary finding: X races Y'], { env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /from the reviewer added for implementer/);
  const peer = noteNum(r);
  assert.equal(s.run(['note', '--from', 'reviewer', '--to', 'reviewer', 'x']).code, 1, 'goes to the other agent only');
  assert.equal(s.run(['note', '--from', 'tester', 'x']).code, 1);
  r = s.run(['progress', 'working'], { env: { CLAUDECODE: '1' } });
  assert.match(r.out, />>> NOTE FROM THE OTHER AGENT[\s\S]*From: the reviewer[\s\S]*X races Y/);
  assert.doesNotMatch(r.out.split('From: the reviewer')[1] ?? '', /!!! HUMAN NOTE/);
  // Discarding that output (progress > /dev/null) loses nothing: both notes still gate the handoff.
  r = s.run(['submit', 'implementer', 'ready'], { input: `v1 Note #${user}` });
  assert.equal(r.code, 12);
  assert.match(r.out, new RegExp(`Note #${peer} is not acknowledged`));
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${user} — done\nNote #${peer} — fixed` }).code, 0);
  // The reviewer is not gated by its own note (only by the user's note for both agents).
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 12);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: `ok (Note #${user} seen)` }).code, 10);
});

test('a task from before acknowledgements: notes already shown stay handled, every later one must be acknowledged (both roles)', () => {
  const s = sandbox();
  s.run(['init', 'legacy'], { input: 'brief' });
  const oldI = noteNum(s.run(['note', '-i', 'old implementer note']));
  s.run(['progress', 'reading']); // shown under the old rule
  const stateFile = path.join(s.taskDir(), 'state.json');
  const legacy = () => {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete st.acked;
    fs.writeFileSync(stateFile, JSON.stringify(st));
  };
  legacy();
  // A new note, delivered by progress (which advances `seen`): it must still be acknowledged.
  const newI = noteNum(s.run(['note', '-i', 'new implementer note']));
  assert.match(s.run(['progress', 'coding']).out, /new implementer note/);
  let r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 12);
  assert.match(r.out, new RegExp(`Note #${newI} is not acknowledged`));
  assert.doesNotMatch(r.out, new RegExp(`Note #${oldI}\\b`), 'the note shown before the upgrade counts as handled');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1 again' }).code, 12, 'a refused submit does not move the baseline');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${newI} — done` }).code, 0);
  assert.ok(s.state().acked, 'the baseline is now stored');

  // The other role, before its first handoff after the upgrade: same rule.
  const t = sandbox();
  t.run(['init', 'legacy2'], { input: 'brief' });
  const oldR = noteNum(t.run(['note', '-r', 'old reviewer note']));
  t.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  t.run(['wait', 'reviewer', '--timeout', '1']); // the reviewer is shown its old note
  const tf = path.join(t.taskDir(), 'state.json');
  const st = JSON.parse(fs.readFileSync(tf, 'utf8'));
  delete st.acked;
  fs.writeFileSync(tf, JSON.stringify(st));
  const newR = noteNum(t.run(['note', '-r', 'new reviewer note']));
  t.run(['progress', 'reviewing']);
  r = t.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(r.code, 12);
  assert.match(r.out, new RegExp(`Note #${newR} is not acknowledged`));
  assert.doesNotMatch(r.out, new RegExp(`Note #${oldR}\\b`));
  assert.equal(t.run(['submit', 'reviewer', 'approve'], { input: `ok (Note #${newR} considered)` }).code, 10);
});

test('agent shells are recognised (Claude Code, Codex sessions sandboxed or not, OpenCode, COLLAB_AGENT); the user override stays', () => {
  const s = sandbox();
  s.run(['init', 'shells'], { input: 'brief' });
  for (const env of [{ CLAUDECODE: '1' }, { CODEX_THREAD_ID: 't-1' }, { CODEX_SESSION_ID: 's-1' }, { CODEX_SANDBOX: 'seatbelt' }, { OPENCODE: '1' }, { COLLAB_AGENT: '1' }]) {
    const r = s.run(['note', 'as the user?'], { env });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.err, /--from/);
  }
  assert.equal(s.run(['note', 'typed by the user', '--as-user'], { env: { CODEX_THREAD_ID: 't-1' } }).code, 0);
  assert.equal(s.run(['note', '--from', 'reviewer', 'a finding'], { env: { CODEX_THREAD_ID: 't-1' } }).code, 0);
  assert.equal(s.run(['note', 'plain user shell']).code, 0);
});

test('--attempt changes nothing but the retry hint, in every wait and join timeout', () => {
  const s = sandbox();
  let r = s.run(['join', '--timeout', '1', '--attempt', '1']);
  assert.equal(r.code, 11);
  assert.ok(r.out.includes("Run 'collab join --attempt 2' again"), r.out);
  assert.ok(s.run(['join', '--timeout', '1']).out.includes("Run 'collab join' again"), 'no --attempt: hint unchanged');
  assert.match(s.run(['join', '--timeout', '1', '--attempt', 'x']).err, /invalid number: x/);

  s.run(['init', 'tries'], { input: 'brief' });
  r = s.run(['wait', 'reviewer', '--timeout', '1', '--attempt', '7']);
  assert.equal(r.code, 11);
  assert.ok(r.out.includes("Run 'collab wait reviewer --attempt 8' again"), r.out);
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.ok(r.out.includes("Run 'collab wait reviewer' again") && !r.out.includes('--attempt'), r.out);
  r = s.run(['wait', 'reviewer', '--attempt', '-1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid number: -1/);

  // A pending decision: both the presenter's and the other agent's timeout name the next attempt.
  assert.equal(s.run(['submit', 'implementer', 'decide', '--self'], { input: 'Pick\n1. a\n2. b\n' }).code, 0);
  r = s.run(['wait', 'implementer', '--timeout', '1', '--attempt', '2']);
  assert.equal(r.code, 11);
  assert.ok(r.out.includes("Run 'collab wait implementer --attempt 3' again"), r.out);
  r = s.run(['wait', 'reviewer', '--timeout', '1', '--attempt', '4']);
  assert.equal(r.code, 11);
  assert.ok(r.out.includes("Run 'collab wait reviewer --attempt 5' again"), r.out);
  s.run(['answer', '1']);

  const id = s.state().id;
  assert.equal(approveCurrent(s, '## Verdict: approved\n').code, 10);
  r = s.run(['join', '--after', id, '--timeout', '1', '--attempt', '9']);
  assert.equal(r.code, 11);
  assert.ok(r.out.includes(`Run 'collab join --after ${id} --attempt 10' again`), r.out);
});

test('a failed check keeps its whole output in the scratch folder (a path with spaces too)', () => {
  const s = sandbox({ COLLAB_HOME: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collab test ')), 'home dir') });
  s.run(['init', 'chk', '--check', `node -e "console.log('first line'); for (let i = 0; i < 100; i++) console.log('noise ' + i); process.exit(3)"`], { input: 'b' });
  const r = s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  assert.equal(r.code, 14);
  const file = /Full output: (.+?\.log) Last lines:/.exec(r.out)?.[1];
  assert.ok(file, r.out);
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, /first line/, 'the beginning is kept even though the printed tail drops it');
  assert.match(log, /exit code 3/);
  assert.doesNotMatch(r.out.split('Last lines:')[1] ?? '', /first line/);
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
  s.run(['submit', 'implementer', 'ready'], { input: 'v1 (Note #1 handled)' });
  const big = 'line\n'.repeat(20000);
  const big2 = noteNum(s.run(['note', '-r', big]));
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" wait reviewer --timeout 1 | head -1`], {
    cwd: s.project, encoding: 'utf8', env: { ...process.env, COLLAB_HOME: s.home, COLLAB_NOTIFY: '0' },
  });
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^YOUR TURN/);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 12, 'a note whose output was cut off is not lost');
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: `ok (Note #1 and Note #${big2} considered)` }).code, 10);
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

  const n = noteNum(s.run(['note', '-i', 'use 2 decimals']));
  r = s.run(['progress', 'writing code']);
  assert.match(r.out, /HUMAN NOTE[\s\S]*use 2 decimals/);
  assert.match(r.out, /acknowledge it as 'Note #N/);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 12, 'shown via progress is not handled (that output may have been discarded)');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: `v1\nNote #${n} — done` }).code, 0);

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

  // An indented line whose first word is wider than the pane keeps its indent.
  const t = sandbox();
  t.run(['init', 'wrap'], { input: `## Goal\nshort intro\n    ${'x'.repeat(80)}\n` });
  const lines = t.run(['watch', '--once'], { env: { COLUMNS: '40', LINES: '40' } }).out.split('\n');
  const at = lines.indexOf('short intro');
  assert.ok(at >= 0, lines.join('\n'));
  assert.equal(lines[at + 1], `    ${'x'.repeat(35)}`, 'the first chunk keeps the indent, within the width');
  assert.ok(lines[at + 2].startsWith('x'), 'the rest of the word continues on the next line');
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
    env: { ...process.env, COLLAB_HOME: s.home, COLLAB_NOTIFY: '0', COLLAB_TASK: '', COLLAB_LOCK_SECS: '1', ...NO_AGENT },
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

test('idle and stall count from the turn start: notes and reads are no sign of life', () => {
  const backdate = (s, mins, { legacy = false } = {}) => {
    const sp = path.join(s.taskDir(), 'state.json');
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const then = Math.floor(Date.now() / 1000) - mins * 60;
    st.updated_epoch = then;
    if (legacy) delete st.turn_since; else st.turn_since = then;
    fs.writeFileSync(sp, JSON.stringify(st));
  };
  const waitReviewer = (s) => s.run(['wait', 'reviewer', '--timeout', '1']);

  // A note to the unresponsive implementer, from the user or the reviewer, doesn't reset the clock.
  let s = sandbox();
  s.run(['init', 'idle'], { input: 'b' });
  backdate(s, 60);
  s.run(['note', '--as-user', 'still there?']);
  s.run(['note', '--from', 'reviewer', 'ping'], { env: { COLLAB_AGENT_SHELL: '' } });
  assert.ok(s.state().updated_epoch > Math.floor(Date.now() / 1000) - 60, 'the notes did write the state');
  let r = waitReviewer(s);
  assert.equal(r.code, 13, r.out);
  assert.match(r.out, /the implementer has not handed off for 60 min/);
  assert.match(s.run(['status']).out, /by reviewer/, 'status still shows the last writer');
  // Snooze and progress still count.
  s.run(['snooze', '30']);
  assert.equal(waitReviewer(s).code, 11, 'snoozed');
  s = sandbox();
  s.run(['init', 'progress'], { input: 'b' });
  backdate(s, 60);
  s.run(['progress', 'running the tests']);
  s.run(['note', '--as-user', 'hello']);
  assert.equal(waitReviewer(s).code, 11, 'a progress post this turn is a sign of life');

  // Stall: a note 121 min into the turn doesn't save it (idle prompt off, so the stall timer decides).
  s = sandbox({ COLLAB_IDLE_SECS: '999999' });
  s.run(['init', 'stall'], { input: 'b' });
  backdate(s, 121);
  s.run(['note', '--as-user', 'hello?']);
  r = waitReviewer(s);
  assert.equal(r.code, 10, r.out);
  assert.match(r.out, /STALLED/);

  // State from before turn_since: updated_epoch is the turn start, as before.
  s = sandbox();
  s.run(['init', 'legacy'], { input: 'b' });
  backdate(s, 60, { legacy: true });
  r = waitReviewer(s);
  assert.equal(r.code, 13, r.out);
  assert.match(r.out, /has not handed off for 60 min/);
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
  r = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(r.code, 11, 'the asker waits for the answer');
  assert.match(r.out, /the implementer presents the reviewer's question to the user; don't ask the user about it yourself/);
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
  const w = s.run(['wait', 'reviewer', '--timeout', '1']);
  assert.equal(w.code, 11);
  assert.match(w.out, /the implementer presents the implementer's question to the user; don't ask the user about it yourself/);
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

test('the reviewer gets its notes since its last review, each with the implementer\'s acknowledgement', () => {
  const s = sandbox();
  const note = (text) => noteNum(s.run(['note', '--from', 'reviewer', text]));
  s.run(['init', 'notes-recap'], { input: 'b' });
  const a = note('close() skips the amount check');
  const b = note(`batch order starves new rows ${'x'.repeat(200)}`);
  s.run(['submit', 'implementer', 'ready'], { input: `v1\n## Review responses\n- Note #${a} — fixed, amount checked in close()\nNote #${b} — declined: batch is fair\n` });
  let out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, new RegExp(`----- your notes since your last review \\(from collab\\)[^\\n]*\\nNote #${a}: close\\(\\) skips the amount check\\n {3}→ #\\d{3}: Note #${a} — fixed, amount checked in close\\(\\)\\nNote #${b}: batch order starves new rows x+…\\n {3}→ #\\d{3}: Note #${b} — declined: batch is fair\\n----- end -----`));
  assert.doesNotMatch(out, /From: the reviewer/, 'the recap leaves out the note header');

  s.run(['submit', 'reviewer', 'changes'], { input: '1. more' });
  const c = note('one more thing');
  s.run(['submit', 'implementer', 'ready'], { input: `v2 (Note #${c} handled)` });
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, new RegExp(`Note #${c}: one more thing\\n {3}→ #\\d{3}: v2 \\(Note #${c} handled\\)`));
  assert.doesNotMatch(out, new RegExp(`Note #${a}:`), 'notes covered by an earlier review are not repeated');
  // A decision the reviewer asks is not a review: the notes it has not verified yet stay listed.
  s.run(['submit', 'reviewer', 'changes'], { input: '1. once more' });
  const f = note('decide keeps me');
  s.run(['submit', 'implementer', 'ready'], { input: `v2b Note #${f} fixed` });
  assert.equal(s.run(['submit', 'reviewer', 'decide', '--self'], { input: 'Which?\n1. a\n2. b\n' }).code, 0);
  s.run(['answer', '1']);
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, new RegExp(`Note #${f}: decide keeps me\\n {3}→ #\\d{3}: v2b Note #${f} fixed`));

  // The user's notes are not the reviewer's: no recap without a note of its own.
  s.run(['submit', 'reviewer', 'changes'], { input: '1. again' });
  const user = noteNum(s.run(['note', '--implementer', 'from the user']));
  s.run(['submit', 'implementer', 'ready'], { input: `v3 Note #${user} done` });
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.doesNotMatch(out, /your notes since/);
});

test('a plan or ready identical to the previous one is refused before the check runs', () => {
  const s = sandbox();
  const marker = path.join(s.project, 'check-ran');
  s.run(['init', 'same', '--plan', '--check', `node -e "require('fs').appendFileSync('check-ran', 'x')"`], { input: 'b' });
  assert.equal(s.run(['submit', 'implementer', 'plan'], { input: 'plan A\n' }).code, 0);
  s.run(['submit', 'reviewer', 'changes'], { input: '1. add step 3' });
  let r = s.run(['submit', 'implementer', 'plan'], { input: 'plan A  \n\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /this plan is identical to your previous one \(#001\), so nothing was submitted/);
  assert.equal(s.state().status, 'PLAN_CHANGES');
  assert.equal(s.run(['submit', 'implementer', 'plan'], { input: 'plan A\nstep 3\n' }).code, 0);
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });

  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'built' }).code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  s.run(['submit', 'reviewer', 'changes'], { input: '1. fix X' });
  const seq = s.state().seq;
  r = s.run(['submit', 'implementer', 'ready'], { input: 'built' });
  assert.equal(r.code, 1, 'the appended check line does not make the stored entry differ');
  assert.match(r.err, /this ready is identical to your previous one/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'the check did not run');
  assert.equal(s.state().seq, seq, 'nothing was written');
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'built, X fixed' }).code, 0);
});

test('a revised plan reaches the reviewer as the changes since the previous plan', () => {
  const s = sandbox();
  const plan = (extra = '') => ['## Approach', ...Array.from({ length: 30 }, (_, i) => `- point ${i}`), '## Steps', '1. a.ts — change', extra, '## Risks', 'none', ''].join('\n');
  s.run(['init', 'delta', '--plan'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: plan() });
  let out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.match(out, /----- 001-implementer-plan\.md -----\n## Approach/, 'the first plan is shown whole');
  s.run(['submit', 'reviewer', 'changes'], { input: '1. add a step' });
  s.run(['submit', 'implementer', 'plan'], { input: plan('2. b.ts — new step') });
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  const id = s.state().id;
  assert.ok(out.includes(`>>> REVISED PLAN: only the changes since plan #001, which you reviewed ('-' removed, '+' added). Full text: 'collab -t ${id} show 3'. <<<`), out);
  assert.match(out, /----- 003-implementer-plan\.md \(changes since #001\) -----\n@@ line \d+, under "Steps"\n {2}## Steps\n {2}1\. a\.ts — change\n\+ 2\. b\.ts — new step\n- \n {2}## Risks\n {2}none\n----- end -----/);
  assert.doesNotMatch(out, /point 5/, 'unchanged lines far from a change are left out');
  assert.match(s.run(['show', '3']).out, /point 5[\s\S]*b\.ts — new step/, 'show still prints the whole plan');

  // A rewrite is shown whole: the diff would be most of it.
  s.run(['submit', 'reviewer', 'changes'], { input: '1. rethink' });
  s.run(['submit', 'implementer', 'plan'], { input: '## Approach\nsomething else entirely\n' });
  out = s.run(['wait', 'reviewer', '--timeout', '1']).out;
  assert.doesNotMatch(out, /REVISED PLAN/);
  assert.match(out, /----- 005-implementer-plan\.md -----\n## Approach\nsomething else entirely/);
});

test('tasks started in the same second never share a folder', () => {
  const s = sandbox();
  s.run(['init', 'twin'], { input: 'first' });
  s.run(['submit', 'implementer', 'ready'], { input: 'v1' });
  const first = s.state().id;
  const firstDir = s.taskDir();
  s.run(['abort']);
  // Occupy every folder name the next init can get (even on a slow runner), each with the first
  // task's entries, so the init always meets an existing folder.
  const p = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const taken = new Set([first]);
  for (let t = 0; t < 30; t++) {
    const id = `twin-${stamp(new Date(Date.now() + t * 1000))}`;
    if (taken.has(id)) continue;
    taken.add(id);
    const dir = path.join(s.home, 'tasks', id);
    fs.cpSync(firstDir, dir, { recursive: true });
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...st, id }));
  }
  const r = s.run(['init', 'twin'], { input: 'second' });
  assert.equal(r.code, 0, r.err);
  const second = s.state().id;
  assert.match(second, /^twin-\d{8}-\d{6}-2$/);
  assert.ok(taken.has(second.slice(0, -2)), `${second} collided with an occupied folder`);
  assert.deepEqual(fs.readdirSync(path.join(s.taskDir(), 'entries')), ['000-implementer-brief.md']);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 'v1' }).code, 0);
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
  assert.doesNotMatch(r.err, /found/, 'no hint when the label is simply absent');
  r = ready('## Summary\nx\n## Closeout\nVerified (log in x): npm test\nAttempted, blocked: none\nDeferred: none\nNot claimed: none\n');
  assert.equal(r.code, 1, 'text between the label and its colon is refused');
  assert.match(r.err, /labels 'Verified:' .*; found 'Verified \(log in x\): npm test': each label must be followed directly by its colon/);
  r = ready('## Summary\nx\n## Closeout\nVerified: npm test\nAttempted, blocked: none\nDeferred: none\n- **Not claimed** (by me): Windows\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /found 'Not claimed \(by me\): Windows'/, 'list markers and bold are stripped from the quote');
  r = ready('## Summary\nx\n## Closeout\nVerified: npm test\nAttempted, blocked: none\nDeferred: none\nNothing else: ok\nNotes (x): y\n');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /found/, 'a line that only starts with the same letters is not a near miss');
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
    input: `v1 (Note #1 done)\n${CLOSEOUT}## Lessons\n- Tests on Windows need\n  forward slashes in globs\n- keep collab.js dependency-free.\n${long}\n- none\n`,
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
    approveCurrent(s, 'ok', 'v2');
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

// --- sounds and speech ------------------------------------------------------------------------

// Stub players: every name collab can launch, as a node script that records its argv, the sound
// environment and when it started and ended (STUB_SLEEP_MS keeps it playing, STUB_EXIT fails it).
const STUB = `const fs = require('fs');
const log = process.env.STUB_LOG;
const rec = (phase) => fs.appendFileSync(log, JSON.stringify({ phase, name: require('path').basename(__filename, '.js'), pid: process.pid, at: Date.now(),
  argv: process.argv.slice(2), event: process.env.COLLAB_SOUND_EVENT, file: process.env.COLLAB_SOUND_FILE, text: process.env.COLLAB_SAY_TEXT }) + '\\n');
rec('start');
setTimeout(() => { rec('end'); process.exit(parseInt(process.env.STUB_EXIT || '0', 10)); }, parseInt(process.env.STUB_SLEEP_MS || '0', 10));
`;
const ALL_PLAYERS = ['afplay', 'say', 'powershell', 'pw-play', 'paplay', 'aplay', 'mpg123', 'ogg123', 'play', 'ffplay', 'spd-say', 'espeak-ng', 'espeak'];
const MAC_SOUNDS = ['Blow', 'Submarine', 'Bottle', 'Pop', 'Tink', 'Glass', 'Hero', 'Morse', 'Sosumi', 'Basso', 'Funk', 'Ping', 'Frog', 'Purr'];

// named: the sentences start with the task name ('collab sound voice name on'), which most of these
// tests assert; the default (no name) has its own test.
function soundBox({ players = ALL_PLAYERS, platform = 'darwin', env = {}, named = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sound-'));
  const bin = path.join(root, 'bin');
  const sys = path.join(root, 'system');
  fs.mkdirSync(bin);
  fs.mkdirSync(sys);
  for (const p of players) fs.writeFileSync(path.join(bin, `${p}.js`), STUB);
  for (const n of MAC_SOUNDS) fs.writeFileSync(path.join(sys, `${n}.aiff`), '');
  const log = path.join(root, 'stub.log');
  const s = sandbox({ COLLAB_SOUND: '', COLLAB_SOUND_BIN: bin, COLLAB_SOUND_PLATFORM: platform, COLLAB_SOUND_SYSTEM_DIR: sys, STUB_LOG: log, ...env });
  if (named) {
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ sound: { voice: { name: true } } }));
  }
  const records = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const started = () => records().filter((r) => r.phase === 'start');
  const queueDir = path.join(s.home, 'audio', 'queue');
  // Wait until every queued job has been played and the drainer is gone.
  const settle = async (ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      let jobs = [];
      try { jobs = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
      const busy = fs.existsSync(path.join(s.home, 'audio', '.lock'));
      if (!jobs.length && !busy) { await pause(300); if (!fs.existsSync(path.join(s.home, 'audio', '.lock'))) return; }
      if (Date.now() - t0 > ms) throw new Error(`audio queue did not drain: ${jobs.length} job(s), lock ${busy}`);
      await pause(100);
    }
  };
  const events = () => started().map((r) => `${r.event}:${r.name === 'say' ? 'say' : 'tone'}`);
  const tones = () => started().filter((r) => r.name !== 'say').map((r) => r.event);
  const runAsync = (args, more = {}) => new Promise((resolve) => {
    const c = require('child_process').spawn(process.execPath, [CLI, ...args], {
      cwd: s.project, env: { ...process.env, COLLAB_HOME: s.home, COLLAB_POLL_SECS: '1', COLLAB_NOTIFY: '0', COLLAB_TASK: '', ...NO_AGENT, ...NO_ELEVENLABS,
        COLLAB_SOUND: '', COLLAB_SOUND_BIN: bin, COLLAB_SOUND_PLATFORM: platform, COLLAB_SOUND_SYSTEM_DIR: sys, STUB_LOG: log, ...env, ...more },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', (code) => resolve({ code, out }));
  });
  return { ...s, bin, sys, log, records, started, settle, events, tones, runAsync, root };
}

test('sound: on by default with the system voice; mute, tones-only and COLLAB_SOUND=0 still work', async () => {
  const s = soundBox();
  s.run(['init', 'plain'], { input: 'b' });
  await s.settle();
  assert.deepEqual(s.events(), ['brief:tone', 'brief:say'], 'no flag, no config: a tone and a short sentence');
  assert.equal(s.started()[1].argv.slice(-1)[0], 'plain: new task');
  s.run(['abort']);
  // An old config.json without a 'sound' key (and one with on: true) still loads, and means on.
  fs.writeFileSync(path.join(s.home, 'config.json'), '{"phone_url":"https://ntfy.sh/x","sound":{"on":true}}\n');
  assert.match(s.run(['sound']).out, /sound: +on for every task: tones \+ short sentences, system voice/);
  assert.match(s.run(['sound', 'voice', 'off']).out, /tones only/);
  s.run(['init', 'tonesonly'], { input: 'b' });
  await s.settle();
  assert.deepEqual(s.events().filter((e) => e.startsWith('brief')), ['brief:tone', 'brief:say', 'brief:tone'], 'voice off: tones only by default');
  s.run(['abort']);
  s.run(['sound', 'voice', 'on']);
  assert.match(s.run(['sound', 'off']).out, /muted for every task/);
  s.run(['init', 'muted', '--sound=full'], { input: 'b' });
  s.run(['note', '--as-user', 'hi']);
  await pause(800);
  await s.settle();
  const before = s.started().length;
  s.run(['note', '--as-user', 'again']);
  await pause(800);
  await s.settle();
  assert.equal(s.started().length, before, 'a global mute silences even a task that asks for sound');
  s.run(['abort']);
  s.run(['sound', 'on']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.on, undefined);
  await s.settle();
  const m0 = s.started().length;
  s.run(['init', 'envmute', '--sound'], { input: 'b', env: { COLLAB_SOUND: '0' } });
  s.run(['note', '--as-user', 'hi'], { env: { COLLAB_SOUND: '0' } });
  s.run(['abort'], { env: { COLLAB_SOUND: '0' } });
  await pause(800);
  await s.settle();
  assert.equal(s.started().length, m0, 'COLLAB_SOUND=0 wins');
  const n0 = s.started().length;
  s.run(['init', 'quiet', '--sound=off'], { input: 'b' });
  await pause(800);
  await s.settle();
  assert.equal(s.started().length, n0, 'COLLAB_SOUND=0 and --sound=off are silent');
  assert.match(s.run(['status']).out, /sound: +silent/);
});

test('sound: --sound parsing, queue options and carrying on through a run', async () => {
  const s = soundBox({ env: { COLLAB_SOUND: '0' } });
  let r = s.run(['init', '--sound', 'first'], { input: 'b' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /task: +first-/, 'a bare --sound does not eat the slug');
  assert.equal(s.state().options.sound, 'voice');
  s.run(['abort']);
  r = s.run(['init', 'second', '--sound', 'tones'], { input: 'b' });
  assert.equal(s.state().options.sound, 'tones');
  assert.match(r.out, /options: tones only\n/);
  s.run(['abort']);
  r = s.run(['init', 'third', '--sound=loud'], { input: 'b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /--sound takes voice or tones/);
  // Queued and split tasks keep the option.
  s.run(['init', 'run', '--sound=tones'], { input: 'b' });
  r = s.run(['queue', 'split'], { input: 'part one\n=== part ===\npart two\n' });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'queue.json'), 'utf8')).items[0].options.sound, 'tones');
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'part2', '--from-queue'], { input: 'b' });
  assert.equal(s.state().options.sound, 'tones');
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  // The next task of the run carries it on; after 'end' (or an abort) it needs a new opt-in.
  s.run(['init', 'carried'], { input: 'b' });
  assert.equal(s.state().options.sound, 'tones');
  s.run(['abort']);
  s.run(['init', 'after-abort'], { input: 'b' });
  assert.equal(s.state().options.sound, undefined);
  s.run(['abort']);
  s.run(['queue', 'add', '--sound', 'fix the thing']);
  const q = JSON.parse(fs.readFileSync(path.join(s.home, 'queue.json'), 'utf8')).items;
  assert.equal(q[q.length - 1].options.sound, 'voice');
  assert.match(q[q.length - 1].text, /^fix the thing/);
});

test('sound: every handoff of a plan task sounds once, tone then sentence, in order', async () => {
  const s = soundBox();
  s.run(['init', 'Dark Mode', '--plan', '--sound=full'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. a\n2. b\n' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['submit', 'implementer', 'ready'], { input: 's1' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. fix\n' });
  s.run(['submit', 'implementer', 'ready'], { input: 's2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['end'], { input: '## Final report\ndone\n' });
  await s.settle();
  const ev = s.events();
  const order = ['brief', 'plan', 'plan-changes', 'plan', 'plan-approve', 'ready', 'changes', 'ready', 'approve', 'end'];
  assert.deepEqual(ev, order.flatMap((e) => [`${e}:tone`, `${e}:say`]));
  const said = s.started().filter((r) => r.name === 'say').map((r) => r.argv[r.argv.length - 1]);
  assert.equal(said[0], 'dark mode: new task started. The implementer is writing a plan');
  assert.equal(said[2], "dark mode: the reviewer requested 2 changes to the plan. The implementer's turn");
  assert.equal(said[6], "dark mode: the reviewer requested 1 change. The implementer's turn, round 2");
  assert.match(said[9], /work complete, 1 task\. Run collab show/);
  assert.equal(s.started().find((r) => r.event === 'approve').argv.slice(-1)[0], path.join(s.sys, 'Hero.aiff'));
  // Nothing overlapped.
  const recs = s.records();
  for (let i = 1; i < recs.length; i += 2) assert.equal(recs[i].phase === 'end' && recs[i].pid === recs[i - 1].pid, true, 'each step ends before the next starts');
});

test('sound: --sound=tones plays no speech; decisions read out every option and how to answer', async () => {
  const s = soundBox();
  s.run(['init', 'calm', '--sound=tones'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  await s.settle();
  assert.deepEqual(s.events(), ['brief:tone', 'ready:tone']);
  s.run(['abort']);
  s.run(['init', 'ask', '--sound=full'], { input: 'b' });
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## Which DB?\n1. **Postgres** (Recommended) — solid\n2. SQLite — simple\n' });
  s.run(['answer', '2']);
  await s.settle();
  const said = s.started().filter((r) => r.name === 'say').map((r) => r.argv[r.argv.length - 1]);
  const decide = said.find((t) => /decision is needed/.test(t));
  assert.match(decide, /Which DB\? Option 1: Postgres \(Recommended\) — solid\. Option 2: SQLite — simple\./);
  assert.match(decide, /Answer in the implementer's terminal, or run collab answer with the option number/);
  assert.match(said[said.length - 1], /decision recorded: option 2, SQLite — simple\. Back to the implementer/);
});

test('sound: round-limit answers sound as their outcome, split parts sound when they start and end', async () => {
  const s = soundBox({ env: { COLLAB_SOUND_PLATFORM: 'darwin' } });
  s.run(['init', 'limit', '--plan', '--max-rounds', '1', '--sound=tones'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. x\n' });
  s.run(['answer', '2']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. x\n' });
  s.run(['answer', '1']);
  s.run(['submit', 'implementer', 'ready'], { input: 's2' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. y\n' });
  s.run(['submit', 'implementer', 'ready'], { input: 's3' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. z\n' });
  s.run(['answer', '3']);
  await s.settle();
  assert.deepEqual(s.tones(), ['brief', 'plan', 'decide', 'plan-approve', 'ready', 'decide', 'answer', 'ready', 'changes', 'ready', 'decide', 'escalate']);

  const p = soundBox();
  p.run(['init', 'big', '--sound=full'], { input: 'b' });
  p.run(['queue', 'split'], { input: 'one\n=== part ===\ntwo\n' });
  p.run(['submit', 'implementer', 'ready'], { input: 's' });
  p.run(['submit', 'reviewer', 'changes'], { input: '1. x\n' });
  p.run(['submit', 'implementer', 'ready'], { input: 's' + '2' });
  p.run(['submit', 'reviewer', 'changes'], { input: '1. y\n' });
  p.run(['submit', 'implementer', 'ready'], { input: 's3' });
  p.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  p.run(['init', 'big-2', '--from-queue'], { input: 'b' });
  p.run(['submit', 'implementer', 'ready'], { input: 's' });
  p.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  await p.settle();
  const said = p.started().filter((r) => r.name === 'say').map((r) => `${r.event}: ${r.argv[r.argv.length - 1]}`);
  assert.deepEqual(said.filter((t) => /^(split|part-|approve)/.test(t)), [
    'split: big: split into 2 parts',
    'part-start: big: part 1 of 2 started. The implementer is working',
    'approve: big: approved. Task done',
    'part-done: big: part 1 of 2 done. 1 to go',
    'part-start: big 2: part 2 of 2 started. The implementer is working',
    'approve: big 2: approved. Task done',
    'part-done: big 2: part 2 of 2 done. All parts done',
  ]);
  assert.ok(!said.some((t) => t.startsWith('brief: big 2')), 'a queued part sounds as part-start, not as a new task');
});

test('sound: events from several processes never overlap; a command never waits for the audio', async () => {
  const s = soundBox({ env: { STUB_SLEEP_MS: '400' } });
  s.run(['init', 'busy', '--sound'], { input: 'b' });
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3].map((i) => s.runAsync(['note', '--as-user', `n${i}`])));
  assert.deepEqual(rs.map((r) => r.code), [0, 0, 0]);
  assert.ok(Date.now() - t0 < 4000, 'notes return without waiting for 3.2 s of audio');
  await s.settle();
  const recs = s.records();
  assert.equal(recs.filter((r) => r.phase === 'start').length, 8, 'brief + 3 notes, each tone + sentence');
  const spans = recs.filter((r) => r.phase === 'start').map((st) => [st.at, recs.find((e) => e.phase === 'end' && e.pid === st.pid).at]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], `step ${i} started before step ${i - 1} ended`);

  // A slow player never holds the command open, and a failing or missing one changes no exit code.
  const slow = soundBox({ env: { STUB_SLEEP_MS: '8000' } });
  slow.run(['init', 'slow', '--sound'], { input: 'b' });
  const t1 = Date.now();
  assert.equal(slow.run(['note', '--as-user', 'x']).code, 0);
  assert.ok(Date.now() - t1 < 3000, 'note returned while the player still plays');
  const bad = soundBox({ env: { STUB_EXIT: '1' } });
  bad.run(['init', 'bad', '--sound'], { input: 'b' });
  assert.equal(bad.run(['submit', 'implementer', 'ready'], { input: 's' }).code, 0);
  assert.equal(bad.run(['submit', 'reviewer', 'approve'], { input: 'ok' }).code, 10);
  await bad.settle();
  assert.equal(bad.started().length, 6, 'a failing step does not stop the next ones');
  const none = soundBox({ players: [] });
  none.run(['init', 'none', '--sound', '--check', 'node -e "process.exit(3)"'], { input: 'b' });
  assert.equal(none.run(['submit', 'implementer', 'ready'], { input: 's' }).code, 14);
  assert.equal(none.run(['abort']).code, 0);
  await none.settle();
  const t = none.run(['sound', 'test', 'decide']);
  assert.equal(t.code, 1);
  assert.match(t.out, /not played: no player/);
  assert.match(t.out, /not played: no speech engine found/);
});

test('sound: a dead drainer is taken over only after the sound it started has finished', async () => {
  const s = soundBox({ env: { STUB_SLEEP_MS: '2500' } });
  s.run(['init', 'crash', '--sound=tones'], { input: 'b' });
  let first;
  for (let i = 0; i < 100 && !first; i++) { await pause(100); first = s.started()[0]; }
  assert.ok(first, 'the first tone started');
  const owner = parseInt(fs.readFileSync(path.join(s.home, 'audio', '.lock', 'owner'), 'utf8'), 10);
  process.kill(owner, 'SIGKILL');
  await pause(200);
  s.run(['note', '--as-user', 'after the crash']);
  await s.settle();
  const recs = s.records();
  const second = recs.filter((r) => r.phase === 'start')[1];
  const firstEnd = recs.find((r) => r.phase === 'end' && r.pid === first.pid);
  assert.ok(second, 'the second tone played');
  // On Windows a process's (non-detached) children die with it, so the first tone stops when its
  // drainer is killed and nothing is left to overlap. Elsewhere it plays on, and the takeover waits.
  if (process.platform === 'win32') assert.ok(!firstEnd || second.at >= firstEnd.at);
  else {
    assert.ok(firstEnd, 'the first tone played to its end');
    assert.ok(second.at >= firstEnd.at, 'the takeover waited for the dead drainer\'s tone');
  }
});

test('sound: idle, stall, confirm-first and agent waits sound once per episode', async () => {
  const s = soundBox({ env: { COLLAB_IDLE_SECS: '1' } });
  s.run(['init', 'idle', '--sound=tones'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  await pause(1500);
  const rs = await Promise.all([s.runAsync(['wait', 'implementer', '--timeout', '3']), s.runAsync(['wait', 'implementer', '--timeout', '3'])]);
  assert.deepEqual(rs.map((r) => r.code), [13, 13]);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13);
  await s.settle();
  assert.deepEqual(s.tones().filter((e) => e === 'idle'), ['idle'], 'one sound for one idle episode');
  const updated = s.state().updated_epoch;
  // Activity (a progress update) starts a new episode.
  s.run(['progress', 'still reviewing']);
  await pause(1500);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13);
  await s.settle();
  assert.equal(s.tones().filter((e) => e === 'idle').length, 2);
  assert.equal(s.state().updated_epoch, updated, 'sound claims are not agent activity');

  const st = soundBox({ env: { COLLAB_STALL_SECS: '1', COLLAB_IDLE_SECS: '100' } });
  st.run(['init', 'stall', '--sound=tones'], { input: 'b' });
  st.run(['submit', 'implementer', 'ready'], { input: 's' });
  await pause(1500);
  const ss = await Promise.all([st.runAsync(['wait', 'implementer', '--timeout', '3']), st.runAsync(['wait', 'implementer', '--timeout', '3'])]);
  assert.deepEqual(ss.map((r) => r.code), [10, 10]);
  await st.settle();
  assert.deepEqual(st.tones().filter((e) => e === 'stall'), ['stall']);

  const q = soundBox();
  q.run(['queue', 'add', '--confirm', '--sound=tones', 'needs a yes']);
  q.run(['queue', 'next']);
  q.run(['queue', 'next']);
  // An agent CLI waiting: no --phone needed, and the same event within a minute sounds once.
  q.run(['init', 'hooks', '--sound=tones', '--force'], { input: 'b' });
  const ev = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { command: 'rm -rf build' }, cwd: q.project });
  q.run(['phone', 'send'], { input: ev });
  q.run(['phone', 'send'], { input: ev });
  // The same prompt in another project's running task is its own event; outside a task, silence.
  const other = path.join(q.root, 'other');
  fs.mkdirSync(other);
  q.run(['init', 'elsewhere', '--sound=tones'], { input: 'b', cwd: other });
  q.run(['phone', 'send'], { input: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { command: 'rm -rf build' }, cwd: other }) });
  q.run(['sound', 'on']);
  const nowhere = path.join(q.root, 'nowhere');
  fs.mkdirSync(nowhere);
  q.run(['phone', 'send'], { input: JSON.stringify({ message: 'x', cwd: nowhere }) });
  await q.settle();
  assert.deepEqual(q.tones(), ['confirm', 'brief', 'agent-waiting', 'brief', 'agent-waiting']);
});

test('sound: config overrides, packs, explicit silence and custom sentences', async () => {
  const s = soundBox();
  const pack = path.join(s.root, 'my pack');
  let r = s.run(['sound', 'pack', '--init', pack]);
  assert.equal(r.code, 0, r.err);
  const manifest = path.join(pack, 'collab-sounds.json');
  const tpl = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(tpl.events.approve.file, null);
  assert.equal(tpl.events.ready.say, '{task}: ready, round {round}');
  assert.equal(s.run(['sound', 'pack', '--init', pack]).code, 1, 'never overwrites a manifest');
  fs.writeFileSync(path.join(pack, 'done.wav'), '');
  fs.writeFileSync(path.join(pack, 'any.wav'), '');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'mine', events: {
    approve: 'done.wav', '*': 'any.wav', 'note-*': { file: 'missing.wav' }, ready: { say: '{task} round {round} is up' }, typo: 'x.wav',
  } }));
  r = s.run(['sound', 'pack', pack]);
  assert.equal(r.code, 1, 'a missing file refuses the pack');
  assert.match(r.err, /note-\*: file not found/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.pack, undefined, 'nothing written');
  fs.writeFileSync(path.join(pack, 'missing.wav'), '');
  fs.writeFileSync(path.join(pack, 'x.wav'), '');
  r = s.run(['sound', 'pack', pack]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /'typo' matches no event/);
  // A file that goes missing later just falls through to the next key ('*').
  fs.rmSync(path.join(pack, 'missing.wav'));
  const mine = path.join(s.root, 'with space é.wav');
  fs.writeFileSync(mine, '');
  r = s.run(['sound', 'set', 'brief', path.basename(mine)], { cwd: s.root });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.realpathSync(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.events.brief), fs.realpathSync(mine), 'stored as an absolute path');
  assert.equal(s.run(['sound', 'set', 'plan', 'none']).code, 0);
  assert.equal(s.run(['sound', 'set', 'bogus', mine]).code, 1);
  assert.equal(s.run(['sound', 'set', 'peer-*', path.join(s.root, 'nope.wav')]).code, 1);
  assert.equal(s.run(['sound', 'set', 'peer-*', mine]).code, 0, 'a glob that matches events is fine');
  fs.writeFileSync(path.join(s.home, 'tilde.wav'), '');
  assert.equal(s.run(['sound', 'set', 'end', '~/tilde.wav'], { env: { HOME: s.home, USERPROFILE: s.home } }).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.events.end, path.join(s.home, 'tilde.wav'));
  assert.equal(s.run(['sound', 'unset', 'end']).code, 0);
  assert.equal(s.run(['sound', 'unset', 'end']).code, 1);
  assert.equal(s.run(['sound', 'volume', '150']).code, 1);
  assert.equal(s.run(['sound', 'volume', '40']).code, 0);

  s.run(['init', 'packed', '--plan', '--sound=full'], { input: 'b' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['note', '--as-user', 'n']);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok\nNote #4 — seen' }).code, 10);
  await s.settle();
  const got = s.started().map((r) => `${r.event}:${r.name === 'say' ? r.argv[r.argv.length - 1] : path.basename(r.argv[r.argv.length - 1])}`);
  assert.deepEqual(got, [
    `brief:${path.basename(mine)}`, 'brief:packed: new task started. The implementer is writing a plan',
    // plan: silenced in config (no tone, no sentence)
    'plan-approve:any.wav', 'plan-approve:packed: plan approved. The implementer is building it',
    'ready:any.wav', 'ready:packed round 1 is up',
    'note-all:any.wav', 'note-all:packed: your note for both agents was added',
    'approve:done.wav', 'approve:packed: approved. Task done',
  ]);
  assert.equal(s.started()[0].argv[1], '0.4', 'volume');
  fs.writeFileSync(manifest, '{ not json');
  r = s.run(['sound', 'pack', pack]);
  assert.equal(r.code, 1);
  assert.match(r.err, /is not valid/);
  assert.match(s.run(['sound']).out, /✗ pack: .*is not valid/);
});

test('sound: setup, on/off and the player and speech commands per platform', () => {
  const s = soundBox();
  let r = s.run(['sound', 'setup']);
  assert.equal(r.code, 0, r.err);
  let cfg = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound;
  assert.equal(cfg.on, true);
  assert.equal(cfg.voice.on, true);
  assert.equal(cfg.events.decide, path.join(s.sys, 'Sosumi.aiff'));
  s.run(['sound', 'set', 'decide', path.join(s.sys, 'Pop.aiff')]);
  s.run(['sound', 'setup']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.events.decide, path.join(s.sys, 'Pop.aiff'));
  s.run(['sound', 'setup', '--force']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.events.decide, path.join(s.sys, 'Sosumi.aiff'));
  assert.match(s.run(['sound', 'off']).out, /muted/);
  assert.match(s.run(['sound']).out, /sound: +off: muted/);
  s.run(['sound', 'unmute']);
  assert.match(s.run(['sound']).out, /on for every task/);

  // A real file name valid on every OS (no double quotes on Windows); quotes are tested in speech text.
  const odd = path.join(s.root, `it's odd ü 日本.mp3`);
  fs.writeFileSync(odd, '');
  const wav = path.join(s.root, 'a b.wav');
  fs.writeFileSync(wav, '');
  const ogg = path.join(s.root, 'c.ogg');
  fs.writeFileSync(ogg, '');
  const dry = (file, platform, more = {}) => s.run(['sound', 'test', file, '--dry-run'], { env: { COLLAB_SOUND_PLATFORM: platform, ...more } });
  r = dry(odd, 'darwin');
  assert.match(r.out, /afplay\.js -v 1 /);
  assert.match(dry(ogg, 'darwin').out, /\.ogg files can't be played on macOS/);
  r = dry(wav, 'win32');
  assert.match(r.out, /powershell\.js -NoProfile -NonInteractive -WindowStyle Hidden -Command .*SoundPlayer/);
  assert.ok(r.out.includes(`"COLLAB_SOUND_FILE":${JSON.stringify(wav)}`));
  assert.match(dry(odd, 'win32').out, /MediaPlayer/);
  assert.match(dry(ogg, 'win32').out, /\.ogg files can't be played on Windows/);
  assert.match(dry(ogg, 'linux').out, /pw-play\.js --volume 1 /);
  const linuxBin = path.join(s.root, 'linux-bin');
  fs.mkdirSync(linuxBin);
  fs.writeFileSync(path.join(linuxBin, 'aplay.js'), STUB);
  fs.writeFileSync(path.join(linuxBin, 'espeak-ng.js'), STUB);
  assert.match(dry(wav, 'linux', { COLLAB_SOUND_BIN: linuxBin }).out, /aplay\.js -q /);
  assert.match(dry(odd, 'linux', { COLLAB_SOUND_BIN: linuxBin }).out, /no player for \.mp3 files found \(mpg123, ffplay\); install/);
  r = s.run(['sound', 'test', 'abort', '--full', '--dry-run'], { env: { COLLAB_SOUND_PLATFORM: 'linux', COLLAB_SOUND_BIN: linuxBin } });
  assert.match(r.out, /speech "dark mode: aborted\. Both agents stop": .*espeak-ng\.js -a 200 /);
  r = s.run(['sound', 'test', 'abort', '--full', '--dry-run'], { env: { COLLAB_SOUND_PLATFORM: 'win32' } });
  assert.match(r.out, /SpeechSynthesizer/);
  assert.ok(r.out.includes('"COLLAB_SAY_TEXT":"dark mode: aborted. Both agents stop"'));
  // The real launch passes the odd file name through intact.
  r = s.run(['sound', 'test', odd]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(s.started().pop().argv.slice(-1)[0], odd);
  r = s.run(['sound', 'test', odd], { env: { COLLAB_SOUND_PLATFORM: 'win32' } });
  assert.equal(s.started().pop().file, odd);
  assert.match(s.run(['sound'], { env: { COLLAB_SOUND_BIN: linuxBin, COLLAB_SOUND_PLATFORM: 'darwin' } }).out, /speech: +no speech engine found \(say\)/);
  const cfgFile = path.join(s.home, 'config.json');
  const conf = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  conf.sound.events.abort = { file: null, say: 'she said "stop" — it\'s über 日本' };
  fs.writeFileSync(cfgFile, JSON.stringify(conf));
  assert.equal(s.run(['sound', 'test', 'abort']).code, 0);
  assert.equal(s.started().pop().argv.slice(-1)[0], 'she said "stop" — it\'s über 日本');
  assert.equal(s.run(['sound', 'test', 'abort'], { env: { COLLAB_SOUND_PLATFORM: 'win32' } }).code, 0);
  assert.equal(s.started().pop().text, 'she said "stop" — it\'s über 日本');
  assert.match(s.run(['sound', 'events']).out, /idle +an agent looks unresponsive/);
});

test('sound: different transitions racing each other are announced in the order they happened', async () => {
  for (let round = 0; round < 3; round++) {
    const s = soundBox();
    s.run(['init', 'race', '--sound=tones'], { input: 'b' });
    const msg = path.join(s.root, 'ready.md');
    fs.writeFileSync(msg, `## Summary\ns\n${CLOSEOUT}`);
    const rs = await Promise.all([
      s.runAsync(['submit', 'implementer', 'ready', '--file', msg]),
      s.runAsync(['note', '--as-user', '--reviewer', 'look at x']),
      s.runAsync(['note', '--from', 'reviewer', 'early finding']),
      s.runAsync(['note', '--as-user', '--implementer', 'and y']),
    ].map((p) => p));
    assert.ok(rs.every((r) => [0, 12].includes(r.code)), rs.map((r) => r.code).join(","));
    await s.settle();
    const order = fs.readdirSync(path.join(s.taskDir(), 'entries')).sort().map((f) => f.replace(/^\d+-/, '').replace(/\.md$/, ''))
      .map((k) => (k === 'implementer-brief' ? 'brief' : k === 'implementer-ready' ? 'ready' : k.replace(/^human-/, '')));
    assert.deepEqual(s.tones(), order, `round ${round + 1}`);
  }
});

test('sound: a long decision keeps every option number and the answering instruction', async () => {
  const s = soundBox();
  s.run(['init', 'a-very-long-task-name-about-many-things-at-once', '--sound=full'], { input: 'b' });
  const long = 'word '.repeat(60).trim();
  s.run(['submit', 'implementer', 'decide', '--self'], { input: `## ${long}?\n1. ${long}\n2. ${long}\n3. ${long}\n4. ${long}\n` });
  await s.settle();
  const said = s.started().filter((r) => r.name === 'say').map((r) => r.argv[r.argv.length - 1]).find((t) => /decision is needed/.test(t));
  for (const n of [1, 2, 3, 4]) assert.match(said, new RegExp(`Option ${n}: word`));
  assert.match(said, /Answer in the implementer's terminal, or run collab answer with the option number$/);
});

test('sound: an unusable audio store never changes a command\'s result', async () => {
  const s = soundBox();
  fs.mkdirSync(s.home, { recursive: true });
  fs.writeFileSync(path.join(s.home, 'audio'), 'not a folder');
  s.run(['queue', 'add', '--confirm', '--sound', 'needs a yes']);
  let r = s.run(['queue', 'next']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CONFIRM FIRST/);
  assert.match(r.out, /needs a yes/);
  r = s.run(['init', 'broken', '--sound', '--from-queue', '--confirmed', 'yes'], { input: 'b' });
  assert.equal(r.code, 0, r.err);
  assert.equal(s.run(['note', '--as-user', 'n']).code, 0);
  assert.equal(s.run(['phone', 'send'], { input: JSON.stringify({ message: 'Claude needs your permission', cwd: s.project }) }).code, 0);
  assert.equal(s.run(['submit', 'implementer', 'ready'], { input: 's\nNote #2 — ok' }).code, 0);
  assert.equal(s.run(['submit', 'reviewer', 'approve'], { input: 'ok\nNote #2 — ok' }).code, 10);
});

// --- ElevenLabs voice ----------------------------------------------------------------------------

// A stand-in for the ElevenLabs API: records each request, answers with `reply(req)`. It runs in
// this process, so commands that call it must use runAsync (spawnSync would block it).
async function fakeElevenLabs(reply) {
  const http = require('http');
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      const r = { method: req.method, url: req.url, key: req.headers['xi-api-key'], body: body ? JSON.parse(body) : null };
      reqs.push(r);
      const a = reply(r);
      if (a === 'hang') return;
      res.writeHead(a.status || 200, { 'Content-Type': a.type || 'audio/mpeg' });
      res.end(a.body === undefined ? Buffer.from('ID3fake-mp3') : a.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, reqs, close: () => { server.closeAllConnections && server.closeAllConnections(); server.close(); } };
}
const KEY = 'sk_test_SECRET_123';

test('elevenlabs: --sound=elevenlabs speaks through the API, caches, and never leaks the key', async () => {
  const api = await fakeElevenLabs(() => ({}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url, ELEVENLABS_API_KEY: KEY, STUB_SLEEP_MS: '300' } });
    let r = s.run(['init', 'Voice', '--sound', 'elevenlabs'], { input: 'b' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([s.state().options.sound, s.state().options.sound_engine], ['voice', 'elevenlabs']);
    assert.match(r.out, /options: sounds, ElevenLabs voice/);
    // Jobs waiting in the queue carry no key.
    s.run(['note', '--as-user', 'one']);
    s.run(['note', '--as-user', 'one']);
    const q = path.join(s.home, 'audio', 'queue');
    const queued = (() => { try { return fs.readdirSync(q).map((f) => fs.readFileSync(path.join(q, f), 'utf8')).join(''); } catch { return ''; } })();
    assert.ok(!queued.includes(KEY));
    await s.settle();
    assert.equal(api.reqs.length, 2, 'brief + one note sentence; the identical second note is a cache hit');
    const [first] = api.reqs;
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128');
    assert.equal(first.key, KEY);
    assert.deepEqual(first.body, { text: 'voice: new task', model_id: 'eleven_flash_v2_5' }, 'the short sentence (the default)');
    const played = s.started().filter((x) => x.event === 'brief').map((x) => x.name);
    assert.deepEqual(played, ['afplay', 'afplay'], 'tone, then the ElevenLabs mp3 through the tone player');
    assert.ok(s.started().every((x) => x.name !== 'say'), 'no system voice when ElevenLabs works');
    const mp3 = s.started()[1].argv.slice(-1)[0];
    assert.match(mp3, /audio[\\/]tts[\\/][0-9a-f]{64}\.mp3$/);
    // The key is nowhere on disk or in any output.
    const all = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'latin1')); } };
    walk(s.home);
    assert.ok(!all.join('').includes(KEY), 'no key under COLLAB_HOME');
    assert.ok(!JSON.stringify(s.records()).includes(KEY), 'no key in player argv/env');
    r = s.run(['sound']);
    assert.ok(!r.out.includes(KEY));
    assert.match(r.out, /key from ELEVENLABS_API_KEY; cache 2 file/);
    assert.match(r.out, /last call .* ago: ok/);
  } finally { api.close(); }
});

test('elevenlabs: failures fall back to the system voice, with a scoped backoff', async () => {
  let status = 401;
  const api = await fakeElevenLabs(() => ({ status, type: 'application/json', body: `{"detail":"bad key ${KEY}"}` }));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url, ELEVENLABS_API_KEY: KEY } });
    s.run(['init', 'fall', '--sound=elevenlabs'], { input: 'b' });
    s.run(['note', '--as-user', 'a']);
    await s.settle();
    assert.equal(api.reqs.length, 1, 'after a 401, ElevenLabs is skipped (backoff)');
    assert.deepEqual(s.started().map((x) => x.name), ['afplay', 'say', 'afplay', 'say']);
    let r = s.run(['sound']);
    assert.match(r.out, /failed, HTTP 401 \(invalid or missing API key\); system voice until/);
    assert.ok(!r.out.includes(KEY) && !r.out.includes('bad key'), 'no response body');
    // A new key retries at once.
    s.run(['note', '--as-user', 'b'], { env: { ELEVENLABS_API_KEY: 'sk_other' } });
    await s.settle();
    assert.equal(api.reqs.length, 2);
    status = 429;
    r = await s.runAsync(['sound', 'test', 'abort', '--elevenlabs'], { ELEVENLABS_API_KEY: 'sk_third' });
    assert.equal(r.code, 1);
    assert.match(r.out, /ElevenLabs not used: ElevenLabs failed: HTTP 429 \(rate limit or character quota reached\); the system voice spoke instead/);
    // A 200 without audio is a failure too.
    status = 200;
    r = await s.runAsync(['sound', 'test', 'end', '--elevenlabs'], { ELEVENLABS_API_KEY: 'sk_fourth' });
    assert.match(r.out, /ElevenLabs sent no audio/);
  } finally { api.close(); }

  const hang = await fakeElevenLabs(() => 'hang');
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: hang.url, ELEVENLABS_API_KEY: KEY, COLLAB_ELEVENLABS_TIMEOUT_SECS: '1' } });
    const r = await s.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    assert.match(r.out, /no answer within 1 s; the system voice spoke instead/);
  } finally { hang.close(); }

  // No key, or no mp3 player: no request at all.
  const api2 = await fakeElevenLabs(() => ({}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api2.url } });
    let r = await s.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    assert.match(r.out, /no ElevenLabs API key/);
    const lin = soundBox({ platform: 'linux', players: ['aplay', 'espeak-ng'], env: { COLLAB_ELEVENLABS_URL: api2.url, ELEVENLABS_API_KEY: KEY } });
    r = await lin.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    assert.match(r.out, /can't play ElevenLabs audio: no player for \.mp3 files found/);
    assert.equal(lin.started().pop().name, 'espeak-ng');
    // The player failing on the mp3 falls back for that sentence.
    const bad = soundBox({ env: { COLLAB_ELEVENLABS_URL: api2.url, ELEVENLABS_API_KEY: KEY, STUB_EXIT: '1' } });
    r = await bad.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    assert.match(r.out, /the player failed on the ElevenLabs audio \(exit code 1\)/);
    // An unusable cache falls back too.
    const nocache = soundBox({ env: { COLLAB_ELEVENLABS_URL: api2.url, ELEVENLABS_API_KEY: KEY } });
    fs.mkdirSync(path.join(nocache.home, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(nocache.home, 'audio', 'tts'), 'not a folder');
    r = await nocache.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    assert.match(r.out, /can't write the ElevenLabs audio cache; the system voice spoke instead/);
    assert.equal(api2.reqs.length, 2, 'only the two runs that had a key and a player called the API');
  } finally { api2.close(); }
});

test('elevenlabs: setup commands, config key, voices, dry run and cache', async () => {
  const api = await fakeElevenLabs((r) => (r.url.startsWith('/v2/voices')
    ? { type: 'application/json', body: JSON.stringify(r.url.includes('next_page_token=p2')
      ? { voices: [{ voice_id: 'v2', name: 'Bea', category: 'cloned' }], has_more: false }
      : { voices: [{ voice_id: 'v1', name: 'Al', category: 'premade' }], has_more: true, next_page_token: 'p2' }) }
    : {}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url } });
    let r = s.run(['sound', 'voice', 'elevenlabs', '--voice', 'v2', '--model', 'eleven_multilingual_v2']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /key: missing/);
    assert.match(r.out, /sent to ElevenLabs/);
    r = s.run(['sound', 'voice', 'key'], { input: `${KEY}\n` });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /plain text/);
    assert.ok(!r.out.includes(KEY));
    const cfg = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8'));
    assert.equal(cfg.sound.voice.api_key, KEY);
    assert.equal(cfg.sound.voice.engine, 'elevenlabs');
    assert.match(s.run(['sound']).out, /engine: +ElevenLabs/);
    // Dry run: the request, no call.
    r = await s.runAsync(['sound', 'test', 'abort', '--dry-run']);
    assert.match(r.out, /ElevenLabs voice v2, model eleven_multilingual_v2 \(not cached: POST /);
    assert.equal(api.reqs.length, 0);
    // A config key works, and a job built under 'voice' mode with the config engine never holds it.
    s.run(['init', 'cfgkey', '--sound', 'voice'], { input: 'b' });
    await s.settle();
    assert.equal(api.reqs.length, 1);
    assert.equal(api.reqs[0].key, KEY);
    assert.equal(api.reqs[0].body.model_id, 'eleven_multilingual_v2');
    assert.ok(api.reqs[0].url.startsWith('/v1/text-to-speech/v2?'));
    r = await s.runAsync(['sound', 'voices']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Al +v1 +premade\nBea +v2 +cloned/);
    assert.ok(api.reqs.some((x) => x.url === '/v2/voices?page_size=100&next_page_token=p2'));
    // Different settings are a different cached file; 'cache clear' empties it.
    await s.runAsync(['sound', 'test', 'end']);
    await s.runAsync(['sound', 'test', 'end']);
    const before = api.reqs.length;
    const conf = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8'));
    conf.sound.voice.stability = 0.3;
    fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify(conf));
    await s.runAsync(['sound', 'test', 'end']);
    assert.equal(api.reqs.length, before + 1);
    assert.deepEqual(api.reqs[api.reqs.length - 1].body.voice_settings, { stability: 0.3 });
    assert.match(s.run(['sound', 'cache', 'clear']).out, /deleted [1-9]\d* cached/);
    assert.equal(s.run(['sound', 'voice', 'key', '--clear']).code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.voice.api_key, undefined);
    assert.equal(s.run(['sound', 'voice', 'system']).code, 0);
    assert.match(s.run(['sound']).out, /engine: +system voice/);
    // Carry-forward and queue options keep the engine.
    s.run(['abort']);
    s.run(['queue', 'add', '--sound=elevenlabs', 'later']);
    s.run(['init', 'q', '--from-queue'], { input: 'b' });
    assert.deepEqual([s.state().options.sound, s.state().options.sound_engine], ['voice', 'elevenlabs']);
  } finally { api.close(); }
});

test('elevenlabs: the cache keeps at most 300 sentences', async () => {
  const api = await fakeElevenLabs(() => ({}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url, ELEVENLABS_API_KEY: KEY } });
    const dir = path.join(s.home, 'audio', 'tts');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 86400e3);
    for (let i = 0; i < 305; i++) {
      const f = path.join(dir, `${String(i).padStart(64, '0')}.mp3`);
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, old, old);
    }
    await s.runAsync(['sound', 'test', 'abort', '--elevenlabs']);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3'));
    assert.equal(left.length, 300);
    assert.ok(!left.includes(`${'0'.repeat(64)}.mp3`), 'the oldest went first');
  } finally { api.close(); }
});

test('sound: short sentences by default, full ones on request, custom sentences still win', async () => {
  const s = soundBox();
  s.run(['init', 'Dark Mode', '--plan', '--sound'], { input: 'b' });
  s.run(['queue', 'split'], { input: 'one\n=== part ===\ntwo\n' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. a\n' });
  s.run(['submit', 'implementer', 'plan'], { input: 'p2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## Which?\n1. A\n2. B\n' });
  s.run(['answer', '1']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. x\n' });
  s.run(['submit', 'implementer', 'ready'], { input: 's2' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  await s.settle();
  const said = s.started().filter((r) => r.name === 'say').map((r) => r.argv[r.argv.length - 1]);
  assert.deepEqual(said, [
    'dark mode: new task', 'dark mode: split into 2 parts', 'dark mode: part 1 of 2 started', 'dark mode: plan ready',
    'dark mode: plan changes', 'dark mode: plan ready', 'dark mode: plan approved', 'dark mode: decision needed',
    'dark mode: answered', 'dark mode: ready, round 1', 'dark mode: changes, round 2', 'dark mode: ready, round 2',
    'dark mode: approved', 'dark mode: part 1 of 2 done',
  ]);
  // --sound=full is a mode like the others: parsed, shown, carried on to the next task of the run.
  s.run(['init', 'next', '--from-queue'], { input: 'b' });
  assert.equal(s.state().options.sound, 'voice', 'the split part keeps the task option');
  s.run(['abort']);
  let r = s.run(['init', 'wordy', '--sound', 'full'], { input: 'b' });
  assert.deepEqual([s.state().options.sound, s.state().options.sound_style], ['voice', 'full']);
  assert.match(r.out, /options: sounds, full sentences/);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'carried'], { input: 'b' });
  assert.deepEqual([s.state().options.sound, s.state().options.sound_style], ['voice', 'full']);
  await s.settle();
  const last = s.started().filter((x) => x.name === 'say').pop().argv.slice(-1)[0];
  assert.equal(last, 'carried: new task started. The implementer is working');
  s.run(['abort']);
  // The config style; a custom sentence wins over either style.
  assert.match(s.run(['sound']).out, /style: +short sentences/);
  r = s.run(['sound', 'voice', 'style', 'full']);
  assert.equal(r.code, 0, r.err);
  assert.match(s.run(['sound']).out, /style: +full sentences/);
  assert.match(s.run(['sound', 'test', 'approve', '--dry-run']).out, /speech "dark mode: approved\. Task done"/);
  s.run(['sound', 'voice', 'style', 'short']);
  assert.match(s.run(['sound', 'test', 'approve', '--dry-run']).out, /speech "dark mode: approved"/);
  assert.match(s.run(['sound', 'test', 'approve', '--full', '--dry-run']).out, /speech "dark mode: approved\. Task done"/);
  assert.equal(s.run(['sound', 'voice', 'style', 'long']).code, 1);
  const cfgFile = path.join(s.home, 'config.json');
  const conf = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  conf.sound.events = { approve: { say: '{task} is done' } };
  fs.writeFileSync(cfgFile, JSON.stringify(conf));
  assert.match(s.run(['sound', 'test', 'approve', '--full', '--dry-run']).out, /speech "dark mode is done"/);
  assert.match(s.run(['sound', 'events']).out, /approve +the reviewer approved: the task is done\n +short: "dark mode: approved"\n +full: +"dark mode: approved\. Task done"/);
});

test('sound: a short idle names the quiet agent, during a turn and after DONE', async () => {
  const s = soundBox({ env: { COLLAB_IDLE_SECS: '1' } });
  s.run(['init', 'quiet', '--sound'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  await pause(1500);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13);
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  await pause(1500);
  assert.equal(s.run(['join', '--after', s.state().id, '--timeout', '3']).code, 13);
  await s.settle();
  const said = s.started().filter((r) => r.name === 'say' && r.event === 'idle').map((r) => r.argv[r.argv.length - 1]);
  assert.deepEqual(said, ['quiet: the reviewer is quiet', 'quiet: the implementer is quiet']);
});

test('elevenlabs: style_exaggeration is separate from the sentence style; old numeric styles still count', async () => {
  const api = await fakeElevenLabs(() => ({}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url, ELEVENLABS_API_KEY: KEY } });
    const cfgFile = path.join(s.home, 'config.json');
    fs.mkdirSync(s.home, { recursive: true });
    const write = (voice) => fs.writeFileSync(cfgFile, JSON.stringify({ sound: { voice: { name: true, ...voice } } }));
    const settingsOf = async (what) => { await s.runAsync(['sound', 'test', what, '--elevenlabs']); return api.reqs[api.reqs.length - 1].body; };
    write({ engine: 'elevenlabs', style: 0 });
    let b = await settingsOf('approve');
    assert.deepEqual(b.voice_settings, { style: 0 }, 'a legacy numeric style, even 0, still reaches ElevenLabs');
    assert.equal(b.text, 'dark mode: approved');
    // The setter keeps the number under its own key before writing the sentence style.
    assert.equal(s.run(['sound', 'voice', 'style', 'full']).code, 0);
    const v = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).sound.voice;
    assert.equal(v.style, 'full');
    assert.equal(v.style_exaggeration, 0);
    b = await settingsOf('abort');
    assert.deepEqual(b.voice_settings, { style: 0 });
    assert.equal(b.text, 'dark mode: aborted. Both agents stop', 'full sentences with the numeric setting kept');
    write({ engine: 'elevenlabs', style: 'short', style_exaggeration: 0.4, stability: 0.5 });
    b = await settingsOf('end');
    assert.deepEqual(b.voice_settings, { stability: 0.5, style: 0.4 });
    write({ engine: 'elevenlabs', style: 'full' });
    b = await settingsOf('stall');
    assert.equal(b.voice_settings, undefined, "'short'/'full' never go out as voice_settings.style");
  } finally { api.close(); }
});

test('sound: a generated pack keeps the quiet agent of idle at run time', async () => {
  const s = soundBox({ env: { COLLAB_IDLE_SECS: '1' } });
  const pack = path.join(s.root, 'gen');
  assert.equal(s.run(['sound', 'pack', '--init', pack]).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pack, 'collab-sounds.json'), 'utf8')).events.idle.say, '{task}: the {quiet} is quiet');
  assert.equal(s.run(['sound', 'pack', pack]).code, 0);
  s.run(['init', 'gen', '--sound=full'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  await pause(1500);
  assert.equal(s.run(['wait', 'implementer', '--timeout', '3']).code, 13);
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  await pause(1500);
  assert.equal(s.run(['join', '--after', s.state().id, '--timeout', '3']).code, 13);
  await s.settle();
  const said = s.started().filter((r) => r.name === 'say' && r.event === 'idle').map((r) => r.argv[r.argv.length - 1]);
  assert.deepEqual(said, ['gen: the reviewer is quiet', 'gen: the implementer is quiet'], 'the pack sentence wins even over --sound=full');
});

test('sound use: switches the running task over the global engine and style, and back', async () => {
  const api = await fakeElevenLabs(() => ({}));
  try {
    const s = soundBox({ env: { COLLAB_ELEVENLABS_URL: api.url, ELEVENLABS_API_KEY: KEY } });
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ sound: { voice: { name: true, engine: 'elevenlabs', style: 'full' } } }));
    s.run(['init', 'Mix'], { input: 'b' });
    await s.settle();
    assert.equal(api.reqs.length, 1);
    assert.equal(api.reqs[0].body.text, 'mix: new task started. The implementer is working', 'global ElevenLabs + full');
    // This task only: the system voice and short sentences. Nothing global changes.
    let r = s.run(['sound', 'use', 'system', 'short']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /tones \+ short sentences, system voice \(from the next event/);
    s.run(['note', '--as-user', 'x']);
    await s.settle();
    assert.equal(api.reqs.length, 1, 'no request for the system voice');
    const said = s.started().filter((x) => x.name === 'say').map((x) => `${x.event}: ${x.argv.slice(-1)[0]}`);
    assert.deepEqual(said, ['sound-change: mix: tones + short sentences, system voice', 'note-all: mix: note added']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).sound.voice, { name: true, engine: 'elevenlabs', style: 'full' });
    // Back to ElevenLabs with full sentences, then to the user's settings.
    s.run(['sound', 'use', 'elevenlabs', 'full']);
    s.run(['note', '--as-user', 'y']);
    await s.settle();
    assert.equal(api.reqs[api.reqs.length - 1].body.text, 'mix: your note for both agents was added');
    r = s.run(['sound', 'use', 'default']);
    assert.equal(r.code, 0);
    const o = s.state().options;
    assert.equal(o.sound, undefined);
    assert.equal(o.sound_engine, undefined);
    assert.equal(o.sound_style, undefined);
    assert.equal(s.state().sound_changes.length, 3);
    // tones / off for this task; a voice word turns the voice back on even over voice.on: false.
    fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ sound: { voice: { name: true, on: false } } }));
    s.run(['sound', 'use', 'off']);
    const n0 = s.started().length;
    s.run(['note', '--as-user', 'z']);
    await pause(600);
    await s.settle();
    assert.equal(s.started().length, n0, 'off: silent, no confirmation either');
    s.run(['sound', 'use', 'short']);
    await s.settle();
    assert.equal(s.started().filter((x) => x.name === 'say').pop().argv.slice(-1)[0], 'mix: tones + short sentences, system voice');
    assert.equal(s.state().options.sound, 'voice');
  } finally { api.close(); }
});

test('sound use: never touches the protocol, carries on through the run, refuses bad input', async () => {
  const s = soundBox();
  s.run(['init', 'proto'], { input: 'b' });
  s.run(['progress', 'working on it']);
  const strip = (st) => { const c = { ...st, options: undefined, sound_changes: undefined, audio_claims: undefined }; return JSON.stringify(c); };
  let before = strip(s.state());
  assert.equal(s.run(['sound', 'use', 'tones'], { env: { CLAUDECODE: '1' } }).code, 0, 'from an agent shell too');
  assert.equal(strip(s.state()), before, 'implementer turn: only the sound fields change');
  assert.equal(s.state().sound_changes[0].by, 'agent');
  s.run(['submit', 'implementer', 'decide', '--self'], { input: '## Q?\n1. a\n2. b\n' });
  before = strip(s.state());
  assert.equal(s.run(['sound', 'use', 'voice', 'full']).code, 0);
  assert.equal(strip(s.state()), before, 'pending decision kept');
  assert.equal(s.state().status, 'DECISION');
  s.run(['answer', '1']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  before = strip(s.state());
  assert.equal(s.run(['sound', 'use', 'elevenlabs']).code, 0, "on the reviewer's turn");
  assert.equal(strip(s.state()), before);
  // Contradictions and unknown words change nothing.
  const opts = JSON.stringify(s.state().options);
  for (const bad of [['tones', 'full'], ['system', 'elevenlabs'], ['short', 'full'], ['loud'], ['default', 'tones'], []]) {
    const r = s.run(['sound', 'use', ...bad]);
    assert.equal(r.code, 1, bad.join(' '));
    assert.equal(JSON.stringify(s.state().options), opts);
  }
  assert.match(s.run(['sound', 'use', 'elevenlabs']).out, /no ElevenLabs API key/);
  // The rest of the run keeps it.
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  assert.equal(s.run(['sound', 'use', 'system']).code, 0, 'a DONE task whose run goes on');
  s.run(['init', 'next'], { input: 'b' });
  assert.deepEqual([s.state().options.sound, s.state().options.sound_engine, s.state().options.sound_style], ['voice', 'system', 'full']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['end'], { input: '## Final report\nok\n' });
  assert.equal(s.run(['sound', 'use', 'tones']).code, 1, 'refused after the run ended');
  s.run(['init', 'fresh'], { input: 'b' });
  assert.equal(s.state().options.sound_engine, undefined, 'a new run starts from the config');
  s.run(['abort']);
  assert.equal(s.run(['sound', 'use', 'tones']).code, 1, 'refused on an aborted task');
  // A legacy combined value (older state) is split into fields when changed in part.
  s.run(['init', 'legacy', '--force'], { input: 'b' });
  const sf = path.join(s.taskDir(), 'state.json');
  const old = JSON.parse(fs.readFileSync(sf, 'utf8'));
  old.options = { sound: 'full' };
  fs.writeFileSync(sf, JSON.stringify(old));
  assert.match(s.run(['status']).out, /sound: +tones \+ full sentences, system voice/);
  s.run(['sound', 'use', 'elevenlabs']);
  assert.deepEqual([s.state().options.sound, s.state().options.sound_engine, s.state().options.sound_style], ['voice', 'elevenlabs', 'full']);
  // Mute wins over a task switch, and the command says so.
  s.run(['sound', 'off']);
  assert.match(s.run(['sound', 'use', 'voice']).out, /but sound is muted/);
  assert.match(s.run(['sound', 'use', 'voice']).out, /muted \('collab sound off'\), so nothing plays until you run 'collab sound on'/);
  s.run(['sound', 'on']);
  const env0 = s.run(['sound', 'use', 'voice'], { env: { COLLAB_SOUND: '0' } }).out;
  assert.match(env0, /COLLAB_SOUND=0 is set in this shell.*unset it/);
  assert.ok(!/collab sound on/.test(env0), "'collab sound on' can't override the environment");
  await s.settle();
});

test('sound use: an explicit --sound beats the run, and later split parts get the latest switch', async () => {
  const s = soundBox({ env: { COLLAB_SOUND: '0' } });
  const fields = () => { const o = s.state().options; return [o.sound, o.sound_engine, o.sound_style]; };
  s.run(['init', 'one'], { input: 'b' });
  s.run(['sound', 'use', 'system', 'short']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'two', '--sound=elevenlabs'], { input: 'b' });
  assert.deepEqual(fields(), ['voice', 'elevenlabs', 'short'], 'the flag beats the inherited engine; the style carries on');
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'three', '--sound', 'full'], { input: 'b' });
  assert.deepEqual(fields(), ['voice', 'elevenlabs', 'full'], 'the flag beats the inherited style');
  s.run(['abort']);
  // Split first, switch after: the next part follows the switch, not the split's snapshot.
  s.run(['init', 'big'], { input: 'b' });
  s.run(['sound', 'use', 'system', 'full']);
  s.run(['queue', 'split'], { input: 'one\n=== part ===\ntwo\n=== part ===\nthree\n' });
  s.run(['sound', 'use', 'elevenlabs', 'short']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'big-2', '--from-queue'], { input: 'b' });
  assert.deepEqual(fields(), ['voice', 'elevenlabs', 'short']);
  // An explicit flag on the part's init still wins.
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'big-3', '--from-queue', '--sound=tones'], { input: 'b' });
  assert.deepEqual(fields(), ['tones', 'elevenlabs', 'short']);
  s.run(['abort']);
  // A reset after the split also reaches the next part: cleared fields stay cleared.
  s.run(['init', 'reset'], { input: 'b' });
  s.run(['sound', 'use', 'system', 'full']);
  s.run(['queue', 'split'], { input: 'one\n=== part ===\ntwo\n' });
  s.run(['sound', 'use', 'default']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'reset-2', '--from-queue'], { input: 'b' });
  assert.deepEqual(fields(), [undefined, undefined, undefined], 'follows the config again');
  s.run(['abort']);
  // A queued task's own --sound beats the run it starts in.
  s.run(['init', 'host'], { input: 'b' });
  s.run(['sound', 'use', 'system']);
  s.run(['queue', 'add', '--sound=elevenlabs', 'later']);
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'approve'], { input: 'ok' });
  s.run(['init', 'later', '--from-queue'], { input: 'b' });
  assert.deepEqual(fields(), ['voice', 'elevenlabs', undefined]);
});

test('sound: the task name is left out by default; voice name on brings it back', async () => {
  const s = soundBox({ named: false });
  s.run(['init', 'dark mode'], { input: 'b' });
  s.run(['submit', 'implementer', 'ready'], { input: 's' });
  s.run(['submit', 'reviewer', 'changes'], { input: '1. x\n' });
  await s.settle();
  const said = () => s.started().filter((r) => r.name === 'say').map((r) => r.argv[r.argv.length - 1]);
  assert.deepEqual(said(), ['New task', 'Ready, round 1', 'Changes, round 2']);
  assert.match(s.run(['sound']).out, /task name left out/);
  assert.match(s.run(['sound', 'test', 'decide', '--full', '--dry-run']).out, /speech "Your decision is needed\. Which theme/);
  assert.match(s.run(['sound', 'events']).out, /short: "Plan ready"/);
  assert.equal(s.run(['sound', 'voice', 'name', 'on']).code, 0);
  s.run(['note', '--as-user', 'n']);
  await s.settle();
  assert.equal(said().pop(), 'dark mode: note added');
  assert.equal(s.run(['sound', 'voice', 'name', 'maybe']).code, 1);
  // A custom sentence keeps {task} either way.
  s.run(['sound', 'voice', 'name', 'off']);
  const cfgFile = path.join(s.home, 'config.json');
  const conf = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  conf.sound.events = { approve: { say: '{task} is done' } };
  fs.writeFileSync(cfgFile, JSON.stringify(conf));
  assert.match(s.run(['sound', 'test', 'approve', '--dry-run']).out, /speech "dark mode is done"/);
});

test('sound: jobs of a task keep their order in the same millisecond, whatever the PIDs', async () => {
  const s = soundBox();
  s.run(['init', 'order'], { input: 'b' });
  await s.settle();
  // Hold the queue: a live lock owner (this test process) makes every drainer leave the jobs alone.
  const lock = path.join(s.home, 'audio', '.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} test`);
  const frozen = path.join(s.root, 'clock.js');
  fs.writeFileSync(frozen, `Date.now = () => ${Date.now()};\n`);
  const runFrozen = (args) => spawnSync(process.execPath, ['-r', frozen, CLI, ...args], {
    cwd: s.project, encoding: 'utf8', env: { ...process.env, COLLAB_HOME: s.home, COLLAB_NOTIFY: '0', COLLAB_TASK: '', ...NO_AGENT, ...NO_ELEVENLABS,
      COLLAB_SOUND: '', COLLAB_SOUND_BIN: s.bin, COLLAB_SOUND_SYSTEM_DIR: s.sys, COLLAB_SOUND_PLATFORM: 'darwin', STUB_LOG: s.log },
  });
  // A note (advances seq), then a 'sound use' (keeps seq), then another note: one millisecond.
  runFrozen(['note', '--as-user', 'one']);
  runFrozen(['sound', 'use', 'full']);
  runFrozen(['note', '--as-user', 'two']);
  const q = path.join(s.home, 'audio', 'queue');
  let jobs = fs.readdirSync(q).filter((f) => f.endsWith('.json')).sort();
  assert.equal(jobs.length, 3);
  assert.equal(new Set(jobs.map((f) => f.split('-')[0])).size, 1, 'all in one millisecond');
  const counters = jobs.map((f) => parseInt(f.split('-')[1], 10));
  assert.ok(counters.every((n, k) => k === 0 || n > counters[k - 1]), `strictly increasing counters: ${counters}`);
  // Reverse the PID tokens (the earliest job gets the highest PID): the order must not change.
  const pids = jobs.map((f) => f.split('-')[2]).reverse();
  jobs.forEach((f, k) => { const p = f.split('-'); p[2] = pids[k]; fs.renameSync(path.join(q, f), path.join(q, p.join('-'))); });
  jobs = fs.readdirSync(q).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(jobs.map((f) => JSON.parse(fs.readFileSync(path.join(q, f), 'utf8')).steps[0].event), ['note-all', 'sound-change', 'note-all']);
  // And it plays in that order.
  fs.rmSync(lock, { recursive: true, force: true });
  const n0 = s.started().length;
  await s.runAsync(['sound', 'drain']);
  await s.settle();
  assert.deepEqual(s.started().slice(n0).map((r) => r.event), ['note-all', 'note-all', 'sound-change', 'sound-change', 'note-all', 'note-all']);
});
