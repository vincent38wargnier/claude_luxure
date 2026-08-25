import { useRef, useEffect, useState, useCallback, Fragment } from "react";
import { useRenderPerf } from "../../perf";
import type { ChatMessage, CostInfo, ContextInfo, ActivityEvent, TaskActivity, TimelinePart, SessionInfo, SessionMarker, Mode, EffortLevel, PendingDiff, McpServerStatus, StoredAccount, UsageInfo, QueuedMessage } from "../../types";
import MessageRow from "./MessageRow";
import ChatTextArea from "./ChatTextArea";
import TabBar from "./TabBar";
import SessionPostIt from "./SessionPostIt";
import MarkerNoteModal from "./MarkerNoteModal";
import QueuedMessages from "./QueuedMessages";
import DiffPanel from "../common/DiffPanel";
import WorkingDots from "../common/WorkingDots";

/** "92s" / "1m32s" for the dock chips' elapsed counters. */
function fmtElapsed(ms?: number): string | null {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Scroll the transcript to an agent's card and pulse a ring on it, so the
 * dock chip answers "which card is this?" without visual matching. */
function jumpToTask(toolUseId: string) {
  const el = document.getElementById(`task-${toolUseId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash-ring");
  // Force a reflow so re-adding the class restarts the animation.
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash-ring");
}

interface ChatViewProps {
  messages: ChatMessage[];
  /** How many older messages the host withheld (display window) — renders the
   * "Show earlier messages" pill at the top of the transcript. */
  historyTruncated?: number;
  onLoadEarlier?: () => void;
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  activeTabId?: string;
  sessions: SessionInfo[];
  openTabIds: string[];
  tabNames?: Record<string, string>;
  /** Post-it identity per open tab — the emoji rides along in the tab strip. */
  tabMarkers?: Record<string, SessionMarker>;
  /** Epoch ms of each tab's last completed reply — drives the idle counters. */
  tabLastReply?: Record<string, number>;
  /** Which editor-group this instance renders (0 = left/top). */
  paneIndex?: number;
  /** True when this pane owns the real-time stream (focus follows clicks). */
  paneFocused?: boolean;
  /** Open/close the second pane. */
  onToggleSplit?: () => void;
  splitActive?: boolean;
  /** Drag & drop a tab: reorder within a strip or move it to the other pane. */
  onMoveTab?: (tabId: string, targetPane: number, index: number) => void;
  onCloseAllTabs?: () => void;
  /** The active conversation's post-it (pinned top-right of the transcript). */
  marker?: SessionMarker | null;
  /** True while an emoji pick for the active conversation is in flight. */
  markerBusy?: boolean;
  /** Post-it clicked: re-pick the emoji from recent conversation context. */
  onSetMarkerNote?: (note: string) => void;
  runningSessionIds: string[];
  cliStatus: string;
  pendingDiffs: PendingDiff[];
  streamingText: string;
  isStreaming: boolean;
  activities: ActivityEvent[];
  liveTimeline: TimelinePart[];
  /** Agents still working (live turn or background) — drives the status strip. */
  runningTasks?: TaskActivity[];
  onDismissTask?: (toolUseId: string) => void;
  /** Live thinking-token estimate for the streaming turn (0 when idle). */
  thinkingTokens?: number;
  /** API retry / rate-limit chip; null when all is well. */
  transientStatus?: { kind: string; text: string } | null;
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
  onNewWorktreeConversation: () => void;
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
  accounts?: StoredAccount[];
  activeAccountId?: string;
  usage?: UsageInfo | null;
  usageByAccount?: Record<string, UsageInfo | null>;
  disconnectedAccounts?: Record<string, boolean>;
  loggedOutAccounts?: Record<string, boolean>;
  onSwitchAccount?: (accountId: string) => void;
  onAddAccount?: () => void;
  onRemoveAccount?: (accountId: string) => void;
  onReauthAccount?: (accountId: string) => void;
  onLogoutAccount?: (accountId: string) => void;
  summarizingIds?: string[];
  summarizeProgress?: { done: number; total: number } | null;
  onSummarizeSession?: (sessionId: string) => void;
  onSummarizeAll?: () => void;
  queuedMessages?: QueuedMessage[];
  onQueueEdit?: (id: string, text: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueSendNow?: (id: string) => void;
  onForceNext?: () => void;
  onEditMessage?: (messageId: string, text: string, images?: string[]) => void;
  onSwitchFork?: (anchorId: string, index: number) => void;
}

export default function ChatView({
  messages,
  historyTruncated,
  onLoadEarlier,
  mode,
  model,
  effort,
  sessionId,
  activeTabId,
  sessions,
  openTabIds,
  tabNames,
  tabMarkers,
  tabLastReply,
  paneIndex,
  paneFocused,
  onToggleSplit,
  splitActive,
  onMoveTab,
  onCloseAllTabs,
  marker,
  markerBusy,
  onSetMarkerNote,
  runningSessionIds,
  cliStatus,
  pendingDiffs,
  streamingText,
  isStreaming,
  activities,
  liveTimeline,
  runningTasks,
  onDismissTask,
  thinkingTokens,
  transientStatus,
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
  onNewWorktreeConversation,
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
  accounts,
  activeAccountId,
  usage,
  usageByAccount,
  disconnectedAccounts,
  loggedOutAccounts,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onReauthAccount,
  onLogoutAccount,
  summarizingIds,
  summarizeProgress,
  onSummarizeSession,
  onSummarizeAll,
  queuedMessages,
  onQueueEdit,
  onQueueRemove,
  onQueueSendNow,
  onForceNext,
  onEditMessage,
  onSwitchFork,
}: ChatViewProps) {
  // Lag diagnostics: flags expensive transcript re-renders (React commit time).
  useRenderPerf("ChatView", { msgs: messages.length, pane: paneIndex });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevMsgCountRef = useRef(messages.length);
  const [showReview, setShowReview] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [noteModalOpen, setNoteModalOpen] = useState(false);

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

  // Switching conversations starts pinned to the latest message; an open
  // note editor or message editor belongs to the previous conversation.
  useEffect(() => {
    stickToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    setNoteModalOpen(false);
    setEditingMessageId(null);
  }, [activeTabId]);

  // Self-heal an orphaned editor: if the message being edited vanished from
  // the list (fork rewind, stop, reload), the editor renders nowhere while
  // editingMessageId keeps every other bubble's edit permanently disabled.
  useEffect(() => {
    if (editingMessageId && !messages.some((m) => m.id === editingMessageId)) {
      setEditingMessageId(null);
    }
  }, [messages, editingMessageId]);

  const handleReview = useCallback(() => {
    setShowReview((prev) => !prev);
  }, []);

  // Editing is allowed even while a turn is streaming: submitting the edit
  // stops the current run and resends from that message (the provider's
  // handleEditMessage already stops the bridge before forking).
  const handleStartEdit = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleSubmitEdit = useCallback(
    (messageId: string, text: string, images?: string[]) => {
      setEditingMessageId(null);
      onEditMessage?.(messageId, text, images);
    },
    [onEditMessage]
  );



  return (
    // data-pane-root scopes the Lightbox's gallery collection to this
    // instance's transcript (each split pane is its own gallery).
    <div className="flex flex-col h-full" data-pane-root="">
      {/* Tab bar */}
      <TabBar
        sessions={sessions}
        openTabIds={openTabIds}
        tabNames={tabNames}
        tabMarkers={tabMarkers}
        tabLastReply={tabLastReply}
        currentTabId={activeTabId || sessionId}
        runningSessionIds={runningSessionIds}
        onSelect={onSwitchSession}
        onClose={onCloseTab}
        onNewChat={onNewConversation}
        onNewWorktree={onNewWorktreeConversation}
        onToggleSplit={onToggleSplit}
        splitActive={splitActive}
        paneIndex={paneIndex}
        paneFocused={paneFocused}
        onMoveTab={onMoveTab}
        onCloseAll={onCloseAllTabs}
        onListSessions={onListSessions}
        summarizingIds={summarizingIds}
        summarizeProgress={summarizeProgress}
        onSummarizeSession={onSummarizeSession}
        onSummarizeAll={onSummarizeAll}
      />

      {/* Messages area — relative wrapper so the conversation's post-it can
          pin to the top-right corner, above the scrolling transcript. */}
      <div className="relative flex-1 min-h-0">
        {marker && (
          <SessionPostIt
            tabKey={activeTabId || sessionId || "chat"}
            marker={marker}
            busy={markerBusy}
            onEditNote={
              onSetMarkerNote ? () => setNoteModalOpen(true) : undefined
            }
          />
        )}
        {noteModalOpen && marker && (
          <MarkerNoteModal
            color={marker.color}
            initialNote={marker.note ?? ""}
            emoji={marker.emoji}
            onSave={(note) => onSetMarkerNote?.(note)}
            onClose={() => setNoteModalOpen(false)}
          />
        )}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="chat-scroll h-full overflow-y-auto py-2 space-y-1"
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

        {!!historyTruncated && historyTruncated > 0 && (
          <div className="flex justify-center py-1">
            <button
              onClick={onLoadEarlier}
              className="text-[10px] px-2.5 py-1 rounded-full border border-vscode-border text-vscode-descriptionFg bg-vscode-bg hover:text-vscode-fg transition-colors"
              title="Older messages are kept out of the panel to keep it fast — click to page them in"
            >
              ↑ Show earlier messages ({historyTruncated} hidden)
            </button>
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
                canEdit={msg.role === "user" && !editingMessageId}
                editWillStopRun={isStreaming}
                mode={mode}
                model={model}
                workspacePath={workspacePath}
                externalFiles={
                  editingMessageId === msg.id ? externalFiles : undefined
                }
                onClearExternalFiles={
                  editingMessageId === msg.id ? onClearExternalFiles : undefined
                }
                onStartEdit={() => handleStartEdit(msg.id)}
                onSubmitEdit={(text, images) =>
                  handleSubmitEdit(msg.id, text, images)
                }
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
      </div>

      {/* Review panel (collapsible) */}
      {showReview && pendingDiffs.length > 0 && (
        <DiffPanel
          diffs={pendingDiffs}
          workspacePath={workspacePath}
          onAccept={onAcceptChange}
          onReject={onRejectChange}
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
        />
      )}

      {/* Cost bar */}
      {cost && (
        <div
          className="px-3 py-0.5 text-[10px] text-vscode-descriptionFg border-t border-[rgba(255,255,255,0.04)] flex items-center gap-3"
          title={`Session cost $${cost.totalCostUsd.toFixed(4)} · ${cost.inputTokens.toLocaleString()} tokens in · ${cost.outputTokens.toLocaleString()} tokens out`}
        >
          <span>${cost.totalCostUsd.toFixed(2)}</span>
          <span>↑{cost.inputTokens.toLocaleString()}</span>
          <span>↓{cost.outputTokens.toLocaleString()}</span>
        </div>
      )}

      {/* Live status strip: the agent dock (one clickable chip per working
          agent — click scrolls to its card), retry/limit chip, thinking
          ticker. Survives the turn ending, for background agents. */}
      {(transientStatus ||
        (runningTasks && runningTasks.length > 0) ||
        (isStreaming && (thinkingTokens ?? 0) > 0)) && (
        <div className="px-2 pt-1 space-y-1" role="status" aria-live="polite">
          {transientStatus && (
            <div className="flex items-center gap-2 text-[11px] rounded-md border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.08)] px-2.5 py-1.5 text-[#f59e0b]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse shrink-0" />
              <span className="truncate">{transientStatus.text}</span>
            </div>
          )}
          {runningTasks && runningTasks.length > 0 && (
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] rounded-md border border-[rgba(139,92,246,0.35)] bg-[rgba(139,92,246,0.07)] px-2.5 py-1.5">
              <WorkingDots color="#a78bfa" />
              <span className="text-[#a78bfa] shrink-0">
                {runningTasks.length} agent{runningTasks.length === 1 ? "" : "s"} working
              </span>
              {runningTasks.map((t) => {
                const label =
                  t.progressSummary || t.description || t.subagentType || "agent";
                const elapsed = fmtElapsed(t.durationMs);
                return (
                  <span
                    key={t.toolUseId}
                    className="group/chip flex items-center min-w-0 max-w-[240px] rounded border border-[rgba(139,92,246,0.35)] text-vscode-descriptionFg hover:bg-[rgba(139,92,246,0.15)] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => jumpToTask(t.toolUseId)}
                      title={`${t.subagentType || "agent"} — ${label}. Click to show its card.`}
                      className="flex items-center gap-1 min-w-0 px-1.5 py-0.5 hover:text-vscode-fg transition-colors"
                    >
                      <span className="truncate">{label}</span>
                      {elapsed && (
                        <span className="shrink-0 tabular-nums text-[10px] opacity-70">
                          {elapsed}
                        </span>
                      )}
                    </button>
                    {onDismissTask && (
                      <button
                        type="button"
                        onClick={() => onDismissTask(t.toolUseId)}
                        aria-label="Dismiss this agent from the strip"
                        title="Dismiss — stop tracking this agent (a late result still lands on its card)"
                        className="shrink-0 px-1 py-0.5 opacity-0 group-hover/chip:opacity-70 focus-visible:opacity-70 hover:!opacity-100 hover:text-[#f87171] transition-opacity"
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          {isStreaming && (thinkingTokens ?? 0) > 0 && (!runningTasks || runningTasks.length === 0) && (
            <div className="flex items-center gap-2 text-[11px] px-2.5 py-0.5 text-vscode-descriptionFg">
              <span className="italic">
                Thinking… ~{(thinkingTokens ?? 0) >= 1000 ? `${((thinkingTokens ?? 0) / 1000).toFixed(1)}k` : thinkingTokens} tokens
              </span>
            </div>
          )}
        </div>
      )}

      {/* Queued follow-ups (Cursor-style) */}
      <QueuedMessages
        items={queuedMessages ?? []}
        onEdit={onQueueEdit ?? (() => {})}
        onRemove={onQueueRemove ?? (() => {})}
        onSendNow={onQueueSendNow ?? (() => {})}
      />

      {/* Input area */}
      <ChatTextArea
        mode={mode}
        model={model}
        effort={effort}
        cliStatus={cliStatus}
        isStreaming={isStreaming}
        activeTabId={activeTabId}
        queueCount={queuedMessages?.length ?? 0}
        onForceNext={onForceNext}
        fileCount={0}
        pendingDiffCount={pendingDiffs.length}
        contextInfo={contextInfo}
        accountEmail={accountEmail}
        accountOrg={accountOrg}
        slashCommands={slashCommands}
        workspacePath={workspacePath}
        externalFiles={editingMessageId ? undefined : externalFiles}
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
        accounts={accounts}
        activeAccountId={activeAccountId}
        usage={usage}
        usageByAccount={usageByAccount}
        disconnectedAccounts={disconnectedAccounts}
        loggedOutAccounts={loggedOutAccounts}
        onSwitchAccount={onSwitchAccount}
        onAddAccount={onAddAccount}
        onRemoveAccount={onRemoveAccount}
        onReauthAccount={onReauthAccount}
        onLogoutAccount={onLogoutAccount}
      />
    </div>
  );
}

function SummaryDivider() {
  return (
    <div className="px-4 py-3 flex items-center gap-3 select-none">
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
      <span className="text-[11px] text-vscode-descriptionFg shrink-0">
        Context summarized
      </span>
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
    </div>
  );
}
