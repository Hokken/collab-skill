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
- **Round limits:** a `changes` beyond `max_rounds` becomes `ESCALATED` instead.

## Queue and task options

- `collab queue add [options] "task"` appends to `~/.collab/queue.json`. Each item remembers the
  project folder it was added from, and an implementer only takes items for its own folder.
- `collab queue next` shows the first item for the current folder. `collab init <slug> --from-queue`
  removes it and applies its options (flags given to `init` override them).
- When a task ends `DONE` and more items are waiting, `wait` and the reviewer's `approve` print a
  `QUEUE:` line. The implementer starts the next item, and the reviewer runs `collab join` again.
  Any other ending (`ESCALATED`, `STALLED`, `ABORTED`) pauses the queue.
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
| `DONE` | — | the reviewer approved |
| `ESCALATED` | — | an agent asked for a human, or the round limit was hit |
| `ABORTED` | — | stopped with `collab abort` |
| `STALLED` | — | nobody handed off for too long |

## Exit codes

Agents branch on these, so they are part of the protocol:

| Code | Meaning |
|---|---|
| `0` | OK / it's your turn |
| `1` | error (message on stderr) |
| `10` | the task is finished; stop looping |
| `11` | `wait` timed out and it's still not your turn; run it again |
| `12` | submit refused: the user added a note during your turn |
| `13` | the other agent looks unresponsive; ask the user whether to stop or keep waiting |
| `14` | submit refused: the task's `--check` command failed |
| `15` | the queue has no task for this project |

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

`collab init` snapshots every git repo under the project folder. It checks the folder itself,
then nested repos up to three levels down. The snapshot comes from `git stash create`, which
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
