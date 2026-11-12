# Collab reference

Details the [README](../README.md) leaves out to stay short: configuration, the lessons file
format, phone hooks for agent permission prompts, and sounds and speech. For the protocol itself (loop, states, exit
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
| `COLLAB_SOUND` | | `0` turns off every sound and spoken sentence from the commands run with it, whatever the task or config says (agents never set it on a task's commands, only on their own test runs) |
| `COLLAB_SOUND_STALE_SECS` | `120` | Sounds still waiting to play after this long are dropped |
| `ELEVENLABS_API_KEY` | | Your ElevenLabs key, for `--sound=elevenlabs` |
| `COLLAB_ELEVENLABS_TIMEOUT_SECS` | `15` | How long to wait for ElevenLabs before the system voice speaks instead |
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

## Sounds and speech

Made so you can tell where a session is without looking at the screen. With sound on, every step
plays a **tone** (to recognise it quickly) and then says a **short sentence**: what happened, e.g.
"Changes, round 2" or "Decision needed". With several collabs at once, `collab sound voice name on`
starts each sentence with the task's name ("dark mode: changes, round 2"); custom sentences can
always use `{task}`.

**Full sentences** say everything needed to follow a session by ear alone: whose turn it is, what
you need to do, and for a decision the question, every option and where to answer ("dark mode: the
reviewer requested 3 changes. The implementer's turn, round 2."). Use them for one task with
`--sound=full`, or always with `collab sound voice style full` (`style short` goes back).
`collab sound events` shows both sentences of every event.

### On by default, and how to change it

Sound is on for every task, with no setup: your system's own sounds and voice, short sentences.

- **Permanent** (`~/.collab/config.json`): `collab sound off` mutes everything, whatever a task asks
  (`collab sound on`, or `unmute`, undoes it); `collab sound voice off|on` (tones only, or tones and
  voice); `collab sound voice style short|full`; `collab sound voice system|elevenlabs`.
  `collab sound setup` also writes the built-in sounds into your config so you can see and edit them.
- **This run only:** `--sound=voice|tones|off|full|elevenlabs` on the request, or
  `collab [-t ID] sound use <words>` on the running task, which takes effect at the next event and
  stays for the rest of the run. Words: `voice` · `tones` · `off` (whether and how it sounds),
  `system` · `elevenlabs` (which voice), `short` · `full` (which sentences), or `default` alone (back
  to the permanent settings). Combine one of each (`sound use elevenlabs full`); contradicting words
  (`tones full`, `system elevenlabs`) are refused without changing anything, and a voice or style
  word turns the voice on. A short confirmation is spoken in the new settings. It never changes the
  task's turn, status or timers, and agents run it when you ask them in words. The rest of the run,
  including later parts of a split task, keeps it; a `--sound=…` given when a task starts wins for
  what it names (`--sound=elevenlabs` sets the voice and keeps the run's sentence style).
- **Order:** `COLLAB_SOUND=0` and `collab sound off` win, then the run's own settings, then the
  permanent ones (`voice.on: false` = tones only). Before this version sound was off unless a task
  had `--sound`; a config with `"on": true` and no `voice.on` now speaks too.

`collab sound` shows the state, the player and voice found on this machine, and what each event
plays. `collab sound test <event | file>` plays it now and prints the exact command
(`--dry-run`: print only), and `collab sound events` lists every event with its sentence.

### Events

| Event | When |
|---|---|
| `brief` | a new task starts |
| `part-start` · `split` | a part of a split task starts · the task was split |
| `plan` · `plan-changes` · `plan-approve` | plan handed in · changes asked · approved (by the reviewer, or by you at the round limit) |
| `ready` · `changes` · `approve` | work handed in · changes asked · approved: the task is done |
| `part-done` | a part of a split task is done (after `approve`) |
| `decide` · `answer` | you have to choose (the full sentence reads the question, every option and where to answer) · your answer was recorded |
| `escalate` · `abort` · `stall` | the loop stopped and needs you |
| `idle` | an agent looks unresponsive: stop or keep waiting? (once per quiet spell) |
| `check-fail` | the task's `--check` failed, nothing was handed off |
| `confirm` | a queued task waits for your go-ahead (once per item) |
| `agent-waiting` | an agent CLI waits for you during a running task, through the [hooks](#hooks-for-agent-permission-prompts) (no `--phone` needed; once a minute per task and message) |
| `note-all` · `note-implementer` · `note-reviewer` | your note was added |
| `peer-note-implementer` · `peer-note-reviewer` | one agent sent the other a note |
| `end` | the run is over: all work is done |
| `sound-change` | the run's sound settings were changed (`collab sound use`): a confirmation in the new settings |

`collab progress` updates stay silent. Each event sounds once, from the command that caused it,
and sounds never overlap: they wait in a queue and play one after the other, while the command
itself returns at once. A sound never changes a command's result.

### Your own sounds

`~/.collab/config.json` (edit it, or use the commands):

```json
"sound": {
  "on": true,
  "volume": 80,
  "voice": { "on": true, "rate": 200 },
  "pack": "/Users/me/collab-sounds/retro",
  "events": {
    "approve": "~/Sounds/done.mp3",
    "note-*": "/Users/me/Sounds/ping.wav",
    "plan": null,
    "decide": { "file": "~/Sounds/bell.wav", "say": "{task}: decision. {question} {options}" }
  }
}
```

- A value is a file, `null` (silent: no tone and no sentence), or `{ "file": …, "say": … }` where
  `"file": null` means no tone and `"say": false` no sentence.
- Keys are event names or globs (`note-*`, `*`); the most specific wins. Tone and sentence are
  looked up separately, so `{ "say": "…" }` alone keeps the tone.
- Custom sentences can use `{task}`, `{round}`, `{part}`, `{parts}`, `{turn}`, `{role}`, `{count}`,
  `{question}`, `{options}`, `{text}` and `{quiet}` (the agent an `idle` event is about).
- `collab sound set <event|glob> <file | none>`, `unset <event|glob>`, `volume <0-100>`,
  `voice on|off|style short|full|rate <words per minute>`.

**Sound packs.** A pack is a folder of sound files with a `collab-sounds.json` that maps events to
them, in the same format (`{ "name": "…", "events": { … } }`, file names relative to the folder).
`collab sound pack --init <folder>` writes a template listing every event with its default sentence
(it never overwrites one); fill in the files, then `collab sound pack <folder>` uses it. It refuses a pack whose
manifest is invalid or names a missing file, and warns about unknown events and formats this
machine can't play (a pack can be meant for several systems). `collab sound pack none` stops using it.

**Order:** your `config.json` events, then the pack, then the built-in system sounds. A file that
is missing or can't be played here falls through to the next one; a `null` stops there (silent).

### ElevenLabs voices

For voices that sound less generic, the sentences can be spoken by [ElevenLabs](https://elevenlabs.io)
(an account and API key are needed; each sentence counts towards your character quota).

- **Per request:** `--sound=elevenlabs`. **Always:** `collab sound voice elevenlabs`, which makes it
  the voice for `--sound` tasks and `collab sound on` too (`collab sound voice system` switches back).
- **Key:** `ELEVENLABS_API_KEY` in your shell profile, so the agents' shells have it; or
  `collab sound voice key`, which reads it from stdin (hidden at a prompt, never on the command line)
  and stores it in `config.json` in plain text (`--clear` removes it). The environment variable wins.
- **Voice and model:** `collab sound voice elevenlabs --voice <id> --model <id>`; defaults are the stock
  voice `21m00Tcm4TlvDq8ikWAM` and `eleven_flash_v2_5` (the fastest). `collab sound voices` lists your
  account's voices. Voice settings: see *Settings* below.
- **Fallback:** no key, offline, an invalid key, a quota or rate limit, a timeout
  (`COLLAB_ELEVENLABS_TIMEOUT_SECS`, 15), an answer without audio, or no mp3 player: that sentence is
  spoken by your system voice instead. After an invalid key ElevenLabs is skipped for 10 minutes
  (rate limit: 2, network: 1), unless you change the key, voice or model. `collab sound` shows the last
  outcome.
- **Cache:** every generated sentence is kept in `~/.collab/audio/tts/` (at most 300 / 50 MB, oldest
  dropped first), so a repeated sentence plays at once and costs nothing. `collab sound cache clear`
  empties it.
- **Try it:** `collab sound test decide --elevenlabs` speaks one sentence and says whether ElevenLabs,
  the cache or the system voice spoke; `--dry-run` shows the request without sending it.
- **Characters:** what ElevenLabs bills. Measured with the example task name "dark mode" (each
  sentence starts with the task name, so longer names add to every one):

  | Event | Short | Full |
  |---|---|---|
  | `brief` · `part-start` · `split` | 19 · 30 · 29 | 55 · 58 · 29 |
  | `plan` · `plan-approve` | 21 · 24 | 60 · 56 |
  | `ready` · `changes` · `plan-changes` | 25 · 27 · 23 | 57 · 76 · 79 |
  | `approve` · `part-done` · `end` | 19 · 27 · 24 | 30 · 36 · 71 |
  | `decide` | 26 | 226 (up to ~700 with a long question and 4 options) |
  | `answer` · `abort` · `stall` · `check-fail` | 19 · 18 · 18 · 23 | 63 · 36 · 68 · 81 |
  | `escalate` · `idle` · `confirm` · `agent-waiting` | 20 · 35 · 40 · 38 | 110 · 113 · 120 · 47 (more with long texts) |
  | `note-all` · `note-implementer` · `note-reviewer` | 21 · 35 · 32 | 46 · 50 · 47 |
  | `peer-note-implementer` · `peer-note-reviewer` | 33 · 36 | 51 · 51 |

  These include the task name ("dark mode: ", 11 characters), which is only said with
  `collab sound voice name on`; by default every sentence is that much shorter.

  A task with a plan and two review rounds (brief, plan, plan approved, ready ×2, changes, approved,
  end) is about 184 characters short versus 462 full, about 2.5× fewer; with one decision, 210
  versus 688 or more (about 3.3×). Over the 25 task events (not counting the `sound-change` confirmation), short is 662 characters and full 1716
  (about 2.6×); per event it ranges from the same (`split`) to about 8.7× fewer (`decide`), so the
  saving depends on the mix of events and the length of the task name. Repeated sentences come
  from the cache and cost nothing, and short sentences repeat far more often.
- **Settings:** `stability`, `similarity_boost`, `style_exaggeration` (ElevenLabs' "style") and `speed`
  in `sound.voice`. `sound.voice.style` is the sentence style (`short` | `full`); a number there,
  written by an earlier version, still counts as the style exaggeration, and
  `collab sound voice style …` moves it to `style_exaggeration` first.
- **Privacy:** with ElevenLabs on, every spoken sentence is sent to ElevenLabs: task names, events,
  decision questions and their options, escalation headlines, and the agent prompts that come through
  the hooks. Tones, packs and the system voice stay on your machine.

### Players and formats

| | Tones | Formats | Voice |
|---|---|---|---|
| macOS | `afplay` | wav, aiff, mp3, m4a/aac, caf, flac | `say` |
| Windows | `powershell.exe`: SoundPlayer (wav), MediaPlayer (others) | wav, mp3, wma, m4a/aac, flac | System.Speech |
| Linux | `pw-play`, `paplay`, `aplay`, `mpg123`, `ogg123`, `play`, `ffplay` (first installed that plays the file) | wav, ogg/oga, flac; mp3 with mpg123 or ffplay; anything with ffplay | `spd-say`, `espeak-ng`, `espeak` |

Built-in sounds: `/System/Library/Sounds` (macOS), `C:\Windows\Media` (Windows),
`/usr/share/sounds/freedesktop/stereo` (Linux, with the `sound-theme-freedesktop` package).
Without a player or voice, that part stays silent and `collab sound` says what to install. Volume
applies where the player supports it (not SoundPlayer, `aplay` or `say`).

The automated tests check which events sound, their order, the sentences and the exact commands for
each platform, with stand-in players. Real playback is only tried by hand: run
`collab sound test decide` once on your machine.
