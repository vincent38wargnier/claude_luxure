import { useRef, useEffect, useState, useCallback, Fragment } from "react";
import type { ChatMessage, CostInfo, ContextInfo, ActivityEvent, TimelinePart, SessionInfo, Mode, EffortLevel, PendingDiff, McpServerStatus } from "../../types";
import MessageRow from "./MessageRow";
import ChatTextArea from "./ChatTextArea";
import TabBar from "./TabBar";
import DiffPanel from "../common/DiffPanel";

interface ChatViewProps {
  messages: ChatMessage[];
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  activeTabId?: string;
  sessions: SessionInfo[];
  openTabIds: string[];
  tabNames?: Record<string, string>;
  runningSessionIds: string[];
  cliStatus: string;
  pendingDiffs: PendingDiff[];
  streamingText: string;
  isStreaming: boolean;
  activities: ActivityEvent[];
  liveTimeline: TimelinePart[];
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
  onOpenMcp?: () => void;
  onRestartMcp?: () => void;
  mcpServers?: McpServerStatus[];
  onEditMessage?: (messageId: string, text: string) => void;
  onSwitchFork?: (anchorId: string, index: number) => void;
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
  tabNames,
  runningSessionIds,
  cliStatus,
  pendingDiffs,
  streamingText,
  isStreaming,
  activities,
  liveTimeline,
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
  onOpenMcp,
  onRestartMcp,
  mcpServers,
  onEditMessage,
  onSwitchFork,
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevMsgCountRef = useRef(messages.length);
  const [showReview, setShowReview] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Considered "stuck" to the bottom when within ~80px of the end.
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const grew = messages.length > prevMsgCountRef.current;
    const lastMsg = messages[messages.length - 1];
    prevMsgCountRef.current = messages.length;

    // Jump down when the user just sent a message; otherwise only follow new
    // output if they're already near the bottom — don't yank them away from
    // something they scrolled up to read.
    if (grew && lastMsg?.role === "user") {
      stickToBottomRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingText]);

  // Switching conversations starts pinned to the latest message.
  useEffect(() => {
    stickToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [activeTabId]);

  const handleReview = useCallback(() => {
    setShowReview((prev) => !prev);
  }, []);

  const handleStartEdit = useCallback((messageId: string) => {
    if (!isStreaming) {
      setEditingMessageId(messageId);
    }
  }, [isStreaming]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleSubmitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingMessageId(null);
      onEditMessage?.(messageId, text);
    },
    [onEditMessage]
  );

  useEffect(() => {
    if (isStreaming) {
      setEditingMessageId(null);
    }
  }, [isStreaming]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <TabBar
        sessions={sessions}
        openTabIds={openTabIds}
        tabNames={tabNames}
        currentTabId={activeTabId || sessionId}
        runningSessionIds={runningSessionIds}
        onSelect={onSwitchSession}
        onClose={onCloseTab}
        onNewChat={onNewConversation}
        onListSessions={onListSessions}
      />

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2 space-y-1"
      >
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
            <Fragment key={msg.id}>
              <MessageRow
                message={msg}
                streamingContent={isLastAssistant ? streamingText : undefined}
                liveActivities={
                  isLastAssistant && activities.length > 0 ? activities : undefined
                }
                liveTimeline={isLastAssistant ? liveTimeline : undefined}
                isEditing={editingMessageId === msg.id}
                canEdit={msg.role === "user" && !isStreaming && !editingMessageId}
                mode={mode}
                model={model}
                onStartEdit={() => handleStartEdit(msg.id)}
                onSubmitEdit={(text) => handleSubmitEdit(msg.id, text)}
                onCancelEdit={handleCancelEdit}
                onModeChange={onModeChange}
                onModelChange={onModelChange}
                onSwitchFork={onSwitchFork}
              />
              {msg.compactBoundary && <SummaryDivider />}
            </Fragment>
          );
        })}

        {/* Fallback for sessions compacted before per-message anchoring existed. */}
        {contextSummarized &&
          !messages.some((m) => m.compactBoundary) &&
          !isStreaming &&
          messages.length > 0 && <SummaryDivider />}

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
        onOpenMcp={onOpenMcp}
        onRestartMcp={onRestartMcp}
        mcpServers={mcpServers}
      />
    </div>
  );
}

function SummaryDivider() {
  return (
    <div className="px-4 py-3 flex items-center gap-3 select-none">
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
      <span className="text-[11px] text-vscode-descriptionFg opacity-45 shrink-0">
        Context summarized
      </span>
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
    </div>
  );
}
