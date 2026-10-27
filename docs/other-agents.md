# Other agent CLIs: Gemini CLI, Antigravity, OpenCode

Can the collab skill run with agents other than Claude Code and Codex CLI? This page checks
three candidates against what collab needs from an agent, says what works, what breaks, and
what would have to change. Findings are from **2026-10-23**; agent CLIs change fast, so re-check
the versions below before acting on them. *Evidence* at the end lists how to reproduce each check.

Each finding is tagged with where it comes from:
- **[code]**: read in the agent's source or its installed JavaScript bundle (the logic itself);
- **[strings]**: a name or prompt text found in a closed-source binary. It shows the feature
  exists, not how it behaves;
- **[bundled docs]**: documentation that ships with the installed agent;
- **[docs]**: the agent's official online docs or announcements (URL given);
- **[untested]**: inferred, not seen working.

Nothing here was run as a real collab loop, and no model prompt was sent (no paid inference).
See *What was not tested*.

| Agent | Version checked | How |
|---|---|---|
| Gemini CLI | 0.53.1 | installed npm bundle (`@google/gemini-cli/bundle`), official docs |
| Antigravity CLI (`agy`) | `agy --version` prints 1.1.10; `agy changelog` tops at 1.4.6 | `--help`, `changelog`, its bundled docs, `strings` on the binary, official codelab |
| OpenCode | v1.19.4 (latest release, 2026-10-22, commit `148842e`) and `dev` at `02671e6` | source on GitHub (`anomalyco/opencode`), opencode.ai docs |

Gemini CLI and Antigravity are different products: Gemini CLI is the open-source Node CLI
(`gemini`); Antigravity is Google's agent platform, and `agy` is its closed-source terminal agent.

## Availability: Gemini CLI no longer serves consumer accounts

Google's announcement of June 18, 2026 ([gemini-cli discussion #28017](https://github.com/google-gemini/gemini-cli/discussions/28017))
says Gemini CLI "will stop serving requests for Google AI Pro, Google AI Ultra, and free tier
individual accounts", and moves that terminal experience to the Antigravity CLI. Enterprise users
with Gemini Code Assist licences and API-key users "remain completely unaffected" [docs]. The post
says nothing about other Workspace accounts or Vertex AI.

So having `gemini` installed doesn't mean it can still answer. For a personal Google account,
Antigravity CLI is now the Google agent to pair with. Gemini CLI only matters to API-key and
Code Assist users. The announcement also says `agy` imports skills, MCP configs and `GEMINI.md`
files from the local Gemini CLI folder [docs, untested].

## What collab needs from an agent

Collab's agent-specific surface is small. Everything else is plain shell commands.

1. **Load and start the skill**: find `SKILL.md` in a folder the installers link
   (`~/.agents/skills/collab`, `~/.claude/skills/collab`), and let the user start it as
   implementer or reviewer.
2. **Wait** for the other agent, possibly for hours, without ending its turn. Collab supports two
   ways: a **background** command that wakes the agent when it exits (Claude Code:
   `wait --timeout 3300` in the background), or a **foreground** loop re-running the same
   `wait --timeout 540` on every exit 11 (Codex).
3. **Keep going for hours**: no turn cap or loop detector that stops the agent mid-loop.
4. **Ask the user** a decision (exit 13, exit 16, `decide`): with a structured question tool
   (Claude Code's `--self` branch) or as plain text (Codex's branch).
5. **Be recognised as an agent shell** by `agentShell()` in `bin/collab.js`, so a plain
   `collab note` from the agent is refused. Today: `CLAUDECODE=1`, `CODEX_*`, or `COLLAB_AGENT`.
6. **Hooks** (optional) for `collab phone send`: a JSON event when the agent waits for a permission
   or asks a question, parsed by `waitingEvent()`.

## Summary

