export type Mode = "agent" | "plan";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
  timestamp: number;
  isStreaming?: boolean;
  diff?: DiffInfo;
  cost?: CostInfo;
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

export const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4-20250514", alias: "sonnet", label: "Sonnet 4" },
  { id: "claude-opus-4-20250514", alias: "opus", label: "Opus 4" },
  { id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku 4.5" },
] as const;

export interface PendingDiff {
  filePath: string;
  diff: string;
}

export interface ExtensionState {
  mode: Mode;
  model?: string;
  messages: ChatMessage[];
  cliStatus: "starting" | "ready" | "busy" | "error" | "stopped";
  pendingDiffs: PendingDiff[];
  sessionId?: string;
  workspacePath?: string;
  accountEmail?: string;
  accountOrg?: string;
}

export interface SessionInfo {
  id: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
  modifiedAt: number;
}

export type WebviewMessage =
  | { type: "sendMessage"; text: string; images?: string[]; mentions?: string[] }
  | { type: "cancelRequest" }
  | { type: "mode"; mode: Mode }
  | { type: "changeModel"; model: string }
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
  | { type: "ready" };

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
  | { type: "accountInfo"; account: AccountInfo }
  | { type: "sessionList"; sessions: SessionInfo[] }
  | { type: "openTabs"; tabIds: string[] }
  | { type: "cliStatus"; status: ExtensionState["cliStatus"] };
