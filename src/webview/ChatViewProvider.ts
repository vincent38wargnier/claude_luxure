import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { ClaudeBridge, ClaudeEvent } from "../cli/claude-bridge";
import { DiffManager } from "../diff/DiffManager";
import { SnapshotManager } from "../diff/SnapshotManager";
import { SessionManager } from "../sessions/SessionManager";
import {
  ActivityEvent,
  ChatMessage,
  ContextInfo,
  CostInfo,
  EffortLevel,
  ExtensionMessage,
  ExtensionState,
  Mode,
  WebviewMessage,
} from "../shared/types";
import { extractMentions, resolveFromMention } from "../utils/path-mentions";
import { log } from "../utils/logger";
import {
  isCompactCommand,
  isSlashCommand,
  resolveSlashCommand,
} from "../shared/cli-commands";
import { SkillsManager } from "../skills/SkillsManager";
import type { SkillScope } from "../shared/types";

interface SessionRuntime {
  sessionId?: string;
  draftId?: string;
  messages: ChatMessage[];
  bridge?: ClaudeBridge;
  streamingMessageId: string | null;
  currentStreamText: string;
  lastContext?: ContextInfo;
  cost?: CostInfo;
  cliStatus: ExtensionState["cliStatus"];
  sessionName?: string;
  contextSummarized?: boolean;
}

function createEmptyRuntime(): SessionRuntime {
  return {
    messages: [],
    streamingMessageId: null,
    currentStreamText: "",
    cliStatus: "stopped",
  };
}

function isDraftKey(key: string): boolean {
  return key.startsWith("draft-");
}

