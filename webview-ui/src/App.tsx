import { useState, useEffect, useCallback, useRef } from "react";
import vscode from "./vscode";
import ChatView from "./components/chat/ChatView";
import { coalesceActivities } from "./components/chat/ActivityFeed";
import SkillsPanel from "./components/skills/SkillsPanel";
import type {
  ExtensionState,
  ExtensionMessage,
  ActivityEvent,
  TimelinePart,
  SessionInfo,
  Mode,
  EffortLevel,
  SkillInfo,
  SkillScope,
  McpServerStatus,
  StoredAccount,
  UsageInfo,
  QueuedMessage,
} from "./types";

const initialState: ExtensionState = {
  mode: "agent",
  messages: [],
  cliStatus: "stopped",
  pendingDiffs: [],
  isStreaming: false,
  streamingText: "",
  runningSessionIds: [],
};

export default function App() {
  const [state, setState] = useState<ExtensionState>(initialState);
  const [liveStreamingText, setLiveStreamingText] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [liveTimeline, setLiveTimeline] = useState<TimelinePart[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string>("default");
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [usageByAccount, setUsageByAccount] = useState<
    Record<string, UsageInfo | null>
  >({});
  const [disconnectedAccounts, setDisconnectedAccounts] = useState<
    Record<string, boolean>
  >({});
  const [summarizingIds, setSummarizingIds] = useState<string[]>([]);
  const [summarizeProgress, setSummarizeProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [tabNames, setTabNames] = useState<Record<string, string>>({});
  const [externalFiles, setExternalFiles] = useState<string[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [savedEditorContent, setSavedEditorContent] = useState("");
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const activeTabRef = useRef<string | undefined>();
  const editorContentRef = useRef("");

  // Queued follow-ups, keyed by conversation (activeTabId). Lives only here.
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  const queueIdRef = useRef(0);
  // A message promoted via "send now"/force, parked until the stop completes.
  const pendingForceRef = useRef<QueuedMessage | null>(null);
  // Edge detection for the streaming→idle transition that drains the queue.
  const prevStreamingRef = useRef(false);
  const prevTabRef = useRef<string | undefined>(undefined);
  // Separate prev-tab tracker for draft→real id migration of a pending queue.
  const migratePrevTabRef = useRef<string | undefined>(undefined);

  const sendQueued = useCallback((item: QueuedMessage) => {
    vscode.postMessage({
      type: "sendMessage",
      text: item.text,
      images: item.images,
      mentions: item.mentions,
    } as any);
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = event.data as ExtensionMessage;

    switch (msg.type) {
      case "state": {
        // Only reset the live activity buffer when switching tabs — clearing it on
        // every state update would wipe the in-progress feed mid-stream.
        const tabChanged = activeTabRef.current !== msg.state.activeTabId;
        activeTabRef.current = msg.state.activeTabId;
        setState(msg.state);
        setLiveStreamingText(msg.state.streamingText || "");
        if (tabChanged) {
          setActivities([]);
          setLiveTimeline([]);
        }
        break;
      }

      case "message":
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, msg.message],
        }));
        break;

      case "streamToken":
        setLiveStreamingText((prev) => prev + msg.text);
        setLiveTimeline((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.type === "text") {
            next[next.length - 1] = { type: "text", text: last.text + msg.text };
          } else {
            next.push({ type: "text", text: msg.text });
          }
          return next;
        });
        break;

      case "streamEnd":
        setLiveStreamingText("");
        setActivities([]);
        setLiveTimeline([]);
        setState((prev) => ({
          ...prev,
          isStreaming: false,
          streamingText: "",
        }));
        break;

      case "activity":
        setActivities((prev) => [...prev.slice(-60), msg.activity]);
        setLiveTimeline((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.type === "activities") {
            next[next.length - 1] = {
              type: "activities",
              // Coalesce on append (merge thinking, fill tool placeholders) so a
              // long thinking run can't grow the stored array without bound.
              activities: coalesceActivities([...last.activities, msg.activity]),
            };
          } else {
            next.push({
              type: "activities",
              activities: coalesceActivities([msg.activity]),
            });
          }
          return next;
        });
        break;

      case "mcpStatus":
        setMcpServers(msg.servers);
        break;

      case "accountsList":
        setAccounts(msg.accounts);
        setActiveAccountId(msg.activeAccountId);
        break;

      case "usageUpdate":
        setUsage(msg.usage);
        break;

      case "usageByAccount":
        setUsageByAccount(msg.usageByAccount);
        setDisconnectedAccounts(msg.disconnected ?? {});
        break;

      case "summarizeStatus": {
        const { sessionId, status } = msg;
        setSummarizingIds((prev) =>
          status === "pending"
            ? prev.includes(sessionId)
              ? prev
              : [...prev, sessionId]
            : prev.filter((id) => id !== sessionId)
        );
        if (status === "done") {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? { ...s, title: msg.title, summary: msg.summary }
                : s
            )
          );
        }
        break;
      }

      case "summarizeProgress":
        setSummarizeProgress(msg.total > 0 ? { done: msg.done, total: msg.total } : null);
        break;

      case "error":
        setState((prev) => ({
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: `err-${Date.now()}`,
              role: "system" as const,
              content: `Error: ${msg.error}`,
              timestamp: Date.now(),
            },
          ],
        }));
        break;

      case "costUpdate":
        setState((prev) => ({ ...prev, cost: msg.cost }));
        break;

      case "contextUpdate":
        setState((prev) => ({ ...prev, contextInfo: msg.context }));
        break;

      case "accountInfo":
        break;

      case "sessionList":
        setSessions(msg.sessions);
        break;

      case "openTabs":
        setOpenTabIds(msg.tabIds);
        setTabNames(msg.names ?? {});
        break;

      case "slashCommands":
        setState((prev) => ({ ...prev, slashCommands: msg.commands }));
        break;

      case "cliStatus":
        setState((prev) => ({ ...prev, cliStatus: msg.status }));
        break;

      case "addFile" as any:
        setExternalFiles((prev) => {
          const filePath = (msg as any).filePath as string;
          if (prev.includes(filePath)) return prev;
          return [...prev, filePath];
        });
        break;

      case "diffUpdate":
        setState((prev) => {
          const existing = prev.pendingDiffs.findIndex(
            (d) => d.filePath === msg.filePath
          );
          const newDiffs = [...prev.pendingDiffs];
          if (existing >= 0) {
            newDiffs[existing] = { filePath: msg.filePath, diff: msg.diff };
          } else {
            newDiffs.push({ filePath: msg.filePath, diff: msg.diff });
          }
          return { ...prev, pendingDiffs: newDiffs };
        });
        break;

      case "skillsList":
        setSkills(msg.skills);
        setSkillsError(null);
        break;

      case "skillContent":
        setSelectedSkillId(msg.skillId);
        editorContentRef.current = msg.content;
        setEditorContent(msg.content);
        setSavedEditorContent(msg.content);
        setSkillsError(null);
        break;

      case "skillsError":
        setSkillsError(msg.error);
        break;

      case "skillsSaved":
        setSavedEditorContent(editorContentRef.current);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Drain the queue when the active conversation goes streaming→idle. A parked
  // "send now" message (pendingForceRef) takes priority over the FIFO head.
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    const prevTab = prevTabRef.current;
    const now = state.isStreaming ?? false;
    const tab = state.activeTabId ?? "";
    prevStreamingRef.current = now;
    prevTabRef.current = tab;
    if (prevTab !== tab || !wasStreaming || now) return; // not a completion edge

    const forced = pendingForceRef.current;
    pendingForceRef.current = null;
    if (forced) {
      sendQueued(forced);
      return;
    }
    const q = queuesRef.current[tab] ?? [];
    if (q.length > 0) {
      setQueues((prev) => ({ ...prev, [tab]: (prev[tab] ?? []).slice(1) }));
      sendQueued(q[0]);
    }
  }, [state.isStreaming, state.activeTabId, sendQueued]);

  // A brand-new chat's tab id flips from "draft-…" to the real session id once
  // it starts; carry any queue parked under the draft id over to the real one.
  useEffect(() => {
    const tab = state.activeTabId;
    const prev = migratePrevTabRef.current;
    migratePrevTabRef.current = tab;
    if (
      prev &&
      tab &&
      prev !== tab &&
      prev.startsWith("draft-") &&
      !tab.startsWith("draft-")
    ) {
      setQueues((q) => {
        const items = q[prev];
        if (!items || items.length === 0) return q;
        const rest = { ...q };
        delete rest[prev];
        rest[tab] = [...(rest[tab] ?? []), ...items];
        return rest;
      });
    }
  }, [state.activeTabId]);

  const handleSend = useCallback(
    (text: string, images?: string[], mentions?: string[]) => {
      // While a turn is in flight, queue the message instead of sending; it
      // drains automatically when the current response finishes.
      if (state.isStreaming) {
        const tab = state.activeTabId ?? "";
        const item: QueuedMessage = {
          id: `q${++queueIdRef.current}`,
          text,
          images,
          mentions,
        };
        setQueues((prev) => ({ ...prev, [tab]: [...(prev[tab] ?? []), item] }));
        return;
      }
      vscode.postMessage({ type: "sendMessage", text, images, mentions } as any);
    },
    [state.isStreaming, state.activeTabId]
  );

  const handleRemoveQueued = useCallback(
    (id: string) => {
      const tab = state.activeTabId ?? "";
      setQueues((prev) => ({
        ...prev,
        [tab]: (prev[tab] ?? []).filter((m) => m.id !== id),
      }));
    },
    [state.activeTabId]
  );

  const handleEditQueued = useCallback(
    (id: string, text: string) => {
      const tab = state.activeTabId ?? "";
      setQueues((prev) => ({
        ...prev,
        [tab]: (prev[tab] ?? []).map((m) => (m.id === id ? { ...m, text } : m)),
      }));
    },
    [state.activeTabId]
  );

  // Send a queued message immediately, stopping the current response if one is
  // running (the streaming→idle edge then delivers the parked message).
  const handleSendQueuedNow = useCallback(
    (id: string) => {
      const tab = state.activeTabId ?? "";
      const item = (queuesRef.current[tab] ?? []).find((m) => m.id === id);
      if (!item) return;
      setQueues((prev) => ({
        ...prev,
        [tab]: (prev[tab] ?? []).filter((m) => m.id !== id),
      }));
      if (state.isStreaming) {
        pendingForceRef.current = item;
        vscode.postMessage({ type: "cancelRequest" });
      } else {
        sendQueued(item);
      }
    },
    [state.isStreaming, state.activeTabId, sendQueued]
  );

  // Pressing Enter on an empty composer while queued items exist: force the
  // first one (stops the current response and sends it next).
  const handleForceNext = useCallback(() => {
    const tab = state.activeTabId ?? "";
    const first = (queuesRef.current[tab] ?? [])[0];
    if (first) handleSendQueuedNow(first.id);
  }, [state.activeTabId, handleSendQueuedNow]);

  const handleEditMessage = useCallback((messageId: string, text: string) => {
    vscode.postMessage({ type: "editMessage", messageId, text });
  }, []);

  const handleSwitchFork = useCallback((anchorId: string, index: number) => {
    vscode.postMessage({ type: "switchFork", anchorId, index });
  }, []);

  const handleCancel = useCallback(() => {
    vscode.postMessage({ type: "cancelRequest" });
  }, []);

  const handleModeChange = useCallback((mode: Mode) => {
    vscode.postMessage({ type: "mode", mode });
  }, []);

  const handleModelChange = useCallback((model: string) => {
    vscode.postMessage({ type: "changeModel", model });
  }, []);

  const handleEffortChange = useCallback((effort: EffortLevel) => {
    vscode.postMessage({ type: "changeEffort", effort });
  }, []);

  const handleNewConversation = useCallback(() => {
    vscode.postMessage({ type: "newConversation" });
  }, []);

  const handleSwitchSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "switchSession", sessionId });
  }, []);

  const handleCloseTab = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "closeTab", sessionId });
  }, []);

  const handleListSessions = useCallback(() => {
    vscode.postMessage({ type: "listSessions" });
  }, []);

  const handleAcceptChange = useCallback((filePath: string) => {
    vscode.postMessage({ type: "acceptChange", filePath });
  }, []);

  const handleRejectChange = useCallback((filePath: string) => {
    vscode.postMessage({ type: "rejectChange", filePath });
  }, []);

  const handleAcceptAll = useCallback(() => {
    vscode.postMessage({ type: "acceptAllChanges" });
  }, []);

  const handleRejectAll = useCallback(() => {
    vscode.postMessage({ type: "rejectAllChanges" });
  }, []);

  const handleEditorChange = useCallback((content: string) => {
    editorContentRef.current = content;
    setEditorContent(content);
  }, []);

  const handleListSkills = useCallback(() => {
    vscode.postMessage({ type: "listSkills" });
  }, []);

  const handleSelectSkill = useCallback((skillId: string) => {
    vscode.postMessage({ type: "readSkill", skillId });
  }, []);

  const handleSaveSkill = useCallback(() => {
    if (!selectedSkillId) return;
    vscode.postMessage({
      type: "saveSkill",
      skillId: selectedSkillId,
      content: editorContentRef.current,
    });
  }, [selectedSkillId]);

  const handleCreateSkill = useCallback((scope: SkillScope, name: string) => {
    vscode.postMessage({ type: "createSkill", scope, name });
  }, []);

  const handleDeleteSkill = useCallback(() => {
    if (!selectedSkillId) return;
    if (!window.confirm("Delete this skill? This cannot be undone.")) return;
    vscode.postMessage({ type: "deleteSkill", skillId: selectedSkillId });
    setSelectedSkillId(null);
    setEditorContent("");
    setSavedEditorContent("");
    editorContentRef.current = "";
  }, [selectedSkillId]);

  const handleOpenSkillInEditor = useCallback((filePath: string) => {
    vscode.postMessage({ type: "openFile", filePath });
  }, []);

  const handleOpenMcp = useCallback(() => {
    vscode.postMessage({ type: "openMcpConfig" });
  }, []);

  const handleRestartMcp = useCallback(() => {
    vscode.postMessage({ type: "restartMcp" });
  }, []);

  const handleSummarizeSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "summarizeSession", sessionId });
  }, []);

  const handleSummarizeAll = useCallback(() => {
    vscode.postMessage({ type: "summarizeAllSessions" });
  }, []);

  const handleSwitchAccount = useCallback((accountId: string) => {
    vscode.postMessage({ type: "switchAccount", accountId });
  }, []);

  const handleAddAccount = useCallback(() => {
    vscode.postMessage({ type: "addAccount" });
  }, []);

  const handleRemoveAccount = useCallback((accountId: string) => {
    vscode.postMessage({ type: "removeAccount", accountId });
  }, []);

  const handleReauthAccount = useCallback((accountId: string) => {
    vscode.postMessage({ type: "reauthAccount", accountId });
  }, []);

  const isStreaming = state.isStreaming ?? false;
  const skillsDirty = editorContent !== savedEditorContent;
  const streamingText = isStreaming ? liveStreamingText : "";

  return (
    <div className="relative flex flex-col h-screen overflow-hidden">
      <SkillsPanel
        open={skillsOpen}
        skills={skills}
        selectedSkillId={selectedSkillId}
        editorContent={editorContent}
        dirty={skillsDirty}
        error={skillsError}
        savedFlash={savedFlash}
        hasWorkspace={!!state.workspacePath}
        onClose={() => setSkillsOpen(false)}
        onSelectSkill={handleSelectSkill}
        onEditorChange={handleEditorChange}
        onListSkills={handleListSkills}
        onSave={handleSaveSkill}
        onDelete={handleDeleteSkill}
        onCreate={handleCreateSkill}
        onOpenInEditor={handleOpenSkillInEditor}
      />
      <ChatView
        messages={state.messages}
        mode={state.mode}
        model={state.model}
        effort={state.effort}
        sessionId={state.sessionId}
        activeTabId={state.activeTabId}
        sessions={sessions}
        openTabIds={openTabIds}
        tabNames={tabNames}
        runningSessionIds={state.runningSessionIds || []}
        cliStatus={state.cliStatus}
        workspacePath={state.workspacePath}
        externalFiles={externalFiles}
        onClearExternalFiles={() => setExternalFiles([])}
        pendingDiffs={state.pendingDiffs}
        streamingText={streamingText}
        isStreaming={isStreaming}
        activities={activities}
        liveTimeline={isStreaming ? liveTimeline : []}
        cost={state.cost ?? null}
        contextInfo={state.contextInfo ?? null}
        accountEmail={state.accountEmail}
        accountOrg={state.accountOrg}
        slashCommands={state.slashCommands}
        contextSummarized={state.contextSummarized}
        onSend={handleSend}
        onCancel={handleCancel}
        onModeChange={handleModeChange}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onNewConversation={handleNewConversation}
        onSwitchSession={handleSwitchSession}
        onCloseTab={handleCloseTab}
        onListSessions={handleListSessions}
        onAcceptChange={handleAcceptChange}
        onRejectChange={handleRejectChange}
        onAcceptAll={handleAcceptAll}
        onRejectAll={handleRejectAll}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenMcp={handleOpenMcp}
        onRestartMcp={handleRestartMcp}
        mcpServers={mcpServers}
        accounts={accounts}
        activeAccountId={activeAccountId}
        usage={usage}
        usageByAccount={usageByAccount}
        disconnectedAccounts={disconnectedAccounts}
        onSwitchAccount={handleSwitchAccount}
        onAddAccount={handleAddAccount}
        onRemoveAccount={handleRemoveAccount}
        onReauthAccount={handleReauthAccount}
        summarizingIds={summarizingIds}
        summarizeProgress={summarizeProgress}
        onSummarizeSession={handleSummarizeSession}
        onSummarizeAll={handleSummarizeAll}
        queuedMessages={queues[state.activeTabId ?? ""] ?? []}
        onQueueEdit={handleEditQueued}
        onQueueRemove={handleRemoveQueued}
        onQueueSendNow={handleSendQueuedNow}
        onForceNext={handleForceNext}
        onEditMessage={handleEditMessage}
        onSwitchFork={handleSwitchFork}
      />
    </div>
  );
}
