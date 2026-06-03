# Claude Luxure ✦

> Cursor-like UI for Claude Code CLI — because Claude deserves to look good.

A VS Code extension that wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with a polished, Cursor-inspired interface. All AI work runs on your own Claude Code installation — this extension is purely a UI layer.

## Features

### Chat Interface
- Streaming markdown rendering with syntax highlighting
- Cost and token usage tracking per turn

### File Context (Drag & Drop + @Mentions)
- **Drag files** from the VS Code explorer directly into the chat
- **Type `@`** to fuzzy-search workspace files and attach them as context
- File contents are automatically read and injected into your prompt

### Image Support
- **Paste images** from clipboard (Ctrl/Cmd+V)
- **Drag & drop** image files into the chat
- Supports PNG, JPEG, and WebP

### Agent / Plan Mode
- **Agent mode**: full Claude Code capabilities (read, write, execute)
- **Plan mode**: read-only analysis — Claude proposes changes without executing them
- Toggle with a Cursor-style dropdown selector

### Inline Diff with Accept/Reject
- Non-git diff system — never pollutes your repository
- VS Code native diff editor (side-by-side) for each changed file
- Per-file **Accept** / **Reject** controls in the chat panel
- **Accept All** / **Reject All** for batch operations
- Files are snapshot before Claude edits; reject restores the original

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

## Installation

### Quick setup (recommended)

```bash
git clone https://github.com/your-org/claude-luxure.git
cd claude_luxure
./setup.sh        # installs deps, builds, and symlinks into your editor(s)
```

Then fully **quit and reopen** your editor — Claude Luxure now loads in **every window**. From then on, editing code only needs **Cmd+Shift+P → "Developer: Reload Window"**. Run `./setup.sh --dev` to also start watch mode so edits auto-rebuild and you skip the manual build. (`npm run setup` does the same thing.)

`setup.sh` is just a wrapper around the manual steps below — use those if you'd rather run them yourself, or need the F5 / VSIX flows.

### Manual build

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then choose how to run it:

### Option A — Symlink into your everyday editor (recommended for local use)

This runs the extension in your **normal** VS Code — every window and workspace, just like a published extension — while still loading straight from your source tree. The **Quick setup** script above does this for you; to do it by hand, link the repo into your editor's extensions folder:

```bash
# from the repo root
ln -s "$(pwd)" ~/.vscode/extensions/claude-luxure
```

Then fully **quit and reopen** VS Code. The extension now loads everywhere.

- **Cursor**: link into `~/.cursor/extensions/` instead.
- **VS Code Insiders**: use `~/.vscode-insiders/extensions/`.

To apply code changes later: rebuild (`npm run build`, or `npm run dev` for watch mode) then **Cmd+Shift+P → "Developer: Reload Window"**. No reinstall — the symlink always points at your latest build.

To remove it: `rm ~/.vscode/extensions/claude-luxure` and reload.

> This is the setup used to develop the app day-to-day: edit → build → reload, all in your real editor.

### Option B — Extension Development Host (F5)

Press **F5** in VS Code with the `claude_luxure` folder open. This opens a **separate** VS Code window with the extension loaded — handy for debugging with breakpoints, but the extension is *not* available in your normal windows.

### Option C — Packaged VSIX

```bash
npm run package
code --install-extension claude-luxure-0.1.0.vsix
```

Installs a fixed copy into every VS Code window. Unlike the symlink, you must re-package and re-install to pick up changes.

## Usage

1. Open the panel — click the **Claude Luxure** icon in the **editor title bar** (top-right of any file tab), or the status-bar entry (bottom-right), run **Cmd+Shift+P → Open Claude Luxure**, or open it from the activity bar (left sidebar)
2. Type a message or drag files into the chat
3. Toggle between Agent and Plan mode using the dropdown
4. Review diffs with Accept/Reject when Claude makes changes

## Architecture

```
Extension Host (Node.js)          Webview (React + Vite)
┌─────────────────────────┐       ┌──────────────────────┐
│ ChatViewProvider        │◄─────►│ ChatView             │
│ ClaudeBridge            │       │ ChatTextArea          │
│ DiffManager             │       │ ModeSelector          │
│ SnapshotManager         │       │ DiffPanel             │
│ VirtualDocProvider      │       │ MessageRow            │
└──────────┬──────────────┘       └──────────────────────┘
           │
           ▼
  claude --stream-json (CLI subprocess)
```

## Development (Run locally in VS Code)

### Quick start

```bash
./setup.sh --dev
```

This installs everything, symlinks the extension into your editor(s), and starts watch mode. After the first run, fully quit and reopen your editor; from then on you work entirely in your **normal** windows — edit code, then **Cmd+Shift+P → "Developer: Reload Window"** to see changes.

Prefer a separate, breakpoint-debuggable window? Press **F5** with the `claude_luxure` folder open to launch the **Extension Development Host** instead.

### Hot-reload workflow

Instead of rebuilding manually every time, run the watcher:

```bash
npm run dev
```

This runs `esbuild --watch` (extension host, ~5ms rebuilds) and `vite dev` (webview) in parallel. Both rebuild instantly on file save.

To see changes in the Extension Development Host, press **Cmd+Shift+P** > **"Developer: Reload Window"**. That takes ~1 second.

### Available scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Watch mode for both extension + webview (use during development) |
| `npm run build` | Full production build (extension + webview) |
| `npm run build:ext` | Build only the extension host |
| `npm run build:webview` | Build only the React webview |
| `npm run package` | Create `.vsix` for distribution |

### Debugging tips

- **Extension logs**: Output panel > "Claude Luxure" channel
- **File logs**: `claude-luxure.log`, written one level **above** the extension folder — e.g. `~/.vscode/extensions/claude-luxure.log` for a VSIX install, or the repo's parent directory when running from a symlink/source checkout
- **Webview DevTools**: In the Extension Development Host, press **Cmd+Shift+P** > **"Developer: Open Webview Developer Tools"**

## License

MIT
