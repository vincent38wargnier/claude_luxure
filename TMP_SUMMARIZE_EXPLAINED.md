# `/summarize` — how it works (temporary explainer)

> Temp doc, safe to delete. Describes the code as of 2026-07-20.

## TL;DR

`/summarize` is **not** a real Claude Code CLI command. It's a pseudo-command owned by the
extension: when sent, it is rewritten into the CLI's native `/compact` command with a custom
steering prompt. The chat bubble still shows the literal `/summarize`, but the CLI receives
`/compact <big prompt>`. When the reply settles, the extension marks the conversation as
compacted and the webview renders a "Context summarized" divider.

```
composer "/summarize [focus]"
        │
        ▼
resolveSlashCommand()                     src/shared/cli-commands.ts:71
  displayText = "/summarize [focus]"      → shown in the chat bubble
  cliText     = "/compact <PROMPT>"       → sent to the CLI bridge
        │
        ▼
runtime.bridge.sendMessage(cliText)       src/webview/ChatViewProvider.ts:3440
        │  (CLI runs its native /compact, steered by the prompt)
        ▼
finalizeStreamingMessage()                src/webview/ChatViewProvider.ts:4770
  isCompactCommand(lastUserMsg) → true
  runtime.contextSummarized = true        (persisted to workspaceState)
  markCompactBoundary()                   tags last settled msg compactBoundary=true
        │
        ▼
<SummaryDivider />                        webview-ui/src/components/chat/ChatView.tsx:392
```

---

## 1. Definition — `src/shared/cli-commands.ts`

### The steering prompt (line 7)

```ts
export const SUMMARIZE_COMPACT_PROMPT = `Summarize what has been done through this conversation. List all the tools used (don't repeat individual tool calls — group by tool name and give counts). Include a very detailed summary of the last 20 messages of the chat so we don't lose the context of the recent messages.`;
```

Three instructions: recap the work, group tool usage by name with counts (no per-call spam),
and deep-summarize the last 20 messages so recent context survives compaction.

### The command entry (line 10)

```ts
{ name: "/summarize", description: "Summarize conversation and compact context", extension: true },
```

`extension: true` marks it as implemented by the extension rather than the CLI.

### The detector (lines 49–52)

```ts
export function isCompactCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^\/(compact|summarize)\b/i.test(trimmed);
}
```

Matches both `/compact` and `/summarize` (case-insensitive). Used *after* the turn to decide
whether to drop the "Context summarized" divider.

### The rewrite (lines 71–76, inside `resolveSlashCommand`)

```ts
if (cmd === "summarize") {
  const prompt = args
    ? `${SUMMARIZE_COMPACT_PROMPT}\n\nAdditional focus: ${args}`
    : SUMMARIZE_COMPACT_PROMPT;
  return { displayText: trimmed, cliText: `/compact ${prompt}` };
}
```

- `displayText` — what gets stored/rendered as the user message (the literal `/summarize …`).
- `cliText` — what the CLI actually receives: `/compact <prompt>`.
- Arguments are supported: `/summarize focus on the auth bug` appends
  `Additional focus: focus on the auth bug` to the prompt.

### Menu pinning (lines 101–104, inside `mergeCliCommands`)

```ts
const summarize = byName.get("/summarize")!;
byName.delete("/summarize");
return [summarize, ...Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))];
```

`/summarize` is always the **first** item in the composer's slash-command autocomplete; every
other command (defaults + dynamic ones reported by the CLI) is alphabetized after it. The
composer consumes this list in `webview-ui/src/components/chat/ChatTextArea.tsx:350`.

---

## 2. Send path — `src/webview/ChatViewProvider.ts`

`handleSendMessage` (line 3398) → `resolveMessageForCli` (line 3144):

```ts
const { displayText, cliText } = resolveSlashCommand(text);
```

- The user `ChatMessage` is created with `content: displayText` (line 3421–3427) — so history
  and the UI keep the short `/summarize`, never the expanded prompt.
- `@file` mention expansion is skipped for slash commands (`!isSlashCommand(text)` guard,
  line 3152).
- The resolved text goes to the CLI over the bridge: `runtime.bridge?.sendMessage(outgoingText)`
  (line 3440). The compaction itself is 100% the CLI's native `/compact` — the extension never
  summarizes anything itself; it only supplies the steering prompt.
- The reply streams back as a normal assistant message (streaming id, watchdog, etc.).

---

## 3. After the turn — divider bookkeeping

`finalizeStreamingMessage` (line 4740) runs when the assistant reply settles:

```ts
const lastUserMessage = [...runtime.messages].reverse().find((m) => m.role === "user");
if (lastUserMessage && isCompactCommand(lastUserMessage.content)) {   // line 4770
  runtime.contextSummarized = true;
  this.markCompactBoundary(runtime);
}
```

Note it checks `displayText` — which is why `isCompactCommand` must match the *unexpanded*
`/summarize`, not the `/compact <prompt>` form.

`markCompactBoundary` (line 775) walks messages newest→oldest and tags the first non-streaming
one with `compactBoundary: true`, anchoring the divider so it stays put as new messages append:

```ts
private markCompactBoundary(runtime: SessionRuntime): void {
  for (let i = runtime.messages.length - 1; i >= 0; i--) {
    const m = runtime.messages[i];
    if (m.isStreaming) continue;
    m.compactBoundary = true;
    return;
  }
}
```

### Persistence

- `runtime.contextSummarized` is saved to workspaceState under
  `claude-luxure.contextSummarized.<persistId>` (line ~741) and reloaded on session restore
  via `loadContextSummarized` (line 762; lines 681 and 1452 call it).
- It is reset to `false` on new/cleared sessions (line 3262).
- Auto-compaction by the CLI also sets it (line 3812) — same divider, different trigger.

---

## 4. Rendering — `webview-ui/src/components/chat/ChatView.tsx`

```tsx
{msg.compactBoundary && <SummaryDivider />}          // line 392
```

Fallback (lines 398–400): if `contextSummarized` is true but **no** message carries
`compactBoundary` (sessions persisted before the anchor existed), render the divider anyway.
`contextSummarized` reaches the view through the state push → `App.tsx:936`.

---

## 5. Don't confuse it with session summaries

`summarizeSession` / `summarizeAllSessions` (`ChatViewProvider.ts:856` / `:884`) are a
**different feature**: on-demand, headless one-shot runs that generate a title + hover summary
for rows in the history list (progress reported via `summarizeStatus` / `summarizeProgress`
messages, results persisted as `claude-luxure.sessionTitle.<id>` / `sessionSummary.<id>`).
They share the word "summarize" but have nothing to do with the `/summarize` slash command
or context compaction.

---

## 6. Where to change what

| You want to…                          | Edit                                              |
| ------------------------------------- | ------------------------------------------------- |
| Change what the summary contains      | `SUMMARIZE_COMPACT_PROMPT`, `cli-commands.ts:7`   |
| Change the menu label/description     | entry at `cli-commands.ts:10`                     |
| Change the CLI mapping / arg handling | `resolveSlashCommand`, `cli-commands.ts:71–76`    |
| Add another compact-like alias        | also update `isCompactCommand`, `cli-commands.ts:49` |
| Change menu ordering                  | `mergeCliCommands`, `cli-commands.ts:101–104`     |
| Change the divider look               | `SummaryDivider` usage, `ChatView.tsx:392`        |
| Change divider anchoring/persistence  | `ChatViewProvider.ts:775`, `:762`, `:4770`        |
