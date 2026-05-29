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

### From Source
```bash
git clone https://github.com/your-org/claude-luxure.git
cd claude_luxure
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### From VSIX
```bash
npm run package
code --install-extension claude-luxure-0.1.0.vsix
```

## Usage

1. Open the **Claude Luxure** panel from the activity bar (left sidebar)
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
cd claude_luxure
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code (with `claude_luxure` folder open). This launches the **Extension Development Host** — a second VS Code window with the extension loaded.

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
- **File logs**: `claude-luxure.log` in the extension's `dist/` parent directory
- **Webview DevTools**: In the Extension Development Host, press **Cmd+Shift+P** > **"Developer: Open Webview Developer Tools"**

## License

MIT
