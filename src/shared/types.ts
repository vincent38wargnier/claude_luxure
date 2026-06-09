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
}

export type ActivityEvent =
  | {
      type: "tool_use";
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId?: string;
      result?: ToolResultData;
    }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "thinking"; text: string }
  | { type: "thinking_delta"; text: string };

export const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4-20250514", alias: "sonnet", label: "Sonnet 4" },
  { id: "claude-opus-4-20250514", alias: "opus", label: "Opus 4" },
  { id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku 4.5" },
] as const;

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
  | { type: "sendMessage"; text: string; images?: string[]; mentions?: string[] }
  | { type: "editMessage"; messageId: string; text: string; images?: string[] }
  | { type: "switchFork"; anchorId: string; index: number }
  | { type: "cancelRequest" }
  | { type: "mode"; mode: Mode }
  | { type: "changeModel"; model: string }
  | { type: "changeEffort"; effort: EffortLevel }
  | { type: "newConversation" }
  | { type: "switchSession"; sessionId: string }
  | { type: "closeTab"; sessionId: string }
  | { type: "listSessions" }
  | { type: "acceptChange"; filePath: string }
  | { type: "rejectChange"; filePath: string }
  | { type: "acceptAllChanges" }
  | { type: "rejectAllChanges" }
  | { type: "searchFiles"; query: string }
  | { type: "openFile"; filePath: string }
  | { type: "openDiff"; filePath: string }
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
  | { type: "refreshUsage" }
  | { type: "summarizeSession"; sessionId: string }
  | { type: "summarizeAllSessions" };

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
  | { type: "error"; error: string }
  | { type: "fileSearchResults"; files: string[] }
  | { type: "diffUpdate"; filePath: string; diff: string; status: "pending" | "accepted" | "rejected" }
  | { type: "costUpdate"; cost: CostInfo }
  | { type: "contextUpdate"; context: ContextInfo }
  | { type: "activity"; activity: ActivityEvent }
  | { type: "accountInfo"; account: AccountInfo }
  | { type: "sessionList"; sessions: SessionInfo[] }
  | { type: "openTabs"; tabIds: string[]; names?: Record<string, string> }
  | { type: "cliStatus"; status: "starting" | "ready" | "busy" | "error" | "stopped" }
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
    }
  | {
      type: "summarizeStatus";
      sessionId: string;
      status: "pending" | "done" | "error";
      title?: string;
      summary?: string;
    }
  | { type: "summarizeProgress"; done: number; total: number };

export interface ExtensionState {
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  messages: ChatMessage[];
  cliStatus: "starting" | "ready" | "busy" | "error" | "stopped";
  pendingDiffs: { filePath: string; diff: string }[];
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
}
