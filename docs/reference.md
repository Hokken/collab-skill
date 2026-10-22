# Collab reference

Details the [README](../README.md) leaves out to stay short: configuration, the lessons file
format and phone hooks for agent permission prompts. For the protocol itself (loop, states, exit
codes, notes, on-disk layout), see [how-it-works.md](how-it-works.md).

## Configuration

All optional, via environment variables:

| Variable | Default | What it does |
|---|---|---|
| `COLLAB_MAX_ROUNDS` | `4` | Review rounds before you are asked how to go on |
| `COLLAB_IDLE_SECS` | `1800` | Quiet time before "stop or keep waiting?" |
| `COLLAB_QUIET_MINS` | `10` | …and no file changes for this long (implementer's turn) |
| `COLLAB_STALL_SECS` | `7200` | Hard stop when nobody answers |
| `COLLAB_POLL_SECS` | `5` | How often a waiting agent checks for its turn |
| `COLLAB_CHECK_TIMEOUT` | `1800` | Seconds before a `--check` command is stopped |
| `COLLAB_NOTIFY` | `1` | `0` turns off desktop notifications (phone pushes only depend on `--phone`) |
| `COLLAB_PHONE_URL` | | Where `--phone` pushes go, overriding `collab phone set` |
| `COLLAB_HOME` | `~/.collab` | Where task state, the queue and settings are kept (lessons live in the repo) |

## The lessons file

Lessons live in `.collab/lessons.md` at the top of your repo (a module inside it shares the same
file), a plain Markdown list you can read and edit. Commit it, and every teammate, machine and
clone gets the same lessons. When editing by hand:

- each top-level `- ` bullet is one lesson (indented lines continue it), at most 300 characters:
  a longer one stays in the file but is left out of briefs until you shorten it;
- headings, notes, code blocks and HTML comments are left alone, and bullets inside them are not
  lessons, so you can keep examples there.

Collab's writes to the file never count as part of the work under review, so they can't void an
approval. That also means your own edits to it aren't reviewed: check it with `git diff` before
committing. The final report lists the lessons recorded during the run, so you can prune them first.

## Phone notifications

With `--phone`, you get a push when a decision is waiting for you, a task is escalated or stalls,
an agent looks unresponsive, a confirm-first queued task needs your go-ahead, and when the whole
run is done. Ordinary handoffs don't notify you. The rest of the run keeps `--phone`; a new
request needs it again.

The first time, collab creates a private, random [ntfy](https://ntfy.sh) topic and the implementer
tells you its name: install the ntfy app and subscribe to it. `collab phone` shows the topic,
`collab phone test` sends a test push, and `collab phone set <topic | url>` switches to your own
topic or a self-hosted server. ntfy.sh topics are public to anyone who knows the name, so keep it
private. Pushes contain the task id and the decision question.

### Hooks for agent permission prompts

Collab only sees what goes through it. An agent stuck on its own permission prompt ("Allow this
command?") looks merely quiet until the 30-minute idle check. To hear about those right away,
let the agent CLI call `collab phone send`. It pushes "Waiting for you: …" only when the project
has a running `--phone` task, and does nothing otherwise:

- **Claude Code** (`~/.claude/settings.json`): its questions (AskUserQuestion) fire no
  notification, so they need a `PreToolUse` hook; permission prompts come through `Notification`:
  ```json
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "collab phone send", "timeout": 10 }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt|elicitation_dialog",
        "hooks": [{ "type": "command", "command": "collab phone send", "timeout": 10 }] }
    ]
  }
  ```
  The hook prints nothing, so the question or prompt shows as usual. Don't add `idle_prompt`:
  Claude Code ends its turn while it waits in the loop, so that one would fire all the time.
- **Codex** (`~/.codex/hooks.json`; hooks are on by default, and Codex asks you once to trust a
  new hook):
  ```json
  { "hooks": { "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "collab phone send", "timeout": 10 }] }
  ] } }
  ```
  The hook prints nothing on stdout and always exits 0, so Codex's normal approval prompt is
  unchanged.

## Exit codes

`0` ok · `10` finished · `11` wait timed out · `12` note not acknowledged · `13` other agent idle ·
`14` check failed · `15` queue empty · `16` decision for the user · `17` files changed since
review/approval · `1` error. What each one asks an agent to do is in
[how-it-works.md](how-it-works.md#exit-codes).
