import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import * as crypto from "crypto";
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
  McpConnectionState,
  McpServerStatus,
  Mode,
  StoredAccount,
  TimelinePart,
  UsageBucket,
  UsageInfo,
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

const ROOT_FORK_ANCHOR = "ROOT";

/** Attach a tool_result to the tool_use it belongs to (matched by id) so the
 * call and its output stay one entry. Multiple result blocks for one call (e.g.
 * an MCP tool_reference block + a text block) concatenate; a later non-empty
 * block is never clobbered by an empty one. */
function attachToolResult(acts: ActivityEvent[], e: ActivityEvent): void {
  if (e.type !== "tool_result" || !e.toolUseId) {
    return;
  }
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.type === "tool_use" && a.toolUseId === e.toolUseId) {
      if (a.result) {
        if (e.content) {
          a.result.content = a.result.content
            ? `${a.result.content}\n${e.content}`
            : e.content;
        }
        if (e.isError) {
          a.result.isError = true;
        }
      } else {
        a.result = { content: e.content, isError: e.isError };
      }
      return;
    }
  }
}

interface ForkVersion {
  sessionId?: string;
  tail: ChatMessage[];
}

interface ForkGroup {
  versions: ForkVersion[];
  activeIndex: number;
}

/** A per-turn snapshot of files before Claude first edits them, keyed by the
 * user message that opened the turn. Powers Cursor-style "restore code" when the
 * conversation is forked from an earlier message. */
interface FileCheckpoint {
  userMsgId: string;
  files: Map<string, string | null>; // null = the file did not exist yet
}

interface SessionRuntime {
  sessionId?: string;
  draftId?: string;
  forks?: Record<string, ForkGroup>;
  checkpoints: FileCheckpoint[];
  messages: ChatMessage[];
  bridge?: ClaudeBridge;
  streamingMessageId: string | null;
  currentStreamText: string;
  /** Set when a tool/thinking block interrupts text, so the next text delta
   * starts a fresh paragraph instead of being glued onto the previous one. */
  pendingParagraphBreak?: boolean;
  currentActivities: ActivityEvent[];
  /** Ordered prose/activity segments for the in-flight assistant turn; copied
   * onto the message at finalize so rendering preserves order of appearance. */
  currentTimeline: TimelinePart[];
  lastContext?: ContextInfo;
  cost?: CostInfo;
  cliStatus: ExtensionState["cliStatus"];
  sessionName?: string;
  contextSummarized?: boolean;
  /** Which account (StoredAccount.id) this conversation is bound to. "default"
   * or undefined → ambient keychain login; otherwise an isolated config-dir. */
  accountId?: string;
}

