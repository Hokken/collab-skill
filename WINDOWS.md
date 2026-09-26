# Windows setup: checklist for Claude Code

> **For:** Claude Code running on the user's Windows machine (VS Code with its integrated
> terminal, Claude Code CLI and Codex CLI).
> **Goal:** install Collab from this repo, verify the parts that could only be tested on macOS,
> and fix whatever is Windows-specific.
>
> Collab is a Node.js CLI plus a skill. The CLI and its 15 automated tests pass on macOS, where it
> has also been used end to end (Claude Code implementing, Codex reviewing). **Nothing has been
> run on Windows yet**, and `install.ps1` has not been executed anywhere.

## Rules

- Don't `git commit` or `git push` unless the user asks.
- Don't start dev servers.
- Before changing the user's PATH, `~\.codex\config.toml` or `~\.claude\settings.json`, show the
  change and get a yes.
- If you fix something in `bin/collab.js`, `install.ps1` or `SKILL.md`: keep it cross-platform
  (the Mac uses the same files), run `node --test`, and tell the user so they can commit it.

## 1. Prerequisites

- [ ] `node --version` is ≥ 18. If not: `winget install OpenJS.NodeJS.LTS`.
- [ ] `git --version` works. If not: `winget install Git.Git`.
- [ ] Find out which shell each CLI uses for commands. Claude Code's Bash tool usually runs Git
      Bash; Codex usually runs PowerShell (check 5.1 vs 7 with `$PSVersionTable`).

## 2. Install

From the repo folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- [ ] It linked (junctions) `~\.agents\skills\Collab` and `~\.claude\skills\Collab` to the repo.
- [ ] It wrote `~\.local\bin\collab.cmd` and `~\.local\bin\collab` (the sh shim for Git Bash).
- [ ] It asked before adding `~\.local\bin` to the user PATH.
- [ ] Re-running it prints `ok` for the links instead of recreating them.

If the script fails, fix it (it has never been run) and re-run it.

## 3. Automated tests

- [ ] `node --test` in the repo: all 15 tests pass.

These tests exercise git snapshots, file renames under concurrent reads, mtimes and UTF-8 bodies,
which are exactly the areas where Windows differs. Fix any failures in `bin/collab.js`, not in the
tests, unless a test makes a POSIX-only assumption.

## 4. Checks only possible on Windows

In **new** terminals, after the PATH change:

- [ ] **PowerShell** (VS Code terminal): `collab help` shows the grouped help, in colour.
- [ ] **Git Bash:** `collab help` works too (through the extensionless shim).
- [ ] **Message passing from PowerShell** keeps non-ASCII text intact:
      ```powershell
      mkdir $env:TEMP\collab-try; cd $env:TEMP\collab-try
      Set-Content -Encoding utf8 $env:TEMP\brief.md "Résumé — test → ok"
      collab init try --file $env:TEMP\brief.md
      collab show 0          # must print: Résumé — test → ok
      collab abort; collab clean -y
      ```
      Also try piping a here-string (`@' … '@ | collab note`) and report whether accents survive.
      This depends on the PowerShell version; `--file` is the documented safe path.
- [ ] **`collab watch`** in the VS Code terminal redraws in place (no repeated frames in the
      scrollback), and Ctrl-C restores the terminal.
- [ ] **Notification:** a `submit` shows a Windows toast (or at least rings the bell). If no
      toast appears, report it; `notify()` in `bin/collab.js` is where to adjust it.
- [ ] **Codex sees the skill:** in Codex, `/skills` lists `Collab`. If not, re-run
      `install.ps1 -LinkCodexSkills` and check again.
- [ ] **Claude Code sees the skill:** `/Collab` is available.
- [ ] **Codex can write to `~\.collab`:** check `~\.codex\config.toml`. If its sandbox is
      `workspace-write`, propose adding (with the user's OK):
      ```toml
      [sandbox_workspace_write]
      writable_roots = ["C:\\Users\\<user>\\.collab"]
      ```
- [ ] **Claude Code can run `collab` without prompting:** auto mode, or propose adding
      `Bash(collab:*)` to the allowlist in `~\.claude\settings.json`.
- [ ] **Codex's command timeout** allows the blocking `collab wait … --timeout 540` (at least
      600000 ms). If it caps lower, reduce the `--timeout` in `SKILL.md` (e.g. 240). Codex
      re-runs on exit 11 anyway.

## 5. End-to-end run (with the user)

In a throwaway folder (`git init` and `git commit --allow-empty -m init` first), open three VS
Code terminals:

1. **Codex:** `$Collab review`. It should run `collab join` and keep waiting without ending its turn.
2. **Claude Code** (auto mode): `/Collab implement`, then as the next message:
   *"Create a small Node.js module slugify.js that exports slugify(text): lowercase, strip
   accents, replace non-alphanumerics with single hyphens, trim hyphens. Add slugify.test.js
   using node:test with at least 6 cases, and make sure `node --test` passes. Use --max-rounds 2."*
3. **You:** `collab watch`.

Expected: brief → ready → changes or approve → … → `DONE`, both agents give a final report, and
nobody copy-pastes anything. Then try once with `--plan` and a `collab note -i "…"` mid-run.

Pay particular attention to whether **Codex passes its messages with `--file`** (as `SKILL.md`
tells it to in PowerShell), and whether it keeps waiting between turns.

## 6. Report

Tell the user: what was installed where, the test results, each checklist item (pass, fail or
skipped, and why), any code changes you made (for them to commit), and anything that still needs
a decision.
