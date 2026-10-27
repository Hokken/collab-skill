# How Collab works

Collab is two things:

- **`SKILL.md`**: instructions every agent follows, the same file for every agent and role.
- **`bin/collab.js`**: a small CLI that stores the shared state and enforces the rules (turns,
  notes, round limits). The agents only ever talk to each other through it.

Neither agent needs to know which product the other one is. Anything that can load a skill (or
follow `SKILL.md` as instructions) and run shell commands can take either role.

## The loop

```text
 implementer                         collab state                         reviewer
 ───────────                         ────────────                         ────────
 collab init  ── brief ──────────▶   IMPLEMENTING  ◀──────────────────── collab join / wait
 …work… collab progress "…"
 collab submit implementer ready ─▶  READY_FOR_REVIEW ─────────────────▶ (wait returns)
 collab wait implementer                                                   …review… collab diff
                              ◀───── CHANGES_REQUESTED ◀── collab submit reviewer changes
 …fix… submit ready ─────────────▶  READY_FOR_REVIEW ─────────────────▶ …
                                     DONE ◀─────────────── collab submit reviewer approve
```

- **Waiting** is `collab wait <role>`: it polls the state file every few seconds and returns
  when it's your turn or the task ends. It uses no model tokens.
- **Plan mode** (`init --plan`) adds a first phase: `PLANNING → PLAN_REVIEW → (PLAN_CHANGES …)`.
  Approving the plan moves to `IMPLEMENTING` and doesn't end the task.
- **Verdicts must match their items:** `submit reviewer approve` is refused (exit 1, nothing
  written) when it contains a numbered `[blocking]` item (`1. [blocking] …`), and
  `submit reviewer changes` is refused when it has no numbered item for the implementer to
  address. This applies in both phases.
- **Closeout:** a build-phase `submit implementer ready` is refused (exit 1, nothing written)
  without a `## Closeout` section that has the labels `Verified:`, `Attempted, blocked:`,
  `Deferred:` and `Not claimed:` (content may be `none`; list markers and bold are fine).
- **Review recap:** when it's the reviewer's turn, `wait` also prints the `[blocking]` items
  (with their continuation lines) of the earlier `changes` entries of the current phase, by round,
  and in a `--plan` task's build phase, which entry is the approved plan. Both come from `entries/`:
  the plan approval is the only reviewer `approve` of an unfinished task, so it separates the phases.
  It also lists the reviewer's own notes (`--from reviewer`) since its last review, one line each,
  with the implementer's latest `Note #N` line about each, so the reviewer verifies the fixes.
- **Revised plans:** from the second `plan` on, the reviewer's `wait` prints a line diff against
  the previous plan (hunks with 2 lines of context, labelled with the heading above them) instead
  of the whole plan, unless the diff is over 60% of the plan's size (then the plan is printed
  whole). `collab show N` prints the full entry.
- **No identical resubmissions:** an implementer `plan` or `ready` whose text matches its previous
  entry of the same kind (ignoring trailing whitespace and the appended `check passed` line) is
  refused with exit 1 before the check runs, and nothing is written.
- **Round limits:** a `changes` beyond `max_rounds` (or the plan rounds) becomes a `DECISION`
  for the user, presented by the implementer (its `wait` returns 16; the reviewer keeps waiting):
  `1` gives 2 more rounds and passes the review on, `2` approves (`DONE`), `3` stops
  (`ESCALATED`). An answer in the user's own words counts as `1`, and the implementer gets the words.
- **Decisions:** the agent holding the turn can `submit <role> decide` a question with numbered
  options. The task goes to `DECISION` (turn: `human`) until someone runs `collab answer <N | text>`.
  Then it returns to the status and turn it came from, and the asker gets the answer. The other
  agent's `wait` returns 16 once, so a Claude Code agent can show the options as an interactive
  choice. With `--self`, the asker shows them itself and the other agent keeps waiting. Exactly one
  agent presents each decision (`decisionPresenter`), so the user answers in one place; the other
  agent's `wait` timeouts tell it not to ask. No idle or stall checks run while the user decides.

## Runs: from one request to the end

A request can take several tasks: the parts of a split, queued tasks, or stages the implementer
starts one after another. That sequence is a *run*. Between tasks, the reviewer waits in
`collab join --after <finished-task>`, which looks at the newest task of that project:

- a new active task: `join` prints its brief (exit 0);
- `collab end` was run on it: `join` prints the final report and returns 10 (`WORK COMPLETE`);
- it ended `ESCALATED`, `ABORTED` or `STALLED`: `join` returns 10 (`TASK FINISHED`);
- it's `DONE` and nothing new has started for `COLLAB_IDLE_SECS`: `join` returns 13.