| Need | Gemini CLI 0.53.1 | Antigravity `agy` | OpenCode v1.19.4 |
|---|---|---|---|
| Account access | API key or Code Assist only [docs] | personal Google accounts [docs] | any provider it supports |
| 1. Skill folder | ok: `~/.agents/skills` [code, docs] | **needs change**: global skills live in `~/.gemini/config/`, not `~/.agents/skills` [bundled docs] | ok: `~/.agents/skills`, `~/.claude/skills` [docs] |
| 1. Starting it | agent picks it from the request, user consents each time [docs] | agent picks it from the request or its name; `/<name>` per a migration guide [docs, untested in the CLI] | `skill` tool; `/collab` with a metadata opt-in [docs] |
| 2. Wait | **needs change**: 300-s no-output limit; background + `inject` setting [code] | async commands with status notices [strings] | foreground, 2-min default, agent passes a longer timeout [code] |
| 3. Long runs | **needs change**: loop detector on 5 identical calls [code] | unknown [untested] | **needs change**: `doom_loop` asks after 3 identical calls [docs] |
| 4. Ask the user | `ask_user` [code] | `ask_user` [strings] | `question` [docs] |
| 5. Agent shell | `GEMINI_CLI=1` [code] | unknown; `ANTIGRAVITY_*` names exist [strings] | `OPENCODE=1`, set by the CLI and inherited by its shells [code] |
| 6. Hooks | `Notification` (`ToolPermission`) [code] | `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`; camelCase JSON in and out [bundled docs] | JS/TS plugins, `permission.asked` event [docs] |
| **Verdict** | **works with changes**, for API-key / Code Assist users | **unproven; likely works with changes** | **works with changes** |

None of them is ruled out: all three can load a skill, run shell commands and ask the user.
Two problems recur:
- **Repeated waits.** The Codex way of waiting (re-run the identical `collab wait` on every exit
  11) is what Gemini CLI's and OpenCode's loop guards look for. Fixing it once in collab helps both.
- **Install folders.** `agy` doesn't read either folder collab installs to.

## Gemini CLI

- **Skill folders [code, docs]:** `~/.gemini/skills/` "or the `~/.agents/skills/` alias", plus
  `.gemini/skills/` / `.agents/skills/` in the workspace ([Using Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/)).
  The bundle builds the alias as `path.join(homedir(), ".agents", "skills")`. `install.sh` already
  links `~/.agents/skills/collab`, so the skill is found without any install change.
