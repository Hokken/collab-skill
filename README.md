# Collab

An autonomous **implementer ⇄ reviewer** loop between two coding agents, such as Claude Code and
Codex CLI running in two terminals. No more copy-pasting summaries and reviews between them.

- One agent **implements**, the other **reviews**. They hand off turns through a shared state
  folder (`~/.collab/`) using the small `collab` CLI in this repo.
- Waiting is a blocking shell command, so no model tokens are spent while an agent waits.
- The loop ends by itself: the reviewer approves, the round limit is hit, someone escalates, or
  you abort.
- You stay in control: a live dashboard, steering notes, a plan-first mode, and a prompt when an
  agent goes quiet.

Zero dependencies: Node.js ≥ 18 (and git for `collab diff`). Works on macOS, Linux and Windows.

## Install

```bash
git clone https://github.com/Hokken/collab-skill.git ~/Documents/Work/collab-skill
cd ~/Documents/Work/collab-skill
./install.sh                     # macOS / Linux
```

```powershell
git clone https://github.com/Hokken/collab-skill.git $env:USERPROFILE\Documents\Work\collab-skill
cd $env:USERPROFILE\Documents\Work\collab-skill
powershell -ExecutionPolicy Bypass -File .\install.ps1     # Windows
```

The installer links the skill into `~/.agents/skills/Collab` (read by Codex) and
`~/.claude/skills/Collab` (Claude Code), and puts `collab` on your PATH. Updating is just
`git pull`. On Windows, see [WINDOWS.md](WINDOWS.md) for the first-time checks.

## Use

| Terminal | Command |
|---|---|
| A: reviewer | Codex: `$Collab review` · Claude Code: `/Collab review` |
| B: implementer | Claude Code: `/Collab implement`, then describe the task in your next message (add `--plan` to have the plan approved first) |
| C: you | `collab watch`: interactive dashboard (↑↓ browse steps, space/b scroll, f follow latest, q quit) |

While it runs:

```bash
collab note "don't touch the i18n files"     # steer both agents
collab note -r "be strict on accessibility"  # reviewer only (-i = implementer only)
collab status | log | diff --stat
collab abort                                  # stop both loops
collab clean                                  # delete finished tasks
collab help                                   # everything else
```

## How it works

- `collab init` snapshots every git repo under the project (`git stash create`, which leaves
  your working tree untouched), so `collab diff` shows only what changed during the task, even
  in folders holding several nested repos.
- While an agent has the turn, it posts short `collab progress "…"` updates at each step. They
  show live in `collab watch`, in the other agent's `wait` output, and count as a sign of life.
- Turns are enforced: an agent can't submit out of turn. A note from you that arrives mid-turn
  blocks that agent's next handoff until it has dealt with the note.
- If the other agent hasn't handed off for 30 min (and, while implementing, no project file has
  changed for 10 min), the waiting agent asks you: stop the task or keep waiting?
- State lives in `~/.collab/tasks/<task-id>/`: `state.json`, `log.md` (the full history) and
  `entries/`.

| Env var | Default | |
|---|---|---|
| `COLLAB_HOME` | `~/.collab` | state folder |
| `COLLAB_MAX_ROUNDS` | 4 | review rounds before escalating to you |
| `COLLAB_IDLE_SECS` | 1800 | quiet time before "stop or keep waiting?" |
| `COLLAB_QUIET_MINS` | 10 | …and no file changes for this long (implementer's turn) |
| `COLLAB_STALL_SECS` | 7200 | hard stop when nobody answers |
| `COLLAB_POLL_SECS` | 5 | polling interval |
| `COLLAB_NOTIFY` | 1 | `0` disables desktop notifications |

## Develop

```bash
node --test          # full test suite, ~15 s
```

- `bin/collab.js`: the CLI (single file, no dependencies)
- `SKILL.md`: instructions both agents follow
- `install.sh`, `install.ps1`: installers