`collab end` (implementer) needs the project's newest task to be `DONE` and no queued task for the
project that would start on its own. Tasks waiting for the user's go-ahead (`--confirm` or held)
stay queued and are listed in the report.
It writes an `end` entry with the implementer's report, followed by each task's closeout (the
`## Closeout` of its last `ready`, or "no structured closeout recorded" for older tasks), the
reviewer's `## For the user` briefings (from a build approve, never the plan approval), and every
user answer and every `## Decisions taken` section from the run. The run is the tasks since the
previous `end` in that project.

## Queue and task options

- `collab queue add [options] "task"` appends to `~/.collab/queue.json`. Each item remembers the
  project folder it was added from, and an implementer only takes items for its own project.
- **Projects:** two folders are the same project when one contains the other (a repo root and a
  module inside it). Tasks, the queue, `join` and the one-active-task-per-project rule all use
  this, so agents started from different levels of the same tree still find each other. Unrelated
  folders, siblings included, stay separate. When several tasks match, the newest active one is
  the default.
- **Pairs stay apart:** `init` prints `reviewer: /collab review <task-id>`, and a reviewer started
  with a task id joins with `collab -t <task-id> join`. A bare `join` only looks at the folder's
  project (no fallback to `$COLLAB_HOME/current`, the last task started anywhere), and refuses
  (exit 1, listing them) when the folder contains several projects with an active task. Each task
  has one reviewer: `join` writes `tasks/<id>/reviewer.seen`, whose mtime the reviewer's `wait`,
  `progress` and `submit` refresh. While it is live (within `COLLAB_IDLE_SECS`, or the reviewer
  holds the turn and isn't idle), another `join` is refused (exit 1); `join --force` takes over.
- `collab queue next` shows the first item for the current folder. `collab init <slug> --from-queue`
  removes it and applies its options (flags given to `init` override them).
- When a task ends `DONE` and more items are waiting, `wait` and the reviewer's `approve` print a
  `QUEUE:` line. The implementer starts the next item, and the reviewer, as after every `DONE`,
  runs `collab join --after <task>` (see *Runs*).
  Any other ending (`ESCALATED`, `STALLED`, `ABORTED`) pauses the queue.
- `collab queue split` (implementer, once, before its first `plan` or `ready`) splits the current
  task. The parts come on stdin, separated by `=== part ===` lines. Part 1 stays the current task
  and gets a `split` timeline entry. Parts 2..N are inserted ahead of this project's other queued
  items, with the task's options and a `part` marker (`index`, `total`, `parent`). A task started
  from a part gets a *Part of a split task* section in its brief and can't be split again. If a
  part ends `ESCALATED`, `ABORTED` or `STALLED`, its later parts are held: `queue next` shows
  `HELD:` and `CONFIRM FIRST`, and they need the user's go-ahead.
- Options are stored in `state.json` and summarised in a *Task options* section of the brief:
  - `--check` is enforced: `submit implementer ready` runs it in the project folder and refuses with
    exit 14 on failure. On success, a `check passed` line is appended to the summary.
  - `--scope` is flagged: `collab diff` lists changed files outside the globs.
  - `--focus`, `--branch` and `--commit` are instructions the agents follow (and the reviewer checks).
    Before a `--commit` commit, the implementer runs `collab verify` and commits only on exit 0.
  - `--confirm` makes the implementer ask you before starting that queued task.
- **Approval is bound to the reviewed tree** (build phase, tasks with git repos). `submit
  implementer ready` records a digest of the project files, after `--check` ran. For each repo
  it lists every path changed since the task's base snapshot (tracked, untracked but not ignored,
  new ignored `*.md`), plus every assume-unchanged / skip-worktree path. Each path gets a signature
  of what is on disk (content sha256 and exec bit, a symlink's target, or a nested repo's
  checked-out commit; a nested repo's own files are covered by its own entry). `submit reviewer
  approve` recomputes it. If it differs, the approve is refused with exit 17, lists the changed
  paths, and records the new digest as pending. `approve --rereviewed` then succeeds only if the
  files still match that pending digest. `collab diff` never changes a digest. A successful
  approve (or the user's *approve as it is* at the round limit) records the approved digest,
  which `collab verify` compares against (exit 0 or 17; exit 1 when none was recorded).
  Computing it is read-only: `git diff` runs on a temporary copy of the index, and nothing is
  written to the repo. If it can't be computed (a git error, an unreadable file, a changed folder
  that isn't one of the task's snapshotted repos), the command fails (exit 1) instead of passing.
  Ignored files other than new `*.md` are not covered. Tasks without git repos, or started before
  this existed, approve as before with a notice.

## Project lessons

Lessons carry knowledge from one task of a project to the next. They live in the project, in
`.collab/lessons.md`, meant to be committed so they travel with the repo and reach everyone who
works on it.

- **Where:** the nearest `.collab/lessons.md` from the task's folder up to its git repo's top
  level, so a module inside a repo shares the repo's file. With none yet, it is created at the top
  level. Outside git: the nearest one below the home folder, else one in the folder itself. On a
  case-insensitive filesystem an existing variant such as `.Collab/LESSONS.md` *is* that file
  (same file on disk) and is edited under its own name; on a case-sensitive one it is just
  another project file.
- **Format:** Markdown, one top-level `- ` bullet per lesson (indented lines continue it). Collab
  appends `- text <!-- collab: by <role>, task <id>, <date> -->`; the comment is hidden when
  rendered. People can edit the file freely: their bullets count as lessons, and anything else
  (headings, paragraphs) is left alone. Bullets inside fenced code blocks (``` or ~~~) or
  multi-line HTML comments are not lessons, and empty or comment-only bullets are skipped. CRLF
  files stay CRLF. Lessons are numbered consecutively in file order, as `collab lessons` lists
  them; `add`, `rm`, briefs and the final report use the same numbers. Removing a lesson whose
  line opens an HTML comment keeps that opener, so the comment's body stays hidden.
