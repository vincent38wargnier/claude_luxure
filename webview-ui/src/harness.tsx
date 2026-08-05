import { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import ChatView from "./components/chat/ChatView";
import SkillsPanel from "./components/skills/SkillsPanel";
import type {
  ChatMessage,
  QueuedMessage,
  SessionInfo,
  SessionMarker,
  SkillInfo,
  TaskActivity,
  TimelinePart,
} from "./types";

/**
 * Dev-only harness (loaded by /harness.html, never part of the shipped
 * webview): renders ChatView with a realistic mock conversation so the UI can
 * be screenshotted and design-reviewed in a plain browser at any panel width.
 *
 * Variants (query params):
 *   ?streaming=1  — a turn in flight (tests edit-while-running, stop states)
 *   ?skills=1     — the skills manager panel with mock skills (tests search)
 *   ?newpostit=1  — the post-it before its emoji is picked (placeholder "?")
 *   ?split=1      — split view: a second, mid-turn conversation beside the main
 */

/** A fake screenshot as an SVG data URI — deterministic, offline. */
function shot(label: string, bg: string, w = 800, h = 500): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="${bg}"/>` +
    `<rect x="14" y="14" width="${w - 28}" height="${h - 28}" rx="12" fill="rgba(255,255,255,0.14)"/>` +
    `<text x="50%" y="52%" font-family="system-ui" font-size="${Math.round(h / 9)}" fill="#ffffff" text-anchor="middle" font-weight="600">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const now = Date.now();

const finishedTask: TaskActivity = {
  type: "task",
  toolUseId: "toolu_task_1",
  taskId: "task-9f2",
  subagentType: "Explore",
  description: "Map how the webview renders tool activity",
  prompt:
    "Sweep webview-ui/src and report every component that renders ActivityEvent data, with file:line references.",
  status: "completed",
  progressSummary: "Reported 6 components with references",
  toolUses: 23,
  totalTokens: 48200,
  durationMs: 96000,
  children: [
    { type: "tool_use", toolName: "Glob", toolInput: { pattern: "webview-ui/src/**/*.tsx" }, parentToolUseId: "toolu_task_1" },
    { type: "tool_use", toolName: "Read", toolInput: { file_path: "webview-ui/src/components/chat/ActivityFeed.tsx" }, parentToolUseId: "toolu_task_1" },
    { type: "tool_use", toolName: "Grep", toolInput: { pattern: "ActivityEvent" }, parentToolUseId: "toolu_task_1" },
  ],
  result: {
    content:
      "Six components render activity data. The feed itself is `ActivityFeed.tsx`; cards are `AgentTaskCard`, `McpCallCard`, `ProofCard`, `FileChangeCard`; `MessageRow` walks the timeline.",
    images: [shot("Component map", "#7c3aed", 900, 540)],
  },
};

const timeline: TimelinePart[] = [
  {
    type: "text",
    text: "I'll check how the status strip behaves after the turn ends, then patch the tracker. Starting with a sweep of the webview components.",
  },
  {
    type: "activities",
    activities: [
      { type: "tool_use", toolName: "Read", toolInput: { file_path: "src/cli/claude-bridge.ts" } },
      { type: "tool_use", toolName: "Grep", toolInput: { pattern: "task_progress" } },
      { type: "tool_use", toolName: "Bash", toolInput: { command: "npm run build" } },
      finishedTask,
      {
        type: "tool_use",
        toolName: "mcp__chrome-devtools__take_screenshot",
        toolInput: { fullPage: false },
        result: {
          content: "Captured the panel at two widths.",
          images: [
            shot("Panel · narrow", "#0e7490", 640, 800),
            shot("Panel · wide", "#0f766e", 1280, 720),
          ],
        },
      },
      {
        type: "proof",
        images: [shot("Status strip · after fix", "#b45309", 1200, 660)],
        caption: "Agents strip stays visible after the turn ends",
      },
      {
        type: "tool_use",
        toolName: "Edit",
        toolInput: {
          file_path: "webview-ui/src/components/chat/ChatView.tsx",
          old_string: 'className="flex-1 overflow-y-auto py-2 space-y-1"',
          new_string: 'className="chat-scroll flex-1 overflow-y-auto py-2 space-y-1"',
        },
      },
      {
        type: "tool_use",
        toolName: "TodoWrite",
        toolInput: {
          todos: [
            { content: "Parse task_* events in the bridge", status: "completed" },
            { content: "Render live agent cards", status: "completed" },
            { content: "Ship the responsive image grid", status: "in_progress" },
            { content: "Add full-transcript viewer for agents", status: "pending" },
          ],
        },
      },
    ],
  },
  {
    type: "text",
    text: `## What changed

The messages scroller is now a **size container**, so image sets pick their column count from the panel's real width.

| Panel width | Columns |
|---|---|
| < 440px | 1 |
| ≥ 440px | 2 |
| ≥ 760px | 3 |

- Single images keep their natural aspect ratio
- Tiles crop to 16:10 and zoom on click
- Works in every card: attachments, MCP results, agent results, proofs

\`\`\`css
@container (min-width: 760px) {
  .img-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
\`\`\`

Reload the window and the next screenshot-heavy turn lays out as a gallery.`,
  },
];

const messages: ChatMessage[] = [
  {
    id: "u1",
    role: "user",
    content:
      "Here are the screenshots from the QA run — the status strip disappears mid-turn on two of them. Can you fix the tracker and tidy how these render?",
    images: [
      shot("QA · run 1", "#1d4ed8", 800, 500),
      shot("QA · run 2", "#9d174d", 800, 500),
      shot("QA · run 3", "#065f46", 640, 640),
      shot("QA · run 4", "#92400e", 900, 500),
      shot("QA · run 5", "#334155", 800, 560),
    ],
    timestamp: now - 9 * 60_000,
  },
  {
    id: "a1",
    role: "assistant",
    content: "",
    timestamp: now - 8 * 60_000,
    timeline,
    turnStats: { durationMs: 252_000 },
  },
  {
    id: "u2",
    role: "user",
    content: "Nice. Two more from the wide layout for reference.",
    images: [
      shot("Wide · before", "#7f1d1d", 1280, 720),
      shot("Wide · after", "#14532d", 1280, 720),
    ],
    timestamp: now - 3 * 60_000,
  },
  {
    id: "a2",
    role: "assistant",
    content:
      "Both captured. The **after** shot confirms the strip survives the turn boundary — the background agent keeps its card until the notification lands.",
    timestamp: now - 2 * 60_000,
    // Short text-only turn: the settle line must NOT render for this one.
    turnStats: { durationMs: 8_000 },
  },
];

const sessions: SessionInfo[] = [
  {
    id: "s-main",
    firstMessage: "Fix the agent tracker",
    timestamp: new Date(now - 60 * 60_000).toISOString(),
    messageCount: 12,
    modifiedAt: now - 2 * 60_000,
    title: "Agent tracker",
  },
  {
    id: "s-ui",
    firstMessage: "Polish the chat UI",
    timestamp: new Date(now - 30 * 60_000).toISOString(),
    messageCount: 4,
    modifiedAt: now - 10 * 60_000,
    title: "UI polish",
  },
  {
    id: "s-db",
    firstMessage: "Migrate the sessions table",
    timestamp: new Date(now - 2.5 * 86_400_000).toISOString(),
    messageCount: 8,
    modifiedAt: now - 2.2 * 86_400_000,
    title: "DB migration",
  },
];

const initialRunningTasks: TaskActivity[] = [
  {
    type: "task",
    toolUseId: "toolu_task_bg",
    taskId: "task-bg1",
    subagentType: "claude",
    description: "Audit accessibility of the composer",
    status: "running",
    progressSummary: "Reading ChatTextArea.tsx",
    toolUses: 12,
    totalTokens: 45300,
    durationMs: 92000,
    background: true,
  },
  {
    type: "task",
    toolUseId: "toolu_task_stuck",
    taskId: "task-stuck",
    subagentType: "agent",
    status: "running",
    // No description/progress — mirrors the stuck chip that reads just "agent".
  },
];

const noop = () => {};

const params = new URLSearchParams(window.location.search);
const streaming = params.has("streaming");

// ?streaming=1: the conversation ends on an in-flight assistant turn.
const streamingMessages: ChatMessage[] = [
  ...messages,
  {
    id: "u3",
    role: "user",
    content: "Now make the retry logic exponential instead of linear.",
    timestamp: now - 60_000,
  },
  {
    id: "a3",
    role: "assistant",
    content: "",
    timestamp: now - 55_000,
    isStreaming: true,
  },
];

const liveText =
  "Looking at the retry helper now — the backoff is currently linear, so I'll switch it to exponential with jitter and update the tests.";

// ?split=1: a second conversation in the split pane, mid-turn.
const splitDemo = params.has("split");

/** Realistic jsdiff createPatch output for the Review panel fixtures. */
function patch(name: string, hunks: string): string {
  return (
    `Index: ${name}\n` +
    `===================================================================\n` +
    `--- ${name}\toriginal\n` +
    `+++ ${name}\tmodified\n` +
    hunks
  );
}

const WS = "/Users/vincent/Documents/code/magify.fun/code/claude_luxure";
const pendingDiffs = [
  {
    filePath: `${WS}/webview-ui/src/components/chat/TabBar.tsx`,
    diff: patch(
      "TabBar.tsx",
      `@@ -29,8 +29,20 @@\n function isDraftTab(id: string): boolean {\n   return id.startsWith("draft-");\n }\n \n+/** Compact "waiting since" label: now → 5m → 3h → 2d. */\n+function formatIdle(elapsedMs: number): string {\n+  const s = Math.max(0, Math.floor(elapsedMs / 1000));\n+  if (s < 60) return "now";\n+  if (s < 3600) return \`\${Math.floor(s / 60)}m\`;\n+  if (s < 86400) return \`\${Math.floor(s / 3600)}h\`;\n+  return \`\${Math.floor(s / 86400)}d\`;\n+}\n+\n function Spinner() {\n   return (\n     <svg className="animate-spin" width="12" height="12">\n@@ -117,9 +129,10 @@\n   const tabs = useMemo(() => {\n     return openTabIds.map((id) => {\n-      const provided = tabNames?.[id];\n+      const provided = tabNames?.[id] ?? sessionMap.get(id)?.title;\n       if (provided) {\n         return { id, label: truncate(provided, 22) };\n       }\n`
    ),
  },
  {
    filePath: `${WS}/webview-ui/src/components/chat/SplitPane.tsx`,
    diff: patch(
      "SplitPane.tsx",
      `@@ -0,0 +1,9 @@\n+import { useMemo, useRef, useState } from "react";\n+import MessageRow from "./MessageRow";\n+import { IdleBadge } from "./TabBar";\n+\n+/** The second conversation of the split view. */\n+export default function SplitPane({ state, onPick }) {\n+  const [picking, setPicking] = useState(false);\n+  return <div className="split-pane" />;\n+}\n`
    ),
  },
  {
    filePath: `${WS}/webview-ui/src/legacy/OldStatusStrip.tsx`,
    diff: patch(
      "OldStatusStrip.tsx",
      `@@ -1,7 +0,0 @@\n-import { useState } from "react";\n-\n-/** Superseded by the agent dock. */\n-export default function OldStatusStrip() {\n-  const [visible] = useState(true);\n-  return visible ? <div className="strip" /> : null;\n-}\n`
    ),
  },
];

const splitMessages: ChatMessage[] = [
  {
    id: "sp-u1",
    role: "user",
    content:
      "Add a lastReplyAt column to the sessions table and backfill it from the transcripts.",
    timestamp: now - 22 * 60_000,
  },
  {
    id: "sp-a1",
    role: "assistant",
    content:
      "Column added with a migration; the backfill script reads each transcript's mtime. Dry run over the staging snapshot matched **58,214 rows**.",
    timestamp: now - 20 * 60_000,
    turnStats: { durationMs: 74_000 },
  },
  {
    id: "sp-u2",
    role: "user",
    content: "Run it for real and verify the counts match.",
    timestamp: now - 4 * 60_000,
  },
  {
    id: "sp-a2",
    role: "assistant",
    content: "",
    timestamp: now - 50_000,
    isStreaming: true,
  },
];

const mockSkills: SkillInfo[] = [
  { id: "g1", scope: "global", command: "/impeccable", name: "impeccable", description: "Design critique loop for UI work", path: "~/.claude/skills/impeccable/SKILL.md" },
  { id: "g2", scope: "global", command: "/commit", name: "commit", description: "Stage, write message, commit", path: "~/.claude/skills/commit/SKILL.md" },
  { id: "g3", scope: "global", command: "/review-pr", name: "review-pr", description: "Adversarial pull-request review", path: "~/.claude/skills/review-pr/SKILL.md" },
  { id: "g4", scope: "global", command: "/changelog", name: "changelog", description: "Draft release notes from git history", path: "~/.claude/skills/changelog/SKILL.md" },
  { id: "g5", scope: "global", command: "/impact-analysis", name: "impact-analysis", description: "Trace blast radius of a change", path: "~/.claude/skills/impact-analysis/SKILL.md" },
  { id: "p1", scope: "project", command: "/deploy-preview", name: "deploy-preview", description: "Build and deploy a preview env", path: ".claude/skills/deploy-preview/SKILL.md" },
  { id: "p2", scope: "project", command: "/e2e", name: "e2e", description: "Run the Playwright suite headlessly", path: ".claude/skills/e2e/SKILL.md" },
];

/** ?skills=1 — the skills manager with local state so search/select work. */
function SkillsHarness() {
  const [selectedId, setSelectedId] = useState<string | null>("g1");
  const [content, setContent] = useState("# impeccable\n\nRun the critique loop.");
  return (
    <SkillsPanel
      open
      skills={mockSkills}
      selectedSkillId={selectedId}
      editorContent={content}
      dirty={false}
      error={null}
      savedFlash={false}
      hasWorkspace
      onClose={noop}
      onSelectSkill={setSelectedId}
      onEditorChange={setContent}
      onListSkills={noop}
      onSave={noop}
      onDelete={noop}
      onCreate={noop}
      onOpenInEditor={noop}
    />
  );
}

interface HarnessLayout {
  tabs: [string[], string[]];
  active: [string | null, string | null];
  focused: 0 | 1;
}

/** Chat harness: simulates the provider's pane model locally — two full
 * ChatView instances, drag & drop between strips, click-to-focus. */
function ChatHarness() {
  const newPostit = params.has("newpostit");
  const [markers, setMarkers] = useState<Record<string, SessionMarker>>({
    "s-main": newPostit
      ? { color: "#F5DE7A" }
      : { emoji: "🛰️", color: "#F5DE7A" },
    "s-ui": { emoji: "🎨", color: "#8FCFF0", note: "impeccable pass — composer + a11y" },
    "s-db": { emoji: "🗄️", color: "#9FE0B0" },
  });
  const [markerBusy] = useState(false);
  const [runningTasks, setRunningTasks] = useState<TaskActivity[]>(
    initialRunningTasks
  );
  // Seed the composer's past-prompt suggestions. In the real webview the
  // extension host answers requestPromptHistory from the CLI transcripts;
  // the harness pushes a canned corpus (modeled on this repo's real one).
  useEffect(() => {
    const day = 86_400_000;
    const entries = [
      { text: "can you add opus 5 to the available models?", count: 2, lastUsed: Date.now() - 6 * day },
      { text: "check how i can run this claude luxure by default in all my vscode instances", count: 2, lastUsed: Date.now() - 5 * day },
      { text: "improve the edit bubble to behave like the original text area", count: 1, lastUsed: Date.now() - 4 * day },
      { text: "can you take a screenshot on this url and show me what ui i should improve https://app.jarvio.io", count: 3, lastUsed: Date.now() - 10 * day },
      { text: "add a pastel sticky note with a small emoji on each conversation in the history list", count: 1, lastUsed: Date.now() - 24 * day },
      { text: "add a yellow time-since-last-reply pill on the tabs and history rows", count: 1, lastUsed: Date.now() - 28 * day },
      { text: "fix the tab idle counters when the transcript is missing", count: 1, lastUsed: Date.now() - 20 * day },
      { text: "continue", count: 2, lastUsed: Date.now() - 2 * day },
      // Long multi-sentence prompt: its middle sentence becomes a phrase
      // chunk (¶ row) — demoes the two-granularity retrieval.
      { text: "the composer suggestions feel slow on large corpora. run the harness suite and screenshot the composer states. also check the memwatch counters after reload.", count: 2, lastUsed: Date.now() - 3 * day },
    ];
    window.postMessage({ type: "promptHistory", entries }, "*");
  }, []);
  // Mirrors App's queue-while-streaming behavior so the flow is testable here.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queueIdRef = useRef(0);
  // Idle counters: one fresh, one hours old, one days old.
  const [lastReply] = useState<Record<string, number>>(() => ({
    "s-main": Date.now() - 8 * 60_000,
    "s-ui": Date.now() - 3.4 * 3_600_000,
    "s-db": Date.now() - 2.2 * 86_400_000,
  }));
  // Mirrors the provider's setMarkerNote: trim, cap, empty clears the note.
  const setNoteFor = (id: string) => (note: string) => {
    const trimmed = note.replace(/\s+/g, " ").trim().slice(0, 80);
    console.log(`[harness] setMarkerNote session=${id} note="${trimmed}"`);
    setMarkers((m) => ({
      ...m,
      [id]: { ...m[id], note: trimmed || undefined },
    }));
  };

  // The provider's pane model, in miniature (incl. normalize-on-empty).
  const [layout, setLayout] = useState<HarnessLayout>(() =>
    splitDemo
      ? { tabs: [["s-main", "s-ui"], ["s-db"]], active: ["s-main", "s-db"], focused: 0 }
      : { tabs: [["s-main", "s-ui", "s-db"], []], active: ["s-main", null], focused: 0 }
  );

  const normalize = (l: HarnessLayout): HarnessLayout => {
    if (l.tabs[0].length === 0 && l.tabs[1].length > 0) {
      l = { tabs: [l.tabs[1], []], active: [l.active[1], null], focused: 0 };
    }
    if (l.tabs[1].length === 0) {
      l = { ...l, active: [l.active[0], null], focused: 0 };
    }
    const active = l.active.map((a, i) =>
      l.tabs[i].length === 0 ? null : a && l.tabs[i].includes(a) ? a : l.tabs[i][0]
    ) as [string | null, string | null];
    return { ...l, active };
  };

  const moveTab = (tabId: string, targetPane: number, index: number) => {
    const target: 0 | 1 = targetPane === 1 ? 1 : 0;
    setLayout((prev) => {
      const tabs: [string[], string[]] = [[...prev.tabs[0]], [...prev.tabs[1]]];
      const source: 0 | 1 | undefined = tabs[0].includes(tabId)
        ? 0
        : tabs[1].includes(tabId)
          ? 1
          : undefined;
      if (source === undefined) return prev;
      const from = tabs[source].indexOf(tabId);
      tabs[source].splice(from, 1);
      let insert = index;
      if (source === target && from < insert) insert -= 1;
      insert = Math.max(0, Math.min(insert, tabs[target].length));
      tabs[target].splice(insert, 0, tabId);
      const active: [string | null, string | null] = [...prev.active];
      let focused = prev.focused;
      if (source !== target) {
        active[target] = tabId;
        focused = target;
        if (active[source] === tabId) {
          active[source] = tabs[source][Math.min(from, tabs[source].length - 1)] ?? null;
        }
      }
      return normalize({ tabs, active, focused });
    });
  };

  const selectTab = (sessionId: string, pane: 0 | 1) => {
    setLayout((prev) => {
      const inPane: 0 | 1 = prev.tabs[0].includes(sessionId)
        ? 0
        : prev.tabs[1].includes(sessionId)
          ? 1
          : pane;
      const active: [string | null, string | null] = [...prev.active];
      active[inPane] = sessionId;
      return normalize({ ...prev, active, focused: inPane });
    });
  };

  const toggleSplit = () => {
    setLayout((prev) => {
      if (prev.tabs[1].length > 0) {
        return normalize({
          tabs: [[...prev.tabs[0], ...prev.tabs[1]], []],
          active: [prev.active[prev.focused] ?? prev.active[0], null],
          focused: 0,
        });
      }
      const donorIdx = prev.tabs[0].findIndex((id) => id !== prev.active[0]);
      if (donorIdx < 0) return prev;
      const tabs0 = [...prev.tabs[0]];
      const donor = tabs0.splice(donorIdx, 1)[0];
      return normalize({ tabs: [tabs0, [donor]], active: [prev.active[0], donor], focused: 1 });
    });
  };

  const focusPane = (pane: 0 | 1) =>
    setLayout((prev) => (prev.tabs[pane].length ? normalize({ ...prev, focused: pane }) : prev));

  const splitOpen = layout.tabs[1].length > 0;

  /** Per-conversation display fixtures. */
  const convFor = (id: string | null) => {
    if (id === "s-main") {
      return {
        messages: streaming ? streamingMessages : messages,
        isStreaming: streaming,
        streamingText: streaming ? liveText : "",
        cliStatus: "ready" as const,
      };
    }
    if (id === "s-db") {
      return {
        messages: splitMessages,
        isStreaming: true,
        streamingText:
          "Backfill running — 41,300 of 58,214 rows written, counts consistent so far.",
        cliStatus: "busy" as const,
      };
    }
    return { messages: [] as ChatMessage[], isStreaming: false, streamingText: "", cliStatus: "ready" as const };
  };

  const renderPane = (i: 0 | 1) => {
    const activeId = layout.active[i] ?? undefined;
    const conv = convFor(activeId ?? null);
    const focused = layout.focused === i;
    return (
      <ChatView
        paneIndex={i}
        paneFocused={focused}
        messages={conv.messages}
        mode="agent"
        model="claude-fable-5"
        effort="high"
        sessionId={activeId}
        activeTabId={activeId}
        sessions={sessions}
        openTabIds={layout.tabs[i]}
        tabNames={{ "s-main": "Agent tracker", "s-ui": "UI polish", "s-db": "DB migration" }}
        tabMarkers={markers}
        tabLastReply={lastReply}
        onToggleSplit={toggleSplit}
        splitActive={splitOpen}
        onMoveTab={moveTab}
        onCloseAllTabs={noop}
        marker={activeId ? markers[activeId] ?? null : null}
        markerBusy={activeId === "s-main" && markerBusy}
        onSetMarkerNote={activeId ? setNoteFor(activeId) : undefined}
        runningSessionIds={[...(streaming ? ["s-main"] : []), ...(splitOpen ? ["s-db"] : [])]}
        cliStatus={conv.cliStatus}
        pendingDiffs={i === 0 ? pendingDiffs : []}
        streamingText={conv.streamingText}
        isStreaming={conv.isStreaming}
        activities={[]}
        liveTimeline={conv.isStreaming && activeId === "s-main" ? [{ type: "text", text: liveText }] : []}
        runningTasks={focused ? runningTasks : []}
        onDismissTask={(id) => {
          console.log(`[harness] dismissTask ${id}`);
          setRunningTasks((ts) => ts.filter((t) => t.toolUseId !== id));
        }}
        thinkingTokens={0}
        transientStatus={null}
        cost={{ inputTokens: 48200, outputTokens: 12400, totalCostUsd: 0.4821 }}
        contextInfo={{
          inputTokens: 52000,
          outputTokens: 9000,
          cacheReadTokens: 40000,
          cacheCreationTokens: 2000,
          contextWindow: 200000,
          model: "claude-fable-5",
        }}
        accountEmail="vincent@jarvio.io"
        workspacePath="/Users/vincent/Documents/code/magify.fun/code/claude_luxure"
        onSend={(text) => {
          if (conv.isStreaming) {
            console.log(`[harness] queued: ${text}`);
            setQueued((q) => [...q, { id: `q${++queueIdRef.current}`, text }]);
          } else {
            console.log(`[harness] send: ${text}`);
          }
        }}
        queuedMessages={queued}
        onQueueEdit={(id, text) =>
          setQueued((q) => q.map((m) => (m.id === id ? { ...m, text } : m)))
        }
        onQueueRemove={(id) => setQueued((q) => q.filter((m) => m.id !== id))}
        onQueueSendNow={(id) => setQueued((q) => q.filter((m) => m.id !== id))}
        onCancel={noop}
        onEditMessage={(id, text, images) =>
          console.log(
            `[harness] editMessage id=${id} images=${images?.length ?? 0} text=${text.slice(0, 40)}`
          )
        }
        onModeChange={noop}
        onModelChange={noop}
        onEffortChange={noop}
        onNewConversation={noop}
        onNewWorktreeConversation={noop}
        onSwitchSession={(id) => selectTab(id, i)}
        onCloseTab={noop}
        onListSessions={noop}
        onAcceptChange={noop}
        onRejectChange={noop}
        onAcceptAll={noop}
        onRejectAll={noop}
      />
    );
  };

  return (
    <div className="flex-1 min-h-0 h-screen split-host">
      <div className={`split-panes h-full ${splitOpen ? "is-split" : ""}`}>
        <div
          className={`split-pane relative ${splitOpen && layout.focused !== 0 ? "pane-unfocused" : ""}`}
          onMouseDownCapture={() => splitOpen && layout.focused !== 0 && focusPane(0)}
        >
          {renderPane(0)}
        </div>
        {splitOpen && (
          <div
            className={`split-pane relative ${layout.focused !== 1 ? "pane-unfocused" : ""}`}
            onMouseDownCapture={() => layout.focused !== 1 && focusPane(1)}
          >
            {renderPane(1)}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  params.has("skills") ? <SkillsHarness /> : <ChatHarness />
);
