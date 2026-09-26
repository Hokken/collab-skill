# Collab on Windows

Collab runs natively on Windows 10/11, in PowerShell, cmd and Git Bash, including VS Code's
integrated terminal. No WSL needed.

## Install

```powershell
git clone https://github.com/Hokken/collab-skill.git
cd collab-skill
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

- links the skill with **directory junctions** (no admin rights or Developer Mode needed):
  - `%USERPROFILE%\.agents\skills\Collab` → the repo (Codex reads this folder)
  - `%USERPROFILE%\.claude\skills\Collab` → the repo (Claude Code)
- adds two small shims in `%USERPROFILE%\.local\bin`: `collab.cmd` for PowerShell and cmd, and
  `collab` for Git Bash;
- asks before adding `%USERPROFILE%\.local\bin` to your user PATH.

After a PATH change, **restart VS Code** (or open new terminals). Updating later is just `git pull`.

**Codex doesn't list the skill?** Some Codex versions only read `%USERPROFILE%\.codex\skills`.
Re-run the installer with `-LinkCodexSkills`.

## Let the agents run without prompts

Every handoff is a `collab` command, so permission prompts would stop the loop. For Claude Code,
either use auto mode, or allow the command in `%USERPROFILE%\.claude\settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(collab:*)", "PowerShell(collab:*)"]
  }
}
```

For Codex, use an approval mode that allows shell commands without asking. If its sandbox is
`workspace-write`, add Collab's state folder as a writable root in `%USERPROFILE%\.codex\config.toml`:

```toml
[sandbox_workspace_write]
writable_roots = ["C:\\Users\\<you>\\.collab"]
```

## Accented characters and PowerShell 5.1

Windows PowerShell 5.1 mangles non-ASCII text (é, —, →) piped into other programs. The skill
therefore tells agents running in PowerShell to pass messages with `--file`:

```powershell
collab submit implementer ready --file "$env:TEMP\collab-msg.md"
```

If you type notes yourself, plain arguments are fine: `collab note "use the café API"`.
PowerShell 7 and Git Bash don't have this problem.

## Notifications

Collab shows a Windows toast when a task finishes, needs you, or when an agent hands off. If you
don't see any, check **Focus Assist / Do not disturb** and the notification settings for
*Windows PowerShell*. The terminal bell still rings either way.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `collab` is not recognized | Open a new terminal after installing; check `%USERPROFILE%\.local\bin` is on your user PATH. |
| Running scripts is disabled | Use `powershell -ExecutionPolicy Bypass -File .\install.ps1`. |
| `collab watch` keys don't respond | Use Windows Terminal or VS Code's terminal; very old consoles don't support them. |
| An agent keeps asking to run `collab` | See *Let the agents run without prompts* above. |
