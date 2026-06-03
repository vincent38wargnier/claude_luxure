#!/usr/bin/env bash
#
# setup.sh — one-shot local install for Claude Luxure.
#
# Installs dependencies (root + webview), builds both bundles, and symlinks the
# extension into every editor it finds (VS Code / Cursor / Insiders) so it loads
# in every window — the "run it in your real editor" / debug setup. Safe to re-run.
#
# Usage:
#   ./setup.sh          install + build + link
#   ./setup.sh --dev    ...then start watch mode (auto-rebuild on save)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

LINK_NAME="claude-luxure"

WATCH=0
case "${1:-}" in
  --dev|--watch) WATCH=1 ;;
  "") ;;
  *) echo "Unknown option: $1 (use --dev to start watch mode)"; exit 1 ;;
esac

echo "==> Installing root dependencies…"
npm install

echo "==> Installing webview dependencies…"
(cd webview-ui && npm install)

echo "==> Building extension + webview…"
npm run build

# Symlink the repo into each editor's extensions folder. Creating the link there
# (plus the extension's onStartupFinished activation) is what makes it load in
# every window. Idempotent: repoints an existing link, never clobbers a real dir.
linked_any=0
link_into() {
  local ext_dir="$1" editor_name="$2"
  [ -d "$ext_dir" ] || return 0          # editor not installed — skip
  local target="$ext_dir/$LINK_NAME"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "!!  $editor_name: '$target' exists and is not a symlink — skipping."
    return 0
  fi
  ln -sfn "$REPO_ROOT" "$target"         # -n so an existing link is replaced, not followed into
  echo "==> $editor_name: linked ($target → $REPO_ROOT)"
  linked_any=1
}

link_into "$HOME/.vscode/extensions"          "VS Code"
link_into "$HOME/.cursor/extensions"          "Cursor"
link_into "$HOME/.vscode-insiders/extensions" "VS Code Insiders"

if [ "$linked_any" -eq 0 ]; then
  echo "!!  No editor extensions folder found (~/.vscode, ~/.cursor, ~/.vscode-insiders)."
  echo "    Install VS Code or Cursor, then re-run ./setup.sh."
fi

command -v claude >/dev/null 2>&1 || \
  echo "!!  'claude' CLI not on PATH — install it: npm i -g @anthropic-ai/claude-code && claude login"

echo ""
echo "Done ✦"
echo "  1. Fully quit and reopen your editor (first install only) — it now loads in every window."
echo "  2. Open it from the editor title-bar ✦ button, the status bar, or Cmd+Shift+P → 'Open Claude Luxure'."
echo "  3. Edit code, then Cmd+Shift+P → 'Developer: Reload Window' to pick up changes."
echo ""

if [ "$WATCH" -eq 1 ]; then
  echo "==> Starting watch mode (npm run dev). Leave this running; reload the window after edits. Ctrl+C to stop."
  exec npm run dev
else
  echo "Tip: run 'npm run dev' (or './setup.sh --dev') to auto-rebuild on save — then you only reload the window."
fi
