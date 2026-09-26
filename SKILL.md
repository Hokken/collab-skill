---
name: Collab
description: Autonomous implementer/reviewer loop between two coding agents (e.g. Claude Code and Codex CLI) coordinated through the shared `collab` CLI in ~/.collab. Use when the user says "collab implement", "collab review", "collab 1" (implementer) or "collab 0" (reviewer).
---

# collab — autonomous implementer ⇄ reviewer loop

Two agents, running in separate terminals, share one task through the `collab` CLI:
one **implements**, the other **reviews**, and they hand off turns until the reviewer
approves, the round limit is reached, or someone escalates to the human.

## Pick your role

Read the argument from the user's message:

| Argument               | Role            |
|------------------------|-----------------|
| `implement`, `1`       | **implementer** |
| `review`, `0`          | **reviewer**    |

Anything after the role (e.g. `collab implement add dark mode to the tarot app`) is the
task for the implementer. If the role is missing, ask the user once, then continue on your own.

If you are the implementer and no task was given, reply only with "Collab implementer ready,
what should I build?" and end your turn. Treat the user's next message as the task and start
the implementer loop from step 1. This is the only point where the implementer waits for the user.

**Plan mode:** if the user asks for a plan first (`--plan`, "plan", "plan first", e.g.
`/Collab implement --plan`), start with `collab init … --plan`. The reviewer then approves a
plan before any code is written (see *Plan phase* below).

## The CLI

`collab` is on PATH (fallback: `node ~/.agents/skills/Collab/bin/collab.js`). Run `collab help` for details.

- **Pin your task:** once `collab init` (implementer) or `collab join` (reviewer) prints the
  task id, pass `-t <task-id>` as the first argument on **every** later call, e.g.
  `collab -t dark-mode-20260926-120000 wait reviewer`. That way a second collab pair started
  elsewhere can never redirect you to its task.
- **Passing messages** (brief, summary, review), depending on your shell:
  - *bash / zsh / Git Bash:* a quoted heredoc on stdin:
    `collab -t <id> submit implementer ready <<'EOF' … EOF`
  - *PowerShell (e.g. Codex on Windows):* prefer **`--file`**. Write the message to a temp file,
    then run `collab -t <id> submit implementer ready --file "$env:TEMP\collab-msg.md"`.
    Windows PowerShell 5.1 mangles non-ASCII text piped into programs; in PowerShell 7, piping
    a single-quoted here-string (`@' … '@ | collab …`) also works.
  - `init` and `note` accept `--file` too.
- In PowerShell, read a command's exit code from `$LASTEXITCODE`.
- Exit codes: `0` = OK / your turn, `10` = task finished (DONE, ESCALATED, ABORTED, STALLED),
  `11` = wait timed out and it's still not your turn (just run the same command again),
  `12` = submit refused because the user added a note during your turn (see below),
  `13` = the other agent looks unresponsive (see below), `1` = error.
- If a submit fails with "task already finished", the user stopped the task: stop looping and
  give them a short report of where you were.

## The other agent looks unresponsive (exit 13)

`wait` returns 13 when the other agent has not handed off for 30 min. While the implementer is
working, it also needs no project file to have changed for 10 min. This is the one case where
you **ask the user and end your turn**:
- **Claude Code:** use the AskUserQuestion tool: "The <other role> has not handed off for
  N min. Stop the task?", with the options **Keep waiting (30 min)** and **Stop the task**.
- **Codex CLI:** ask the same question in plain text and end your turn.

On *keep waiting*, run `collab -t <id> snooze 30` (or the minutes the user gives), then go back
to waiting. On *stop*, run `collab -t <id> abort` and give the user a short final report.

## Human notes (the user steering a running task)

The user can add a note at any time with `collab note "…"`. Notes show up as
`!!! HUMAN NOTE` entries, either in your `wait` output or as a refused submit (exit 12).
- A human note **takes priority** over the brief and over the other agent's feedback.
- Implementer: act on it, and list it under `## Review responses` as `Note #N — done / how`.
- Reviewer: take it into account, and check that the implementer followed earlier notes.
- On exit 12, nothing was submitted. Handle the note, then submit again with your **full,
  updated** message (not just a diff of it).

## Progress updates while it's your turn

While you hold the turn, post a one-line status at each real step, so the user (in `collab watch`)
and the waiting agent can see that the pause is normal:

```
collab -t <id> progress "reading the review, 3 items to address"
collab -t <id> progress "running npm test"
collab -t <id> progress "fixing item 2: missing null check in parser.ts"
```

- Post one when your turn starts, before anything long (tests, builds, large reads), and when you
  move to the next item. Typically 3–8 per turn. **Never on a timer**, and never in a loop.
- Keep it short and concrete (under ~80 characters): *what* you're doing, not how you feel.
- It isn't a handoff: it doesn't pass the turn or add a timeline entry. It does count as a sign
  of life, so a long but active turn won't be flagged as unresponsive.
- If its output shows a `!!! HUMAN NOTE`, the user added a note during your turn. Handle it
  like any other note (see *Human notes*).
- When `wait` times out (exit 11), its output includes the other agent's latest progress. A
  recent update means the wait is normal, so just keep waiting.