- **Starting it [docs]:** skills are agent-triggered. "The `activate_skill` tool is used
  exclusively by the Gemini agent. You cannot invoke this tool manually"; the agent activates a
  skill when a request matches it ([activate_skill](https://geminicli.com/docs/tools/activate-skill/)),
  and "every time a skill is triggered during a session, the agent must ask for permission to
  activate it" (Using Agent Skills). `/skills` manages skills (list, enable, disable, link, reload)
  but doesn't run one. So the user writes a request such as *"use the collab skill as reviewer for
  task <id>"* and approves the activation. A real `/collab` would need a separate custom command,
  which collab doesn't ship [untested].
- **Shell timeout [code]:** `tools.shell.inactivityTimeout`, default 300: "The maximum time in
  seconds allowed without output from the shell command." `collab wait` prints nothing until it
  returns, so a `--timeout` of 300 s or more risks being cut off. 240 s leaves a safety margin.
  No absolute cap was found.
- **Background [code]:** the shell tool has `is_background`. The setting
  `tools.shell.backgroundCompletionBehavior` defaults to `silent`; `inject` "automatically returns
  output to agent", `notify` shows a message. Whether `inject` starts a new turn while the agent is
  idle (what Claude Code does) is **[untested]**.
- **Loop detection [code]:** `LoopDetectionService.checkToolCallLoop` hashes each tool call (name +
  JSON args) and reports a loop when the same call, or a cycle of up to 5 calls, repeats
  `TOOL_CALL_LOOP_THRESHOLD = 5` times in a row; the user then sees "Loop detected, stopping
  execution". It runs on the tool-call request, so a Codex-style reviewer's fifth identical `wait`
  is flagged when it is requested, not after it ends. `model.disableLoopDetection` (default
  `false`) turns it off. `maxSessionTurns` defaults to -1 (no limit).
- **Ask the user [code]:** `ask_user` tool (`ASK_USER_TOOL_NAME`).
- **Agent shell [code]:** `GEMINI_CLI=1` (`GEMINI_CLI_IDENTIFICATION_ENV_VAR`) in its commands' environment.
- **Hooks [code]:** events include `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent` and
  `Notification`. Permission prompts fire `Notification` with `notification_type: "ToolPermission"`
  and a `message`. `waitingEvent()` already falls back to `j.message`, so `collab phone send` may work
  as a `Notification` hook today [untested].

**Verdict: works with changes, for API-key and Code Assist users.** The skill loads as is. Waiting
has to avoid both the 300-second silence limit and 5 identical calls in a row.

## Antigravity CLI (`agy`)

Closed source. Below, [bundled docs] means the customization docs `agy` ships in
`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/`, and [strings] means names found
in the binary.

- **Skill folders [bundled docs, docs]:** the bundled `SKILL.md` gives the discovery order: workspace
  (walking up from the cwd to the repo root, e.g. `.agents/skills/`), `skills.json` / `plugins.json`
  in the workspace, "**Global Discovery**: `~/.gemini/config/`", built-in skills, then global JSON
  configs. Google's [Antigravity skills codelab](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
  agrees that the CLI does not read `~/.agents/skills` ("Antigravity picks it up from this folder
  but Antigravity CLI does not"). It gives `~/.gemini/antigravity-cli/skills/` as the CLI's global
  folder in one place and `~/.gemini/config/skills/` in another. **Collab's installers link
  neither**, so a globally installed collab isn't found by `agy`. A `skills.json` can also point at
  any folder [bundled docs]. Which global folder this version reads needs a live check with `/skills`.
- **Starting it [docs]:** agent-triggered: the model matches the request against each skill's
  `description`, or the user names the skill in the prompt (codelab). `/skills` lists them. The
  codelab and the bundled docs don't mention slash invocation, but Google's
  [workflows-to-skills migration guide](https://www.antigravity.google/docs/migration/workflows-to-skills/)
  says "You can invoke any skill located in `.agents/skills/<name>/` or `~/.gemini/config/skills/<name>/`
  by typing `/<name>`". Its example is for the Antigravity App and it names no version, so whether
  `/collab` works in this `agy` is **[untested]**. That guide also names `~/.gemini/config/skills/` as the
  global folder, which matches the bundled docs.
- **Waiting [strings]:** `run_command` takes `Blocking` and `WaitMsBeforeAsync` (after that wait,
  the command goes on asynchronously), and `command_status` takes `WaitDurationSeconds`. Its prompt
  text says: "If the command runs for longer than this duration … the system will notify you that it
  is still running." The changelog fixes a problem when "a background command finished while the
  agent kept working". This looks like Claude Code's background model. Whether a completion wakes
  an idle agent is **[untested]**.
- **Long runs [untested]:** no loop detector or turn cap was found; that doesn't mean there isn't one.
- **Ask the user [strings]:** `ask_user` and `notify_user` tools.
- **Agent shell [untested]:** no documented variable. The binary names `ANTIGRAVITY_CONVERSATION_ID`,
  `ANTIGRAVITY_PROJECT_ID` and others; which ones reach the agent's shell is unknown. Until checked,
  the user exports `COLLAB_AGENT=1` before starting `agy`.
- **Hooks [bundled docs]:** `hooks.json` with `PreToolUse` / `PostToolUse` (with a tool `matcher`),
  `PreInvocation`, `PostInvocation` and `Stop`. Hooks get camelCase JSON on stdin (`conversationId`,
  `workspacePaths`, …) and **must print a JSON object on stdout**. `collab phone send` prints nothing
  on stdout and reads `cwd`, so it would need changes to work as an `agy` hook. The binary also
  contains `Notification` and `PermissionRequest` [strings], but the bundled docs don't list them.

**Verdict: unproven, likely works with changes.** Its tools match collab's Claude Code
instructions most closely, but the folder it reads skills from has to be added to the installers,
and none of its runtime behaviour is verified.

## OpenCode

- **Skill folders [docs]** ([Agent skills](https://opencode.ai/docs/skills/)): global
  `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, plus `.opencode/`, `.claude/`
  and `.agents/skills` from the cwd up to the git worktree. Both folders collab installs to are read.
- **Starting it [docs]:** the agent loads a skill with its `skill` tool when the request matches it.
  A `/collab` command in the TUI needs an opt-in in the frontmatter's `metadata` map:
  ```yaml
  metadata:
    opencode/slash: "true"
  ```
  This is on the live docs page, but not in `packages/web/src/content/docs/skills.mdx` at v1.19.4 or
  at `dev` `02671e6`, so it may be newer than the release [docs, untested]. OpenCode ignores unknown
  frontmatter fields, so the key would be harmless for other agents.
- **Waiting [code, v1.19.4]:** [`packages/opencode/src/tool/shell.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/tool/shell.ts)
  runs commands in the foreground, default timeout 2 min (`flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000`).
  The agent can pass a longer `timeout` (ms), and this tool doesn't cap it (`packages/core/src/tool/bash.ts`
  in the same release caps at 10 min, but it isn't the shell tool the `opencode` package uses).
  So it can wait the Codex way: `--timeout 540` with a `timeout` of at least 600000.
- **Waiting, upcoming [code, `dev` `02671e6`]:** [`packages/core/src/tool/plugin/shell.ts`](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/core/src/tool/plugin/shell.ts)
  adds `background: true`: "You will be notified when it completes. DO NOT poll for completion."
  That's Claude Code's model. It isn't in v1.19.4.
- **Long runs [docs]** ([Permissions](https://opencode.ai/docs/permissions/)): `doom_loop` is
  "triggered when the same tool call repeats 3 times with identical input", default `"ask"`, so a
  foreground waiting loop stops for a permission prompt on its third identical wait. It can be set to
  `"allow"` in `opencode.json`.
- **Ask the user [docs]** ([Tools](https://opencode.ai/docs/tools/)): `question` tool (header,
  question, options, custom answer).
- **Agent shell [code]:** v1.19.4's CLI middleware in
  [`packages/opencode/src/index.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/index.ts)
  sets `process.env.AGENT = "1"` and `process.env.OPENCODE = "1"` for the whole process, and the shell
  tool runs commands with `process.env` plus whatever a plugin's `shell.env` hook adds, so every
  command sees `OPENCODE=1`. (An earlier version of this page missed the middleware and said the
  release sets nothing.) `dev`'s shell tool also sets them itself, plus `AI_AGENT=opencode` and
  `OPENCODE_SESSION_ID`.
- **Hooks [docs]** ([Plugins](https://opencode.ai/docs/plugins/)): no shell command hooks. A JS/TS
  plugin subscribes with an `event` handler (`event: async ({ event }) => { if (event.type === …) }`),
  and the documented *Permission Events* are `permission.asked` and `permission.replied`. A plugin
  also gets `$`, Bun's shell API. So `collab phone send` would need a small plugin that runs it on
  `permission.asked` (and on `session.idle`, which the docs' example uses) [untested].

**Verdict: works with changes.** It works with today's release using the Codex-style
instructions plus the repeated-wait fix, and `OPENCODE=1` identifies its shell. Once the `dev`
shell tool ships, it can wait like Claude Code.

**Status:** collab now supports OpenCode (stages 1, 3, 4 and 5 below, for OpenCode): `wait` and
`join` take `--attempt N`, `agentShell()` recognises `OPENCODE=1`, and `SKILL.md`, the README, the
help text and the installers name it. The `/collab` slash opt-in was left out until OpenCode's
release documents it. Not yet done: a real paired run (stage 6) and a phone-hook plugin.

## Recommendation

It depends on what accounts collab's users have:

1. **Personal Google account (free, AI Pro, AI Ultra): Antigravity CLI first.** It is the only
   Google terminal agent those accounts can still use, and its tools are the closest to collab's
   Claude Code instructions. But nothing about its runtime behaviour is verified. So its first stage
   is a short live test, which costs some inference and needs your OK.
2. **OpenCode next, or first if you'd rather start with something proven by source.** It reads
   collab's existing install folders, its behaviour is in readable source, and it works with today's
   release once the repeated-wait fix is in.
3. **Gemini CLI only for API-key or Code Assist users.** It is the best documented of the three, but
   for most people it no longer answers, so it isn't worth supporting first.

The repeated-wait fix (stage 1 below) helps OpenCode and Gemini CLI, and costs nothing for `agy`,
so it is worth doing whichever agent comes first.

## Recommended changes (staged)

Each stage can be queued as its own task.

0. **`agy` live test** (no code change; needs your OK for the inference). Link collab into the global
   folder `agy` reads (try `~/.gemini/config/skills/collab`, then `~/.gemini/antigravity-cli/skills/collab`)
   and check `/skills` and whether `/collab` starts it. In one session, run
   `env | grep -i -E 'antigravity|agy|gemini'`. Then start a throwaway task and, while it is the
   reviewer's turn, run `collab -t <probe-task-id> wait implementer --timeout 600` as an async command
   to see whether its completion wakes the idle agent. Record the results here.
1. **Waiting without tripping loop guards** (`bin/collab.js`, `SKILL.md`, tests).
   - Add a heartbeat option to `wait`/`join` (e.g. `--heartbeat SECS`) that prints a short line such as
     `still waiting (12 min)` every SECS. That keeps Gemini CLI's inactivity timer alive, so one call
     can last as long as `--timeout`.
   - Make consecutive waits differ for loop detectors, e.g. an ignored `--attempt N` that the skill
     tells agents to increment on each exit 11. Alternatively, document the settings
     (`model.disableLoopDetection`, OpenCode `doom_loop: "allow"`). The flag works without
     touching the user's config; the settings are simpler. The follow-up task should decide.
   - No exit code changes; tests drive the new options through `sandbox()`.
2. **Installers** (`install.sh`, `install.ps1`): also link the skill into the global folder `agy`
   reads (the one stage 0 confirms), the same way as the other links: back up a real folder,
   skip it when it is already the target. Gemini CLI and OpenCode need no install change.
3. **`agentShell()`** (`bin/collab.js` + test): also accept `GEMINI_CLI === '1'`, the `agy` variable
   from stage 0 if there is one, and `OPENCODE === '1'` (done). Update the comment that lists them.
4. **`SKILL.md`**:
   - Turn the per-CLI branches from "Claude Code / Codex" into "agents that wake on a background
     command's exit / agents that loop in the foreground", and say which agent follows which, in each
     place that has a Codex paragraph today: *How to wait*, *The other agent looks unresponsive*,
     *Decisions* (`ask_user` / `question` take the `--self` branch, like AskUserQuestion), *Queued tasks*.
   - Explain that these agents start the skill from a request (*"use the collab skill as
     implementer: …"*), or `/collab` where it works (`agy` if stage 0 confirms it; OpenCode with its opt-in), and add `metadata: opencode/slash: "true"` for OpenCode once
     its release supports it.
   - Update the frontmatter `description` ("e.g. Claude Code and Codex CLI").
5. **CLI text and docs**: the `reviewer:` line in `cmdInit` and `collab help` (today `/collab review
   <id>` / `$collab review <id>`) also show the request form. `README.md`: supported agents, each
   agent's install folder and the Gemini CLI account limit, with a link to this page.
   `docs/reference.md`: hook examples (`agy` hooks need JSON on stdout, so `collab phone send` needs
   an `agy` mode first), each with a `waitingEvent()` test for its JSON.
6. **Acceptance gate**: a real paired run with each newly supported agent, as implementer and as
   reviewer, with Claude Code or Codex on the other side: a `--plan` task with a decision, a wait of
   over 30 min across several exit 11s, and a note. That's the only way to prove needs 2 and 3,
   which this page only reads from code.

## What was not tested

- No agent was run in a collab loop, and no model prompt was sent (as agreed in the plan review: no
  paid inference without asking). [code] and [strings] findings describe code and names, not behaviour
  seen at runtime.
- Not checked: whether the local `gemini` install can still answer with your account (credentials
  weren't inspected); how long any agent really blocks on one command; whether a background
  completion (`inject` in Gemini CLI, async commands in `agy`) wakes an idle agent; which global skill
  folder this `agy` version reads; which environment variables reach `agy`'s shell; the hook JSON
  Gemini CLI sends.
- OpenCode was not installed (the brief rules out global installs). Its findings come from the
  v1.19.4 and `dev` sources and its docs.
- Windows was not checked for any of the three.

## Evidence

How each local finding was checked, so it can be re-run. The `chunk-*.js` file names change between
builds, so search the whole bundle.

**Gemini CLI 0.53.1.** `G=$(npm root -g)/@google/gemini-cli/bundle`, then `grep -F '<text>' $G/*.js`:

| Finding | Search text |
|---|---|
| shell env var | `GEMINI_CLI_IDENTIFICATION_ENV_VAR = "GEMINI_CLI"` (value `"1"` next to it) |
| `~/.agents/skills` | `static getUserAgentSkillsDir() {` and `static getGlobalAgentsDir() {` |
| inactivity limit | `inactivityTimeout: {` (default 300, description) |
| background completion | `backgroundCompletionBehavior: {` |
| loop detection | `var TOOL_CALL_LOOP_THRESHOLD = 5`, `checkToolCallLoop(toolCall) {`, `getToolCallKey(toolCall) {` |
| turning it off | `disableLoopDetection: {` (default false), `maxSessionTurns = params.maxSessionTurns ?? -1` |
| ask the user | `ASK_USER_TOOL_NAME = "ask_user"` |
| hook event | `notification_type: type2` and `NotificationType.ToolPermission` |

**Antigravity CLI.**
- `agy --version`, `agy --help`, `agy changelog` (async commands, plugin skills, hooks).
- Bundled docs: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md` (*Loading Priority
  and Precedence*), `docs/skills.md`, `docs/hooks.md` (*Supported Event Types*, *Common Input Fields*),
  `docs/json_configs.md`.
- Strings: `strings -n 6 $(command -v agy) | grep -oE 'run_command|command_status|WaitMsBeforeAsync|WaitDurationSeconds|ask_user|notify_user|ANTIGRAVITY_[A-Z_]{3,}|\.agents/skills'`
  and `strings -n 8 $(command -v agy) | grep WaitDurationSeconds` for the prompt text.

**OpenCode** (`gh api repos/anomalyco/opencode/contents/<path>?ref=<ref> --jq .content | base64 -d`):
- v1.19.4 (`148842e`): [`packages/opencode/src/tool/shell.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/tool/shell.ts)
  (`defaultTimeoutMs`, `shellEnv`), [`packages/opencode/src/index.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/index.ts)
  (`process.env.OPENCODE = "1"`), [`packages/core/src/tool/bash.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/tool/bash.ts)
  (`MAX_TIMEOUT_MS`), [`packages/web/src/content/docs/permissions.mdx`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/web/src/content/docs/permissions.mdx) (`doom_loop`).
- `dev` (`02671e6`, 2026-10-23): [`packages/core/src/tool/plugin/shell.ts`](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/core/src/tool/plugin/shell.ts)
  (`background`, `OPENCODE = "1"`, `DEFAULT_TIMEOUT_MS`).

**Online docs:** [Gemini CLI: Using Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/),
[activate_skill](https://geminicli.com/docs/tools/activate-skill/),
[Gemini CLI announcement #28017](https://github.com/google-gemini/gemini-cli/discussions/28017),
[Antigravity skills codelab](https://codelabs.developers.google.com/getting-started-with-antigravity-skills),
[OpenCode skills](https://opencode.ai/docs/skills/), [tools](https://opencode.ai/docs/tools/),
[permissions](https://opencode.ai/docs/permissions/), [plugins](https://opencode.ai/docs/plugins/),
[Antigravity workflows-to-skills migration](https://www.antigravity.google/docs/migration/workflows-to-skills/).
