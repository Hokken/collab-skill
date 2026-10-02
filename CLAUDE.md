# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Collab is an agent skill plus a CLI that lets two coding agents (e.g. Claude Code and Codex CLI) run an
autonomous implementer ⇄ reviewer loop. The whole product is two files:

- `bin/collab.js`: the `collab` CLI (~1400 lines, single file). It owns the shared state and enforces the protocol.
- `SKILL.md`: the prose instructions every agent follows, for both roles. Agents only talk to each other through the CLI.

`docs/how-it-works.md` is the protocol reference (loop, states, exit codes, notes, queue, on-disk layout). Read it before changing behaviour.

## Commands

```bash
npm test                                         # node --test, ~30 s, no deps to install
node --test --test-name-pattern "queue"          # run matching tests only
node bin/collab.js help                          # run the CLI from the repo
```

CI (`.github/workflows/test.yml`) runs `npm test` on ubuntu/macos/windows × Node 18/22.

## Hard constraints

- **Zero dependencies**, Node >= 18 built-ins only. Keep it that way.
- **Cross-platform**: macOS, Linux and native Windows (PowerShell/cmd/Git Bash). Watch path handling,
  `fs.renameSync` races on Windows (writes go through `retry()`), CRLF/BOM in input (`readBody`), and
  notifications (`notify()` branches per platform). `bin/collab.cmd` is the Windows shim.
- **Exit codes are protocol**: `SKILL.md` tells agents to branch on them (0, 1, 10–16, defined as
  `EXIT_*` constants at the top of `collab.js` and documented in its header comment and in
  `docs/how-it-works.md`). Changing or adding one means updating all three, plus `SKILL.md`.
- **Backwards-compatible state**: old `state.json` files (including ones written by an earlier bash
  version without `phase`/`seen`/`plan_round`) must still load; there is a test for it.

## Architecture of `bin/collab.js`

- **Dispatch**: `main()` handles a leading `-t <task-id>` (sets `TASK_OVERRIDE`), then looks up
  `COMMANDS` → `cmdXxx(args)` functions. Errors are signalled by throwing: `die(msg)` throws
  `CollabError` (exit 1 with `collab: msg` on stderr), `exit(code)` throws `ExitCode`. Don't call
  `process.exit` directly.
- **Task resolution**: `taskDir()` picks the task from `-t`, then `$COLLAB_TASK`, then the newest
  active (else newest) task for the current project (`latestTask(cwd)`), then `$COLLAB_HOME/current`.
  Folders are the same project when one contains the other (`sameProject`; used by `projectTasks`
  and the queue), so a repo root and a module inside it share tasks. `init` allows one
  active task per project. So pairs in different projects don't interfere, and agents also pin
  their task id with `-t`.
- **State**: `$COLLAB_HOME/tasks/<slug>-<stamp>/state.json`. All mutations go through
  `withLock(d, () => update(d, fn))`: the lock is an exclusive `.lock` directory with an `owner` file
  (broken only when held past `COLLAB_LOCK_SECS` and its owner pid is gone),
  and writes are temp-file + rename. `update(..., { touch: false })` is for changes that must not count
  as agent activity (e.g. snooze).
- **Turns**: `transition(st, role, kind)` is the state machine (PLANNING/PLAN_REVIEW/PLAN_CHANGES →
  IMPLEMENTING → READY_FOR_REVIEW ⇄ CHANGES_REQUESTED → DONE, plus ESCALATED/ABORTED/STALLED terminals).
  `cmdSubmit` validates the turn, enforces unseen notes (exit 12) and `--check` (exit 14, via `runCheck`),
  writes an entry to `entries/NNN-<role>-<kind>.md`, and appends to `log.md`.
- **Decisions**: `submit <role> decide` (numbered options, `decisionOptions`) parks the task in the
  non-terminal `DECISION` status with `turn: 'human'` and saves the previous status/turn in
  `st.decision`. `cmdAnswer` restores them. The other agent's `wait` returns exit 16 once (unless
  `--self`), and idle/stall checks are skipped meanwhile. Hitting the round limit makes a
  `kind: 'limit'` decision (`LIMIT_OPTIONS`, shown to both agents) instead of escalating.
- **Runs**: after DONE the reviewer waits in `join --after <id>`, which follows the project's newest
  task. `cmdEnd` sets `st.ended` on the last DONE task (`join --after` then exits 10) and collects
  the run's user answers and `## Decisions taken` sections (`collectDecisions`).
- **Waiting**: `cmdWait`/`cmdJoin` poll `state.json` every `COLLAB_POLL_SECS`. Idle detection
  (`idleReason`, exit 13) combines time since last handoff, `collab progress` pings, and (on the
  implementer's turn) project file mtimes via `lastFileChange`, which skips `SKIP_DIRS`.
- **Notes**: `pendingNotes`/`markSeen` track, per role, the last entry shown; notes surface in `wait`,
  `progress`, or by refusing `submit`.
- **Diffs**: `cmdInit` snapshots every git repo under the project (its own repo + nested ones up to
  3 levels, even if the outer repo ignores them, `findRepos`) with `git stash create` plus the untracked-file list, without touching the working tree.
  `cmdDiff` diffs against that snapshot and flags files outside `--scope` globs (`globRegex`).
- **Queue**: `$COLLAB_HOME/queue.json`, edited via `withQueue`; items are filtered by project folder
  (`realDir`). `init --from-queue` pops an item and applies its options (`TASK_OPTS`/`normTaskOpts`).
  `queue split` lets the implementer split its current task: parts 2..N are queued with a `part`
  marker (`index`/`total`/`parent`) that `init --from-queue` copies into `state.part`. A task with a
  `part` can't be split again. When a part ends without approval, `holdParts` marks its later parts
  `confirm` + `held`, so they wait for the user.
- **Dashboard**: `cmdWatch` is a raw-mode TTY UI; rendering is the pure function `renderWatch(view, cols, rows, opts)`,
  which tests exercise through `watch --once`.

## Tests

`test/collab.test.js` drives the real CLI end to end via `spawnSync`. Use the `sandbox()` helper: it
creates a temp `COLLAB_HOME` and project dir with `COLLAB_POLL_SECS=1`, `COLLAB_NOTIFY=0` and
`COLLAB_TASK=''`, and returns `run(args, { input, cwd, env })`, `state()` and `taskDir()`. `gitRepo(dir)`
makes a committed repo for diff tests. Add a test for any behaviour change; keep timing-based tests
tolerant of slow CI runners.

## Install / distribution

`install.sh` / `install.ps1` only create links (symlinks on Unix, directory junctions on Windows) from
`~/.agents/skills/Collab` and `~/.claude/skills/Collab` to the repo, and put `collab` in `~/.local/bin`,
so edits in this repo are live for installed agents. They must also handle the `npx skills add` layout,
where the repo itself already lives in `~/.agents/skills/`. `package.json` `files` controls what ships.
