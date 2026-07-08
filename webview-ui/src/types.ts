export type Mode = "agent" | "plan";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: { id: EffortLevel; label: string; short: string }[] = [
  { id: "low", label: "Low", short: "Lo" },
  { id: "medium", label: "Medium", short: "Med" },
  { id: "high", label: "High", short: "Hi" },
  { id: "xhigh", label: "Extra High", short: "XHi" },
  { id: "max", label: "Max", short: "Max" },
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
  timestamp: number;
  isStreaming?: boolean;
  diff?: DiffInfo;
  cost?: CostInfo;
  activities?: ActivityEvent[];
  /** Ordered interleaving of prose and activity for an assistant turn, so file
   * edits / tool steps render where they happened relative to the text rather
   * than lumped above it. Absent on older messages (fall back to activities). */
  timeline?: TimelinePart[];
  forkInfo?: ForkInfo;
  /** Marks the message after which the context was summarized (/compact or
   * auto-compaction). Anchors the "Context summarized" divider in the chat. */
  compactBoundary?: boolean;
  /** On a system error message that was an auth failure (401), the account that
   * failed — renders an inline "Reconnect" button that re-runs its login. */
  authErrorAccountId?: string;
  authErrorAccountLabel?: string;
  /** Facts about the finished turn (set on finalize) — drives the quiet
   * "Done · 4m12s · …" settle line that anchors the end of a turn. */
  turnStats?: TurnStats;
}

/** Summary of a completed assistant turn. Counts are derived from the
 * timeline at render time; only what the webview can't compute lives here. */
export interface TurnStats {
  durationMs?: number;
}

/** One segment of an assistant turn's timeline: either a run of prose, or a
 * contiguous run of activity (tool calls / thinking) between prose segments. */
export type TimelinePart =
  | { type: "text"; text: string }
  | { type: "activities"; activities: ActivityEvent[] };

/** Marks a user message that is a fork point with multiple edited versions. */
export interface ForkInfo {
  anchorId: string;
  index: number;
  total: number;
}

export interface DiffInfo {
  filePath: string;
  hunks: string;
  status: "pending" | "accepted" | "rejected";
}

export interface CostInfo {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

export interface ContextInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  model: string;
}

export interface AccountInfo {
  email: string;
  orgName?: string;
  subscriptionType?: string;
}

/** An account selectable in the composer switcher. The "default" account uses
 * the ambient keychain login; others have their own isolated CLAUDE_CONFIG_DIR
 * (a full `auth login`, full scope), so both chat AND usage % work per-account
 * and they can run in parallel. */
export interface StoredAccount {
  id: string;
  label: string;
  email?: string;
  subscriptionType?: string;
  isDefault: boolean;
  /** Isolated config dir for a non-default account (undefined for Default). */
  configDir?: string;
}

/** One rate-limit bucket from GET /api/oauth/usage. */
export interface UsageBucket {
  utilization: number; // 0-100
  resetsAt: string; // ISO timestamp
}

/** Subscription usage for the active conversation's account. */
export interface UsageInfo {
  fiveHour?: UsageBucket | null;
  sevenDay?: UsageBucket | null;
  sevenDaySonnet?: UsageBucket | null;
  sevenDayOpus?: UsageBucket | null;
}

export interface ToolResultData {
  content: string;
  isError?: boolean;
  /** Images carried by the tool result (e.g. a browser screenshot), as data
   * URLs, so the card can render the actual pixels instead of an
   * "[image: image/png]" marker. */
  images?: string[];
}

/** One drawing instruction for annotate_screenshot, rendered onto the image by
 * the webview canvas. Coordinates are pixels by default; `unit: "percent"`
 * makes every coordinate/size a 0-100 fraction of the image dimensions. */
export interface ProofAnnotation {
  kind: "rect" | "ellipse" | "highlight" | "arrow" | "text" | "badge";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Label drawn near the shape; the content for kind "text" / "badge". */
  text?: string;
  /** CSS color; defaults to red (#FF3B30). */
  color?: string;
  unit?: "px" | "percent";
}

