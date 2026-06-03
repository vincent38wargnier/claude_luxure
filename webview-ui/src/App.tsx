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
        onEditMessage={handleEditMessage}
        onSwitchFork={handleSwitchFork}
      />
    </div>
  );
}