- **Errors:** a missing file reads as empty; any other read failure (a folder in its place, no
  permission) is an error, and the file is never replaced. `collab lessons` then exits 1; a
  handoff, `init` or `end` reports it and goes on. If the file ends inside an unclosed code
  fence or HTML comment, nothing is appended (it would be invisible): `lessons add` exits 1 and a
  handoff reports `lessons not recorded`.
- **Not a project change:** collab writes the file during handoffs, so `collab diff`, `--scope`
  and the approved-tree digest leave out every `.collab/lessons.md`. Recording a lesson never
  voids a review, and an edit to the file during a task is not reviewed. In a repo whose
  `core.ignorecase` is true (git sets it when the working tree's filesystem ignores case) any
  case variant is left out; otherwise only the exact name. That setting has to match the
  filesystem, as git itself assumes.
- **Recording:** the user runs `collab lessons add "…"`, or an agent adds a `## Lessons` section
  (bullets or numbered items; continuation lines are joined) to any `submit` message except
  `decide`. They are recorded only once the submit succeeds (a refused one records nothing), at
  most 5 per message. A lesson whose text (case, whitespace and trailing punctuation aside)
  already exists for the project is not added again.
- **Bounds:** a lesson is at most 300 characters. `lessons add` refuses a longer one (exit 1); a
  longer bullet in a message is skipped with a notice, never shortened, and the submit still
  succeeds. A longer hand-written one stays in the file but is left out of briefs (`init` and
  `collab lessons` say which to shorten). `init` puts the newest 30 of the rest into the brief
  under *Project lessons*, plus lines counting older and over-long ones.
- **Precedence:** the brief section says that the user's current instructions and the project's
  own rules come first; a lesson that contradicts them or is obsolete is reported with evidence,
  not followed. Otherwise the reviewer treats breaking one as blocking.
- **Pruning:** `collab lessons` lists them, `collab lessons rm N…` removes them (all the given
  numbers, or none if one doesn't exist), or edit the file. `collab end` lists the lessons
  recorded during the run, so the user can check them before committing: from every lessons file
  the run's tasks used (a repo root and a module can each have one), per file, with the
  `lessons rm … --dir` command for it.

## Phone notifications

Off unless a task has `--phone` (`init`, `queue add`, or the `/collab implement` request). The
next task started after an approved one (`DONE`, run not ended) keeps it, so one flag covers a
split, a queue or a staged plan. After `collab end`, an escalation, an abort or a stall, a new
task needs the flag again. Queued items carry it like any other option.

- **Destination:** `COLLAB_PHONE_URL`, else `phone_url` in `~/.collab/config.json`. The first
  `--phone` task without one creates a random `https://ntfy.sh/collab-<16 hex>` topic, and `init`
  prints a `phone:` line (with `NEW` the first time) telling the user what to subscribe to.
  `collab phone` shows it, `collab phone set <topic | url>` changes it (a bare topic means ntfy.sh),
  `collab phone test` sends a test push and reports a failure (exit 1).
- **What pushes:** a decision for the user (including the round limit), an escalation through
  `submit`, an unresponsive agent (`wait`/`join --after` exit 13), a stall, a confirm-first
  queued task shown by `queue next` during a `--phone` run (or one queued with `--phone` itself),
  and `collab end`. Ordinary handoffs,
  a `DONE` inside a run and `abort` don't.
- **From the agent CLIs:** `collab phone send ["message"] [--dir PATH]` lets hooks report waits
  collab can't see (an agent's own question or permission prompt). It reads a Claude Code
  `Notification` hook's JSON on stdin (`message`, `cwd`), a Claude Code `PreToolUse` hook's on
  `AskUserQuestion` (`tool_input.questions`: "Claude asks: …"), a Codex `PermissionRequest` hook's (`tool_input`,
  `cwd`) or Codex `notify`'s JSON argument (`type`, `last-assistant-message`, `cwd`), or plain
  text. It pushes `Waiting for you: …` (high) only when the folder's project has a `--phone` task
  that is running (or `DONE` with the run not ended), once per identical message per minute. It
  never fails: it always exits 0, prints nothing on stdout, and says on stderr why it didn't send.