export type ActivityEvent =
  | {
      type: "tool_use";
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId?: string;
      result?: ToolResultData;
      /** Set when this call was made by a subagent: the tool_use id of the
       * Agent call that spawned it — used to nest it under that task card. */
      parentToolUseId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
      images?: string[];
      parentToolUseId?: string;
    }
  | { type: "thinking"; text: string; parentToolUseId?: string }
  | { type: "thinking_delta"; text: string; parentToolUseId?: string }
  /** A screenshot/image Claude explicitly presented to the user (via the
   * extension's luxure MCP tools) — rendered as a prominent image card. */
  | { type: "proof"; images: string[]; caption?: string }
  /** A subagent run spawned via the Agent tool — a live card updated in place
   * from the CLI's system:task_started/task_progress/task_updated/
   * task_notification events. The agent's own tool calls (tagged with
   * parentToolUseId) nest under it as `children`. */
  | {
      type: "task";
      /** tool_use id of the spawning Agent call — the join key for progress
       * events, child activities and the final tool_result. */
      toolUseId: string;
      /** CLI-assigned task id (from system:task_started). */
      taskId?: string;
      subagentType?: string;
      description?: string;
      prompt?: string;
      /** Launched with run_in_background: keeps running after the parent turn
       * ends; a task-notification later resumes the model automatically. */
      background?: boolean;
      status: "running" | "completed" | "failed";
      /** One-line live summary from the latest task_progress event. */
      progressSummary?: string;
      lastToolName?: string;
      toolUses?: number;
      totalTokens?: number;
      durationMs?: number;
      /** The agent's own activity, nested under the card (capped). */
      children?: ActivityEvent[];
      result?: ToolResultData;
    };

export type TaskActivity = Extract<ActivityEvent, { type: "task" }>;

