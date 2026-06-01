import { useState, useEffect, useCallback, useRef } from "react";
import vscode from "./vscode";
import ChatView from "./components/chat/ChatView";
import type {
  ExtensionState,
  ExtensionMessage,
  ActivityEvent,
  SessionInfo,
  Mode,
  EffortLevel,
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
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [externalFiles, setExternalFiles] = useState<string[]>([]);
  const activeTabRef = useRef<string | undefined>();

  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = event.data as ExtensionMessage;

    switch (msg.type) {
      case "state":
        activeTabRef.current = msg.state.activeTabId;
        setState(msg.state);
        setLiveStreamingText(msg.state.streamingText || "");
        setActivities([]);
        break;

      case "message":
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, msg.message],
        }));
        break;

      case "streamToken":
        setLiveStreamingText((prev) => prev + msg.text);
        break;

      case "streamEnd":
        setLiveStreamingText("");
        setActivities([]);
        setState((prev) => ({
          ...prev,
          isStreaming: false,
          streamingText: "",
        }));
        break;

      case "activity":
        setActivities((prev) => [...prev.slice(-20), msg.activity]);
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
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const handleSend = useCallback(
    (text: string, images?: string[], mentions?: string[]) => {
      vscode.postMessage({
        type: "sendMessage",
        text,
        images,
        mentions,
      } as any);
    },
    []
  );

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

  const isStreaming = state.isStreaming ?? false;
  const streamingText = isStreaming ? liveStreamingText : "";

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <ChatView
        messages={state.messages}
        mode={state.mode}
        model={state.model}
        effort={state.effort}
        sessionId={state.sessionId}
        activeTabId={state.activeTabId}
        sessions={sessions}
        openTabIds={openTabIds}
        runningSessionIds={state.runningSessionIds || []}
        cliStatus={state.cliStatus}
        workspacePath={state.workspacePath}
        externalFiles={externalFiles}
        onClearExternalFiles={() => setExternalFiles([])}
        pendingDiffs={state.pendingDiffs}
        streamingText={streamingText}
        isStreaming={isStreaming}
        activities={activities}
        cost={state.cost ?? null}
        contextInfo={state.contextInfo ?? null}
        accountEmail={state.accountEmail}
        accountOrg={state.accountOrg}
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
      />
    </div>
  );
}
