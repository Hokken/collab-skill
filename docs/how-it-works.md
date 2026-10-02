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
- **Round limits:** a `changes` beyond `max_rounds` (or the plan rounds) becomes a `DECISION`
  for the user, shown to both agents: `1` gives 2 more rounds and passes the review on, `2`
  approves (`DONE`), `3` stops (`ESCALATED`). An answer in the user's own words counts as `1`, and
  the implementer gets the words.
- **Decisions:** the agent holding the turn can `submit <role> decide` a question with numbered
  options. The task goes to `DECISION` (turn: `human`) until someone runs `collab answer <N | text>`.
  Then it returns to the status and turn it came from, and the asker gets the answer. The other
  agent's `wait` returns 16 once, so a Claude Code agent can show the options as an interactive
  choice. With `--self`, the asker shows them itself and the other agent keeps waiting. No idle or
  stall checks run while the user decides.

## Runs: from one request to the end

A request can take several tasks: the parts of a split, queued tasks, or stages the implementer
starts one after another. That sequence is a *run*. Between tasks, the reviewer waits in
`collab join --after <finished-task>`, which looks at the newest task of that project:

- a new active task: `join` prints its brief (exit 0);
- `collab end` was run on it: `join` prints the final report and returns 10 (`WORK COMPLETE`);
- it ended `ESCALATED`, `ABORTED` or `STALLED`: `join` returns 10 (`TASK FINISHED`);
- it's `DONE` and nothing new has started for `COLLAB_IDLE_SECS`: `join` returns 13.

`collab end` (implementer) needs the project's newest task to be `DONE` and its queue to be empty.
It writes an `end` entry with the implementer's report, followed by every user answer and every
`## Decisions taken` section from the run. The run is the tasks since the previous `end` in that
project.

## Queue and task options

- `collab queue add [options] "task"` appends to `~/.collab/queue.json`. Each item remembers the
  project folder it was added from, and an implementer only takes items for its own project.
- **Projects:** two folders are the same project when one contains the other (a repo root and a
  module inside it). Tasks, the queue, `join` and the one-active-task-per-project rule all use
  this, so agents started from different levels of the same tree still find each other. Unrelated
  folders, siblings included, stay separate. When several tasks match, the newest active one is
  the default.
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
  - `--confirm` makes the implementer ask you before starting that queued task.

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
| `11` | `wait` timed out and it's still not your turn; run it again |
| `12` | submit refused: the user added a note during your turn |
| `13` | the other agent looks unresponsive; ask the user whether to stop or keep waiting |
| `14` | submit refused: the task's `--check` command failed |
| `15` | the queue has no task for this project |
| `16` | the other agent asked the user to decide; show them the options, record the answer with `collab answer` |

## Human notes

`collab note` adds an entry for `all`, `implementer` or `reviewer`. Each role tracks the last entry
it has been shown. A note reaches its target in one of three ways:

1. in the `wait` output at the start of its next turn;
2. in the output of its next `collab progress`;
3. by refusing its next `submit` (exit 12) until it has seen the note.

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
during the task, even when you started with uncommitted work.

## On disk

```text
~/.collab/
  current                          id of the most recent task
  queue.json                       queued tasks, each with its project folder and options
  tasks/<slug>-<YYYYMMDD-HHMMSS>/
    state.json                     status, turn, rounds, repos, progress, …
    log.md                         the whole conversation, human-readable
    entries/NNN-<role>-<kind>.md   one file per message (brief, plan, ready, changes, note-…)
    progress.log                   JSON lines of progress updates
    untracked/<n>.txt              untracked files per repo at the start
```

State changes are made under a lock (an exclusive `.lock` directory) and written atomically
(temp file, then rename, retried on Windows while another process is reading).

## Adapting it

- **Another agent:** point it at `SKILL.md`. The only agent-specific part is *How to wait*
  (backgrounded vs. foreground shell commands).
- **Different rules:** the review checklist, the summary format and the escalation rules are all
  plain prose in `SKILL.md`. Edit them freely.
- **Tests:** `npm test` covers the protocol end to end; add a test for any change in behaviour.
