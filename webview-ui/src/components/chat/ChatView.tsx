import { useRef, useEffect, useState, useCallback } from "react";
import type { ChatMessage, CostInfo, ContextInfo, ActivityEvent, SessionInfo, Mode, EffortLevel, PendingDiff } from "../../types";
import MessageRow from "./MessageRow";
import ChatTextArea from "./ChatTextArea";
import TabBar from "./TabBar";
import DiffPanel from "../common/DiffPanel";

function formatToolActivity(activity: ActivityEvent): string {
  if (activity.type === "tool_use") {
    const name = activity.toolName;
    const input = activity.toolInput;
    if (name === "Read" || name === "read_file") return `Reading ${input.file_path || input.path || "file"}`;
    if (name === "Write" || name === "write_to_file" || name === "WriteToFile") return `Writing ${input.file_path || input.path || "file"}`;
    if (name === "Edit" || name === "edit_file" || name === "EditFile") return `Editing ${input.file_path || input.path || "file"}`;
    if (name === "Bash" || name === "bash") return `Running: ${String(input.command || "").slice(0, 60)}`;
    if (name === "Grep" || name === "grep") return `Searching for "${String(input.pattern || "").slice(0, 40)}"`;
    if (name === "Glob" || name === "glob") return `Finding files: ${input.pattern || input.glob_pattern || ""}`;
    if (name === "LS" || name === "ls") return `Listing ${input.path || input.directory || "."}`;
    if (name === "View") return `Viewing ${input.file_path || input.path || "file"}`;
    return `${name}`;
  }
  if (activity.type === "thinking" || activity.type === "thinking_delta") return "Thinking...";
  if (activity.type === "tool_result") return "Processing result...";
  return "";
}

function ActivityIndicator({ activities }: { activities: ActivityEvent[] }) {
  const last = activities[activities.length - 1];
  if (!last) return null;
  const label = formatToolActivity(last);
  if (!label) return null;

  return (
    <div className="px-4 py-2 flex items-center gap-2 text-[12px] text-vscode-descriptionFg animate-pulse">
      <div className="flex gap-0.5">
        <div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "0ms" }} />
        <div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "150ms" }} />
        <div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
      <span className="truncate opacity-70">{label}</span>
    </div>
  );
}

interface ChatViewProps {
  messages: ChatMessage[];
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  activeTabId?: string;
  sessions: SessionInfo[];
  openTabIds: string[];
  runningSessionIds: string[];
  cliStatus: string;
  pendingDiffs: PendingDiff[];
  streamingText: string;
  isStreaming: boolean;
  activities: ActivityEvent[];
  cost: CostInfo | null;
  contextInfo: ContextInfo | null;
  accountEmail?: string;
  accountOrg?: string;
  slashCommands?: string[];
  contextSummarized?: boolean;
  workspacePath?: string;
  externalFiles?: string[];
  onClearExternalFiles?: () => void;
  onSend: (text: string, images?: string[], mentions?: string[]) => void;
  onCancel: () => void;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onNewConversation: () => void;
  onSwitchSession: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onListSessions: () => void;
  onAcceptChange: (filePath: string) => void;
  onRejectChange: (filePath: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onOpenSkills?: () => void;
}

export default function ChatView({
  messages,
  mode,
  model,
  effort,
  sessionId,
  activeTabId,
  sessions,
  openTabIds,
  runningSessionIds,
  cliStatus,
  pendingDiffs,
  streamingText,
  isStreaming,
  activities,
  cost,
  contextInfo,
  accountEmail,
  accountOrg,
  slashCommands,
  contextSummarized,
  workspacePath,
  externalFiles,
  onClearExternalFiles,
  onSend,
  onCancel,
  onModeChange,
  onModelChange,
  onEffortChange,
  onNewConversation,
  onSwitchSession,
  onCloseTab,
  onListSessions,
  onAcceptChange,
  onRejectChange,
  onAcceptAll,
  onRejectAll,
  onOpenSkills,
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showReview, setShowReview] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const handleReview = useCallback(() => {
    setShowReview((prev) => !prev);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <TabBar
        sessions={sessions}
        openTabIds={openTabIds}
        currentTabId={activeTabId || sessionId}
        runningSessionIds={runningSessionIds}
        onSelect={onSwitchSession}
        onClose={onCloseTab}
        onNewChat={onNewConversation}
        onListSessions={onListSessions}
      />

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        {messages.length === 0 && !isStreaming && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3 opacity-40">
              <div className="text-3xl">✦</div>
              <p className="text-xs text-vscode-descriptionFg">
                Ask Claude anything...
              </p>
              <p className="text-[10px] text-vscode-descriptionFg">
                Drop files or type @ to add context
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isLastAssistant =
            msg.role === "assistant" &&
            i === messages.length - 1 &&
            isStreaming;

          return (
            <MessageRow
              key={msg.id}
              message={msg}
              streamingContent={isLastAssistant ? streamingText : undefined}
            />
          );
        })}

        {isStreaming && activities.length > 0 && !streamingText && (
          <ActivityIndicator activities={activities} />
        )}

        {contextSummarized && !isStreaming && messages.length > 0 && (
          <div className="px-4 py-3 flex items-center gap-3 select-none">
            <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
            <span className="text-[11px] text-vscode-descriptionFg opacity-45 shrink-0">
              Context summarized
            </span>
            <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Review panel (collapsible) */}
      {showReview && pendingDiffs.length > 0 && (
        <DiffPanel
          diffs={pendingDiffs}
          onAccept={onAcceptChange}
          onReject={onRejectChange}
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
        />
      )}

      {/* Cost bar */}
      {cost && (
        <div className="px-3 py-0.5 text-[10px] text-vscode-descriptionFg border-t border-[rgba(255,255,255,0.04)] flex items-center gap-3">
          <span>${cost.totalCostUsd.toFixed(4)}</span>
          <span className="opacity-50">↑{cost.inputTokens.toLocaleString()}</span>
          <span className="opacity-50">↓{cost.outputTokens.toLocaleString()}</span>
        </div>
      )}

      {/* Input area */}
      <ChatTextArea
        mode={mode}
        model={model}
        effort={effort}
        cliStatus={cliStatus}
        isStreaming={isStreaming}
        fileCount={0}
        pendingDiffCount={pendingDiffs.length}
        contextInfo={contextInfo}
        accountEmail={accountEmail}
        accountOrg={accountOrg}
        slashCommands={slashCommands}
        workspacePath={workspacePath}
        externalFiles={externalFiles}
        onClearExternalFiles={onClearExternalFiles}
        onSend={onSend}
        onCancel={onCancel}
        onModeChange={onModeChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        onReview={handleReview}
        onOpenSkills={onOpenSkills}
      />
    </div>
  );
}
