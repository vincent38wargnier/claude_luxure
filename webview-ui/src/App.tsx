import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import vscode from "./vscode";
import {
  PERF,
  countMessage,
  installPerfMonitors,
  markSwitch,
  markSwitchPainted,
  perfLog,
  r1,
  switchExtras,
} from "./perf";
import ChatView from "./components/chat/ChatView";
import { coalesceActivities } from "./components/chat/ActivityFeed";
import { renderAnnotatedImage } from "./utils/annotate";
import SkillsPanel from "./components/skills/SkillsPanel";
import type {
  ExtensionState,
  ExtensionMessage,
  ActivityEvent,
  ChatMessage,
  TaskActivity,
  TimelinePart,
  SessionInfo,
  SessionMarker,
  Mode,
  EffortLevel,
  SkillInfo,
  SkillScope,
  McpServerStatus,
  StoredAccount,
  UsageInfo,
  QueuedMessage,
} from "./types";

/** Replace a task card (matched by toolUseId) inside timeline parts,
 * immutably, so React re-renders just the patched run. */
function patchTaskInParts(
  parts: TimelinePart[],
  task: TaskActivity
): { parts: TimelinePart[]; found: boolean } {
  let found = false;
  const next = parts.map((p) => {
    if (p.type !== "activities") {
      return p;
    }
    const idx = p.activities.findIndex(
      (a) => a.type === "task" && a.toolUseId === task.toolUseId
    );
    if (idx < 0) {
      return p;
    }
    found = true;
    const acts = p.activities.slice();
    acts[idx] = task;
    return { type: "activities" as const, activities: acts };
  });
  return { parts: next, found };
}

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
  // Live thinking-token counter (system:thinking_tokens) for the current turn.
  const [thinkingTokens, setThinkingTokens] = useState(0);
  // API retry / rate-limit chip; cleared when tokens flow again.
  const [transient, setTransient] = useState<{ kind: string; text: string } | null>(null);
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
  // Post-it identity per conversation key, and which keys have an emoji pick
  // in flight (drives the spinner on the post-it).
  const [tabMarkers, setTabMarkers] = useState<Record<string, SessionMarker>>({});
  const [markerBusyKeys, setMarkerBusyKeys] = useState<Record<string, boolean>>({});
  const [tabLastReply, setTabLastReply] = useState<Record<string, number>>({});
  // Editor-group layout: which tabs live in which pane, what each pane shows,
  // and which pane owns the real-time stream. Pane 1 empty ⇔ split closed.
  const [panes, setPanes] = useState<{ tabIds: string[]; activeId: string | null }[]>([
    { tabIds: [], activeId: null },
    { tabIds: [], activeId: null },
  ]);
  const [focusedPane, setFocusedPane] = useState(0);
  /** Full-state pushes for the UNFOCUSED pane's conversation. */
  const [pushedPanes, setPushedPanes] = useState<Record<number, ExtensionState | null>>({});
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
    const perfT0 = performance.now();
    let perfExtra: Record<string, unknown> | undefined;
    countMessage(msg.type);

    switch (msg.type) {
      case "state": {
        const tabChanged = activeTabRef.current !== msg.state.activeTabId;
        activeTabRef.current = msg.state.activeTabId;
        setState(msg.state);
        setLiveStreamingText(msg.state.streamingText || "");
        // The provider's per-session buffers are authoritative: restoring them
        // here is what brings a running conversation's streamed feed back when
        // switching to its tab (it used to be wiped and lost until the turn
        // finalized). Older providers without the fields keep the old
        // wipe-on-switch behavior.
        setLiveTimeline((prev) =>
          msg.state.liveTimeline ?? (tabChanged ? [] : prev)
        );
        setActivities((prev) =>
          msg.state.liveActivities ?? (tabChanged ? [] : prev)
        );
        if (tabChanged) {
          setThinkingTokens(0);
          setTransient(null);
        }
        if (msg.state.marker && msg.state.activeTabId) {
          const key = msg.state.activeTabId;
          const marker = msg.state.marker;
          setTabMarkers((prev) => ({ ...prev, [key]: marker }));
        }
        if (PERF) {
          perfExtra = {
            ...(switchExtras(msg.perfId) ?? {}),
            transportMs: msg.perfSentAt
              ? Date.now() - msg.perfSentAt
              : undefined,
            msgs: msg.state.messages.length,
            live:
              (msg.state.liveTimeline?.length ?? 0) +
              (msg.state.liveActivities?.length ?? 0),
          };
          markSwitchPainted(msg.perfId);
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
        setTransient(null); // tokens flowing again — retry/limit chip is stale
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
        setThinkingTokens(0);
        setTransient(null);
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

      case "taskUpdate": {
        // In-place patch of an agent card — live progress for a running
        // subagent, including after its parent turn already finalized.
        const task = msg.task;
        if (msg.messageId) {
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m): ChatMessage => {
              if (m.id !== msg.messageId) {
                return m;
              }
              const patched: ChatMessage = { ...m };
              if (m.timeline && m.timeline.length > 0) {
                const r = patchTaskInParts(m.timeline, task);
                patched.timeline = r.found
                  ? r.parts
                  : [...m.timeline, { type: "activities", activities: [task] }];
              } else {
                patched.timeline = [{ type: "activities", activities: [task] }];
              }
              if (m.activities) {
                patched.activities = m.activities.map((a) =>
                  a.type === "task" && a.toolUseId === task.toolUseId ? task : a
                );
              }
              return patched;
            }),
          }));
        } else {
          setLiveTimeline((prev) => {
            const r = patchTaskInParts(prev, task);
            if (r.found) {
              return r.parts;
            }
            // Not in the live buffer yet (e.g. panel re-opened mid-run) — append.
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.type === "activities") {
              next[next.length - 1] = {
                type: "activities",
                activities: [...last.activities, task],
              };
            } else {
              next.push({ type: "activities", activities: [task] });
            }
            return next;
          });
          setActivities((prev) => {
            const idx = prev.findIndex(
              (a) => a.type === "task" && a.toolUseId === task.toolUseId
            );
            if (idx < 0) {
              return [...prev.slice(-60), task];
            }
            const next = prev.slice();
            next[idx] = task;
            return next;
          });
        }
        break;
      }

      case "thinkingTokens":
        setThinkingTokens(msg.tokens);
        break;

      case "transientStatus":
        setTransient(msg.status);
        break;

      case "annotateImage":
        // Burn the requested annotations into the image on a canvas and hand
        // the PNG back to the extension (which saves it / shows it in chat).
        renderAnnotatedImage(msg.image, msg.annotations)
          .then((dataUrl) =>
            vscode.postMessage({
              type: "annotateResult",
              requestId: msg.requestId,
              dataUrl,
            })
          )
          .catch((err) =>
            vscode.postMessage({
              type: "annotateResult",
              requestId: msg.requestId,
              error: String(err?.message || err),
            })
          );
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
              authErrorAccountId: msg.authErrorAccountId,
              authErrorAccountLabel: msg.authErrorAccountLabel,
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
        // Merge (don't replace): a draft key that just migrated to a session id
        // may briefly be referenced under its old key elsewhere.
        if (msg.markers) {
          const incoming = msg.markers;
          setTabMarkers((prev) => ({ ...prev, ...incoming }));
        }
        if (msg.lastReplyAt) {
          const incoming = msg.lastReplyAt;
          setTabLastReply((prev) => ({ ...prev, ...incoming }));
        }
        if (msg.panes && msg.panes.length > 0) {
          const incoming = msg.panes;
          setPanes([
            incoming[0] ?? { tabIds: [], activeId: null },
            incoming[1] ?? { tabIds: [], activeId: null },
          ]);
          setFocusedPane(msg.focusedPane === 1 ? 1 : 0);
        }
        break;

      case "markerUpdate": {
        const { key, marker, busy } = msg;
        setTabMarkers((prev) => ({ ...prev, [key]: marker }));
        setMarkerBusyKeys((prev) => ({ ...prev, [key]: !!busy }));
        break;
      }

      case "paneState": {
        const { pane, state: paneState } = msg;
        setPushedPanes((prev) => ({ ...prev, [pane]: paneState ?? null }));
        if (PERF) {
          perfExtra = {
            pane,
            transportMs: msg.perfSentAt
              ? Date.now() - msg.perfSentAt
              : undefined,
            msgs: paneState?.messages.length ?? 0,
          };
        }
        break;
      }

      case "slashCommands":
        setState((prev) => ({ ...prev, slashCommands: msg.commands }));
        break;

      case "cliStatus":
        setState((prev) => ({ ...prev, cliStatus: msg.status }));
        break;

      case "addFile":
        setExternalFiles((prev) => {
          if (prev.includes(msg.filePath)) return prev;
          return [...prev, msg.filePath];
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

    if (PERF) {
      const ms = performance.now() - perfT0;
      // Always log the heavy full-state pushes; anything else only when slow.
      if (msg.type === "state" || msg.type === "paneState" || ms > 8) {
        perfLog("msg", { type: msg.type, ms: r1(ms), ...(perfExtra ?? {}) });
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Lag diagnostics: long-task observer + event-loop sampler for this thread.
  useEffect(() => installPerfMonitors(), []);

  // Agents still working right now — from finalized messages AND the live turn
  // (a background agent outlives its turn). Last sighting of a card wins, so a
  // completion patch removes it from the strip.
  const runningTasks = useMemo(() => {
    const all = new Map<string, TaskActivity>();
    const scan = (acts?: ActivityEvent[]) => {
      for (const a of acts || []) {
        if (a.type === "task") {
          all.set(a.toolUseId, a);
        }
      }
    };
    for (const m of state.messages) {
      scan(m.activities);
      for (const p of m.timeline || []) {
        if (p.type === "activities") {
          scan(p.activities);
        }
      }
    }
    for (const p of liveTimeline) {
      if (p.type === "activities") {
        scan(p.activities);
      }
    }
    return [...all.values()].filter((t) => t.status === "running");
  }, [state.messages, liveTimeline]);

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

  /** Pane-aware send: `tabId` targets that pane's conversation (the provider
   * moves focus to it first), and queueing keys off THAT pane's streaming
   * state — a busy left pane must not queue a message meant for an idle
   * right pane. */
  const sendTo = useCallback(
    (
      tabId: string | undefined,
      paneStreaming: boolean,
      text: string,
      images?: string[],
      mentions?: string[]
    ) => {
      if (paneStreaming) {
        const tab = tabId ?? "";
        const item: QueuedMessage = {
          id: `q${++queueIdRef.current}`,
          text,
          images,
          mentions,
        };
        setQueues((prev) => ({ ...prev, [tab]: [...(prev[tab] ?? []), item] }));
        return;
      }
      vscode.postMessage({ type: "sendMessage", text, images, mentions, tabId } as any);
    },
    []
  );

  const handleSend = useCallback(
    (text: string, images?: string[], mentions?: string[]) => {
      sendTo(state.activeTabId, state.isStreaming ?? false, text, images, mentions);
    },
    [sendTo, state.isStreaming, state.activeTabId]
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

  const handleEditMessage = useCallback(
    (messageId: string, text: string, images?: string[]) => {
      vscode.postMessage({ type: "editMessage", messageId, text, images });
    },
    []
  );

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

  const handleNewWorktreeConversation = useCallback(() => {
    vscode.postMessage({ type: "newWorktreeConversation" });
  }, []);

  const handleSwitchSession = useCallback((sessionId: string, pane?: number) => {
    vscode.postMessage({
      type: "switchSession",
      sessionId,
      pane,
      perfId: markSwitch(sessionId),
    });
  }, []);

  const handleCloseTab = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "closeTab", sessionId });
  }, []);

  const handleCloseAllTabs = useCallback(() => {
    vscode.postMessage({ type: "closeAllTabs" });
  }, []);

  const handleToggleSplit = useCallback(() => {
    vscode.postMessage({ type: "toggleSplit" });
  }, []);

  const handleFocusPane = useCallback((pane: number) => {
    vscode.postMessage({ type: "focusPane", pane });
  }, []);

  const handleMoveTab = useCallback((tabId: string, pane: number, index: number) => {
    vscode.postMessage({ type: "moveTab", tabId, pane, index });
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

  const handleSetMarkerNote = useCallback((note: string) => {
    vscode.postMessage({ type: "setMarkerNote", note });
  }, []);

  const handleDismissTask = useCallback((toolUseId: string) => {
    vscode.postMessage({ type: "dismissTask", toolUseId });
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
  const splitOpen = (panes[1]?.tabIds.length ?? 0) > 0;

  /** One full Claude Luxure instance per pane. The focused pane rides the
   * real-time singleton state (streamText deltas, tasks, thinking...); the
   * other renders the provider's full-state pushes for its conversation. */
  const renderPane = (i: number) => {
    const pane = panes[i] ?? { tabIds: [], activeId: null };
    const focused = i === focusedPane;
    const pv: ExtensionState = focused
      ? state
      : pushedPanes[i] ?? {
          mode: state.mode,
          messages: [],
          cliStatus: "stopped",
          pendingDiffs: [],
        };
    const pvStreaming = focused ? isStreaming : pv.isStreaming ?? false;
    const pvStreamingText = focused
      ? streamingText
      : pvStreaming
        ? pv.streamingText ?? ""
        : "";
    const activeId =
      (focused ? state.activeTabId : pane.activeId ?? pv.activeTabId) ??
      pane.activeId ??
      undefined;

    return (
      <ChatView
        paneIndex={i}
        paneFocused={focused}
        messages={pv.messages}
        mode={pv.mode ?? state.mode}
        model={pv.model ?? state.model}
        effort={pv.effort ?? state.effort}
        sessionId={pv.sessionId}
        activeTabId={activeId}
        sessions={sessions}
        openTabIds={pane.tabIds}
        tabNames={tabNames}
        tabMarkers={tabMarkers}
        tabLastReply={tabLastReply}
        onToggleSplit={handleToggleSplit}
        splitActive={splitOpen}
        onMoveTab={handleMoveTab}
        onCloseAllTabs={handleCloseAllTabs}
        marker={tabMarkers[activeId ?? ""] ?? pv.marker ?? null}
        markerBusy={!!markerBusyKeys[activeId ?? ""]}
        onSetMarkerNote={handleSetMarkerNote}
        runningSessionIds={state.runningSessionIds || []}
        cliStatus={pv.cliStatus}
        workspacePath={state.workspacePath}
        externalFiles={focused ? externalFiles : []}
        onClearExternalFiles={focused ? () => setExternalFiles([]) : () => {}}
        pendingDiffs={pv.pendingDiffs ?? []}
        streamingText={pvStreamingText}
        isStreaming={pvStreaming}
        activities={focused ? activities : pvStreaming ? pv.liveActivities ?? [] : []}
        liveTimeline={
          focused
            ? isStreaming
              ? liveTimeline
              : []
            : pvStreaming
              ? pv.liveTimeline ?? []
              : []
        }
        runningTasks={focused ? runningTasks : []}
        onDismissTask={handleDismissTask}
        thinkingTokens={focused ? thinkingTokens : 0}
        transientStatus={focused ? transient : null}
        cost={pv.cost ?? null}
        contextInfo={pv.contextInfo ?? null}
        accountEmail={state.accountEmail}
        accountOrg={state.accountOrg}
        slashCommands={state.slashCommands}
        contextSummarized={pv.contextSummarized}
        onSend={(text, images, mentions) =>
          sendTo(pane.activeId ?? undefined, pvStreaming, text, images, mentions)
        }
        onCancel={handleCancel}
        onModeChange={handleModeChange}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onNewConversation={handleNewConversation}
        onNewWorktreeConversation={handleNewWorktreeConversation}
        onSwitchSession={(sessionId) => handleSwitchSession(sessionId, i)}
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
        queuedMessages={queues[activeId ?? ""] ?? []}
        onQueueEdit={handleEditQueued}
        onQueueRemove={handleRemoveQueued}
        onQueueSendNow={handleSendQueuedNow}
        onForceNext={handleForceNext}
        onEditMessage={handleEditMessage}
        onSwitchFork={handleSwitchFork}
      />
    );
  };

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
      <div className="flex-1 min-h-0 split-host">
        <div className={`split-panes h-full ${splitOpen ? "is-split" : ""}`}>
          <div
            className={`split-pane relative ${splitOpen && focusedPane !== 0 ? "pane-unfocused" : ""}`}
            onMouseDownCapture={() => {
              if (splitOpen && focusedPane !== 0) {
                handleFocusPane(0);
              }
            }}
          >
            {renderPane(0)}
          </div>
          {splitOpen && (
            <div
              className={`split-pane relative ${focusedPane !== 1 ? "pane-unfocused" : ""}`}
              onMouseDownCapture={() => {
                if (focusedPane !== 1) {
                  handleFocusPane(1);
                }
              }}
            >
              {renderPane(1)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