export const AVAILABLE_MODELS = [
  { id: "claude-fable-5", alias: "fable", label: "Fable 5" },
  { id: "claude-sonnet-4-20250514", alias: "sonnet", label: "Sonnet 4" },
  { id: "claude-opus-4-20250514", alias: "opus", label: "Opus 4" },
  { id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku 4.5" },
] as const;

export interface PendingDiff {
  filePath: string;
  diff: string;
}

/** Visual identity mark for a conversation: a post-it color assigned when the
 * tab is created plus an emoji picked by a Haiku one-shot from the content.
 * Clicking the post-it opens a small editor for a user note; when a note is
 * set the sticky shows the note instead of the emoji. */
export interface SessionMarker {
  emoji?: string;
  color: string;
  /** User-typed note shown on the sticky in place of the emoji when set. */
  note?: string;
}

export interface ExtensionState {
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  messages: ChatMessage[];
  cliStatus: "starting" | "ready" | "busy" | "error" | "stopped";
  pendingDiffs: PendingDiff[];
  sessionId?: string;
  activeTabId?: string;
  isStreaming?: boolean;
  streamingText?: string;
  runningSessionIds?: string[];
  cost?: CostInfo;
  contextInfo?: ContextInfo;
  workspacePath?: string;
  accountEmail?: string;
  accountOrg?: string;
  slashCommands?: string[];
  contextSummarized?: boolean;
  accounts?: StoredAccount[];
  activeAccountId?: string;
  usage?: UsageInfo | null;
  /** Live buffers of the in-flight turn (ordered timeline + raw activities),
   * so switching back to a running conversation restores the streamed feed
   * instead of losing it until the turn finalizes. */
  liveTimeline?: TimelinePart[];
  liveActivities?: ActivityEvent[];
  /** The active conversation's post-it (color + picked emoji). */
  marker?: SessionMarker;
}

export interface SessionInfo {
  id: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
  modifiedAt: number;
  /** Claude-generated short title (replaces the raw first-message slice in the
   * list when present). Produced on demand via the summarize action. */
  title?: string;
  /** Claude-generated 1-2 sentence summary, shown on hover. */
  summary?: string;
}

/** A follow-up message the user queued while Claude was busy. Lives only in the
 * webview (transient); drained into a real sendMessage when the turn finishes. */
export interface QueuedMessage {
  id: string;
  text: string;
  images?: string[];
  mentions?: string[];
}

export type SkillScope = "global" | "project";

export interface SkillInfo {
  id: string;
  scope: SkillScope;
  command: string;
  name: string;
  description?: string;
  path: string;
}

export type WebviewMessage =
  | { type: "sendMessage"; text: string; images?: string[]; mentions?: string[]; tabId?: string }
  | { type: "editMessage"; messageId: string; text: string; images?: string[] }
  | { type: "switchFork"; anchorId: string; index: number }
  | { type: "cancelRequest" }
  | { type: "mode"; mode: Mode }
  | { type: "changeModel"; model: string }
  | { type: "changeEffort"; effort: EffortLevel }
  | { type: "newConversation" }
  | { type: "newWorktreeConversation" }
  | { type: "switchSession"; sessionId: string; pane?: number }
  | { type: "closeTab"; sessionId: string }
  /** Close every open tab except conversations with a turn still running. */
  | { type: "closeAllTabs" }
  /** Open/close the second pane (a full side-by-side instance). */
  | { type: "toggleSplit" }
  /** The user started interacting with this pane — route real-time streaming
   * (and the composer) to its conversation. */
  | { type: "focusPane"; pane: number }
  /** Drag & drop: reorder a tab within a strip or move it to the other pane,
   * inserting at `index`. */
  | { type: "moveTab"; tabId: string; pane: number; index: number }
  | { type: "listSessions" }
  | { type: "acceptChange"; filePath: string }
  | { type: "rejectChange"; filePath: string }
  | { type: "acceptAllChanges" }
  | { type: "rejectAllChanges" }
  | { type: "searchFiles"; query: string }
  | {
      // Files dragged in from outside VS Code: the webview only gets blob
      // content (no filesystem path), so the host writes temp copies and
      // answers with `addFile` mentions pointing at them.
      type: "saveDroppedFiles";
      files: { name: string; dataBase64: string }[];
    }
  | { type: "openFile"; filePath: string }
  | { type: "openDiff"; filePath: string }
  | { type: "openExternal"; url: string }
  | { type: "ready" }
  | { type: "listSkills" }
  | { type: "readSkill"; skillId: string }
  | { type: "saveSkill"; skillId: string; content: string }
  | { type: "createSkill"; scope: SkillScope; name: string }
  | { type: "deleteSkill"; skillId: string }
  | { type: "openMcpConfig" }
  | { type: "restartMcp" }
  | { type: "switchAccount"; accountId: string }
  | { type: "addAccount" }
  | { type: "removeAccount"; accountId: string }
  | { type: "reauthAccount"; accountId: string }
  | { type: "refreshUsage" }
  | { type: "summarizeSession"; sessionId: string }
  | { type: "summarizeAllSessions" }
  /** Post-it clicked: re-pick the active conversation's emoji from recent context. */
  | { type: "setMarkerNote"; note: string }
  | { type: "dismissTask"; toolUseId: string }
  /** Reply to an "annotateImage" render request: the burned-in PNG (data URL)
   * or the reason rendering failed. */
  | { type: "annotateResult"; requestId: string; dataUrl?: string; error?: string };

export type McpConnectionState = "connecting" | "connected" | "stopped" | "error";

/** Overall connection status of one configured MCP server. `connection` is
 * derived from the live Claude session's lifecycle (a running session connects
 * every server in `.mcp.json`) — intentionally tool-agnostic, with no per-tool
 * credential/token checks. */
export interface McpServerStatus {
  name: string;
  connection: McpConnectionState;
}

export type ExtensionMessage =
  | { type: "state"; state: ExtensionState }
  | { type: "mcpStatus"; servers: McpServerStatus[] }
  | { type: "streamToken"; text: string }
  | { type: "streamEnd" }
  | { type: "message"; message: ChatMessage }
  | {
      type: "error";
      error: string;
      /** Set when `error` is an auth failure (401) — the account whose token
       * couldn't authenticate, so the webview can render an inline "Reconnect"
       * button that re-runs the login for it. */
      authErrorAccountId?: string;
      authErrorAccountLabel?: string;
    }
  | { type: "fileSearchResults"; files: string[] }
  | { type: "addFile"; filePath: string }
  | { type: "diffUpdate"; filePath: string; diff: string; status: "pending" | "accepted" | "rejected" }
  | { type: "costUpdate"; cost: CostInfo }
  | { type: "contextUpdate"; context: ContextInfo }
  | { type: "activity"; activity: ActivityEvent }
  /** In-place update of a task card (matched by task.toolUseId). When messageId
   * is set the task lives in that finalized message's timeline — background
   * agents keep reporting after their parent turn already ended. */
  | { type: "taskUpdate"; task: TaskActivity; messageId?: string }
  /** Live thinking-token counter for the streaming turn (system:thinking_tokens). */
  | { type: "thinkingTokens"; tokens: number }
  /** Transient status chip above the composer (API retry / rate limit); null clears. */
  | {
      type: "transientStatus";
      status: { kind: "retry" | "rate-limit"; text: string } | null;
    }
  | { type: "accountInfo"; account: AccountInfo }
  | { type: "sessionList"; sessions: SessionInfo[] }
  | {
      type: "openTabs";
      tabIds: string[];
      names?: Record<string, string>;
      /** Post-it identity per tab (emoji shows in the tab strip). */
      markers?: Record<string, SessionMarker>;
      /** Epoch ms of each tab's last completed reply — feeds the idle-time
       * counter that flags conversations left waiting for a follow-up. */
      lastReplyAt?: Record<string, number>;
      /** Editor-group layout: which tabs live in which pane and what each pane
       * shows. Pane 1 empty ⇔ split closed. */
      panes?: { tabIds: string[]; activeId: string | null }[];
      focusedPane?: number;
    }
  /** In-place update of one conversation's post-it (emoji picked / picking). */
  | { type: "markerUpdate"; key: string; marker: SessionMarker; busy?: boolean }
  /** Full display state of the UNFOCUSED pane's conversation (the focused
   * pane rides the real-time "state" + stream events). state undefined ⇒ the
   * split closed. Re-pushed while that conversation streams. */
  | { type: "paneState"; pane: number; state?: ExtensionState }
  | { type: "cliStatus"; status: ExtensionState["cliStatus"] }
  | { type: "slashCommands"; commands: string[] }
  | { type: "skillsList"; skills: SkillInfo[] }
  | { type: "skillContent"; skillId: string; content: string }
  | { type: "skillsError"; error: string }
  | { type: "skillsSaved"; skillId: string }
  | { type: "accountsList"; accounts: StoredAccount[]; activeAccountId: string }
  | { type: "usageUpdate"; usage: UsageInfo | null }
  | {
      type: "usageByAccount";
      usageByAccount: Record<string, UsageInfo | null>;
      /** Account ids whose stored login can no longer authenticate and can't
       * self-heal (expired token, no refresh token) → show a Reconnect button. */
      disconnected?: Record<string, boolean>;
    }
  | {
      type: "summarizeStatus";
      sessionId: string;
      status: "pending" | "done" | "error";
      title?: string;
      summary?: string;
    }
  | { type: "summarizeProgress"; done: number; total: number }
  /** Ask the webview to burn annotations into an image on a canvas and answer
   * with "annotateResult". */
  | {
      type: "annotateImage";
      requestId: string;
      image: string;
      annotations: ProofAnnotation[];
    };
