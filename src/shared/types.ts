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
  forkInfo?: ForkInfo;
}

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

export type ActivityEvent =
  | { type: "tool_use"; toolName: string; toolInput: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string }
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
  | { type: "deleteSkill"; skillId: string };

export type ExtensionMessage =
  | { type: "state"; state: ExtensionState }
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
  | { type: "openTabs"; tabIds: string[] }
  | { type: "cliStatus"; status: "starting" | "ready" | "busy" | "error" | "stopped" }
  | { type: "slashCommands"; commands: string[] }
  | { type: "skillsList"; skills: SkillInfo[] }
  | { type: "skillContent"; skillId: string; content: string }
  | { type: "skillsError"; error: string }
  | { type: "skillsSaved"; skillId: string };

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
}
