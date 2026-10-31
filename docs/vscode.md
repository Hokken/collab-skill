# collab-up: Collab in VS Code

`collab-up` sets up a whole Collab workspace from one VS Code terminal. Run it in an integrated
terminal and it opens four new terminals in the current folder:

| Terminal | Runs |
|---|---|
| **Claude code** | `claude` |
| **Codex** | `codex` |
| **collab watch** | `collab watch` (the dashboard) |
| **collab note** | nothing, ready for `collab note "…"` |

```bash
collab-up             # open the four terminals
collab-up --update    # run `claude update` and `codex update` first, then start them
collab-up --install   # install or update the VS Code extension (see below)
collab-up --help
```

Focus ends on the *Claude code* terminal. With `--update`, Claude Code and Codex still start if
an update fails.

## How it works

A shell command can't create named VS Code terminals on its own, so `collab-up` comes in two parts:

- `bin/collab-up.js`, the command. It sends a `vscode://hokken.collab-terminals/up?…` link
  through VS Code's `code` CLI. VS Code hands the link to the window you typed in (on macOS
  and Linux, the window that owns the terminal; on Windows, the focused window, which is the same
  one).
- `vscode/`, a tiny extension (**Collab Terminals**, `hokken.collab-terminals`) that receives
  the link and creates the terminals. It isn't on the Marketplace: `collab-up --install` packs
  the folder into a `.vsix` and installs it with `code --install-extension`. It does nothing
  until `collab-up` calls it.

## Requirements

- Everything Collab needs (Node.js 18+, git), plus **VS Code**.
- The `claude` (Claude Code) and `codex` (Codex CLI) commands on your PATH.
- VS Code's **`code` command** on your PATH:
  - **Windows**: the VS Code installer adds it (open a new terminal after installing).
  - **macOS**: in VS Code, open the command palette (⇧⌘P) and run
    **Shell Command: Install 'code' command in PATH**, then open a new terminal.
  - **Linux**: the `.deb`/`.rpm`/snap packages add it.

  Check with `code --version`.

## Install

The normal Collab installer sets up `collab-up` too. If you already have Collab, `git pull` and
re-run it; it's safe to re-run.

**macOS / Linux**

```bash
git clone https://github.com/Hokken/collab-skill.git   # or: cd collab-skill && git pull
cd collab-skill && ./install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/Hokken/collab-skill.git   # or: cd collab-skill; git pull
cd collab-skill; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. puts `collab-up` next to `collab` in `~/.local/bin` (a symlink on macOS/Linux; `collab-up.cmd`
   plus a Git Bash shim on Windows);
2. installs the Collab Terminals extension if `code` is found. Without `code` it says so and
   carries on; install `code` later and run `collab-up --install`.
   To leave the extension out, use `./install.sh --skip-vscode` or `install.ps1 -SkipVSCode`.

Then:

1. **Reload VS Code windows that were already open** (command palette →
   **Developer: Reload Window**) so they load the extension.
2. Open a new integrated terminal, `cd` to your project and run `collab-up`.
3. The first time, VS Code may ask whether *Collab Terminals* may open the link. Tick
   *Don't ask again* and allow it.

Installed with `npx skills add`? Run the second step from the
[Quick start](../README.md#install) (`~/.agents/skills/collab/install.sh`, or `install.ps1` on
Windows); it sets up `collab-up` as well.

## Updating

`git pull` updates `collab-up` itself straight away. When a pull changes the `vscode/` folder, run
`collab-up --install` (or re-run the installer) and reload your VS Code windows.

## Default shell

The extension types the commands into each terminal's default shell. PowerShell, bash, zsh and
fish chain `--update` commands with `;`; cmd.exe gets `&`.

## Uninstall

```bash
code --uninstall-extension hokken.collab-terminals
rm ~/.local/bin/collab-up            # Windows: del %USERPROFILE%\.local\bin\collab-up*
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `collab-up: run this from a VS Code integrated terminal.` | `collab-up` only works inside VS Code's own terminal (not Terminal.app, iTerm or Windows Terminal). |
| `the VS Code "code" command was not found` | Put `code` on your PATH (see [Requirements](#requirements)), open a new terminal, run `collab-up --install`. |
| Nothing happens, or VS Code offers to look for the extension in the Marketplace | The extension isn't installed or the window hasn't loaded it: run `collab-up --install`, then **Developer: Reload Window**. |
| `collab-up: command not found` | `~/.local/bin` isn't on your PATH: see the [Quick start](../README.md#install). On Windows, restart VS Code after a PATH change. |
| A terminal says `claude`/`codex` is not recognized | Install that agent CLI, or fix your PATH so a new terminal finds it. |
| You use VS Code Insiders, Cursor or another fork | Not supported: `collab-up` talks to the stable `code` command and the `vscode://` scheme. |