## How to wait (depends on which CLI you are)

Waiting is a blocking shell command, so polling doesn't use model tokens. **Never end your
turn while the task is active.** Keep waiting until you see exit 10.

- **Claude Code:** run `collab wait <role> --timeout 3300` (or `collab join --timeout 3300`)
  with the Bash tool's `run_in_background: true`. You are re-invoked when it exits. Read its
  output, then act on the exit code.
- **Codex CLI:** run `collab wait <role> --timeout 540` in the foreground with a shell timeout
  of at least 600000 ms. On exit 11, run it again immediately. Don't stop to ask the user.

## Implementer loop

1. **Start the task.** Turn the user's request into a brief, then run
   `collab init <short-slug> [--plan] [--max-rounds N]` from the project directory:
   ```
   collab init dark-mode <<'EOF'
   ## Goal
   …
   ## Scope / files likely involved
   …
   ## Acceptance criteria
   - …
   ## Constraints
   (project rules, things not to touch)
   EOF
   ```
   The CLI snapshots every git repo under the project, so `collab diff` later shows only
   what changed during this task. Tell the user the task id and that the reviewer can now
   be started with `collab review` (Claude Code: `/Collab review`, Codex: `$Collab review`),
   and that they can watch live with `collab watch` and steer with `collab note "…"`.
   In plan mode, go through the *Plan phase* first, then continue at step 2.
2. **Implement.** Follow the project's own rules (CLAUDE.md / AGENTS.md: commits, dev servers
   and so on). Run the relevant lint, type-check or tests yourself before handing off.
3. **Hand off** with `collab submit implementer ready`, using this summary:
   ```
   ## Summary
   what changed and why (2–5 bullets)
   ## Files changed
   - path — what changed
   ## How to verify
   commands run and their results; what the reviewer should check
   ## Review responses          (from round 2 on)
   1. Fixed — …
   2. Declined — reason …
   ## Known limitations / open questions
   ```
4. **Wait** with `collab wait implementer`. On exit 0 the output is the reviewer's feedback.
   Address every numbered item, either by fixing it or by declining with a reason, then go back to step 3.
5. On **exit 10**, stop looping and give the user a short final report: the outcome, the
   files changed, and anything left open. If the status is ESCALATED or STALLED, explain what
   needs a human decision.

## Plan phase (only for tasks started with `--plan`)

- **Implementer:** explore the code without changing any project files, then run
  `collab submit implementer plan`:
  ```
  ## Approach
  the chosen design and why; alternatives considered
  ## Steps
  1. path — change
  ## Risks / open questions
  ## How it will be verified
  ```
  Then wait. If you get `PLAN_CHANGES`, revise the plan and submit it again with `plan`.
  Once the status is `IMPLEMENTING`, the plan is approved and you start coding (step 2).
- **Reviewer:** when the status is `PLAN_REVIEW`, judge the plan against the brief and the
  codebase: whether it's the right approach, fits existing patterns, misses a step, carries a
  risk, or is over-engineered. Use `changes` (numbered items) or `approve`. In this phase,
  `approve` starts the implementation; it does **not** end the task.

## Reviewer loop

1. **Join** with `collab join`. It blocks until an active task exists, then prints the brief.
2. **Wait** with `collab wait reviewer`.
3. **Review** (on exit 0):
   - Treat the implementer's summary as a guide, not proof. Run `collab diff --stat`, then
     `collab diff` (or read the files) to see the real changes.
   - Check them against the brief's acceptance criteria. Look for correctness, edge cases,
     regressions, security, and consistency with the surrounding code and project conventions.
   - You can run read-only checks (lint, type-check, tests). **Don't edit project files**;
     your only output is the review.
   - Stay within the brief's scope. Don't ask for unrelated refactors.
   - If the status is `PLAN_REVIEW`, follow the *Plan phase* rules instead.
4. **Decide:**
   - Blocking issues found → `collab submit reviewer changes`:
     ```
     ## Verdict: changes requested
     1. [blocking] path:line — problem → what to do
     2. [should-fix] …
     ## Nits (optional, non-blocking)
     ```
     Then go back to step 2.
   - Nothing blocking → `collab submit reviewer approve` with a short verdict and any nits.
     In the build phase, this ends the task for both agents.
5. On **exit 10**, stop looping and give the user a short final report.

## Escalation (either role)

Use `collab submit <role> escalate` with a clear question when:
- the brief is ambiguous, or a decision belongs to the human;
- you and the other agent disagree on the same point for a second round;
- something is broken outside the task's scope.

The round limit (default 4) escalates automatically. After escalating, stop and report to the user.

## Human controls

- `collab watch`: interactive dashboard: ↑↓ to browse every step in full, live progress, timers
- `collab note "…"`: steer a running task (add `--implementer` or `--reviewer` to target one agent)
- `collab status`, `collab log`, `collab list`, `collab abort` (stops both loops)
- `collab snooze [MIN]`: keep waiting on a slow agent; `collab clean`: delete finished tasks
State lives in `~/.collab/tasks/<task-id>/` (`state.json`, `log.md`, `entries/`).