function createEmptyRuntime(): SessionRuntime {
  return {
    messages: [],
    checkpoints: [],
    streamingMessageId: null,
    currentStreamText: "",
    currentActivities: [],
    currentTimeline: [],
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

/** Opening line of the summary prompt. Any transcript whose first message
 * starts with this is a leftover print-mode summary call, not a real
 * conversation — used to keep it out of the history list. */
const SUMMARY_PROMPT_MARKER =
  "Below is the start of a conversation between a user and an AI coding assistant.";

/**
 * Render prior conversation turns as a context block for a rewound (edited)
 * conversation. After an edit we start a fresh CLI session, so earlier turns are
 * replayed as text. Any file edits from those turns are already on disk, so the
 * model can re-read files as needed rather than relying on transcript surgery.
 */
function renderSeedHistory(messages: ChatMessage[]): string {
  const turns: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const body = (m.content || "").trim();
    const imageNote =
      m.images && m.images.length > 0
        ? ` _[${m.images.length} image(s) omitted]_`
        : "";
    if (!body && !imageNote) {
      continue;
    }
    const label = m.role === "user" ? "User" : "Assistant";
    turns.push(`### ${label}\n${body}${imageNote}`);
  }
  if (turns.length === 0) {
    return "";
  }
  return [
    "<previous_conversation>",
    "The user rewound to an earlier point in our conversation. The exchange below already happened and is provided only as context; any file changes from it are already saved on disk. Continue naturally from here in response to the new message that follows — do not greet, summarize, or repeat this history unless asked.",
    "",
    turns.join("\n\n"),
    "</previous_conversation>",
  ].join("\n");
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-luxure.chatView";

  private webview: vscode.Webview | undefined;
  private webviewView: vscode.WebviewView | undefined;
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
  private accountSubscription: string | undefined;
  private usagePollTimer: ReturnType<typeof setInterval> | undefined;
  private usagePollInFlight = false;
  private usageAllInFlight = false;
  private cachedCliVersion: string | undefined;
  // Cache per keychain service name: the global "Claude Code-credentials"
  // (Default) plus one per config-dir account ("…-<sha256(configDir)[:8]>").
  private cachedKeychainTokens = new Map<
    string,
    { token: string; at: number }
  >();

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
        this.accountSubscription = info.subscriptionType;
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
        this.sendAccountsList();
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
    if (persistId && runtime.accountId && runtime.accountId !== "default") {
      this.context.workspaceState.update(
        `claude-luxure.accountFor.${persistId}`,
        runtime.accountId
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

  /** Anchor the "Context summarized" divider to the most recent settled
   * message, so it stays put as new messages are appended below it. */
  private markCompactBoundary(runtime: SessionRuntime): void {
    for (let i = runtime.messages.length - 1; i >= 0; i--) {
      const m = runtime.messages[i];
      if (m.isStreaming) {
        continue;
      }
      m.compactBoundary = true;
      return;
    }
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
    // Merge in any Claude-generated title/summary persisted for each session so
    // the list shows the friendly title and hover summary across reloads. Drop
    // any leftover summary-prompt sessions so they never appear as history, and
    // self-heal any garbage titles persisted by the earlier buggy summarizer.
    const enriched = sessions
      .filter((s) => !s.firstMessage.startsWith(SUMMARY_PROMPT_MARKER))
      .map((s) => {
        let title = this.context.workspaceState.get<string>(
          `claude-luxure.sessionTitle.${s.id}`
        );
        let summary = this.context.workspaceState.get<string>(
          `claude-luxure.sessionSummary.${s.id}`
        );
        if (title !== undefined && !this.isUsableTitle(title)) {
          this.context.workspaceState.update(
            `claude-luxure.sessionTitle.${s.id}`,
            undefined
          );
          this.context.workspaceState.update(
            `claude-luxure.sessionSummary.${s.id}`,
            undefined
          );
          title = undefined;
          summary = undefined;
        }
        return { ...s, title, summary };
      });
    this.postMessage({ type: "sessionList", sessions: enriched });
  }

  /** A real generated title is short prose. Reject empties, raw JSON envelopes
   * ("{...") and the summary prompt itself — leftovers from the buggy version. */
  private isUsableTitle(title: string): boolean {
    const t = title.trim();
    return (
      t.length > 0 &&
      t.length <= 80 &&
      !t.startsWith("{") &&
      !t.startsWith(SUMMARY_PROMPT_MARKER)
    );
  }

  // ─────────────────────── Conversation summaries ───────────────────────
  // A one-shot `claude -p` call over the first interactions of a transcript
  // produces a short title + summary, persisted per-session in workspaceState.

  /** Sessions currently being summarized, to dedupe concurrent requests. */
  private summarizing = new Set<string>();

  /** Generate (or regenerate) the title + summary for a single conversation. */
  private async handleSummarizeSession(sessionId: string): Promise<void> {
    if (!sessionId || this.summarizing.has(sessionId)) return;
    this.summarizing.add(sessionId);
    this.postMessage({ type: "summarizeStatus", sessionId, status: "pending" });
    try {
      const result = await this.summarizeOne(sessionId);
      if (result) {
        this.postMessage({
          type: "summarizeStatus",
          sessionId,
          status: "done",
          title: result.title,
          summary: result.summary,
        });
      } else {
        this.postMessage({ type: "summarizeStatus", sessionId, status: "error" });
      }
    } catch (err) {
      log("WARN", "Failed to summarize session:", sessionId, String(err));
      this.postMessage({ type: "summarizeStatus", sessionId, status: "error" });
    } finally {
      this.summarizing.delete(sessionId);
    }
  }

  /** Summarize conversations from the last 7 days that haven't been processed
   * yet, with a small concurrency cap so we don't spawn many CLI processes at
   * once. Older or already-titled conversations are skipped. */
  private async handleSummarizeAllSessions(): Promise<void> {
    const mgr = this.getSessionManager();
    if (!mgr) return;
    const sessions = await mgr.listSessions();
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const pending = sessions.filter(
      (s) =>
        s.modifiedAt >= sevenDaysAgo &&
        !s.firstMessage.startsWith(SUMMARY_PROMPT_MARKER) &&
        !this.context.workspaceState.get<string>(
          `claude-luxure.sessionTitle.${s.id}`
        )
    );
    const total = pending.length;
    if (total === 0) {
      this.postMessage({ type: "summarizeProgress", done: 0, total: 0 });
      return;
    }

    let done = 0;
    let idx = 0;
    this.postMessage({ type: "summarizeProgress", done, total });
    const worker = async (): Promise<void> => {
      while (idx < pending.length) {
        const s = pending[idx++];
        await this.handleSummarizeSession(s.id);
        done++;
        this.postMessage({ type: "summarizeProgress", done, total });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, total) }, () => worker())
    );
    // total: 0 signals the webview to clear the progress indicator.
    this.postMessage({ type: "summarizeProgress", done: 0, total: 0 });
  }

  /** Read the first interactions, ask Claude for a title+summary, persist both. */
  private async summarizeOne(
    sessionId: string
  ): Promise<{ title: string; summary: string } | null> {
    const transcript = await this.buildSummaryTranscript(sessionId);
    if (!transcript) return null;
    const { title, summary } = await this.runClaudeSummary(transcript);
    if (title) {
      this.context.workspaceState.update(
        `claude-luxure.sessionTitle.${sessionId}`,
        title
      );
    }
    if (summary) {
      this.context.workspaceState.update(
        `claude-luxure.sessionSummary.${sessionId}`,
        summary
      );
    }
    return { title, summary };
  }

  /** Compact transcript of the first 10 interactions, used as summary input. */
  private async buildSummaryTranscript(
    sessionId: string
  ): Promise<string | null> {
    const mgr = this.getSessionManager();
    if (!mgr) return null;
    const msgs = await mgr.getSessionMessages(sessionId);
    if (msgs.length === 0) return null;
    return msgs
      .slice(0, 10)
      .map(
        (m) =>
          `${m.role.toUpperCase()}: ${m.content.replace(/\s+/g, " ").slice(0, 800)}`
      )
      .join("\n");
  }

  /** Spawn a headless `claude -p` (Haiku, JSON output) and parse {title,summary}.
   * Runs under the active conversation's account so auth matches the UI, and in
   * a throwaway cwd so the transient print-mode session is NOT written into the
   * project's transcript folder (which would otherwise pollute the history). */
  private runClaudeSummary(
    transcript: string
  ): Promise<{ title: string; summary: string }> {
    const prompt =
      `${SUMMARY_PROMPT_MARKER} Write a concise title and a short summary of ` +
      "what it is about. Respond with ONLY a JSON object, no markdown, no extra " +
      'text: {"title": "<max 6 words>", "summary": "<1-2 sentences>"}.\n\n' +
      `<conversation>\n${transcript}\n</conversation>`;

    const runtime = this.activeKey ? this.runtimes.get(this.activeKey) : undefined;
    const configDir = this.getConfigDirForAccount(runtime?.accountId);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (configDir) {
      env.CLAUDE_CONFIG_DIR = configDir;
    }
    // The CLI slugifies the *realpath* of cwd (e.g. macOS /tmp → /private/tmp),
    // so resolve it here too — otherwise the computed delete path won't match.
    let cwd = os.tmpdir();
    try {
      cwd = fs.realpathSync(cwd);
    } catch {
      // keep the unresolved path; deletion may then miss but cwd still works
    }

    return new Promise((resolve, reject) => {
      const child = execFile(
        "claude",
        [
          "-p",
          prompt,
          "--model",
          "claude-haiku-4-5-20251001",
          "--output-format",
          "json",
        ],
        { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          try {
            // The CLI wraps the model reply in a result envelope; the model's
            // text (our JSON) is in `.result`. It also writes a transcript for
            // this throwaway session — delete it so it never lingers anywhere.
            const envelope = JSON.parse(stdout.trim());
            if (typeof envelope.session_id === "string") {
              this.deleteTransientSession(configDir, cwd, envelope.session_id);
            }
            const text =
              typeof envelope.result === "string" ? envelope.result : stdout;
            resolve(this.parseTitleSummary(text));
          } catch {
            resolve(this.parseTitleSummary(stdout));
          }
        }
      );
      // The prompt is passed via -p; close stdin so the CLI doesn't wait ~3s
      // for piped input before proceeding.
      child.stdin?.end();
    });
  }

  /** Remove the transcript a throwaway print-mode summary session wrote under
   * `cwd`'s project slug, so summary calls don't litter the sessions store. */
  private deleteTransientSession(
    configDir: string | undefined,
    cwd: string,
    sessionId: string
  ): void {
    try {
      const base = configDir || path.join(os.homedir(), ".claude");
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const file = path.join(base, "projects", slug, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Non-fatal — worst case a transient session lingers in a temp slug.
    }
  }

  /** Extract {title, summary} from model text, tolerating code fences / prose. */
  private parseTitleSummary(text: string): { title: string; summary: string } {
    let body = text.trim();
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) body = fence[1].trim();
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(body.slice(start, end + 1));
        const title = String(obj.title || "").trim();
        const summary = String(obj.summary || "").trim();
        if (title || summary) {
          return { title: title || summary.slice(0, 40), summary: summary || title };
        }
      } catch {
        // fall through to heuristic
      }
    }
    const stripped = text.trim();
    return {
      title: stripped.split("\n")[0].slice(0, 50),
      summary: stripped.slice(0, 200),
    };
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
    this.sendAccountsList();
    void this.pollUsageForActive();
  }

  private stopRuntimeBridge(key: string, runtime: SessionRuntime): void {
    const bridge = runtime.bridge;
    runtime.bridge = undefined;
    runtime.cliStatus = "stopped";
    if (runtime.streamingMessageId) {
      this.finalizeStreamingMessage(key, runtime, false);
    }
    if (bridge) {
      // Detach our handlers BEFORE killing. The process exits asynchronously and
      // would otherwise emit "exit"/"stopped" that mutate this runtime after it has
      // moved on to a new bridge (e.g. after an edit), prematurely finalizing the
      // new turn's streaming message and swallowing the response.
      bridge.removeAllListeners();
      bridge.stop();
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
    const names: Record<string, string> = {};
    for (const id of this.openTabIds) {
      names[id] = this.tabNameFor(id);
    }
    this.postMessage({ type: "openTabs", tabIds: this.openTabIds, names });
  }

  /** A human-readable tab label: the session's name, else its first real user
   * message (from memory, or persisted messages for tabs not loaded yet). */
  private tabNameFor(key: string): string {
    const rt = this.runtimes.get(key);
    if (rt?.sessionName) {
      return rt.sessionName;
    }
    const messages =
      rt?.messages ??
      this.context.workspaceState.get<ChatMessage[]>(
        `claude-luxure.messages.${key}`
      );
    const firstUser = messages?.find(
      (m) => m.role === "user" && m.content.trim() && !isSlashCommand(m.content)
    );
    if (firstUser) {
      return sessionNameFromText(firstUser.content);
    }
    return "New chat";
  }

  private handleNewConversation(): void {
    this.persistActiveSession();

    const draftKey = this.createDraftRuntime();
    // New conversations inherit the last-used account so a chosen account
    // "sticks" across new chats; switch per-conversation via the composer.
    this.runtimes.get(draftKey)!.accountId =
      this.context.globalState.get<string>("claude-luxure.lastAccountId") || "default";
    this.openTabIds.unshift(draftKey);
    this.activeKey = draftKey;

    this.sendState();
    this.sendOpenTabs();
    this.sendAccountsList();
    void this.pollUsageForActive();
  }

  async reveal(): Promise<void> {
    if (this.webviewView) {
      this.webviewView.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    log("INFO", "resolveWebviewView called — panel opening");
    this.webviewView = webviewView;
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

    // Push an MCP status snapshot now. It's refreshed event-driven on every CLI
    // status change (start/restart/stop/error) — the only thing that actually
    // moves the indicator — so no polling timer is needed.
    this.refreshMcpStatus();
    this.sendAccountsList();
    this.startUsagePolling();

    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.webview = undefined;
      this.stopUsagePolling();
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
        this.sendAccountsList();
        void this.pollUsageForActive();
        break;

      case "sendMessage":
        log("INFO", "sendMessage:", (message as any).text?.slice(0, 100));
        await this.handleSendMessage(
          message.text,
          message.images,
          message.mentions
        );
        break;

      case "editMessage":
        log("INFO", "editMessage:", message.messageId);
        await this.handleEditMessage(
          message.messageId,
          message.text,
          message.images
        );
        break;

      case "switchFork":
        await this.handleSwitchFork(message.anchorId, message.index);
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

      case "openFile": {
        const doc = await vscode.workspace.openTextDocument(message.filePath);
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }

      case "openDiff":
        await this.handleOpenDiff(message.filePath);
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

      case "openMcpConfig":
        await this.handleOpenMcpConfig();
        break;

      case "restartMcp":
        this.handleRestartMcp();
        break;

      case "switchAccount":
        await this.handleSwitchAccount(message.accountId);
        break;

      case "addAccount":
        await this.handleAddAccount();
        break;

      case "removeAccount":
        await this.handleRemoveAccount(message.accountId);
        break;

      case "refreshUsage":
        void this.pollUsageForAll();
        break;

      case "summarizeSession":
        void this.handleSummarizeSession(message.sessionId);
        break;

      case "summarizeAllSessions":
        void this.handleSummarizeAllSessions();
        break;
    }
  }

  /**
   * Open Claude Code's project-scoped MCP config (`.mcp.json` at the workspace
   * root) in the editor, creating an empty scaffold if it doesn't exist yet.
   * This is the file Claude Code reads for project MCP servers — analogous to
   * Cursor's `.cursor/mcp.json`.
   */
  private async handleOpenMcpConfig(): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      vscode.window.showWarningMessage(
        "Open a workspace folder to edit its MCP config (.mcp.json)."
      );
      return;
    }

    const mcpPath = path.join(workspacePath, ".mcp.json");
    try {
      if (!fs.existsSync(mcpPath)) {
        fs.writeFileSync(mcpPath, '{\n  "mcpServers": {}\n}\n', "utf-8");
      }
      const doc = await vscode.workspace.openTextDocument(mcpPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open MCP config: ${err}`);
    }
  }

  /**
   * Restart the active session's `claude` process. The bridge relaunches the CLI
   * with `--resume` (so the conversation is preserved), which reloads `.mcp.json`
   * and reconnects every MCP server with fresh env — the practical way to recover
   * a dropped or stale MCP server (e.g. after refreshing an expired token)
   * without the interactive `/mcp` → Reconnect step.
   */
  private handleRestartMcp(): void {
    const runtime = this.getActiveRuntime();
    // Flip the indicator to "connecting" immediately so the restart is visible
    // even before the new process reports back.
    this.refreshMcpStatus(true);
    if (runtime.bridge) {
      vscode.window.showInformationMessage(
        "Reconnecting MCP servers (restarting Claude — your conversation is preserved)…"
      );
      runtime.bridge.restart();
    } else {
      // No process yet (e.g. before the first message) — start one so its MCP
      // servers connect. The bridge's status handler refreshes the indicator.
      vscode.window.showInformationMessage(
        "Starting Claude to connect MCP servers…"
      );
      void this.startBridge(this.activeKey, runtime);
    }
  }

  /** Build and push the current MCP status to the webview. `forceConnecting`
   * paints every server "connecting" optimistically (used the instant a restart
   * is triggered, before the new process reports back). */
  private refreshMcpStatus(forceConnecting = false): void {
    this.postMessage({
      type: "mcpStatus",
      servers: this.computeMcpServerStatuses(forceConnecting),
    });
  }

  /** Derive overall MCP status: the servers configured in the project's
   * `.mcp.json`, each tagged with one connection state taken from the active
   * session's lifecycle. The CLI exposes no reliable per-server connection
   * signal — its init event reports every server "pending" (they connect async,
   * with no follow-up event) and `claude mcp list` reports "pending approval"
   * non-interactively even for healthy servers. But a running session here uses
   * `--dangerously-skip-permissions`, which connects every configured server, so
   * session-up == servers-connected is the honest, tool-agnostic signal — and it
   * flips amber→green on restart. Reads no draft runtime, so it's safe to call
   * from any event handler. */
  private computeMcpServerStatuses(forceConnecting: boolean): McpServerStatus[] {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      return [];
    }
    let config: { mcpServers?: Record<string, unknown> };
    try {
      config = JSON.parse(
        fs.readFileSync(path.join(workspacePath, ".mcp.json"), "utf-8")
      );
    } catch {
      return [];
    }
    const serversObj = config?.mcpServers;
    if (!serversObj || typeof serversObj !== "object") {
      return [];
    }

    const runtime = this.activeKey ? this.runtimes.get(this.activeKey) : undefined;
    let connection: McpConnectionState;
    if (forceConnecting) {
      connection = "connecting";
    } else {
      switch (runtime?.cliStatus) {
        case "starting":
          connection = "connecting";
          break;
        case "ready":
        case "busy":
          connection = "connected";
          break;
        case "error":
          connection = "error";
          break;
        default:
          connection = "stopped";
      }
    }

    return Object.keys(serversObj).map((name) => ({ name, connection }));
  }

  // ───────────────────────── Accounts ─────────────────────────

  /** The user-added (config-dir) accounts; the synthetic "Default" keychain
   * account is not stored here — it's prepended in {@link getAllAccounts}. */
  private getAddedAccounts(): StoredAccount[] {
    return (
      this.context.globalState.get<StoredAccount[]>("claude-luxure.accounts") || []
    );
  }

  /** All selectable accounts: the keychain "Default" first, then added ones. */
  private getAllAccounts(): StoredAccount[] {
    const def: StoredAccount = {
      id: "default",
      label: this.accountEmail || "Default account",
      email: this.accountEmail,
      subscriptionType: this.accountSubscription,
      isDefault: true,
    };
    return [def, ...this.getAddedAccounts()];
  }

  private labelFor(accountId: string | undefined): string {
    return (
      this.getAllAccounts().find((a) => a.id === (accountId || "default"))?.label ||
      "account"
    );
  }

  /** Config dir to spawn under for an account. Default/undefined → undefined
   * (the process uses the ambient keychain login). */
  private getConfigDirForAccount(
    accountId: string | undefined
  ): string | undefined {
    if (!accountId || accountId === "default") {
      return undefined;
    }
    return this.getAddedAccounts().find((a) => a.id === accountId)?.configDir;
  }

  private sendAccountsList(): void {
    const runtime = this.activeKey ? this.runtimes.get(this.activeKey) : undefined;
    this.postMessage({
      type: "accountsList",
      accounts: this.getAllAccounts(),
      activeAccountId: runtime?.accountId || "default",
    });
  }

  /** Bind the active conversation to a different account. If a process is
   * running, restart it with the new token + `--resume` (conversation preserved
   * — same mechanism as the MCP restart). */
  private async handleSwitchAccount(accountId: string): Promise<void> {
    const runtime = this.getActiveRuntime();
    runtime.accountId = accountId;
    this.context.globalState.update("claude-luxure.lastAccountId", accountId);
    if (runtime.sessionId) {
      this.context.workspaceState.update(
        `claude-luxure.accountFor.${runtime.sessionId}`,
        accountId === "default" ? undefined : accountId
      );
    }
    const configDir = this.getConfigDirForAccount(accountId);
    if (configDir) {
      this.linkSharedAssets(configDir);
    }
    if (runtime.bridge) {
      vscode.window.showInformationMessage(
        `Switching to ${this.labelFor(accountId)} (restarting Claude — your conversation is preserved)…`
      );
      // Empty string clears it → switch back to the Default account.
      runtime.bridge.restart({ configDir: configDir ?? "" });
    }
    this.sendAccountsList();
    this.sendState();
    void this.pollUsageForAll();
  }

  private async handleAddAccount(): Promise<void> {
    const id = `acct-${generateId()}`;
    const configDir = path.join(
      this.context.globalStorageUri.fsPath,
      "accounts",
      id
    );
    try {
      fs.mkdirSync(configDir, { recursive: true });
      this.linkSharedAssets(configDir);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not create account profile: ${err}`);
      return;
    }

    // Drive a normal browser login scoped to this account's config dir, in a
    // terminal so the user sees the URL if the browser doesn't auto-open.
    const terminal = vscode.window.createTerminal({
      name: "Add Claude account",
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    terminal.show();
    terminal.sendText("claude auth login");
    vscode.window.showInformationMessage(
      "Log in as the account you want to add (use an incognito window if it differs from your current claude.ai login). I'll detect it automatically."
    );

    const ok = await this.waitForLogin(configDir);
    terminal.dispose();
    if (!ok) {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      vscode.window.showWarningMessage(
        "Didn't detect a completed login — account not added. Try again when ready."
      );
      return;
    }

    const info = await this.authStatusForDir(configDir);
    const email = info?.email as string | undefined;
    const added = this.getAddedAccounts();
    added.push({
      id,
      label: email || `Account ${added.length + 1}`,
      email,
      subscriptionType: info?.subscriptionType,
      isDefault: false,
      configDir,
    });
    await this.context.globalState.update("claude-luxure.accounts", added);
    this.sendAccountsList();
    void this.pollUsageForAll();
    vscode.window.showInformationMessage(
      `Added ${email || "account"}. Select it from the account switcher.`
    );
  }

  /** Share assets from ~/.claude into an account's isolated config dir via
   * symlinks. Read-mostly assets (skills/plugins/memory) so added accounts see
   * the same skills as Default; and crucially the `projects` session store, so a
   * conversation created under any account can be `--resume`d after switching
   * accounts (sessions live inside CLAUDE_CONFIG_DIR, so without this a switch
   * fails with "No conversation found"). Auth/settings stay isolated. Idempotent
   * — also called on spawn/switch to retrofit older accounts. */
  private linkSharedAssets(configDir: string): void {
    const base = path.join(os.homedir(), ".claude");
    for (const asset of ["skills", "plugins", "CLAUDE.md", "commands", "agents"]) {
      this.linkIfAbsent(path.join(base, asset), path.join(configDir, asset));
    }
    // Shared session store. Replace a fresh real `projects/` dir (created by an
    // earlier spawn) with the symlink so transcripts resolve to ~/.claude/projects.
    this.shareSessionStore(
      path.join(base, "projects"),
      path.join(configDir, "projects")
    );
  }

  private linkIfAbsent(src: string, dst: string): void {
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.symlinkSync(src, dst);
      }
    } catch {
      // Non-fatal — the account still works, just without that shared asset.
    }
  }

  private shareSessionStore(src: string, dst: string): void {
    try {
      if (!fs.existsSync(src)) {
        return;
      }
      if (fs.existsSync(dst)) {
        const st = fs.lstatSync(dst);
        if (st.isSymbolicLink()) {
          return; // already shared
        }
        if (st.isDirectory()) {
          // A freshly-provisioned account's own (junk) session store — replace it.
          fs.rmSync(dst, { recursive: true, force: true });
        } else {
          return;
        }
      }
      fs.symlinkSync(src, dst);
    } catch {
      // Non-fatal.
    }
  }

  private authStatusForDir(configDir: string): Promise<any> {
    return new Promise((resolve) => {
      execFile(
        "claude",
        ["auth", "status"],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            resolve(undefined);
          }
        }
      );
    });
  }

  /** Poll `auth status` for a config dir until it reports logged in (or times
   * out after ~3 min). */
  private async waitForLogin(
    configDir: string,
    attempts = 60
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const info = await this.authStatusForDir(configDir);
      if (info?.loggedIn) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }

  private async handleRemoveAccount(accountId: string): Promise<void> {
    if (!accountId || accountId === "default") {
      return;
    }
    const acct = this.getAddedAccounts().find((a) => a.id === accountId);
    const added = this.getAddedAccounts().filter((a) => a.id !== accountId);
    await this.context.globalState.update("claude-luxure.accounts", added);
    if (
      this.context.globalState.get<string>("claude-luxure.lastAccountId") === accountId
    ) {
      this.context.globalState.update("claude-luxure.lastAccountId", "default");
    }
    // Remove the isolated profile dir. Its shared assets are symlinks, which are
    // unlinked (not followed), so the real ~/.claude targets are untouched.
    if (acct?.configDir) {
      try {
        fs.rmSync(acct.configDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    // Any open conversation bound to the removed account falls back to Default.
    for (const runtime of this.runtimes.values()) {
      if (runtime.accountId === accountId) {
        runtime.accountId = "default";
        if (runtime.sessionId) {
          this.context.workspaceState.update(
            `claude-luxure.accountFor.${runtime.sessionId}`,
            undefined
          );
        }
        if (runtime.bridge) {
          runtime.bridge.restart({ configDir: "" });
        }
      }
    }
    this.sendAccountsList();
    this.sendState();
    void this.pollUsageForActive();
  }

  // ───────────────────────── Usage ─────────────────────────

  /** Access token for GET /api/oauth/usage: for a config-dir account, read its
   * own file-based credential (full scope, so the endpoint allows it); for the
   * Default account, the auto-refreshed keychain token. */
  private async resolveUsageToken(
    accountId: string | undefined
  ): Promise<string | undefined> {
    const configDir = this.getConfigDirForAccount(accountId);
    if (configDir) {
      // On macOS the CLI stores a custom-config-dir login in a keychain entry
      // suffixed with sha256(configDir)[:8] — NOT in <configDir>/.credentials.json.
      // (That file only exists on Linux/other.) Read the keychain entry first so
      // added accounts — which have full `user:profile` scope, same as Default —
      // get real usage too. This is the whole reason their bars were blank.
      const fromKeychain = await this.readKeychainToken(
        this.keychainServiceForConfigDir(configDir)
      );
      if (fromKeychain) {
        return fromKeychain;
      }
      try {
        const raw = fs.readFileSync(
          path.join(configDir, ".credentials.json"),
          "utf-8"
        );
        return JSON.parse(raw)?.claudeAiOauth?.accessToken;
      } catch {
        return undefined;
      }
    }
    return await this.readKeychainToken();
  }

  /** The macOS keychain service name the CLI uses for a custom-config-dir login:
   * the base service plus the first 8 hex of sha256(configDir). Verified against
   * the live entry ("Claude Code-credentials-623e75a5"). */
  private keychainServiceForConfigDir(configDir: string): string {
    const suffix = crypto
      .createHash("sha256")
      .update(configDir)
      .digest("hex")
      .slice(0, 8);
    return `Claude Code-credentials-${suffix}`;
  }

  /** Read the ambient keychain OAuth access token (macOS). May prompt once for
   * keychain access ("Always Allow" makes subsequent reads silent). */
  private readKeychainToken(
    service = "Claude Code-credentials"
  ): Promise<string | undefined> {
    // The keychain token is valid ~60min (the CLI refreshes it). Cache for 60s
    // so frequent polls (e.g. after every turn) don't spawn `security` each time.
    const cached = this.cachedKeychainTokens.get(service);
    if (cached && Date.now() - cached.at < 60_000) {
      return Promise.resolve(cached.token);
    }
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        resolve(undefined);
        return;
      }
      execFile(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          try {
            const json = JSON.parse(stdout.trim());
            const token = json?.claudeAiOauth?.accessToken;
            if (token) {
              this.cachedKeychainTokens.set(service, { token, at: Date.now() });
            }
            resolve(token);
          } catch {
            resolve(undefined);
          }
        }
      );
    });
  }

  private getCliVersion(): Promise<string> {
    if (this.cachedCliVersion) {
      return Promise.resolve(this.cachedCliVersion);
    }
    return new Promise((resolve) => {
      execFile("claude", ["--version"], (_err, stdout) => {
        const m = (stdout || "").match(/(\d+\.\d+\.\d+)/);
        this.cachedCliVersion = m ? m[1] : "2.0.0";
        resolve(this.cachedCliVersion);
      });
    });
  }

  /** Fetch subscription usage. The endpoint is undocumented (it powers the CLI's
   * /usage view); isolated here so it's easy to fix if the contract changes. */
  private async fetchUsage(token: string): Promise<UsageInfo | null> {
    const version = await this.getCliVersion();
    return new Promise((resolve) => {
      const req = https.request(
        "https://api.anthropic.com/api/oauth/usage",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": `claude-code/${version}`,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              log("WARN", "usage endpoint status:", String(status));
              resolve(null);
              return;
            }
            try {
              const data = JSON.parse(body) as Record<string, any>;
              const bucket = (b: any): UsageBucket | null =>
                b && typeof b.utilization === "number"
                  ? { utilization: b.utilization, resetsAt: b.resets_at }
                  : null;
              resolve({
                fiveHour: bucket(data.five_hour),
                sevenDay: bucket(data.seven_day),
                sevenDaySonnet: bucket(data.seven_day_sonnet),
                sevenDayOpus: bucket(data.seven_day_opus),
              });
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("error", (err) => {
        log("WARN", "usage fetch error:", String(err));
        resolve(null);
      });
      req.end();
    });
  }

  private async pollUsageForActive(): Promise<void> {
    if (this.usagePollInFlight) {
      return;
    }
    this.usagePollInFlight = true;
    try {
      const runtime = this.activeKey
        ? this.runtimes.get(this.activeKey)
        : undefined;
      const token = await this.resolveUsageToken(runtime?.accountId);
      if (!token) {
        this.postMessage({ type: "usageUpdate", usage: null });
        return;
      }
      const usage = await this.fetchUsage(token);
      this.postMessage({ type: "usageUpdate", usage });
    } finally {
      this.usagePollInFlight = false;
    }
  }

  /** Poll usage for every account in parallel (each has its own full-scope
   * keychain token), so the switcher can show per-account bars. Also refreshes
   * the active account's bottom bars from the same fetch. Called less often than
   * {@link pollUsageForActive} (timer + account changes) to bound endpoint load —
   * N accounts = N requests, vs. 1 for the active-only poll. */
  private async pollUsageForAll(): Promise<void> {
    if (this.usageAllInFlight) {
      return;
    }
    this.usageAllInFlight = true;
    try {
      const accounts = this.getAllAccounts();
      const entries = await Promise.all(
        accounts.map(async (a) => {
          const token = await this.resolveUsageToken(a.id);
          const usage = token ? await this.fetchUsage(token) : null;
          return [a.id, usage] as const;
        })
      );
      const usageByAccount: Record<string, UsageInfo | null> = {};
      for (const [id, usage] of entries) {
        usageByAccount[id] = usage;
      }
      this.postMessage({ type: "usageByAccount", usageByAccount });
      // Keep the bottom bars in sync with the same data, no extra request.
      const runtime = this.activeKey
        ? this.runtimes.get(this.activeKey)
        : undefined;
      const activeId = runtime?.accountId || "default";
      this.postMessage({
        type: "usageUpdate",
        usage: usageByAccount[activeId] ?? null,
      });
    } finally {
      this.usageAllInFlight = false;
    }
  }

  private startUsagePolling(): void {
    if (this.usagePollTimer) {
      return;
    }
    void this.pollUsageForAll();
    // The endpoint is safe at ~180s intervals; tokens auto-refresh server-side.
    this.usagePollTimer = setInterval(
      () => void this.pollUsageForAll(),
      180_000
    );
  }

  private stopUsagePolling(): void {
    if (this.usagePollTimer) {
      clearInterval(this.usagePollTimer);
      this.usagePollTimer = undefined;
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

  private resolveMessageForCli(text: string): {
    displayText: string;
    resolvedText: string;
  } {
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

    return { displayText, resolvedText };
  }

  /**
   * Rewind the conversation to an earlier message (Cursor-style edit-and-continue).
   *
   * Rather than surgically forking the CLI's internal transcript files (an
   * undocumented, version-fragile format that even the built-in /rewind mishandles),
   * we own the history ourselves: editing a message truncates everything from it
   * onward, starts a fresh CLI session, and seeds that session with the prior turns
   * rendered as context — then sends the edited message. This uses only documented
   * primitives (spawn + send), so it can't break on a CLI update.
   */
  private async handleEditMessage(
    messageId: string,
    text: string,
    images?: string[]
  ): Promise<void> {
    if (!this.activeKey) {
      return;
    }

    const runtime = this.getActiveRuntime();
    const messageIndex = runtime.messages.findIndex((m) => m.id === messageId);
    if (messageIndex < 0 || runtime.messages[messageIndex].role !== "user") {
      return;
    }

    // Cursor-style rollback: if Claude changed files at or after this message,
    // offer to restore them to their pre-message state before we fork. "Keep
    // code" forks without touching files; cancelling aborts the fork entirely.
    const forkIdx = runtime.checkpoints.findIndex((c) => c.userMsgId === messageId);
    if (forkIdx >= 0) {
      const restore = new Map<string, string | null>();
      // Walk newest → fork point so the earliest baseline per file wins.
      for (let i = runtime.checkpoints.length - 1; i >= forkIdx; i--) {
        for (const [p, content] of runtime.checkpoints[i].files) {
          restore.set(p, content);
        }
      }
      if (restore.size > 0) {
        const n = restore.size;
        const choice = await vscode.window.showInformationMessage(
          `Claude changed ${n} file${n === 1 ? "" : "s"} after this message. Restore ${n === 1 ? "it" : "them"} to the previous state?`,
          { modal: true },
          "Restore code",
          "Keep code"
        );
        if (choice === undefined) {
          return; // Cancelled — leave the conversation and files untouched.
        }
        if (choice === "Restore code") {
          await this.restoreFiles(restore);
        }
      }
      runtime.checkpoints = runtime.checkpoints.slice(0, forkIdx);
    }

    // The shared prefix stays; the rest is the branch we're leaving — preserved as
    // a fork version so the user can switch back to it with the ‹ › control.
    const anchorId =
      messageIndex > 0
        ? runtime.messages[messageIndex - 1].id
        : ROOT_FORK_ANCHOR;
    const priorMessages = runtime.messages.slice(0, messageIndex);
    const leavingTail = runtime.messages.slice(messageIndex);

    if (!runtime.forks) {
      runtime.forks = {};
    }
    let group = runtime.forks[anchorId];
    if (!group) {
      // First edit here: capture the existing branch as version 0.
      group = {
        versions: [{ sessionId: runtime.sessionId, tail: leavingTail }],
        activeIndex: 0,
      };
      runtime.forks[anchorId] = group;
    } else {
      // Sync the branch we're leaving back into its slot before forking again.
      group.versions[group.activeIndex] = {
        sessionId: runtime.sessionId,
        tail: leavingTail,
      };
    }
    // The edit is a new version; its session id is captured when we later leave it.
    group.versions.push({ sessionId: undefined, tail: [] });
    group.activeIndex = group.versions.length - 1;

    this.stopRuntimeBridge(this.activeKey, runtime);

    // Rewind onto a fresh session; the fork registry rides along on the runtime.
    this.resetRuntimeToFreshSession(runtime);
    runtime.messages = [...priorMessages];
    runtime.contextSummarized = false;
    runtime.streamingMessageId = null;
    runtime.currentStreamText = "";
    runtime.currentTimeline = [];

    this.postMessage({ type: "streamEnd" });
    this.sendOpenTabs();
    this.sendState();

    await this.handleSendMessage(text, images, undefined, priorMessages);
  }

  /**
   * Restore files to captured contents (Cursor-style rollback). A null content
   * means the file did not exist at that point, so it is deleted. Open editors
   * are updated in place so the rollback is visible without a reload.
   */
  private async restoreFiles(files: Map<string, string | null>): Promise<void> {
    for (const [filePath, content] of files) {
      try {
        if (content === null) {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } else {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, content, "utf-8");
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === filePath
          );
          if (doc) {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length)
            );
            edit.replace(doc.uri, fullRange, content);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
          }
        }
        // The accept/reject baseline for this file is now stale — drop it.
        this.snapshotManager.clear(filePath);
      } catch {
        // Best-effort: skip files we can't write.
      }
    }
  }

  private async handleSwitchFork(
    anchorId: string,
    index: number
  ): Promise<void> {
    if (!this.activeKey) {
      return;
    }
    const runtime = this.getActiveRuntime();
    const group = runtime.forks?.[anchorId];
    if (
      !group ||
      index < 0 ||
      index >= group.versions.length ||
      index === group.activeIndex ||
      runtime.streamingMessageId
    ) {
      return;
    }

    // Fork point: right after the anchor message (or the very start).
    let forkPoint = 0;
    if (anchorId !== ROOT_FORK_ANCHOR) {
      const anchorIdx = runtime.messages.findIndex((m) => m.id === anchorId);
      if (anchorIdx < 0) {
        return;
      }
      forkPoint = anchorIdx + 1;
    }
    const prefix = runtime.messages.slice(0, forkPoint);

    // Save the branch we're leaving (it may have grown), then adopt the target.
    group.versions[group.activeIndex] = {
      sessionId: runtime.sessionId,
      tail: runtime.messages.slice(forkPoint),
    };
    group.activeIndex = index;
    const target = group.versions[index];

    this.stopRuntimeBridge(this.activeKey, runtime);
    this.rekeyRuntime(runtime, target.sessionId);
    runtime.messages = [...prefix, ...target.tail];
    runtime.streamingMessageId = null;
    runtime.currentStreamText = "";
    runtime.currentTimeline = [];

    this.postMessage({ type: "streamEnd" });
    this.sendOpenTabs();
    this.sendState();
  }

  /**
   * Detach the active runtime from its CLI session id and re-key it as a fresh
   * draft, preserving its in-memory messages. The next startBridge creates a new
   * session and the "ready" handler migrates the draft key to the real id.
   */
  private resetRuntimeToFreshSession(runtime: SessionRuntime): void {
    this.rekeyRuntime(runtime, undefined);
  }

  /**
   * Re-key the active runtime to a different session id (or a fresh draft when
   * undefined), preserving its in-memory state (messages, fork registry). Used by
   * edit (fresh session) and fork switching (adopt an existing version's session).
   */
  private rekeyRuntime(runtime: SessionRuntime, newSessionId?: string): void {
    const oldKey = this.activeKey;
    const newKey = newSessionId || `draft-${generateId()}`;

    runtime.sessionId = newSessionId;
    runtime.bridge = undefined;
    runtime.cliStatus = "stopped";
    if (newSessionId) {
      delete runtime.draftId;
    } else {
      runtime.draftId = newKey;
    }

    if (newKey !== oldKey) {
      this.runtimes.delete(oldKey);
      this.runtimes.set(newKey, runtime);
      const tabIdx = this.openTabIds.indexOf(oldKey);
      if (tabIdx >= 0) {
        this.openTabIds[tabIdx] = newKey;
      } else {
        this.openTabIds.unshift(newKey);
      }
      if (this.activeKey === oldKey) {
        this.activeKey = newKey;
      }
    }
  }

  private async handleSendMessage(
    text: string,
    images?: string[],
    _mentions?: string[],
    seedHistory?: ChatMessage[]
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

    const { displayText, resolvedText } = this.resolveMessageForCli(text);

    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: displayText,
      images,
      timestamp: Date.now(),
    };
    runtime.messages.push(userMessage);
    // Open a checkpoint for this turn: as Claude edits files during the reply,
    // each file's pre-edit content is recorded here, so a later fork can offer
    // to roll the workspace back to this point.
    runtime.checkpoints.push({ userMsgId: userMessage.id, files: new Map() });
    if (this.isActiveKey(runtimeKey)) {
      this.postMessage({ type: "message", message: userMessage });
    }

    const seed =
      seedHistory && seedHistory.length > 0 ? renderSeedHistory(seedHistory) : "";
    const outgoingText = seed ? `${seed}\n\n${resolvedText}` : resolvedText;
    runtime.bridge?.sendMessage(outgoingText, images);

    runtime.streamingMessageId = generateId();
    runtime.currentStreamText = "";
    runtime.pendingParagraphBreak = false;
    runtime.currentActivities = [];
    runtime.currentTimeline = [];
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

    // Resolve which account this conversation is bound to (restoring a persisted
    // binding for resumed sessions), then the config dir to spawn it under.
    if (!runtime.accountId && runtime.sessionId) {
      runtime.accountId = this.context.workspaceState.get<string>(
        `claude-luxure.accountFor.${runtime.sessionId}`
      );
    }
    const configDir = this.getConfigDirForAccount(runtime.accountId);
    // Ensure the account's config dir shares the session store + skills (also
    // retrofits accounts created before sharing was introduced).
    if (configDir) {
      this.linkSharedAssets(configDir);
    }

    const bridge = new ClaudeBridge({
      cwd: workspacePath,
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      sessionId: runtime.sessionId,
      sessionName: runtime.sessionName,
      configDir,
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
    const thisBridge = bridge;
    // A bridge whose runtime has moved on (e.g. an edit swapped in a new session)
    // must never mutate that runtime — its late exit/stream events would otherwise
    // corrupt the live turn (clearing streamingMessageId, swallowing the reply).
    const isStale = () => runtime.bridge !== thisBridge;

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
      this.markCompactBoundary(runtime);
      if (isActive()) {
        this.sendState();
      }
    });

    bridge.on("status", (status: string) => {
      if (isStale()) {
        return;
      }
      log("INFO", "CLI status:", status, "session:", runtimeKey);
      runtime.cliStatus = status as ExtensionState["cliStatus"];

      if (status === "ready" && bridge.sessionId) {
        const newSessionId = bridge.sessionId;
        if (isDraftKey(runtimeKey)) {
          this.migrateDraftToSession(runtimeKey, newSessionId, runtime);
          runtimeKey = newSessionId;
          this.sendOpenTabs();
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
        this.refreshMcpStatus();
        this.sendState();
      }
    });

    bridge.on("exit", () => {
      if (isStale()) {
        return;
      }
      if (runtime.streamingMessageId) {
        this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      }
    });

    bridge.on("textDelta", (text: string) => {
      if (isStale()) {
        return;
      }
      // The assistant emits its answer as several text blocks split by tool
      // calls. Re-paragraph them so they don't run together ("...wiring.Handler").
      if (
        runtime.pendingParagraphBreak &&
        runtime.currentStreamText &&
        !runtime.currentStreamText.endsWith("\n")
      ) {
        runtime.currentStreamText += "\n\n";
        if (isActive()) {
          this.postMessage({ type: "streamToken", text: "\n\n" });
        }
      }
      runtime.pendingParagraphBreak = false;
      runtime.currentStreamText += text;
      this.pushTimelineText(runtime, text);
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
      this.handleAssistantEvent(runtime, event);
    });

    bridge.on("assistantText", (text: string) => {
      if (isStale()) {
        return;
      }
      log("INFO", "assistantText received, length:", text.length);
      if (runtime.streamingMessageId && !runtime.currentStreamText) {
        runtime.currentStreamText = text;
        this.pushTimelineText(runtime, text);
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
      if (isStale()) {
        return;
      }
      log("INFO", "result received, finalizing message");
      this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
      // A turn just consumed quota — refresh the usage bars for the active tab.
      if (isActive()) {
        void this.pollUsageForActive();
      }
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
      this.appendActivity(runtime, activity);
      this.pushTimelineActivity(runtime, activity);
      // A tool call or thinking block means the assistant paused its prose; flag
      // a paragraph break so the next text delta doesn't fuse onto the last one.
      if (
        runtime.currentStreamText &&
        (activity.type === "tool_use" ||
          activity.type === "thinking" ||
          activity.type === "thinking_delta")
      ) {
        runtime.pendingParagraphBreak = true;
      }
      if (isActive()) {
        this.postMessage({ type: "activity", activity });
      }
    });

    bridge.on("controlRequest", (event: ClaudeEvent) => {
      this.handleControlRequest(runtime, event);
    });

    bridge.on("error", (err: string) => {
      if (isStale()) {
        return;
      }
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

  private handleAssistantEvent(runtime: SessionRuntime, event: ClaudeEvent): void {
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
          this.captureCheckpoint(runtime, filePath);
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
        this.captureCheckpoint(runtime, toolInput.file_path as string);
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

  /**
   * Record a file's current on-disk content into the active turn's checkpoint,
   * once per file per turn — its state before Claude first edits it. Kept
   * independent of SnapshotManager (which is cleared on accept/reject) so it
   * survives to power a fork-time rollback.
   */
  private captureCheckpoint(runtime: SessionRuntime, filePath: string): void {
    const checkpoint = runtime.checkpoints[runtime.checkpoints.length - 1];
    if (!checkpoint || checkpoint.files.has(filePath)) {
      return;
    }
    try {
      checkpoint.files.set(
        filePath,
        fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null
      );
    } catch {
      checkpoint.files.set(filePath, null);
    }
  }

  private appendActivity(runtime: SessionRuntime, e: ActivityEvent): void {
    if (!runtime.currentActivities) {
      runtime.currentActivities = [];
    }
    this.coalesceInto(runtime.currentActivities, e);
  }

  /** Push (and coalesce) an activity onto the timeline's trailing activity run,
   * starting a new run if the previous segment was prose. */
  private pushTimelineActivity(runtime: SessionRuntime, e: ActivityEvent): void {
    const tl = runtime.currentTimeline;
    let last = tl[tl.length - 1];
    if (!last || last.type !== "activities") {
      last = { type: "activities", activities: [] };
      tl.push(last);
    }
    this.coalesceInto(last.activities, e);
  }

  /** Append streamed prose to the timeline's trailing text run, starting a new
   * run if the previous segment was activity (so order of appearance is kept). */
  private pushTimelineText(runtime: SessionRuntime, text: string): void {
    const tl = runtime.currentTimeline;
    const last = tl[tl.length - 1];
    if (last && last.type === "text") {
      last.text += text;
    } else {
      tl.push({ type: "text", text });
    }
  }

  /** Coalesce a raw activity event into `acts`: fill tool placeholders, merge
   * contiguous thinking, drop tool_result. Scoped to whatever array is passed,
   * so it serves both the flat list and a single timeline run. */
  private coalesceInto(acts: ActivityEvent[], e: ActivityEvent): void {
    if (e.type === "tool_result") {
      // Don't render the result as its own step — attach it to the tool_use it
      // belongs to (matched by id) so the call + its output stay one entry.
      attachToolResult(acts, e);
      return;
    }
    if (e.type === "thinking" || e.type === "thinking_delta") {
      const last = acts[acts.length - 1];
      if (!last || (last.type !== "thinking" && last.type !== "thinking_delta")) {
        acts.push({ type: "thinking", text: "" });
      }
      return;
    }
    if (e.type === "tool_use") {
      const input = e.toolInput || {};
      const hasInput = Object.keys(input).length > 0;
      if (hasInput) {
        // Fill the placeholder emitted at content_block_start (empty input).
        const placeholder = acts.find(
          (a) =>
            a.type === "tool_use" &&
            a.toolName === e.toolName &&
            Object.keys(a.toolInput || {}).length === 0
        );
        if (placeholder && placeholder.type === "tool_use") {
          placeholder.toolInput = input;
          if (e.toolUseId && !placeholder.toolUseId) {
            placeholder.toolUseId = e.toolUseId;
          }
          return;
        }
        // Skip exact duplicates (assistant event re-emits completed tool calls).
        const dup = acts.find(
          (a) =>
            a.type === "tool_use" &&
            a.toolName === e.toolName &&
            JSON.stringify(a.toolInput) === JSON.stringify(input)
        );
        if (dup) {
          return;
        }
      }
      acts.push({
        type: "tool_use",
        toolName: e.toolName,
        toolInput: input,
        toolUseId: e.toolUseId,
      });
    }
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
      if (runtime.currentActivities.length > 0) {
        msg.activities = runtime.currentActivities;
      }
      if (runtime.currentTimeline.length > 0) {
        msg.timeline = runtime.currentTimeline;
      }
    }
    runtime.currentActivities = [];
    runtime.currentTimeline = [];

    const lastUserMessage = [...runtime.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage && isCompactCommand(lastUserMessage.content)) {
      runtime.contextSummarized = true;
      this.markCompactBoundary(runtime);
    }

    runtime.streamingMessageId = null;
    runtime.currentStreamText = "";
    runtime.pendingParagraphBreak = false;

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

  /**
   * Open a file in VS Code's native diff editor (HEAD ↔ working tree), so the
   * user sees exactly what changed — git-diff style. Falls back to opening the
   * file if git/diff isn't available.
   */
  private async handleOpenDiff(filePath: string): Promise<void> {
    const ws = this.getWorkspacePath();
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : ws
      ? path.join(ws, filePath)
      : filePath;
    try {
      // Open the real file with Claude's changes highlighted inline (Cursor
      // style). Works for new/untracked files too, unlike a git-HEAD diff.
      await this.diffManager.revealFile(absPath);
    } catch (err) {
      log("WARN", "openDiff failed:", String(err));
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

  /** Attach fork-switcher metadata to the active version's fork-point messages. */
  private decorateForks(runtime: SessionRuntime): ChatMessage[] {
    const forks = runtime.forks;
    if (!forks) {
      return runtime.messages;
    }
    const result = runtime.messages.slice();
    for (const anchorId of Object.keys(forks)) {
      const group = forks[anchorId];
      if (group.versions.length < 2) {
        continue;
      }
      let pointIdx = -1;
      if (anchorId === ROOT_FORK_ANCHOR) {
        pointIdx = 0;
      } else {
        const anchorIdx = result.findIndex((m) => m.id === anchorId);
        if (anchorIdx >= 0) {
          pointIdx = anchorIdx + 1;
        }
      }
      if (pointIdx >= 0 && pointIdx < result.length) {
        result[pointIdx] = {
          ...result[pointIdx],
          forkInfo: {
            anchorId,
            index: group.activeIndex,
            total: group.versions.length,
          },
        };
      }
    }
    return result;
  }

  private sendState(): void {
    const runtime = this.getActiveRuntime();
    this.postMessage({
      type: "state",
      state: {
        mode: this.mode,
        model: this.model,
        effort: this.effort,
        messages: this.decorateForks(runtime),
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
    this.stopUsagePolling();
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
