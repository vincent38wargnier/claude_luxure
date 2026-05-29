import { useRef, useEffect, useState, useCallback } from "react";
import type { ChatMessage, CostInfo, ContextInfo, SessionInfo, Mode, PendingDiff } from "../../types";
import MessageRow from "./MessageRow";
import ChatTextArea from "./ChatTextArea";
import TabBar from "./TabBar";
import DiffPanel from "../common/DiffPanel";

interface ChatViewProps {
  messages: ChatMessage[];
  mode: Mode;
  model?: string;
  sessionId?: string;
  sessions: SessionInfo[];
  cliStatus: string;
  pendingDiffs: PendingDiff[];
  streamingText: string;
  isStreaming: boolean;
  cost: CostInfo | null;
  contextInfo: ContextInfo | null;
  accountEmail?: string;
  accountOrg?: string;
  workspacePath?: string;
  externalFiles?: string[];
  onClearExternalFiles?: () => void;
  onSend: (text: string, images?: string[], mentions?: string[]) => void;
  onCancel: () => void;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onNewConversation: () => void;
  onSwitchSession: (sessionId: string) => void;
  onListSessions: () => void;
  onAcceptChange: (filePath: string) => void;
  onRejectChange: (filePath: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

export default function ChatView({
  messages,
  mode,
  model,
  sessionId,
  sessions,
  cliStatus,
  pendingDiffs,
  streamingText,
  isStreaming,
  cost,
  contextInfo,
  accountEmail,
  accountOrg,
  workspacePath,
  externalFiles,
  onClearExternalFiles,
  onSend,
  onCancel,
  onModeChange,
  onModelChange,
  onNewConversation,
  onSwitchSession,
  onListSessions,
  onAcceptChange,
  onRejectChange,
  onAcceptAll,
  onRejectAll,
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
        currentSessionId={sessionId}
        onSelect={onSwitchSession}
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
        cliStatus={cliStatus}
        isStreaming={isStreaming}
        fileCount={0}
        pendingDiffCount={pendingDiffs.length}
        contextInfo={contextInfo}
        accountEmail={accountEmail}
        accountOrg={accountOrg}
        workspacePath={workspacePath}
        externalFiles={externalFiles}
        onClearExternalFiles={onClearExternalFiles}
        onSend={onSend}
        onCancel={onCancel}
        onModeChange={onModeChange}
        onModelChange={onModelChange}
        onReview={handleReview}
      />
    </div>
  );
}
