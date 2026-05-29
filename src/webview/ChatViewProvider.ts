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
  EffortLevel,
  ExtensionMessage,
  ExtensionState,
  Mode,
  WebviewMessage,
} from "../shared/types";
import { extractMentions, resolveFromMention } from "../utils/path-mentions";
import { log } from "../utils/logger";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-luxure.chatView";

  private webview: vscode.Webview | undefined;
  private bridge: ClaudeBridge | undefined;
  private messages: ChatMessage[] = [];
  private mode: Mode = "agent";
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private currentStreamText = "";
  private streamingMessageId: string | null = null;
  private snapshotManager = new SnapshotManager();
  private diffManager = new DiffManager(this.snapshotManager);
  private accountEmail: string | undefined;
  private accountOrg: string | undefined;
  private lastContext: ContextInfo | undefined;
  private currentSessionId: string | undefined;
  private openTabIds: string[] = [];
  private sessionManager: SessionManager | undefined;

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
      } catch (parseErr) {
        log("WARN", "Failed to parse account info:", stdout.slice(0, 200));
      }
    });
  }

  private restoreLastSession(): void {
    this.openTabIds = this.context.workspaceState.get<string[]>("claude-luxure.openTabs") || [];
    const lastSessionId = this.context.workspaceState.get<string>("claude-luxure.lastSessionId");
    if (lastSessionId) {
      this.currentSessionId = lastSessionId;
      if (!this.openTabIds.includes(lastSessionId)) {
        this.openTabIds.unshift(lastSessionId);
      }
      const cached = this.context.workspaceState.get<ChatMessage[]>(`claude-luxure.messages.${lastSessionId}`);
      if (cached && cached.length > 0) {
        this.messages = cached.map((m) => ({ ...m, isStreaming: false }));
        log("INFO", `Restored ${cached.length} messages for session ${lastSessionId}`);
      }
    }
  }

  private persistSession(): void {
    if (this.currentSessionId && this.messages.length > 0) {
      this.context.workspaceState.update(
        `claude-luxure.messages.${this.currentSessionId}`,
        this.messages.filter((m) => !m.isStreaming)
      );
      this.context.workspaceState.update("claude-luxure.lastSessionId", this.currentSessionId);
    }
    this.context.workspaceState.update("claude-luxure.openTabs", this.openTabIds);
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

  private async handleSwitchSession(sessionId: string): Promise<void> {
    this.persistSession();
    this.bridge?.stop();
    this.bridge = undefined;

    this.currentSessionId = sessionId;
    this.currentStreamText = "";
    this.streamingMessageId = null;
    this.lastContext = undefined;

    if (!this.openTabIds.includes(sessionId)) {
      this.openTabIds.unshift(sessionId);
    }

    const cached = this.context.workspaceState.get<ChatMessage[]>(`claude-luxure.messages.${sessionId}`);
    if (cached && cached.length > 0) {
      this.messages = cached.map((m) => ({ ...m, isStreaming: false }));
    } else {
      const mgr = this.getSessionManager();
      if (mgr) {
        const rawMsgs = await mgr.getSessionMessages(sessionId);
        this.messages = rawMsgs.map((m, i) => ({
          id: `restored-${i}-${Date.now()}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.timestamp).getTime() || Date.now(),
        }));
      } else {
        this.messages = [];
      }
    }

    this.context.workspaceState.update("claude-luxure.lastSessionId", sessionId);
    this.persistSession();
    this.sendState();
    this.sendOpenTabs();
  }

  private handleCloseTab(sessionId: string): void {
    this.openTabIds = this.openTabIds.filter((id) => id !== sessionId);
    if (this.currentSessionId === sessionId) {
      if (this.openTabIds.length > 0) {
        this.handleSwitchSession(this.openTabIds[0]);
        return;
      } else {
        this.handleNewConversation();
        return;
      }
    }
    this.persistSession();
    this.sendOpenTabs();
  }

  private sendOpenTabs(): void {
    this.postMessage({ type: "openTabs", tabIds: this.openTabIds });
  }

  private handleNewConversation(): void {
    this.persistSession();
    this.bridge?.stop();
    this.bridge = undefined;

    this.currentSessionId = undefined;
    this.messages = [];
    this.currentStreamText = "";
    this.streamingMessageId = null;
    this.lastContext = undefined;

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

      case "cancelRequest":
        this.bridge?.stop();
        if (this.streamingMessageId) {
          this.finalizeStreamingMessage();
        }
        break;

      case "mode":
        this.mode = message.mode;
        if (this.bridge) {
          this.bridge.restart({ mode: this.mode });
        }
        this.sendState();
        break;

      case "changeModel":
        this.model = message.model;
        this.lastContext = undefined;
        this.context.workspaceState.update("claude-luxure.model", this.model);
        if (this.bridge) {
          this.bridge.restart({ model: this.model });
        }
        this.sendState();
        break;

      case "changeEffort":
        this.effort = message.effort;
        this.context.workspaceState.update("claude-luxure.effort", this.effort);
        if (this.bridge) {
          this.bridge.restart({ effort: this.effort });
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
    }
  }

  private async handleSendMessage(
    text: string,
    images?: string[],
    mentions?: string[]
  ): Promise<void> {
    if (!this.bridge || this.bridge.status === "stopped") {
      await this.startBridge();
    }

    const workspacePath = this.getWorkspacePath();
    let resolvedText = text;

    if (workspacePath) {
      const fileMentions = extractMentions(text);
      for (const mention of fileMentions) {
        const absPath = resolveFromMention(mention, workspacePath);
        try {
          const content = fs.readFileSync(absPath, "utf-8");
          const label = mention;
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
      content: text,
      images,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);
    this.postMessage({ type: "message", message: userMessage });

    this.bridge?.sendMessage(resolvedText, images);

    this.streamingMessageId = generateId();
    this.currentStreamText = "";
    const assistantMessage: ChatMessage = {
      id: this.streamingMessageId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    this.messages.push(assistantMessage);
    this.postMessage({ type: "message", message: assistantMessage });
  }

  private async startBridge(): Promise<void> {
    log("INFO", "startBridge called");
    const workspacePath = this.getWorkspacePath();
    log("INFO", "workspacePath:", workspacePath);
    if (!workspacePath) {
      this.postMessage({
        type: "error",
        error: "No workspace folder open",
      });
      return;
    }

    this.bridge = new ClaudeBridge({
      cwd: workspacePath,
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      sessionId: this.currentSessionId,
    });

    this.bridge.on("status", (status: string) => {
      log("INFO", "CLI status:", status);
      if (status === "ready" && this.bridge?.sessionId && !this.currentSessionId) {
        this.currentSessionId = this.bridge.sessionId;
        if (!this.openTabIds.includes(this.currentSessionId)) {
          this.openTabIds.unshift(this.currentSessionId);
          this.sendOpenTabs();
        }
        this.context.workspaceState.update("claude-luxure.lastSessionId", this.currentSessionId);
        log("INFO", "Session ID captured:", this.currentSessionId);
      }
      this.postMessage({
        type: "cliStatus",
        status: status as ExtensionState["cliStatus"],
      });
    });

    this.bridge.on("textDelta", (text: string) => {
      this.currentStreamText += text;
      this.postMessage({ type: "streamToken", text });

      if (this.streamingMessageId) {
        const msg = this.messages.find(
          (m) => m.id === this.streamingMessageId
        );
        if (msg) {
          msg.content = this.currentStreamText;
        }
      }
    });

    this.bridge.on("assistant", (event: ClaudeEvent) => {
      this.handleAssistantEvent(event);
    });

    this.bridge.on("assistantText", (text: string) => {
      log("INFO", "assistantText received, length:", text.length);
      if (this.streamingMessageId && !this.currentStreamText) {
        this.currentStreamText = text;
        this.postMessage({ type: "streamToken", text });
        if (this.streamingMessageId) {
          const msg = this.messages.find(
            (m) => m.id === this.streamingMessageId
          );
          if (msg) {
            msg.content = text;
          }
        }
      }
    });

    this.bridge.on("result", (event: ClaudeEvent) => {
      log("INFO", "result received, finalizing message");
      this.finalizeStreamingMessage();
      if (event.total_cost_usd !== undefined) {
        this.postMessage({
          type: "costUpdate",
          cost: {
            inputTokens: (event.total_input_tokens as number) || 0,
            outputTokens: (event.total_output_tokens as number) || 0,
            totalCostUsd: (event.total_cost_usd as number) || 0,
          },
        });
      }
    });

    this.bridge.on("contextUpdate", (ctx: ContextInfo) => {
      log("INFO", "Context update:", ctx.model, `${ctx.inputTokens}/${ctx.contextWindow}`);
      this.lastContext = ctx;
      this.postMessage({ type: "contextUpdate", context: ctx });
    });

    this.bridge.on("activity", (activity: ActivityEvent) => {
      this.postMessage({ type: "activity", activity });
    });

    this.bridge.on("controlRequest", (event: ClaudeEvent) => {
      this.handleControlRequest(event);
    });

    this.bridge.on("error", (err: string) => {
      log("ERROR", "CLI error:", err);
      this.postMessage({ type: "error", error: err });
      this.outputChannel.appendLine(`[ERROR] ${err}`);
    });

    this.bridge.on("stderr", (text: string) => {
      log("STDERR", text);
      this.outputChannel.appendLine(`[stderr] ${text}`);
    });

    this.bridge.on("event", (event: ClaudeEvent) => {
      log("EVENT", event.type, event.subtype || "");
    });

    this.bridge.on("rawOutput", (text: string) => {
      log("RAW", text.slice(0, 200));
    });

    this.diffManager.startWatching(workspacePath);
    await this.bridge.start();
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

  private handleControlRequest(event: ClaudeEvent): void {
    const subtype = event.subtype as string;

    if (subtype === "can_use_tool") {
      const toolName = (event as any).tool_name as string;
      const toolInput = (event as any).tool_input as Record<string, unknown>;

      if (this.isWriteTool(toolName) && toolInput?.file_path) {
        this.snapshotManager.capture(toolInput.file_path as string);
      }

      this.bridge?.sendControlResponse({
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

  private finalizeStreamingMessage(): void {
    if (this.streamingMessageId) {
      const msg = this.messages.find(
        (m) => m.id === this.streamingMessageId
      );
      if (msg) {
        msg.isStreaming = false;
        msg.content = this.currentStreamText;
      }
      this.streamingMessageId = null;
      this.currentStreamText = "";
      this.postMessage({ type: "streamEnd" });

      if (this.bridge?.sessionId) {
        this.currentSessionId = this.bridge.sessionId;
      }
      this.persistSession();

      const pendingDiffs = this.diffManager.getPendingDiffs();
      for (const diff of pendingDiffs) {
        this.diffManager.openDiffEditor(diff.filePath);
      }

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
    this.postMessage({
      type: "state",
      state: {
        mode: this.mode,
        model: this.model,
        effort: this.effort,
        messages: this.messages,
        cliStatus: this.bridge?.status || "stopped",
        pendingDiffs: this.diffManager.getPendingDiffs(),
        sessionId: this.currentSessionId || this.bridge?.sessionId,
        workspacePath: this.getWorkspacePath(),
        accountEmail: this.accountEmail,
        accountOrg: this.accountOrg,
      },
    });
  }

  getDiffManager(): DiffManager {
    return this.diffManager;
  }

  dispose(): void {
    this.persistSession();
    this.bridge?.stop();
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
