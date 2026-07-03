# Product

## Register

product

## Users

Developers running Claude Code sessions inside VS Code or Cursor. They are mid-task in their own codebase: coding while an AI agent works alongside them, often with long multi-agent turns running in the background. Primary user today is the project author; the design bar is "an engineer fluent in Cursor should trust it instantly".

## Product Purpose

Claude Luxure is a Cursor-quality chat UI wrapped around the Claude Code CLI. The extension is purely a UI layer: streaming chat, file/image context, inline diff accept/reject, multi-session tabs, and live tracking of agents and background work. Success means the user always knows what Claude is doing right now, never loses track of background work, and never loses their own work (drafts, queued messages, forks).

## Brand Personality

Calm, precise, native. It should feel like a built-in VS Code panel with Cursor's quiet density — not a consumer chatbot. Amber (#f59e0b) is the "Claude is working" signature; violet (#a78bfa) marks subagents; green confirms. Dark, stepped surfaces (page → card → composer) carry the hierarchy.

## Anti-references

- Consumer chat apps (iMessage-style bubbles, avatars, playful fillers).
- Loud SaaS dashboards: gradient buttons, hero metrics, decorative motion.
- Anything that fights VS Code theming or reinvents its standard affordances (scrollbars, modals, form controls).

## Design Principles

1. **Status is sacred** — every running process (turn, subagent, background task, retry) has a visible, truthful indicator; the panel never goes dark while work continues.
2. **Density without noise** — collapsed one-liners that expand to full detail; the transcript stays scannable during 50-tool turns.
3. **Native first** — VS Code theme tokens, fonts, and interaction conventions; the tool disappears into the task.
4. **The transcript is a workspace** — messages are editable/forkable, files clickable, diffs actionable, images zoomable.
5. **Never lose work** — drafts, queues, forks, and background results survive reloads and turn boundaries.

## Accessibility & Inclusion

Inherits the user's VS Code theme (including high-contrast themes) via `--vscode-*` variables where possible. Interactive elements should be keyboard-reachable and labelled; animation is informational (progress dots, pulse) and should respect `prefers-reduced-motion` (known gap — not yet implemented).
