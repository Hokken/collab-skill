#!/usr/bin/env bash
# Install the Collab skill from this repo (macOS / Linux).
# Safe to re-run. Everything is a symlink to this repo, so `git pull` updates it in place.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_LINK="$HOME/.agents/skills/Collab"        # Codex reads ~/.agents/skills
CLAUDE_LINK="$HOME/.claude/skills/Collab"
BIN="$HOME/.local/bin"
BACKUPS="${COLLAB_HOME:-$HOME/.collab}/backups" # outside any skills folder, so no duplicate skill

command -v node >/dev/null 2>&1 || { echo "error: Node.js >= 18 is required"; exit 1; }
node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' \
  || { echo "error: Node.js >= 18 is required (found $(node --version))"; exit 1; }
command -v git >/dev/null 2>&1 || echo "warning: git not found — 'collab diff' will not work"

chmod +x "$REPO/bin/collab.js"
mkdir -p "$(dirname "$SKILL_LINK")" "$(dirname "$CLAUDE_LINK")" "$BIN"

# link <target> <path>: make <path> a symlink to <target>; a real folder/file is backed up first
link() {
  local target="$1" dest="$2"
  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$target" ]; then echo "ok      $dest"; return; fi
    rm "$dest"
  elif [ -e "$dest" ]; then
    mkdir -p "$BACKUPS"
    local b; b="$BACKUPS/$(basename "$dest").$(date +%Y%m%d-%H%M%S)"
    mv "$dest" "$b"
    echo "backup  $dest -> $b"
  fi
  ln -s "$target" "$dest"
  echo "linked  $dest -> $target"
}

link "$REPO" "$SKILL_LINK"
link "$REPO" "$CLAUDE_LINK"
link "$REPO/bin/collab.js" "$BIN/collab"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo; echo "note: $BIN is not on your PATH — add it to your shell profile, e.g.:"
     echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

echo
echo "Done. Check with: collab help"
echo "Restart Claude Code / Codex sessions so they load the skill."
