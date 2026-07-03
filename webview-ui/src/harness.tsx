import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import ChatView from "./components/chat/ChatView";
import SkillsPanel from "./components/skills/SkillsPanel";
import type {
  ChatMessage,
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
];

const runningTasks: TaskActivity[] = [
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

/** Chat variant with a live post-it: clicking it simulates the extension's
 * re-pick round-trip (spinner ~1.2s, then a fresh emoji). */
function ChatHarness() {
  const newPostit = params.has("newpostit");
  const [markers, setMarkers] = useState<Record<string, SessionMarker>>({
    "s-main": newPostit
      ? { color: "#F5DE7A" }
      : { emoji: "🛰️", color: "#F5DE7A" },
    "s-ui": { emoji: "🎨", color: "#8FCFF0" },
  });
  const [markerBusy, setMarkerBusy] = useState(false);
  const reevaluate = () => {
    setMarkerBusy(true);
    setTimeout(() => {
      const pool = ["🧪", "🐛", "🚀", "🔍", "📊", "⚡", "🗄️"];
      setMarkers((m) => ({
        ...m,
        "s-main": {
          ...m["s-main"],
          emoji: pool[Math.floor(Math.random() * pool.length)],
        },
      }));
      setMarkerBusy(false);
    }, 1200);
  };

  return (
    <ChatView
      messages={streaming ? streamingMessages : messages}
      mode="agent"
      model="claude-fable-5"
      effort="high"
      sessionId="s-main"
      activeTabId="s-main"
      sessions={sessions}
      openTabIds={["s-main", "s-ui"]}
      tabNames={{ "s-main": "Agent tracker", "s-ui": "UI polish" }}
      tabMarkers={markers}
      marker={markers["s-main"]}
      markerBusy={markerBusy}
      onReevaluateMarker={reevaluate}
      runningSessionIds={["s-main"]}
      cliStatus="ready"
      pendingDiffs={[]}
      streamingText={streaming ? liveText : ""}
      isStreaming={streaming}
      activities={[]}
      liveTimeline={streaming ? [{ type: "text", text: liveText }] : []}
      runningTasks={runningTasks}
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
      onSend={noop}
      onCancel={noop}
      onModeChange={noop}
      onModelChange={noop}
      onEffortChange={noop}
      onNewConversation={noop}
      onNewWorktreeConversation={noop}
      onSwitchSession={noop}
      onCloseTab={noop}
      onListSessions={noop}
      onAcceptChange={noop}
      onRejectChange={noop}
      onAcceptAll={noop}
      onRejectAll={noop}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  params.has("skills") ? <SkillsHarness /> : <ChatHarness />
);