- **How:** a plain-text POST with ntfy's `Title`, `Priority` and `Tags` headers, sent by a
  detached child process with a 10 s timeout, so a slow or unreachable server never delays a
  command or changes its result. `COLLAB_NOTIFY=0` only turns off desktop notifications.
- **Privacy:** anyone who knows an ntfy.sh topic name can read it; the random name is the
  secret. Pushes contain the task id and the decision question or escalation headline.

## States

| Status | Whose turn | Meaning |
|---|---|---|
| `PLANNING`, `PLAN_CHANGES` | implementer | writing or revising the plan (`--plan` only) |
| `PLAN_REVIEW` | reviewer | reviewing the plan |
| `IMPLEMENTING`, `CHANGES_REQUESTED` | implementer | building or fixing |
| `READY_FOR_REVIEW` | reviewer | reviewing the changes |
| `DECISION` | human | an agent asked the user to choose; `collab answer` resumes the task |
| `DONE` | — | the reviewer approved |
| `ESCALATED` | — | an agent hit a blocker, or the user chose *stop* at the round limit |
| `ABORTED` | — | stopped with `collab abort` |
| `STALLED` | — | nobody handed off for too long |

## Exit codes

Agents branch on these, so they are part of the protocol:

| Code | Meaning |
|---|---|
| `0` | OK / it's your turn |
| `1` | error (message on stderr) |
| `10` | the task is finished; stop looping (`join --after`: the run ended, or a task ended without approval) |
| `11` | `wait` timed out and it's still not your turn; run it again (with `--attempt N`, the message names `--attempt N+1`: the option has no other effect, it only keeps agent loop guards such as OpenCode's `doom_loop` from seeing identical calls) |
| `12` | submit refused: a note for you is not acknowledged (`Note #N`) in your message |
| `13` | the other agent looks unresponsive; ask the user whether to stop or keep waiting |
| `14` | submit refused: the task's `--check` command failed |
| `15` | the queue has no task for this project |
| `16` | the user has to decide (the other agent asked, or the round limit for the implementer) and you present it; show them the options, record the answer with `collab answer` |
| `17` | the project files changed since the review (`approve` refused; inspect, then `approve --rereviewed`) or since the approval (`collab verify`; don't commit) |

## Notes

`collab note` adds an entry for `all`, `implementer` or `reviewer`: from the user by default
(`NNN-human-note-<to>.md`, shown as `!!! HUMAN NOTE`), or from an agent with `--from <role>`
(`NNN-peer-note-<to>.md`, shown as `>>> NOTE FROM THE OTHER AGENT`, always addressed to the other
agent). A plain `collab note` from an agent's shell (`CLAUDECODE=1`, OpenCode's `OPENCODE=1`, `COLLAB_AGENT`, or Codex's
`CODEX_THREAD_ID` / `CODEX_SESSION_ID` / sandbox variables) is refused, so an agent can't post as the user; a user typing inside an agent
session adds `--as-user`.