function sessionNameFromText(text: string): string {
  if (isSlashCommand(text)) {
    return "New chat";
  }
  const line = text.split("\n")[0].trim();
  return line.slice(0, 80) || "New chat";
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-luxure.chatView";

  private webview: vscode.Webview | undefined;
  private runtimes = new Map<string, SessionRuntime>();
  private activeKey = "";
  private mode: Mode = "agent";
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private snapshotManager = new SnapshotManager();
  private diffManager = new DiffManager(this.snapshotManager);
  private accountEmail: string | undefined;
  private accountOrg: string | undefined;
  private openTabIds: string[] = [];
  private sessionManager: SessionManager | undefined;
  private diffWatchStarted = false;
  private slashCommands: string[] = [];
  private skillsManager = new SkillsManager();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.diffManager.setDiffCallback((diff) => {
      this.postMessage({
        type: "diffUpdate",
        filePath: diff.filePath,
        diff: diff.diff,
        status: "pending",
      });
    });
    this.model = this.context.workspaceState.get<string>("claude-luxure.model");
    this.effort = this.context.workspaceState.get<EffortLevel>("claude-luxure.effort");
    this.fetchAccountInfo();
    this.restoreLastSession();
  }

  private getActiveRuntime(): SessionRuntime {
    if (!this.activeKey) {
      const draftKey = this.createDraftRuntime();
      this.activeKey = draftKey;
      if (!this.openTabIds.includes(draftKey)) {
        this.openTabIds.unshift(draftKey);
      }
    }
    let runtime = this.runtimes.get(this.activeKey);
    if (!runtime) {
      runtime = createEmptyRuntime();
      if (isDraftKey(this.activeKey)) {
        runtime.draftId = this.activeKey;
      } else {
        runtime.sessionId = this.activeKey;
      }
      this.runtimes.set(this.activeKey, runtime);
    }
    return runtime;
  }

  private createDraftRuntime(): string {
    const draftKey = `draft-${generateId()}`;
    this.runtimes.set(draftKey, createEmptyRuntime());
    this.runtimes.get(draftKey)!.draftId = draftKey;
    return draftKey;
  }

  private isActiveKey(key: string): boolean {
    return key === this.activeKey;
  }

  private getRunningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [key, runtime] of this.runtimes) {
      if (runtime.streamingMessageId) {
        ids.push(runtime.sessionId || key);
      }
    }
    return ids;
  }

  private findBridgeForSessionId(sessionId: string): ClaudeBridge | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.sessionId === sessionId && runtime.bridge && runtime.bridge.status !== "stopped") {
        return runtime.bridge;
      }
    }
    return undefined;
  }

  private migrateDraftToSession(draftKey: string, sessionId: string, runtime: SessionRuntime): void {
    this.runtimes.delete(draftKey);
    runtime.sessionId = sessionId;
    delete runtime.draftId;
    this.runtimes.set(sessionId, runtime);

    const tabIdx = this.openTabIds.indexOf(draftKey);
    if (tabIdx >= 0) {
      this.openTabIds[tabIdx] = sessionId;
    } else if (!this.openTabIds.includes(sessionId)) {
      this.openTabIds.unshift(sessionId);
    }

    if (this.activeKey === draftKey) {
      this.activeKey = sessionId;
    }
  }

  private fetchAccountInfo(): void {
    execFile("claude", ["auth", "status"], (err, stdout) => {
      if (err) {
        log("WARN", "Failed to fetch account info:", err.message);
        return;
      }
      try {
        const info = JSON.parse(stdout.trim());
        this.accountEmail = info.email;
        this.accountOrg = info.orgName;
        log("INFO", "Account info:", info.email, info.orgName);
        this.postMessage({
          type: "accountInfo",
          account: {
            email: info.email,
            orgName: info.orgName,
            subscriptionType: info.subscriptionType,
          },
        });
        this.sendState();
      } catch {
        log("WARN", "Failed to parse account info:", stdout.slice(0, 200));
      }
    });
  }

  private restoreLastSession(): void {
    this.openTabIds = this.context.workspaceState.get<string[]>("claude-luxure.openTabs") || [];
    const lastSessionId = this.context.workspaceState.get<string>("claude-luxure.lastSessionId");

    if (lastSessionId) {
      if (!this.openTabIds.includes(lastSessionId)) {
        this.openTabIds.unshift(lastSessionId);
      }

      const runtime = createEmptyRuntime();
      runtime.sessionId = lastSessionId;
      runtime.contextSummarized = this.loadContextSummarized(lastSessionId);
      const cached = this.context.workspaceState.get<ChatMessage[]>(`claude-luxure.messages.${lastSessionId}`);
      if (cached && cached.length > 0) {
        runtime.messages = cached.map((m) => ({ ...m, isStreaming: false }));
        log("INFO", `Restored ${cached.length} messages for session ${lastSessionId}`);
      }
      this.runtimes.set(lastSessionId, runtime);
      this.activeKey = lastSessionId;
    } else if (this.openTabIds.length > 0) {
      this.activeKey = this.openTabIds[0];
      if (!this.runtimes.has(this.activeKey)) {
        const runtime = createEmptyRuntime();
        if (isDraftKey(this.activeKey)) {
          runtime.draftId = this.activeKey;
        } else {
          runtime.sessionId = this.activeKey;
          runtime.contextSummarized = this.loadContextSummarized(this.activeKey);
          const cached = this.context.workspaceState.get<ChatMessage[]>(
            `claude-luxure.messages.${this.activeKey}`
          );
          if (cached) {
            runtime.messages = cached.map((m) => ({ ...m, isStreaming: false }));
          }
        }
        this.runtimes.set(this.activeKey, runtime);
      }
    }
  }

  private persistRuntime(key: string, runtime: SessionRuntime): void {
    const persistId = runtime.sessionId;
    if (persistId && runtime.messages.length > 0) {
      this.context.workspaceState.update(
        `claude-luxure.messages.${persistId}`,
        runtime.messages.filter((m) => !m.isStreaming)
      );
      this.context.workspaceState.update("claude-luxure.lastSessionId", persistId);
      this.context.workspaceState.update(
        `claude-luxure.contextSummarized.${persistId}`,
        runtime.contextSummarized ?? false
      );
    }
    this.context.workspaceState.update("claude-luxure.openTabs", this.openTabIds);
  }

  private loadContextSummarized(key: string): boolean {
    if (isDraftKey(key)) {
      return false;
    }
    return (
      this.context.workspaceState.get<boolean>(
        `claude-luxure.contextSummarized.${key}`
      ) ?? false
    );
  }

  private persistActiveSession(): void {
    const runtime = this.runtimes.get(this.activeKey);
    if (runtime) {
      this.persistRuntime(this.activeKey, runtime);
    }
  }

  private getSessionManager(): SessionManager | undefined {
    const wp = this.getWorkspacePath();
    if (!wp) return undefined;
    if (!this.sessionManager) {
      this.sessionManager = new SessionManager(wp);
    }
    return this.sessionManager;
  }

  private async handleListSessions(): Promise<void> {
    const mgr = this.getSessionManager();
    if (!mgr) return;
    const sessions = await mgr.listSessions();
    this.postMessage({ type: "sessionList", sessions });
  }

  private async loadRuntimeMessages(key: string, runtime: SessionRuntime): Promise<void> {
    if (isDraftKey(key)) {
      runtime.messages = [];
      return;
    }

    runtime.sessionId = key;
    runtime.contextSummarized = this.loadContextSummarized(key);
    const cached = this.context.workspaceState.get<ChatMessage[]>(`claude-luxure.messages.${key}`);
    if (cached && cached.length > 0) {
      runtime.messages = cached.map((m) => ({ ...m, isStreaming: false }));
      return;
    }

    const mgr = this.getSessionManager();
    if (mgr) {
      const rawMsgs = await mgr.getSessionMessages(key);
      runtime.messages = rawMsgs.map((m, i) => ({
        id: `restored-${i}-${Date.now()}`,
        role: m.role as "user" | "assistant",
        content: m.content,
        timestamp: new Date(m.timestamp).getTime() || Date.now(),
      }));
    } else {
      runtime.messages = [];
    }
  }

  private async handleSwitchSession(sessionId: string): Promise<void> {
    this.persistActiveSession();

    if (!this.openTabIds.includes(sessionId)) {
      this.openTabIds.unshift(sessionId);
    }

    this.activeKey = sessionId;

    if (!this.runtimes.has(sessionId)) {
      const runtime = createEmptyRuntime();
      runtime.sessionId = sessionId;
      await this.loadRuntimeMessages(sessionId, runtime);
      this.runtimes.set(sessionId, runtime);
    }

    this.context.workspaceState.update("claude-luxure.lastSessionId", sessionId);
    this.persistActiveSession();
    this.sendState();
    this.sendOpenTabs();
  }

  private stopRuntimeBridge(key: string, runtime: SessionRuntime): void {
    runtime.bridge?.stop();
    runtime.bridge = undefined;
    runtime.cliStatus = "stopped";
    if (runtime.streamingMessageId) {
      this.finalizeStreamingMessage(key, runtime, false);
    }
  }

  private handleCloseTab(tabId: string): void {
    const runtime = this.runtimes.get(tabId);
    if (runtime) {
      this.stopRuntimeBridge(tabId, runtime);
      this.runtimes.delete(tabId);
    }

    this.openTabIds = this.openTabIds.filter((id) => id !== tabId);

    if (this.activeKey === tabId) {
      if (this.openTabIds.length > 0) {
        void this.handleSwitchSession(this.openTabIds[0]);
        return;
      }
      this.handleNewConversation();
      return;
    }

    this.persistActiveSession();
    this.sendOpenTabs();
    this.sendState();
  }

  private sendOpenTabs(): void {
    this.postMessage({ type: "openTabs", tabIds: this.openTabIds });
  }

  private handleNewConversation(): void {
    this.persistActiveSession();

    const draftKey = this.createDraftRuntime();
    this.openTabIds.unshift(draftKey);
    this.activeKey = draftKey;

    this.sendState();
    this.sendOpenTabs();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    log("INFO", "resolveWebviewView called — panel opening");
    this.webview = webviewView.webview;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(
          path.join(this.context.extensionPath, "webview-ui", "dist")
        ),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleWebviewMessage(msg),
      undefined,
      this.context.subscriptions
    );

    webviewView.onDidDispose(() => {
      this.webview = undefined;
    });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const distPath = path.join(
      this.context.extensionPath,
      "webview-ui",
      "dist"
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(distPath, "assets", "index.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(distPath, "assets", "index.css"))
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Luxure</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    log("INFO", "Webview message received:", message.type);
    switch (message.type) {
      case "ready":
        log("INFO", "Webview ready, sending state");
        this.sendState();
        this.sendOpenTabs();
        this.handleListSessions();
        break;

      case "sendMessage":
        log("INFO", "sendMessage:", (message as any).text?.slice(0, 100));
        await this.handleSendMessage(
          message.text,
          message.images,
          message.mentions
        );
        break;

      case "cancelRequest": {
        const runtime = this.getActiveRuntime();
        this.stopRuntimeBridge(this.activeKey, runtime);
        if (this.isActiveKey(this.activeKey)) {
          this.postMessage({ type: "streamEnd" });
          this.sendState();
        }
        break;
      }

      case "mode":
        this.mode = message.mode;
        {
          const runtime = this.getActiveRuntime();
          if (runtime.bridge) {
            runtime.bridge.restart({ mode: this.mode });
          }
        }
        this.sendState();
        break;

      case "changeModel":
        this.model = message.model;
        this.context.workspaceState.update("claude-luxure.model", this.model);
        {
          const runtime = this.getActiveRuntime();
          runtime.lastContext = undefined;
          if (runtime.bridge) {
            runtime.bridge.restart({ model: this.model });
          }
        }
        this.sendState();
        break;

      case "changeEffort":
        this.effort = message.effort;
        this.context.workspaceState.update("claude-luxure.effort", this.effort);
        {
          const runtime = this.getActiveRuntime();
          if (runtime.bridge) {
            runtime.bridge.restart({ effort: this.effort });
          }
        }
        this.sendState();
        break;

      case "acceptChange":
        await this.diffManager.acceptChange(message.filePath);
        this.sendState();
        break;

      case "rejectChange":
        await this.diffManager.rejectChange(message.filePath);
        this.sendState();
        break;

      case "acceptAllChanges":
        await this.diffManager.acceptAll();
        this.sendState();
        break;

      case "rejectAllChanges":
        await this.diffManager.rejectAll();
        this.sendState();
        break;

      case "newConversation":
        this.handleNewConversation();
        break;

      case "switchSession":
        await this.handleSwitchSession(message.sessionId);
        break;

      case "closeTab":
        this.handleCloseTab(message.sessionId);
        break;

      case "listSessions":
        await this.handleListSessions();
        break;

      case "searchFiles":
        await this.handleFileSearch(message.query);
        break;

      case "openFile":
        const doc = await vscode.workspace.openTextDocument(message.filePath);
        await vscode.window.showTextDocument(doc, { preview: true });
        break;

      case "listSkills":
        this.handleListSkills();
        break;

      case "readSkill":
        this.handleReadSkill(message.skillId);
        break;

      case "saveSkill":
        await this.handleSaveSkill(message.skillId, message.content);
        break;

      case "createSkill":
        await this.handleCreateSkill(message.scope, message.name);
        break;

      case "deleteSkill":
        await this.handleDeleteSkill(message.skillId);
        break;
    }
  }

  private handleListSkills(): void {
    try {
      const skills = this.skillsManager.listSkills(this.getWorkspacePath());
      this.postMessage({ type: "skillsList", skills });
    } catch (err) {
      this.postSkillsError(err);
    }
  }

  private handleReadSkill(skillId: string): void {
    try {
      const content = this.skillsManager.readSkill(
        skillId,
        this.getWorkspacePath()
      );
      this.postMessage({ type: "skillContent", skillId, content });
    } catch (err) {
      this.postSkillsError(err);
    }
  }

  private async handleSaveSkill(
    skillId: string,
    content: string
  ): Promise<void> {
    try {
      this.skillsManager.writeSkill(
        skillId,
        content,
        this.getWorkspacePath()
      );
      await this.reloadCliSkills();
      const skills = this.skillsManager.listSkills(this.getWorkspacePath());
      this.postMessage({ type: "skillsList", skills });
      this.postMessage({ type: "skillsSaved", skillId });
    } catch (err) {
      this.postSkillsError(err);
    }
  }

  private async handleCreateSkill(
    scope: SkillScope,
    name: string
  ): Promise<void> {
    try {
      const skill = this.skillsManager.createSkill(
        scope,
        name,
        this.getWorkspacePath()
      );
      await this.reloadCliSkills();
      const skills = this.skillsManager.listSkills(this.getWorkspacePath());
      this.postMessage({ type: "skillsList", skills });
      this.postMessage({ type: "skillContent", skillId: skill.id, content: this.skillsManager.readSkill(skill.id, this.getWorkspacePath()) });
      this.postMessage({ type: "skillsSaved", skillId: skill.id });
    } catch (err) {
      this.postSkillsError(err);
    }
  }

  private async handleDeleteSkill(skillId: string): Promise<void> {
    try {
      this.skillsManager.deleteSkill(skillId, this.getWorkspacePath());
      await this.reloadCliSkills();
      const skills = this.skillsManager.listSkills(this.getWorkspacePath());
      this.postMessage({ type: "skillsList", skills });
    } catch (err) {
      this.postSkillsError(err);
    }
  }

  private postSkillsError(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: "skillsError", error });
  }

  private async reloadCliSkills(): Promise<void> {
    const runtime = this.getActiveRuntime();
    const bridge = runtime.bridge;
    if (
      bridge &&
      (bridge.status === "ready" || bridge.status === "busy")
    ) {
      bridge.sendMessage("/reload-skills");
    }
  }

  private async handleSendMessage(
    text: string,
    images?: string[],
    _mentions?: string[]
  ): Promise<void> {
    const runtimeKey = this.activeKey || this.createDraftRuntime();
    if (!this.activeKey) {
      this.activeKey = runtimeKey;
      if (!this.openTabIds.includes(runtimeKey)) {
        this.openTabIds.unshift(runtimeKey);
        this.sendOpenTabs();
      }
    }
    const runtime = this.getActiveRuntime();

    if (!runtime.sessionName && !runtime.sessionId && !isSlashCommand(text)) {
      runtime.sessionName = sessionNameFromText(text);
    }

    if (!runtime.bridge || runtime.bridge.status === "stopped") {
      await this.startBridge(runtimeKey, runtime);
    }

    const { displayText, cliText } = resolveSlashCommand(text);
    const workspacePath = this.getWorkspacePath();
    let resolvedText = cliText;

    if (workspacePath && !isSlashCommand(text)) {
      const fileMentions = extractMentions(text);
      for (const mention of fileMentions) {
        const absPath = resolveFromMention(mention, workspacePath);
        try {
          const content = fs.readFileSync(absPath, "utf-8");
          resolvedText = resolvedText.replace(
            mention,
            `\n<file path="${absPath}">\n${content}\n</file>\n`
          );
        } catch {
          // File not readable, leave mention as-is
        }
      }
    }

    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: displayText,
      images,
      timestamp: Date.now(),
    };
    runtime.messages.push(userMessage);
    if (this.isActiveKey(runtimeKey)) {
      this.postMessage({ type: "message", message: userMessage });
    }

    runtime.bridge?.sendMessage(resolvedText, images);

    runtime.streamingMessageId = generateId();
    runtime.currentStreamText = "";
    const assistantMessage: ChatMessage = {
      id: runtime.streamingMessageId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    runtime.messages.push(assistantMessage);
    if (this.isActiveKey(runtimeKey)) {
      this.postMessage({ type: "message", message: assistantMessage });
    }

    this.sendState();
  }

  private async startBridge(runtimeKey: string, runtime: SessionRuntime): Promise<void> {
    log("INFO", "startBridge called for", runtimeKey);
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      this.postMessage({ type: "error", error: "No workspace folder open" });
      return;
    }

    if (runtime.sessionId) {
      const existing = this.findBridgeForSessionId(runtime.sessionId);
      if (existing && existing.status !== "stopped") {
        runtime.bridge = existing;
        runtime.cliStatus = existing.status;
        return;
      }
    }

    const bridge = new ClaudeBridge({
      cwd: workspacePath,
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      sessionId: runtime.sessionId,
      sessionName: runtime.sessionName,
    });

    runtime.bridge = bridge;
    this.attachBridgeHandlers(runtimeKey, runtime, bridge);

    if (!this.diffWatchStarted) {
      this.diffManager.startWatching(workspacePath);
      this.diffWatchStarted = true;
    }

    await bridge.start();
  }

  private attachBridgeHandlers(
    runtimeKey: string,
    runtime: SessionRuntime,
    bridge: ClaudeBridge
  ): void {
    const isActive = () => this.isActiveKey(runtimeKey);

    bridge.on("slashCommands", (commands: string[]) => {
      this.slashCommands = commands;
      this.postMessage({ type: "slashCommands", commands });
      if (isActive()) {
        this.sendState();
      }
    });

    bridge.on("compactBoundary", (event: ClaudeEvent) => {
      const meta = (event as any).compact_metadata;
      log(
        "INFO",
        "Compact boundary reached for session:",
        runtimeKey,
        meta ? `pre_tokens=${meta.pre_tokens} trigger=${meta.trigger}` : ""
      );
      runtime.contextSummarized = true;
      if (isActive()) {
        this.sendState();
      }
    });

    bridge.on("status", (status: string) => {
      log("INFO", "CLI status:", status, "session:", runtimeKey);
      runtime.cliStatus = status as ExtensionState["cliStatus"];

      if (status === "ready" && bridge.sessionId) {
        const newSessionId = bridge.sessionId;
        if (isDraftKey(runtimeKey)) {
          this.migrateDraftToSession(runtimeKey, newSessionId, runtime);
          runtimeKey = newSessionId;
        } else if (!runtime.sessionId) {
          runtime.sessionId = newSessionId;
          if (!this.openTabIds.includes(newSessionId)) {
            this.openTabIds.unshift(newSessionId);
            this.sendOpenTabs();
          }
        }
        this.context.workspaceState.update("claude-luxure.lastSessionId", newSessionId);
        log("INFO", "Session ID captured:", newSessionId);
      }

      if (
        (status === "stopped" || status === "error") &&
        runtime.streamingMessageId
      ) {
        this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      }

      if (isActive()) {
        this.postMessage({
          type: "cliStatus",
          status: runtime.cliStatus,
        });
        this.sendState();
      }
    });

    bridge.on("exit", () => {
      if (runtime.streamingMessageId) {
        this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      }
    });

    bridge.on("textDelta", (text: string) => {
      runtime.currentStreamText += text;
      if (runtime.streamingMessageId) {
        const msg = runtime.messages.find((m) => m.id === runtime.streamingMessageId);
        if (msg) {
          msg.content = runtime.currentStreamText;
        }
      }
      if (isActive()) {
        this.postMessage({ type: "streamToken", text });
      }
    });

    bridge.on("assistant", (event: ClaudeEvent) => {
      this.handleAssistantEvent(event);
    });

    bridge.on("assistantText", (text: string) => {
      log("INFO", "assistantText received, length:", text.length);
      if (runtime.streamingMessageId && !runtime.currentStreamText) {
        runtime.currentStreamText = text;
        if (runtime.streamingMessageId) {
          const msg = runtime.messages.find((m) => m.id === runtime.streamingMessageId);
          if (msg) {
            msg.content = text;
          }
        }
        if (isActive()) {
          this.postMessage({ type: "streamToken", text });
        }
      }
    });

    bridge.on("result", (event: ClaudeEvent) => {
      log("INFO", "result received, finalizing message");
      this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      if (event.total_cost_usd !== undefined) {
        runtime.cost = {
          inputTokens: (event.total_input_tokens as number) || 0,
          outputTokens: (event.total_output_tokens as number) || 0,
          totalCostUsd: (event.total_cost_usd as number) || 0,
        };
        if (isActive()) {
          this.postMessage({ type: "costUpdate", cost: runtime.cost });
        }
      }
    });

    bridge.on("contextUpdate", (ctx: ContextInfo) => {
      log("INFO", "Context update:", ctx.model, `${ctx.inputTokens}/${ctx.contextWindow}`);
      runtime.lastContext = ctx;
      if (isActive()) {
        this.postMessage({ type: "contextUpdate", context: ctx });
        this.sendState();
      }
    });

    bridge.on("activity", (activity: ActivityEvent) => {
      if (isActive()) {
        this.postMessage({ type: "activity", activity });
      }
    });

    bridge.on("controlRequest", (event: ClaudeEvent) => {
      this.handleControlRequest(runtime, event);
    });

    bridge.on("error", (err: string) => {
      log("ERROR", "CLI error:", err);
      if (runtime.streamingMessageId) {
        this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      }
      if (isActive()) {
        this.postMessage({ type: "error", error: err });
      }
      this.outputChannel.appendLine(`[ERROR] ${err}`);
    });

    bridge.on("stderr", (text: string) => {
      log("STDERR", text);
      this.outputChannel.appendLine(`[stderr] ${text}`);
    });

    bridge.on("event", (event: ClaudeEvent) => {
      log("EVENT", event.type, event.subtype || "");
    });

    bridge.on("rawOutput", (text: string) => {
      log("RAW", text.slice(0, 200));
    });
  }

  private handleAssistantEvent(event: ClaudeEvent): void {
    const message = event.message as any;
    if (!message?.content) {
      return;
    }

    for (const block of message.content) {
      if (block.type === "tool_use") {
        const toolName = block.name as string;
        const input = block.input as Record<string, unknown>;

        if (this.isWriteTool(toolName) && input.file_path) {
          const filePath = input.file_path as string;
          this.snapshotManager.capture(filePath);
        }
      }
    }
  }

  private handleControlRequest(runtime: SessionRuntime, event: ClaudeEvent): void {
    const subtype = event.subtype as string;

    if (subtype === "can_use_tool") {
      const toolName = (event as any).tool_name as string;
      const toolInput = (event as any).tool_input as Record<string, unknown>;

      if (this.isWriteTool(toolName) && toolInput?.file_path) {
        this.snapshotManager.capture(toolInput.file_path as string);
      }

      runtime.bridge?.sendControlResponse({
        type: "control_response",
        subtype: "can_use_tool",
        request_id: (event as any).request_id,
        allowed: true,
      });
    }
  }

  private isWriteTool(name: string): boolean {
    const writeTools = [
      "write_to_file",
      "WriteToFile",
      "Write",
      "edit_file",
      "EditFile",
      "Edit",
      "apply_diff",
      "ApplyDiff",
      "search_replace",
      "SearchReplace",
      "Bash",
      "bash",
    ];
    return writeTools.includes(name);
  }

  private finalizeStreamingMessage(
    runtimeKey: string,
    runtime: SessionRuntime,
    notifyWebview: boolean
  ): void {
    if (!runtime.streamingMessageId) {
      return;
    }

    const msg = runtime.messages.find((m) => m.id === runtime.streamingMessageId);
    if (msg) {
      msg.isStreaming = false;
      msg.content = runtime.currentStreamText;
    }

    const lastUserMessage = [...runtime.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage && isCompactCommand(lastUserMessage.content)) {
      runtime.contextSummarized = true;
    }

    runtime.streamingMessageId = null;
    runtime.currentStreamText = "";

    if (runtime.bridge?.sessionId && !runtime.sessionId) {
      runtime.sessionId = runtime.bridge.sessionId;
    }

    this.persistRuntime(runtimeKey, runtime);

    if (notifyWebview) {
      this.postMessage({ type: "streamEnd" });

      const pendingDiffs = this.diffManager.getPendingDiffs();
      for (const diff of pendingDiffs) {
        this.diffManager.openDiffEditor(diff.filePath);
      }

      this.sendState();
    } else {
      this.sendState();
    }
  }

  private async handleFileSearch(query: string): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      return;
    }

    try {
      const files = await vscode.workspace.findFiles(
        `**/*${query}*`,
        "**/node_modules/**",
        50
      );
      const relativePaths = files.map((f) =>
        path.relative(workspacePath, f.fsPath).replace(/\\/g, "/")
      );
      this.postMessage({
        type: "fileSearchResults",
        files: relativePaths,
      });
    } catch {
      this.postMessage({ type: "fileSearchResults", files: [] });
    }
  }

  private getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  addFileToChat(relativePath: string): void {
    this.webview?.postMessage({
      type: "addFile",
      filePath: relativePath,
    } as any);
  }

  private postMessage(message: ExtensionMessage): void {
    this.webview?.postMessage(message);
  }

  private sendState(): void {
    const runtime = this.getActiveRuntime();
    this.postMessage({
      type: "state",
      state: {
        mode: this.mode,
        model: this.model,
        effort: this.effort,
        messages: runtime.messages,
        cliStatus: runtime.bridge?.status || runtime.cliStatus || "stopped",
        pendingDiffs: this.diffManager.getPendingDiffs(),
        sessionId: runtime.sessionId,
        activeTabId: this.activeKey,
        isStreaming: !!runtime.streamingMessageId,
        streamingText: runtime.currentStreamText,
        runningSessionIds: this.getRunningSessionIds(),
        cost: runtime.cost,
        contextInfo: runtime.lastContext,
        workspacePath: this.getWorkspacePath(),
        accountEmail: this.accountEmail,
        accountOrg: this.accountOrg,
        slashCommands: this.slashCommands,
        contextSummarized: runtime.contextSummarized ?? false,
      },
    });
  }

  getDiffManager(): DiffManager {
    return this.diffManager;
  }

  dispose(): void {
    for (const [key, runtime] of this.runtimes) {
      this.persistRuntime(key, runtime);
      runtime.bridge?.stop();
    }
    this.diffManager.dispose();
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
