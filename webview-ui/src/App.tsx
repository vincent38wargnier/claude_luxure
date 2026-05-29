import { useState, useEffect, useCallback, useRef } from "react";
import vscode from "./vscode";
import ChatView from "./components/chat/ChatView";
import type {
  ExtensionState,
  ExtensionMessage,
  ChatMessage,
  CostInfo,
  ContextInfo,
  AccountInfo,
  SessionInfo,
  Mode,
} from "./types";

const initialState: ExtensionState = {
  mode: "agent",
  messages: [],
  cliStatus: "stopped",
  pendingDiffs: [],
};

export default function App() {
  const [state, setState] = useState<ExtensionState>(initialState);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [cost, setCost] = useState<CostInfo | null>(null);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [externalFiles, setExternalFiles] = useState<string[]>([]);
  const streamRef = useRef("");

  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = event.data as ExtensionMessage;

    switch (msg.type) {
      case "state":
        setState(msg.state);
        break;

      case "message":
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, msg.message],
        }));
        if (msg.message.role === "assistant" && msg.message.isStreaming) {
          setIsStreaming(true);
          streamRef.current = "";
          setStreamingText("");
        }
        break;

      case "streamToken":
        streamRef.current += msg.text;
        setStreamingText(streamRef.current);
        break;

      case "streamEnd":
        setIsStreaming(false);
        setStreamingText("");
        streamRef.current = "";
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
        setCost(msg.cost);
        break;

      case "contextUpdate":
        setContextInfo(msg.context);
        break;

      case "accountInfo":
        setAccountInfo(msg.account);
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

  const handleNewConversation = useCallback(() => {
    vscode.postMessage({ type: "newConversation" });
    setCost(null);
    setContextInfo(null);
  }, []);

  const handleSwitchSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "switchSession", sessionId });
    setCost(null);
    setContextInfo(null);
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

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <ChatView
        messages={state.messages}
        mode={state.mode}
        model={state.model}
        sessionId={state.sessionId}
        sessions={sessions}
        openTabIds={openTabIds}
        cliStatus={state.cliStatus}
        workspacePath={state.workspacePath}
        externalFiles={externalFiles}
        onClearExternalFiles={() => setExternalFiles([])}
        pendingDiffs={state.pendingDiffs}
        streamingText={streamingText}
        isStreaming={isStreaming}
        cost={cost}
        contextInfo={contextInfo}
        accountEmail={state.accountEmail}
        accountOrg={state.accountOrg}
        onSend={handleSend}
        onCancel={handleCancel}
        onModeChange={handleModeChange}
        onModelChange={handleModelChange}
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