A note is **shown** to its target at its next `wait` or `progress`, and it must be **acknowledged**:
the target's next `submit` is refused (exit 12) until its message names every note addressed to it
since its previous handoff (`Note #N`). Being shown is not enough, because an agent may discard that
output. This is checked before the task's `--check` runs, so a refused handoff costs no check run,
and again under the lock, for a note that arrives while the check runs. Escalations and decisions
are never blocked, and neither counts as acknowledging: the notes stay pending for the role's next
handoff. A task started before acknowledgements gets its baseline
frozen, for both roles, from what each had been shown, at its first state change after the
upgrade: notes shown before count as handled, every later one must be acknowledged.

A note for one role is never shown to, and never blocks, the other one.

## Staying alive

While it holds the turn, an agent posts `collab progress "…"` at each real step. Progress isn't a
handoff: it adds no timeline entry, but it counts as a sign of life. The waiting side reports
"unresponsive" (exit 13) only when there has been no handoff, no progress and (on the
implementer's turn) no project file change for a while. After a longer limit with nobody
answering, the task becomes `STALLED`.

## Reviewing real changes

`collab init` snapshots every git repo under the project folder: the repo holding the folder
itself, plus nested repos up to three levels down, including ones the outer repo ignores
(e.g. separate module repos). The snapshot comes from `git stash create`, which
records the working tree **without touching it**, plus the list of untracked files at that
moment. `collab diff` compares against that snapshot, so the reviewer sees only what changed
during the task, even when you started with uncommitted work. It also lists new `*.md` files
that git ignores (e.g. in a gitignored plans folder), so a document written there is not missed.

To keep the output to what a reviewer actually reads, `collab diff` lists changed lockfiles
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) in its stat and
scope check but leaves their patch out, and shows a new binary file as `(binary, N bytes)`.
`collab diff --all` includes the lockfile patches.

At each build-phase `ready`, collab also records a tree object of every repo as handed off
(`review_trees` in `state.json`, the last two). It is built on a temporary copy of the index,
with its git objects in the task's `objects/` folder, so the working tree, the real index and the
repo's object store stay untouched. From round 2 on, `collab diff --since-review` shows only what
changed since the handoff the reviewer last reviewed, new files included, and the reviewer's
`wait` output points to it. The `⚠ OUTSIDE SCOPE` check still covers the whole task.
Without a snapshot of the reviewed handoff (round 1, an older task, or a handoff whose optional
snapshot failed) it shows the full diff. A repo with no changes is named as such, and one whose
snapshot can't be read points to `collab diff`. The snapshot holds the files on disk even behind
assume-unchanged / skip-worktree flags or outside a sparse checkout (a sparse path that isn't on
disk keeps its index content, so it never shows as deleted), and a split index is unsplit in the copy, so no
`sharedindex.*` file is written to the repo.

## Files the agents write

Handoff-only files (message drafts for `--file`, notes, logs) go in the task's `scratch/` folder,
which `init` and `join` print and `collab scratch` returns. Before a task exists, `collab scratch`
returns the shared `drafts/` folder instead. Neither is ever in the project. `collab clean` deletes
a task's scratch folder with the task, and drafts older than a day. Documents that are part of the
work go where the brief's `## Deliverables` line says.

## On disk

```text
~/.collab/
  current                          id of the most recent task
  queue.json                       queued tasks, each with its project folder and options
  config.json                      settings: phone_url (where --phone tasks push to)
  drafts/                          agents' drafts written before a task exists (e.g. a brief)
  tasks/<slug>-<YYYYMMDD-HHMMSS>/
    state.json                     status, turn, rounds, repos, progress, …
    log.md                         the whole conversation, human-readable
    entries/NNN-<role>-<kind>.md   one file per message (brief, plan, ready, changes, note-…)
    progress.log                   JSON lines of progress updates
    untracked/<n>.txt              untracked files per repo at the start
    untracked/<n>-ignored-md.txt   ignored *.md files per repo at the start
    digests/{review,pending,approved}.json   file signatures behind review_digest, pending_digest
                                   and approved_digest in state.json
                                   (review_trees: git tree ids for 'collab diff --since-review')
    objects/<n>/                   git objects of the --since-review snapshots, per repo
    scratch/                       the agents' message drafts, notes and logs for this task
```

State changes are made under a lock (an exclusive `.lock` directory) and written atomically
(temp file, then rename, retried on Windows while another process is reading).

## Adapting it

- **Another agent:** point it at `SKILL.md`. The only agent-specific part is *How to wait*
  (backgrounded vs. foreground shell commands).
- **Different rules:** the review checklist, the summary format and the escalation rules are all
  plain prose in `SKILL.md`. Edit them freely.
- **Tests:** `npm test` covers the protocol end to end; add a test for any change in behaviour.
