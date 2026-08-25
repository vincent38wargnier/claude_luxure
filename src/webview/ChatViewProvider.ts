import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import * as crypto from "crypto";
import { execFile } from "child_process";
import {
  ClaudeBridge,
  ClaudeEvent,
  type ApiRetryEvent,
  type TaskUpdateEvent,
} from "../cli/claude-bridge";
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
  ProofAnnotation,
  PromptHistoryEntry,
  SessionMarker,
  StoredAccount,
  TaskActivity,
  TimelinePart,
  UsageBucket,
  UsageInfo,
  WebviewMessage,
} from "../shared/types";
import { buildVocabModel, topProjectWords } from "../shared/vocabWeights";
import { extractMentions, resolveFromMention } from "../utils/path-mentions";
import { loadPromptHistory } from "../utils/promptHistory";
import { LlmSuggester } from "../utils/llmSuggester";
import { log } from "../utils/logger";
import { TranscriptStore } from "../utils/transcriptStore";
import {
  PERF,
  measureStatePayload,
  perfLog,
  r1,
  startLoopLagSampler,
} from "../utils/perf";
import { resolveClaudePath } from "../utils/claude-path";
import { provisionWorktree } from "../worktree/provisioner";
import { generateRecipe } from "../worktree/recipe-generator";
import { validateRecipe, type WorktreeRecipe } from "../worktree/recipe-schema";
import {
  isCompactCommand,
  isSlashCommand,
  resolveSlashCommand,
} from "../shared/cli-commands";
import { SkillsManager } from "../skills/SkillsManager";
import type { SkillScope } from "../shared/types";
import {
  ProofChannel,
  type ProofAnnotateRequest,
  type ProofPresentRequest,
} from "../mcp/proof-channel";

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
        if (e.images && e.images.length > 0) {
          a.result.images = [...(a.result.images || []), ...e.images];
        }
      } else {
        a.result = { content: e.content, isError: e.isError, images: e.images };
      }
      return;
    }
  }
}

/** Merge a re-emitted task activity into the card already on screen (the CLI
 * emits the Agent call twice: a placeholder at content_block_start, then the
 * completed assistant event with full input). Newer non-empty fields win;
 * status only moves away from "running". */
function mergeTaskInto(into: TaskActivity, from: TaskActivity): void {
  if (from.taskId) { into.taskId = from.taskId; }
  if (from.description) { into.description = from.description; }
  if (from.subagentType) { into.subagentType = from.subagentType; }
  if (from.prompt && !into.prompt) { into.prompt = from.prompt; }
  if (from.background) { into.background = true; }
  if (from.progressSummary) { into.progressSummary = from.progressSummary; }
  if (from.lastToolName) { into.lastToolName = from.lastToolName; }
  if (from.toolUses !== undefined) { into.toolUses = from.toolUses; }
  if (from.totalTokens !== undefined) { into.totalTokens = from.totalTokens; }
  if (from.durationMs !== undefined) { into.durationMs = from.durationMs; }
  if (from.result) { into.result = from.result; }
  if (from.status !== "running") { into.status = from.status; }
}

/** Rehydrate persisted messages: clear streaming flags and settle task cards
 * that were still "running" when the window closed — the CLI (and its agents)
 * died with the extension host, so a still-running card would spin forever. */
function restoreMessages(cached: ChatMessage[]): ChatMessage[] {
  const settle = (acts?: ActivityEvent[]) => {
    for (const a of acts || []) {
      if (a.type === "task" && a.status === "running") {
        a.status = a.result ? "completed" : "failed";
        if (!a.result) {
          a.progressSummary = "Interrupted — the panel was reloaded while this agent ran";
        }
      }
    }
  };
  return cached.map((m) => {
    settle(m.activities);
    for (const p of m.timeline || []) {
      if (p.type === "activities") {
        settle(p.activities);
      }
    }
    return { ...m, isStreaming: false };
  });
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

/** Heap-protection knobs. The webview renderer OOM-crashes (V8 aborts around
 * ~2.2-2.7GB) once enough transcript/blob data accumulates in its JS heap —
 * these bound what ever reaches it. */
const DISPLAY_WINDOW_DEFAULT = 60;
const DISPLAY_WINDOW_STEP = 120;
/** Under reported heap pressure, visible conversations collapse to this. */
const DISPLAY_WINDOW_LEAN = 25;
/** Live-turn buffer caps — one runaway turn can't grow state without bound. */
const MAX_TIMELINE_PARTS = 400;
const MAX_RUN_ACTIVITIES = 300;
const MAX_TOOL_RESULT_CHARS = 20_000;
/** Webview liveness: ping cadence, silence treated as death, and the minimum
 * gap between forced recreations (guards against a recovery loop). */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEAD_MS = 50_000;
const RECOVERY_COOLDOWN_MS = 90_000;

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
  /** Watchdog that ends a turn which has gone silent (no CLI output) for too
   * long — e.g. the model parked work in the background and never resumes. */
  watchdogTimer?: ReturnType<typeof setTimeout>;
  /** Set for a worktree-backed conversation (yellow "+"): the bridge runs in
   * this directory instead of the workspace root, with these env overrides
   * (remapped ports / COMPOSE_PROJECT_NAME) merged into the child. */
  worktreeCwd?: string;
  worktreeEnv?: Record<string, string>;
  worktreeBranch?: string;
  /** Post-it identity: color assigned at tab creation, emoji picked by a
   * Haiku one-shot over the conversation (auto after the first turn, and on
   * demand when the post-it is clicked). */
  markerColor?: string;
  markerEmoji?: string;
  markerNote?: string;
  /** Conversation-level settings, stamped at creation (persisted value for a
   * known session, else the provider-wide defaults). Changing them in one
   * conversation must never affect another. */
  mode?: Mode;
  model?: string;
  effort?: EffortLevel;
  /** Epoch ms when this conversation's last reply finished (any way a turn can
   * end: result, error, stop, watchdog). Drives the tab-strip idle counter. */
  lastReplyAt?: number;
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

/** How long a streaming turn may receive zero CLI output before we assume it
 * stalled (e.g. the model deferred work to a background task that can't resume
 * in headless mode) and unstick the UI. Generous, so a long-but-live foreground
 * tool isn't cut short. */
const STREAM_WATCHDOG_MS = 180000; // 3 minutes

/** Fingerprints of an auth failure in CLI error/result text, across CLI
 * versions and failure shapes. A server-side rejection reads "401 Invalid
 * authentication credentials" (and carries api_error_status), but a
 * client-side token-refresh failure reads "Failed to authenticate: OAuth
 * session expired and could not be refreshed" with NO api_error_status —
 * only this text identifies it. Only ever tested on error text (is_error
 * results / process errors), so broad terms like "oauth" don't false-match
 * ordinary assistant prose. */
const AUTH_ERROR_TEXT =
  /\b40[13]\b|invalid bearer|authentication[_ ]?failed|invalid authentication|unauthor|credential|oauth|session expired|failed to authenticate|please run \/login/i;

/** Cap on nested activities kept per task card, so a chatty subagent can't
 * grow the persisted message state without bound (oldest entries drop off;
 * the usage counters still reflect the full run). */
const MAX_TASK_CHILDREN = 150;

/** Curated post-it palette — classic sticky-note pastels, distinct from each
 * other and readable behind an emoji glyph on both dark and light themes. */
const POSTIT_COLORS = [
  "#F5DE7A", // canary
  "#F8B87C", // peach
  "#F49FB6", // rose
  "#C9B6F0", // lavender
  "#8FCFF0", // sky
  "#9FE0B0", // mint
  "#D6E67E", // lime
  "#F4A28C", // coral
];

/** Longest user note a post-it holds — enough for ~10 words, short enough to
 * stay a glanceable sticky rather than a paragraph. */
const MARKER_NOTE_MAX = 80;

/** Keyword fallback when the one-shot emoji pick fails (offline, usage limit):
 * a coarse topic match beats a broken blank post-it. */
const EMOJI_HEURISTICS: [RegExp, string][] = [
  [/\b(bug|fix|error|crash|broken|fail)/i, "🐛"],
  [/\b(ui|css|design|style|layout|component|theme)/i, "🎨"],
  [/\b(deploy|release|ship|publish)/i, "🚀"],
  [/\b(database|db|sql|postgres|mongo|schema|migration)/i, "🗄️"],
  [/\b(auth|login|oauth|token|password|permission)/i, "🔐"],
  [/\b(test|spec|e2e|coverage)/i, "🧪"],
  [/\b(perf|performance|slow|optimi[sz]e|memory|cpu|cache)/i, "⚡"],
  [/\b(docs?|readme|documentation|comment)/i, "📝"],
  [/\b(refactor|cleanup|rename|restructure)/i, "🧹"],
  [/\b(search|find|investigate|explore|research|analy[sz]e)/i, "🔍"],
];

function heuristicEmoji(excerpt: string): string {
  for (const [re, emoji] of EMOJI_HEURISTICS) {
    if (re.test(excerpt)) {
      return emoji;
    }
  }
  return "✨";
}

/** First emoji grapheme in the model's reply — grapheme segmentation keeps ZWJ
 * sequences (👨‍💻), skin tones and flags intact, and skips any stray words. */
function extractFirstEmoji(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment } of seg.segment(trimmed)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) {
        return segment;
      }
    }
  } catch {
    const m = trimmed.match(
      /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/u
    );
    return m?.[0];
  }
  return undefined;
}

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
  /** Per-conversation display window: how many trailing messages the webview
   * gets. Widened by "loadEarlier", collapsed under heap pressure. */
  private displayWindow = new Map<string, number>();
  /** data-URL → webview-URI image cache (see externalizeImage). */
  private imageCacheDir?: string;
  private imageCacheIndex = new Map<string, string>();
  /** Webview liveness watchdog (renderer crashes emit no VS Code event). */
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastWebviewSignal = Date.now();
  private lastWebviewRecovery = 0;
  private webviewBoot = 0;
  private runtimes = new Map<string, SessionRuntime>();

  // ── Pane model: up to two side-by-side instances, VS Code editor-group style.
  /** Open tabs per pane; pane 1 empty ⇔ split closed. */
  private paneTabs: [string[], string[]] = [[], []];
  /** The conversation each pane displays. */
  private paneActive: [string | null, string | null] = [null, null];
  /** The pane the user is working in — its conversation gets real-time
   * streaming; the other pane is refreshed with full-state pushes. */
  private focusedPane: 0 | 1 = 0;

  /** The focused pane's conversation. Accessor pair so the large pre-split
   * codebase keeps reading/assigning `activeKey` unchanged; assignment also
   * guarantees strip membership. */
  private get activeKey(): string {
    return this.paneActive[this.focusedPane] ?? "";
  }
  private set activeKey(v: string) {
    this.paneActive[this.focusedPane] = v || null;
    if (v && !this.paneTabs[0].includes(v) && !this.paneTabs[1].includes(v)) {
      this.paneTabs[this.focusedPane].unshift(v);
    }
  }

  /** Every open tab across both panes (read-only — mutate paneTabs). */
  private get openTabIds(): string[] {
    return [...this.paneTabs[0], ...this.paneTabs[1]];
  }

  // Defaults for NEW conversations only (each runtime carries its own copy,
  // stamped at creation); kept in sync with the last explicit choice.
  private mode: Mode = "agent";
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private snapshotManager = new SnapshotManager();
  private diffManager = new DiffManager(this.snapshotManager);
  private accountEmail: string | undefined;
  private accountOrg: string | undefined;
  private sessionManager: SessionManager | undefined;
  private diffWatchStarted = false;
  private slashCommands: string[] = [];
  private skillsManager = new SkillsManager();
  private accountSubscription: string | undefined;
  private usagePollTimer: ReturnType<typeof setInterval> | undefined;
  private usagePollInFlight = false;
  private usageAllInFlight = false;
  // Accounts whose CLI process returned a real auth failure (401) this session.
  // Ground truth that the stored token can't authenticate — flags the account as
  // disconnected even when {@link isOAuthDead} can't tell (e.g. an expired token
  // whose refresh token is present but rejected server-side). Cleared once a
  // usage probe or reconnect succeeds for that account.
  private readonly authFailedAccountIds = new Set<string>();
  private cachedCliVersion: string | undefined;
  // Cache per keychain service name: the global "Claude Code-credentials"
  // (Default) plus one per config-dir account ("…-<sha256(configDir)[:8]>").
  // Holds the full claudeAiOauth record (accessToken + expiresAt + refreshToken)
  // so disconnection can be judged without an extra `security` spawn.
  private cachedKeychainTokens = new Map<
    string,
    { record: Record<string, any>; at: number }
  >();
  // Visual-proof side-channel: one loopback HTTP server for the extension,
  // plus a route table from each spawned bridge's id to its conversation (the
  // runtime object survives draft→session key migration, so this stays valid).
  private proofChannel: ProofChannel | undefined;
  private proofChannelFailed = false;
  private readonly proofRoutes = new Map<string, SessionRuntime>();
  // In-flight annotate renders awaiting the webview's canvas result.
  private readonly pendingAnnotations = new Map<
    string,
    {
      resolve: (dataUrl: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // Per-session transcript files — transcripts are banned from workspaceState
  // (the whole memento serializes as one sqlite row in the main process; see
  // TranscriptStore).
  private readonly transcripts: TranscriptStore;
  // Names for tabs whose runtime isn't loaded, so tab-strip refreshes don't
  // re-read transcript files. A session's first user message never changes.
  private readonly tabNameCache = new Map<string, string>();

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
    this.transcripts = new TranscriptStore(context);
    startLoopLagSampler();
    this.fetchAccountInfo();
    this.restoreLastSession();
    // After the sync restore path (which still falls back to the memento):
    // move legacy transcripts to files and purge their memento keys, so the
    // state.vscdb row shrinks back to a few KB.
    void this.transcripts.migrateFromMemento(this.context.workspaceState);
    this.transcripts.prune();
  }

  private getActiveRuntime(): SessionRuntime {
    if (!this.activeKey) {
      // Assigning activeKey also inserts the draft into the focused pane's strip.
      this.activeKey = this.createDraftRuntime();
    }
    let runtime = this.runtimes.get(this.activeKey);
    if (!runtime) {
      runtime = createEmptyRuntime();
      if (isDraftKey(this.activeKey)) {
        runtime.draftId = this.activeKey;
      } else {
        runtime.sessionId = this.activeKey;
      }
      this.stampSettings(this.activeKey, runtime);
      this.runtimes.set(this.activeKey, runtime);
    }
    return runtime;
  }

  /** Give a runtime its own conversation-level settings: the persisted ones
   * for a known session, else the provider-wide defaults at creation time. */
  private stampSettings(key: string, runtime: SessionRuntime): void {
    const persisted = !isDraftKey(key)
      ? this.context.workspaceState.get<{
          mode?: Mode;
          model?: string;
          effort?: EffortLevel;
        }>(`claude-luxure.settingsFor.${key}`)
      : undefined;
    runtime.mode = persisted?.mode ?? this.mode;
    runtime.model = persisted?.model ?? this.model;
    runtime.effort = persisted?.effort ?? this.effort;
  }

  private persistSettingsFor(runtime: SessionRuntime): void {
    if (!runtime.sessionId) {
      return;
    }
    this.context.workspaceState.update(
      `claude-luxure.settingsFor.${runtime.sessionId}`,
      { mode: runtime.mode, model: runtime.model, effort: runtime.effort }
    );
  }

  private createDraftRuntime(): string {
    const draftKey = `draft-${generateId()}`;
    this.runtimes.set(draftKey, createEmptyRuntime());
    const runtime = this.runtimes.get(draftKey)!;
    runtime.draftId = draftKey;
    this.stampSettings(draftKey, runtime);
    // Every conversation gets its post-it color at birth, so a brand-new tab
    // is visually distinguishable before any message is sent.
    runtime.markerColor = this.pickMarkerColor();
    return draftKey;
  }

  private isActiveKey(key: string): boolean {
    return key === this.activeKey;
  }

  private paneOf(tabId: string): 0 | 1 | undefined {
    if (this.paneTabs[0].includes(tabId)) {
      return 0;
    }
    if (this.paneTabs[1].includes(tabId)) {
      return 1;
    }
    return undefined;
  }

  /** Re-key a tab in place (draft → real session id), wherever it lives. */
  private renameTab(oldKey: string, newKey: string): void {
    for (const pane of [0, 1] as const) {
      const idx = this.paneTabs[pane].indexOf(oldKey);
      if (idx >= 0) {
        this.paneTabs[pane][idx] = newKey;
      }
      if (this.paneActive[pane] === oldKey) {
        this.paneActive[pane] = newKey;
      }
    }
    if (this.paneOf(newKey) === undefined) {
      this.paneTabs[this.focusedPane].unshift(newKey);
    }
  }

  private persistPanes(): void {
    this.context.workspaceState.update("claude-luxure.openTabs", this.openTabIds);
    this.context.workspaceState.update("claude-luxure.panes", {
      tabs: this.paneTabs,
      active: this.paneActive,
      focused: this.focusedPane,
    });
  }

  /** Keep the pane model coherent: an emptied pane 0 adopts pane 1's tabs, an
   * empty pane 1 folds the split away, and each pane's displayed conversation
   * must be one of its own tabs. */
  private normalizePanes(): void {
    if (this.paneTabs[0].length === 0 && this.paneTabs[1].length > 0) {
      this.paneTabs[0] = this.paneTabs[1];
      this.paneTabs[1] = [];
      this.paneActive[0] = this.paneActive[1];
      this.paneActive[1] = null;
      this.focusedPane = 0;
    }
    if (this.paneTabs[1].length === 0) {
      this.paneActive[1] = null;
      this.focusedPane = 0;
    }
    for (const pane of [0, 1] as const) {
      const tabs = this.paneTabs[pane];
      const active = this.paneActive[pane];
      if (tabs.length === 0) {
        this.paneActive[pane] = null;
      } else if (!active || !tabs.includes(active)) {
        this.paneActive[pane] = tabs[0];
      }
    }
  }

  /** Load a session into a runtime if it isn't already (persisted messages →
   * transcript fallback), so a pane can display it. */
  private async ensureRuntimeLoaded(key: string): Promise<void> {
    if (!key || this.runtimes.has(key)) {
      return;
    }
    const runtime = createEmptyRuntime();
    if (isDraftKey(key)) {
      runtime.draftId = key;
    } else {
      runtime.sessionId = key;
      await this.loadRuntimeMessages(key, runtime);
    }
    this.stampSettings(key, runtime);
    this.runtimes.set(key, runtime);
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
    this.moveDisplayWindow(draftKey, sessionId);
    runtime.sessionId = sessionId;
    delete runtime.draftId;
    this.runtimes.set(sessionId, runtime);
    // The color chosen at draft time can be persisted now that a real id
    // exists — same for any settings picked while still a draft.
    this.persistMarker(runtime);
    this.persistSettingsFor(runtime);

    this.renameTab(draftKey, sessionId);
  }

  /** Read the ambient (Default account) `auth status` and publish it. Awaitable
   * so a reconnect can report the identity the user actually logged in as —
   * callers that just want the refresh can ignore the promise. */
  private fetchAccountInfo(): Promise<void> {
    return new Promise((resolve) => {
      execFile(resolveClaudePath(), ["auth", "status"], (err, stdout) => {
        if (err) {
          log("WARN", "Failed to fetch account info:", err.message);
          resolve();
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
        resolve();
      });
    });
  }

  /** Synchronously hydrate a runtime from the workspaceState message cache —
   * used at startup, before any async transcript loading is possible. */
  private restoreRuntimeFromCache(key: string): void {
    if (!key || this.runtimes.has(key)) {
      return;
    }
    const runtime = createEmptyRuntime();
    if (isDraftKey(key)) {
      runtime.draftId = key;
    } else {
      runtime.sessionId = key;
      runtime.contextSummarized = this.loadContextSummarized(key);
      // Memento fallback covers sessions from before the file store existed
      // whose migration hasn't run/finished yet.
      const cached =
        this.transcripts.load(key) ??
        this.context.workspaceState.get<ChatMessage[]>(
          `claude-luxure.messages.${key}`
        );
      if (cached && cached.length > 0) {
        runtime.messages = restoreMessages(cached);
        log("INFO", `Restored ${cached.length} messages for session ${key}`);
      }
    }
    this.stampSettings(key, runtime);
    this.runtimes.set(key, runtime);
  }

  private restoreLastSession(): void {
    const persisted = this.context.workspaceState.get<{
      tabs?: [string[], string[]];
      active?: [string | null, string | null];
      focused?: number;
    }>("claude-luxure.panes");

    if (persisted?.tabs && Array.isArray(persisted.tabs[0])) {
      this.paneTabs = [persisted.tabs[0] || [], persisted.tabs[1] || []];
      this.paneActive = [persisted.active?.[0] ?? null, persisted.active?.[1] ?? null];
      this.focusedPane = persisted.focused === 1 ? 1 : 0;
    } else {
      // Legacy flat tab list from before the split-pane model.
      this.paneTabs = [
        this.context.workspaceState.get<string[]>("claude-luxure.openTabs") || [],
        [],
      ];
    }

    const lastSessionId = this.context.workspaceState.get<string>("claude-luxure.lastSessionId");
    if (lastSessionId && !this.activeKey) {
      this.activeKey = lastSessionId; // setter inserts it into the focused strip
    }
    this.normalizePanes();

    // Hydrate what each pane shows so the first render isn't empty.
    for (const pane of [0, 1] as const) {
      const key = this.paneActive[pane];
      if (key) {
        this.restoreRuntimeFromCache(key);
      }
    }
  }

  private persistRuntime(key: string, runtime: SessionRuntime): void {
    const persistId = runtime.sessionId;
    if (persistId && runtime.messages.length > 0) {
      this.transcripts.save(
        persistId,
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
    if (persistId && runtime.lastReplyAt) {
      this.context.workspaceState.update(
        `claude-luxure.lastReplyAt.${persistId}`,
        runtime.lastReplyAt
      );
    }
    this.persistPanes();
    this.persistMarker(runtime);
    this.persistSettingsFor(runtime);
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

  /** Ask Claude for a {title, summary} of a transcript (headless one-shot). */
  private runClaudeSummary(
    transcript: string
  ): Promise<{ title: string; summary: string }> {
    const prompt =
      `${SUMMARY_PROMPT_MARKER} Write a concise title and a short summary of ` +
      "what it is about. Respond with ONLY a JSON object, no markdown, no extra " +
      'text: {"title": "<max 6 words>", "summary": "<1-2 sentences>"}.\n\n' +
      `<conversation>\n${transcript}\n</conversation>`;

    const runtime = this.activeKey ? this.runtimes.get(this.activeKey) : undefined;
    return this.runClaudePrint(prompt, runtime?.accountId).then((text) =>
      this.parseTitleSummary(text)
    );
  }

  /** Spawn a headless `claude -p` (Haiku, JSON output) and return the model's
   * reply text. Runs under the given account so auth matches the conversation,
   * and in a throwaway cwd so the transient print-mode session is NOT written
   * into the project's transcript folder (which would otherwise pollute the
   * history); the transcript it does write is deleted afterwards. */
  private runClaudePrint(prompt: string, accountId?: string): Promise<string> {
    const configDir = this.getConfigDirForAccount(accountId);
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
        resolveClaudePath(),
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
            // text is in `.result`. It also writes a transcript for this
            // throwaway session — delete it so it never lingers anywhere.
            const envelope = JSON.parse(stdout.trim());
            if (typeof envelope.session_id === "string") {
              this.deleteTransientSession(configDir, cwd, envelope.session_id);
            }
            resolve(
              typeof envelope.result === "string" ? envelope.result : stdout
            );
          } catch {
            resolve(stdout);
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

  // ─────────────────────── Conversation post-it markers ───────────────────────
  // Each conversation gets a post-it: a palette color assigned when the tab is
  // created, and an emoji picked by a Haiku one-shot over the transcript once
  // automatically after the first completed turn (a first message alone is often
  // not enough context). Clicking the post-it edits a user note, which the
  // sticky then shows in place of the emoji until the note is cleared.

  /** Runtimes with an emoji pick in flight, to dedupe concurrent requests. */
  private markerBusy = new Set<SessionRuntime>();

  private markerKeyFor(runtime: SessionRuntime): string {
    return runtime.sessionId || runtime.draftId || "";
  }

  /** Lazily give a runtime its marker: restore the persisted one for a real
   * session, else assign a fresh color avoiding those already on open tabs. */
  private ensureMarker(key: string, runtime: SessionRuntime): void {
    if (runtime.markerColor) {
      return;
    }
    if (key && !isDraftKey(key)) {
      const persisted = this.context.workspaceState.get<SessionMarker>(
        `claude-luxure.sessionMarker.${key}`
      );
      if (persisted?.color) {
        runtime.markerColor = persisted.color;
        if (!runtime.markerEmoji) {
          runtime.markerEmoji = persisted.emoji;
        }
        if (!runtime.markerNote) {
          runtime.markerNote = persisted.note;
        }
        return;
      }
    }
    runtime.markerColor = this.pickMarkerColor();
    this.persistMarker(runtime);
  }

  /** Random palette color, preferring one no open tab is already using. */
  private pickMarkerColor(): string {
    const used = new Set<string>();
    for (const id of this.openTabIds) {
      const c = this.runtimes.get(id)?.markerColor;
      if (c) {
        used.add(c);
      }
    }
    const free = POSTIT_COLORS.filter((c) => !used.has(c));
    const pool = free.length > 0 ? free : POSTIT_COLORS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private persistMarker(runtime: SessionRuntime): void {
    if (!runtime.sessionId || !runtime.markerColor) {
      return;
    }
    const marker: SessionMarker = {
      emoji: runtime.markerEmoji,
      color: runtime.markerColor,
      note: runtime.markerNote,
    };
    this.context.workspaceState.update(
      `claude-luxure.sessionMarker.${runtime.sessionId}`,
      marker
    );
  }

  private postMarkerUpdate(runtime: SessionRuntime, busy: boolean): void {
    const key = this.markerKeyFor(runtime);
    if (!key || !runtime.markerColor) {
      return;
    }
    this.postMessage({
      type: "markerUpdate",
      key,
      marker: {
        emoji: runtime.markerEmoji,
        color: runtime.markerColor,
        note: runtime.markerNote,
      },
      busy,
    });
  }

  /** Compact excerpt of the most recent turns — the emoji pick's input. */
  private buildMarkerExcerpt(runtime: SessionRuntime): string | null {
    const recent = runtime.messages
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") && m.content.trim()
      )
      .slice(-8);
    if (!recent.some((m) => m.role === "user")) {
      return null;
    }
    return recent
      .map(
        (m) =>
          `${m.role.toUpperCase()}: ${m.content
            .replace(/\s+/g, " ")
            .slice(0, 300)}`
      )
      .join("\n");
  }

  private markerPrompt(excerpt: string): string {
    return (
      `${SUMMARY_PROMPT_MARKER} Reply with exactly ONE emoji character that ` +
      "best represents the conversation's dominant topic or activity — it " +
      "will visually label this chat. Prefer specific over generic " +
      "(🐛 debugging, 🎨 UI/design, 🚀 deploy, 🗄️ database, 🔐 auth, " +
      "🧪 testing, ⚡ performance, 📦 dependencies, 📝 docs, 🔍 research). " +
      "Never reply with 💻 🤖 💬. No words, no punctuation — just the single " +
      "emoji.\n\n" +
      `<conversation>\n${excerpt}\n</conversation>`
    );
  }

  /** Pick (or re-pick) the emoji for a conversation from its recent content.
   * Fire-and-forget: a failed one-shot falls back to a keyword heuristic so
   * the post-it never stays blank once there is content to label. */
  private async evaluateMarker(runtime: SessionRuntime): Promise<void> {
    if (this.markerBusy.has(runtime)) {
      return;
    }
    this.ensureMarker(this.markerKeyFor(runtime), runtime);
    const excerpt = this.buildMarkerExcerpt(runtime);
    if (!excerpt) {
      return;
    }
    this.markerBusy.add(runtime);
    this.postMarkerUpdate(runtime, true);
    try {
      const reply = await this.runClaudePrint(
        this.markerPrompt(excerpt),
        runtime.accountId
      );
      runtime.markerEmoji =
        extractFirstEmoji(reply) || runtime.markerEmoji || heuristicEmoji(excerpt);
    } catch (err) {
      log("WARN", "Emoji pick failed, falling back to heuristic:", String(err));
      runtime.markerEmoji = runtime.markerEmoji || heuristicEmoji(excerpt);
    } finally {
      this.markerBusy.delete(runtime);
      this.persistMarker(runtime);
      this.postMarkerUpdate(runtime, false);
      this.sendOpenTabs(); // the tab strip shows the emoji too
    }
  }

  /** Set (or clear, with an empty string) the active conversation's note. */
  private handleSetMarkerNote(note: string): void {
    const runtime = this.getActiveRuntime();
    this.ensureMarker(this.markerKeyFor(runtime), runtime);
    const trimmed = note.replace(/\s+/g, " ").trim().slice(0, MARKER_NOTE_MAX);
    runtime.markerNote = trimmed || undefined;
    this.persistMarker(runtime);
    this.postMarkerUpdate(runtime, this.markerBusy.has(runtime));
    this.sendOpenTabs();
  }

  // ──────────────────────── Idle-time (last reply) counters ────────────────────────

  /** Fallback last-activity timestamps (transcript mtime) for sessions that
   * predate lastReplyAt persistence. Stat once per session, then cached — the
   * live value written at finalize takes over from the next reply on. */
  private lastReplyFallback = new Map<string, number | null>();

  /** When this conversation's last reply finished, best-effort:
   * live runtime value → persisted value → transcript file mtime. */
  private lastReplyAtFor(key: string, runtime?: SessionRuntime): number | undefined {
    if (runtime?.lastReplyAt) {
      return runtime.lastReplyAt;
    }
    if (!key || isDraftKey(key)) {
      return undefined;
    }
    const persisted = this.context.workspaceState.get<number>(
      `claude-luxure.lastReplyAt.${key}`
    );
    if (persisted) {
      if (runtime) {
        runtime.lastReplyAt = persisted;
      }
      return persisted;
    }
    if (!this.lastReplyFallback.has(key)) {
      this.lastReplyFallback.set(
        key,
        this.getSessionManager()?.transcriptMtime(key) ?? null
      );
    }
    return this.lastReplyFallback.get(key) || undefined;
  }

  // ───────────────────────────── Split view ─────────────────────────────
  // Two full instances side by side (VS Code editor-group style). Each pane
  // has its own tab strip, transcript and composer. Real-time streaming flows
  // to the FOCUSED pane's conversation only (that's what the whole pre-split
  // event plumbing assumes); the other pane is kept live with full-state
  // pushes — on focus changes, on its turn settling, and on a slow ticker
  // while it has a turn in flight. Focus follows interaction.

  private paneTicker?: ReturnType<typeof setInterval>;

  /** perfId of an in-flight tab switch — echoed on the next state send so the
   * webview can correlate its click → state → painted waterfall. */
  private pendingStatePerfId?: string;

  private ensurePaneTicker(): void {
    if (this.paneTicker) {
      return;
    }
    this.paneTicker = setInterval(() => {
      if (this.paneTabs[1].length === 0) {
        return;
      }
      const other = (1 - this.focusedPane) as 0 | 1;
      const key = this.paneActive[other];
      const rt = key ? this.runtimes.get(key) : undefined;
      if (rt?.streamingMessageId) {
        this.sendPaneState(other, "ticker");
      }
    }, 900);
  }

  /** Full display state for the UNFOCUSED pane's conversation. */
  /** Re-push whichever view(s) currently display `key` — the live state when
   * it's the focused conversation, a paneState push when it sits in the other
   * pane. Used after display-window changes (loadEarlier / heap trims). */
  private refreshConversationViews(key: string): void {
    if (this.isActiveKey(key)) {
      this.sendState();
    }
    for (const pane of [0, 1] as const) {
      if (pane !== this.focusedPane && this.paneActive[pane] === key) {
        this.sendPaneState(pane);
      }
    }
  }

  private sendPaneState(pane: 0 | 1, via: "push" | "ticker" = "push"): void {
    if (this.paneTabs[1].length === 0) {
      return;
    }
    const key = this.paneActive[pane];
    const runtime = key ? this.runtimes.get(key) : undefined;
    if (!key || !runtime) {
      return;
    }
    const t0 = performance.now();
    const state = this.buildStateFor(key, runtime);
    const tBuilt = performance.now();
    this.postMessage({
      type: "paneState",
      pane,
      state,
      perfSentAt: Date.now(),
    });
    if (PERF) {
      perfLog("paneState.sent", {
        via,
        pane,
        sid: key.slice(-8),
        ...measureStatePayload(state),
        buildMs: r1(tBuilt - t0),
        postMs: r1(performance.now() - tBuilt),
      });
    }
  }

  /** Layout + fresh state for both panes, in the order the webview needs:
   * layout first (so `state` routes to the right pane), then the states. */
  private sendPanesSnapshot(): void {
    this.sendOpenTabs();
    this.sendState();
    this.sendPaneState((1 - this.focusedPane) as 0 | 1);
  }

  /** The user started interacting with the other pane: its conversation takes
   * over the real-time stream; the demoted one falls back to pushes. */
  private async handleFocusPane(pane: 0 | 1): Promise<void> {
    if (pane === this.focusedPane || (pane === 1 && this.paneTabs[1].length === 0)) {
      return;
    }
    const t0 = performance.now();
    this.persistActiveSession();
    const demoted = this.focusedPane;
    this.focusedPane = pane;
    this.normalizePanes();
    const key = this.paneActive[this.focusedPane];
    if (key) {
      await this.ensureRuntimeLoaded(key);
      this.context.workspaceState.update("claude-luxure.lastSessionId", key);
    }
    this.persistPanes();
    this.sendOpenTabs();
    this.sendState();
    this.sendPaneState(demoted);
    this.sendAccountsList();
    void this.pollUsageForActive();
    perfLog("focus.done", { pane, totalMs: r1(performance.now() - t0) });
  }

  /** Drag & drop: reorder within a strip, or move a conversation to the other
   * pane (where it becomes that pane's displayed conversation). */
  private async handleMoveTab(tabId: string, targetPane: 0 | 1, index: number): Promise<void> {
    const source = this.paneOf(tabId);
    if (source === undefined) {
      return;
    }
    this.persistActiveSession();
    const src = this.paneTabs[source];
    const from = src.indexOf(tabId);
    src.splice(from, 1);
    let insert = index;
    if (source === targetPane && from < insert) {
      insert -= 1; // account for the slot the tab just vacated
    }
    const dst = this.paneTabs[targetPane];
    insert = Math.max(0, Math.min(insert, dst.length));
    dst.splice(insert, 0, tabId);

    if (source !== targetPane) {
      await this.ensureRuntimeLoaded(tabId);
      this.paneActive[targetPane] = tabId;
      this.focusedPane = targetPane;
      if (this.paneActive[source] === tabId || !src.includes(this.paneActive[source] || "")) {
        this.paneActive[source] = src[Math.min(from, src.length - 1)] ?? null;
        if (this.paneActive[source]) {
          await this.ensureRuntimeLoaded(this.paneActive[source]!);
        }
      }
      this.ensurePaneTicker();
    }
    this.normalizePanes();
    this.persistPanes();
    this.sendPanesSnapshot();
  }

  /** Split button: open a second pane (seeded with the next tab, or a fresh
   * draft), or fold pane 1's tabs back into pane 0 — nothing gets closed. */
  private async handleToggleSplit(): Promise<void> {
    this.persistActiveSession();
    if (this.paneTabs[1].length > 0) {
      const focusedConv = this.activeKey;
      this.paneTabs[0] = [...this.paneTabs[0], ...this.paneTabs[1]];
      this.paneTabs[1] = [];
      this.paneActive[1] = null;
      this.focusedPane = 0;
      if (focusedConv) {
        this.paneActive[0] = focusedConv;
      }
      this.normalizePanes();
      this.postMessage({ type: "paneState", pane: 1, state: undefined });
    } else {
      const donorIdx = this.paneTabs[0].findIndex((id) => id !== this.paneActive[0]);
      if (donorIdx >= 0) {
        const donor = this.paneTabs[0].splice(donorIdx, 1)[0];
        this.paneTabs[1] = [donor];
        this.paneActive[1] = donor;
        await this.ensureRuntimeLoaded(donor);
      } else {
        const draft = this.createDraftRuntime();
        this.runtimes.get(draft)!.accountId =
          this.context.globalState.get<string>("claude-luxure.lastAccountId") || "default";
        this.paneTabs[1] = [draft];
        this.paneActive[1] = draft;
      }
      this.focusedPane = 1;
      this.ensurePaneTicker();
    }
    this.persistPanes();
    this.sendPanesSnapshot();
    this.sendAccountsList();
    void this.pollUsageForActive();
  }

  private async loadRuntimeMessages(key: string, runtime: SessionRuntime): Promise<void> {
    if (isDraftKey(key)) {
      runtime.messages = [];
      return;
    }

    runtime.sessionId = key;
    runtime.contextSummarized = this.loadContextSummarized(key);
    const cached =
      this.transcripts.load(key) ??
      this.context.workspaceState.get<ChatMessage[]>(`claude-luxure.messages.${key}`);
    if (cached && cached.length > 0) {
      runtime.messages = restoreMessages(cached);
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

  /** Show a conversation: if its tab is already open in either pane, that pane
   * takes focus (VS Code-style); otherwise it opens in `pane` (default: the
   * focused one). */
  private async handleSwitchSession(
    sessionId: string,
    pane?: 0 | 1,
    perfId?: string
  ): Promise<void> {
    const t0 = performance.now();
    this.pendingStatePerfId = perfId;
    this.persistActiveSession();
    const tPersisted = performance.now();

    const existing = this.paneOf(sessionId);
    const target = existing ?? (pane !== undefined && this.paneTabs[1].length > 0 ? pane : this.focusedPane);
    if (existing === undefined) {
      this.paneTabs[target].unshift(sessionId);
    }
    this.focusedPane = target;
    this.paneActive[target] = sessionId;

    const tLoad = performance.now();
    await this.ensureRuntimeLoaded(sessionId);
    const tLoaded = performance.now();

    this.context.workspaceState.update("claude-luxure.lastSessionId", sessionId);
    this.persistActiveSession();
    const tSnap = performance.now();
    this.sendPanesSnapshot();
    const tDone = performance.now();
    this.sendAccountsList();
    void this.pollUsageForActive();
    perfLog("sw.done", {
      perfId,
      sid: sessionId.slice(-8),
      totalMs: r1(tDone - t0),
      persistMs: r1(tPersisted - t0 + (tSnap - tLoaded)),
      loadMs: r1(tLoaded - tLoad),
      snapshotMs: r1(tDone - tSnap),
    });
  }

  private stopRuntimeBridge(key: string, runtime: SessionRuntime): void {
    const bridge = runtime.bridge;
    runtime.bridge = undefined;
    runtime.cliStatus = "stopped";
    // A killed CLI can never finish its agents — settle their cards so the
    // "N agents working" strip doesn't survive the stop as a ghost.
    const settled = this.settleRunningTasks(
      runtime,
      "Interrupted — the run was stopped",
      this.isActiveKey(key)
    );
    if (runtime.streamingMessageId) {
      this.finalizeStreamingMessage(key, runtime, false);
    } else if (settled > 0) {
      this.persistRuntime(key, runtime);
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

  private async handleCloseTab(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (runtime) {
      this.stopRuntimeBridge(tabId, runtime);
      this.runtimes.delete(tabId);
    }
    this.displayWindow.delete(tabId);

    const wasSplit = this.paneTabs[1].length > 0;
    for (const pane of [0, 1] as const) {
      this.paneTabs[pane] = this.paneTabs[pane].filter((id) => id !== tabId);
      if (this.paneActive[pane] === tabId) {
        this.paneActive[pane] = null;
      }
    }
    this.normalizePanes();
    if (wasSplit && this.paneTabs[1].length === 0) {
      this.postMessage({ type: "paneState", pane: 1, state: undefined });
    }

    if (!this.activeKey) {
      if (this.openTabIds.length > 0) {
        void this.handleSwitchSession(this.openTabIds[0]);
        return;
      }
      this.handleNewConversation();
      return;
    }

    for (const pane of [0, 1] as const) {
      const key = this.paneActive[pane];
      if (key) {
        await this.ensureRuntimeLoaded(key);
      }
    }
    this.persistActiveSession();
    this.sendPanesSnapshot();
  }

  /** Cursor-style "Close All": closes every open tab in both panes, except
   * conversations with a turn still running — closing those would kill the
   * work mid-flight. Closed sessions stay recoverable from History. */
  private handleCloseAllTabs(): void {
    const wasSplit = this.paneTabs[1].length > 0;
    for (const pane of [0, 1] as const) {
      const keep: string[] = [];
      for (const id of this.paneTabs[pane]) {
        const runtime = this.runtimes.get(id);
        if (runtime?.streamingMessageId) {
          keep.push(id);
          continue;
        }
        if (runtime) {
          this.stopRuntimeBridge(id, runtime);
          this.persistRuntime(id, runtime);
          this.runtimes.delete(id);
        }
        this.displayWindow.delete(id);
        if (this.paneActive[pane] === id) {
          this.paneActive[pane] = null;
        }
      }
      this.paneTabs[pane] = keep;
    }
    this.normalizePanes();
    if (wasSplit && this.paneTabs[1].length === 0) {
      this.postMessage({ type: "paneState", pane: 1, state: undefined });
    }
    this.persistPanes();

    if (!this.activeKey) {
      if (this.openTabIds.length > 0) {
        void this.handleSwitchSession(this.openTabIds[0]);
        return;
      }
      this.handleNewConversation();
      return;
    }

    this.sendPanesSnapshot();
  }

  private sendOpenTabs(): void {
    const perfT0 = performance.now();
    const names: Record<string, string> = {};
    const markers: Record<string, SessionMarker> = {};
    const lastReplyAt: Record<string, number> = {};
    for (const id of this.openTabIds) {
      names[id] = this.tabNameFor(id);
      const rt = this.runtimes.get(id);
      if (rt) {
        this.ensureMarker(id, rt);
        markers[id] = {
          emoji: rt.markerEmoji,
          color: rt.markerColor!,
          note: rt.markerNote,
        };
      } else {
        // Tab not loaded into a runtime yet — its persisted marker still
        // identifies it in the strip.
        const persisted = this.context.workspaceState.get<SessionMarker>(
          `claude-luxure.sessionMarker.${id}`
        );
        if (persisted?.color) {
          markers[id] = persisted;
        }
      }
      const replyAt = this.lastReplyAtFor(id, rt);
      if (replyAt) {
        lastReplyAt[id] = replyAt;
      }
    }
    this.postMessage({
      type: "openTabs",
      tabIds: this.openTabIds,
      names,
      markers,
      lastReplyAt,
      panes: [
        { tabIds: [...this.paneTabs[0]], activeId: this.paneActive[0] },
        { tabIds: [...this.paneTabs[1]], activeId: this.paneActive[1] },
      ],
      focusedPane: this.focusedPane,
    });
    const perfMs = performance.now() - perfT0;
    if (perfMs > 5) {
      // tabNameFor reads persisted transcripts for tabs without a runtime —
      // the usual reason this gets slow as tabs pile up.
      perfLog("tabs.sent", { tabs: this.openTabIds.length, ms: r1(perfMs) });
    }
  }

  /** A human-readable tab label: the session's name, else its first real user
   * message (from memory, or persisted messages for tabs not loaded yet). */
  private tabNameFor(key: string): string {
    const rt = this.runtimes.get(key);
    if (rt?.sessionName) {
      return rt.sessionName;
    }
    const cachedName = this.tabNameCache.get(key);
    if (!rt?.messages && cachedName) {
      return cachedName;
    }
    const messages =
      rt?.messages ??
      this.transcripts.load(key) ??
      this.context.workspaceState.get<ChatMessage[]>(
        `claude-luxure.messages.${key}`
      );
    const firstUser = messages?.find(
      (m) => m.role === "user" && m.content.trim() && !isSlashCommand(m.content)
    );
    if (firstUser) {
      const name = sessionNameFromText(firstUser.content);
      this.tabNameCache.set(key, name);
      return name;
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
    this.activeKey = draftKey; // setter inserts it into the focused strip

    this.sendPanesSnapshot();
    this.sendAccountsList();
    void this.pollUsageForActive();
  }

  /** Yellow "+": start a conversation in a fresh git worktree with a duplicated,
   * port-remapped environment. If the project has no duplication config yet, we
   * ASK before generating it with a one-time Claude research pass. */
  private async handleNewWorktreeConversation(): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      void vscode.window.showErrorMessage("Open a workspace folder first.");
      return;
    }

    // 1. Load the project's recipe — or ask permission to generate it.
    let recipe = this.tryLoadWorktreeRecipe(workspacePath);
    if (!recipe) {
      const choice = await vscode.window.showInformationMessage(
        "This project has no environment-duplication config yet.\n\n" +
          "Let Claude analyze the project and generate .claude-luxure/worktree.json " +
          "(how to copy secrets, clone deps, remap ports, isolate services)? " +
          "One time per project, takes ~2 minutes.",
        { modal: true },
        "Generate config"
      );
      if (choice !== "Generate config") {
        return; // cancelled
      }
    }

    // 2. Name the environment (becomes the branch + worktree name).
    const name = await vscode.window.showInputBox({
      title: "New worktree conversation",
      prompt: "Name this environment — becomes the branch + worktree",
      placeHolder: "e.g. fix login bug",
      ignoreFocusOut: true,
    });
    if (!name || !name.trim()) {
      return; // cancelled
    }

    try {
      // 3. Generate the recipe now if it was missing (user already approved).
      if (!recipe) {
        recipe = await this.generateWorktreeRecipe(workspacePath);
        if (!recipe) {
          return; // cancelled mid-analysis
        }
        void vscode.window.showInformationMessage(
          "Duplication config generated — review or edit .claude-luxure/worktree.json anytime."
        );
      }

      // 4. Full environment or files-only? Only worth asking when the recipe
      //    actually has heavy steps (setup command / docker services).
      const setupCmds = recipe.provision
        .map((s) => ("cmd" in s ? s.cmd : ""))
        .filter(Boolean)
        .join(", ");
      const isCompose = recipe.services.mode === "compose";
      let full = false;
      if (setupCmds || isCompose) {
        const choice = await vscode.window.showInformationMessage(
          "Duplicate the FULL environment?\n\n" +
            `Full: also runs the project setup (${setupCmds || "docker compose up"}) so the copy is immediately runnable — can take several minutes.\n\n` +
            "Files & ports only: instant; the agent can run setup itself later.",
          { modal: true },
          "Full environment",
          "Files & ports only"
        );
        if (!choice) {
          return; // cancelled
        }
        full = choice === "Full environment";
      }

      // 5. Provision (worktree + secrets + deps + remapped ports [+ setup/stack]).
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Luxure — duplicating environment",
          cancellable: false,
        },
        (progress) =>
          provisionWorktree({
            projectPath: workspacePath,
            recipe: recipe!,
            slug: name,
            runSteps: full,
            startServices: full,
            now: new Date().toISOString(),
            onProgress: (line) => progress.report({ message: line }),
          })
      );
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `Worktree provisioning failed: ${result.warnings.slice(-1)[0] || "unknown error"}`
        );
        return;
      }

      // Open a fresh conversation bound to the worktree's cwd + env.
      this.persistActiveSession();
      const draftKey = this.createDraftRuntime();
      const rt = this.runtimes.get(draftKey)!;
      rt.accountId =
        this.context.globalState.get<string>("claude-luxure.lastAccountId") || "default";
      rt.worktreeCwd = result.cwd;
      rt.worktreeEnv = result.env;
      rt.worktreeBranch = result.branch;
      rt.sessionName = result.branch;
      this.activeKey = draftKey; // setter inserts it into the focused strip

      this.sendPanesSnapshot();
      this.sendAccountsList();
      void this.pollUsageForActive();

      const portSummary = result.ports.map((p) => `${p.var}=${p.port}`).join("  ");
      void vscode.window.showInformationMessage(
        `Worktree ready: ${result.branch}${portSummary ? ` · ${portSummary}` : ""}` +
          (result.warnings.length ? `  (${result.warnings.length} warning(s) — see logs)` : "")
      );
      for (const w of result.warnings) {
        log("WARN", "worktree:", w);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Worktree setup error: ${String(err)}`);
      log("ERROR", "handleNewWorktreeConversation failed:", String(err));
    }
  }

  /** Read + validate `.claude-luxure/worktree.json`; undefined when absent or
   * invalid (invalid → we offer to regenerate, same as missing). */
  private tryLoadWorktreeRecipe(projectPath: string): WorktreeRecipe | undefined {
    const recipeFile = path.join(projectPath, ".claude-luxure", "worktree.json");
    if (!fs.existsSync(recipeFile)) {
      return undefined;
    }
    try {
      const v = validateRecipe(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
      if (v.valid && v.recipe) {
        return v.recipe;
      }
      log("WARN", "worktree recipe invalid, offering regeneration:", v.errors.join("; "));
    } catch (e) {
      log("WARN", "worktree recipe unreadable, offering regeneration:", String(e));
    }
    return undefined;
  }

  /** Run the one-time research pass and write the recipe. Returns undefined on
   * user cancellation; throws on failure. */
  private async generateWorktreeRecipe(projectPath: string): Promise<WorktreeRecipe | undefined> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Claude Luxure — analyzing project (one-time, ~2 min)",
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        let res;
        try {
          res = await generateRecipe({
            projectPath,
            claudePath: resolveClaudePath(),
            signal: controller.signal,
            onStderr: (s) => {
              const line = s.trim();
              if (line && line.length < 120) {
                progress.report({ message: line });
              }
            },
          });
        } catch (e) {
          if (token.isCancellationRequested) {
            return undefined; // user cancelled — the child was aborted, stay quiet
          }
          throw e;
        }
        if (token.isCancellationRequested) {
          return undefined;
        }
        if (!res.validation.valid || !res.recipe) {
          throw new Error(`recipe generation failed: ${res.validation.errors.join("; ")}`);
        }
        const recipe: WorktreeRecipe = { ...res.recipe, generatedAt: new Date().toISOString() };
        fs.mkdirSync(path.join(projectPath, ".claude-luxure"), { recursive: true });
        fs.writeFileSync(
          path.join(projectPath, ".claude-luxure", "worktree.json"),
          JSON.stringify(recipe, null, 2) + "\n"
        );
        return recipe;
      }
    );
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

    const resourceRoots = [
      vscode.Uri.file(
        path.join(this.context.extensionPath, "webview-ui", "dist")
      ),
    ];
    // Images are served as files from this cache instead of base64 data URLs
    // held in state — pixels then live in Chromium's image cache, not V8.
    const imgCache = this.ensureImageCacheDir();
    if (imgCache) {
      resourceRoots.push(vscode.Uri.file(imgCache));
    }
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots,
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
    this.startHeartbeat();

    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.webview = undefined;
      this.stopUsagePolling();
      this.stopHeartbeat();
    });
  }

  /** Ping the webview while it's visible; if it stays silent past the dead
   * threshold, assume its renderer died (OOM crashes leave a gray panel and no
   * VS Code event) and recreate it. Any incoming message counts as liveness. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastWebviewSignal = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const view = this.webviewView;
      if (!view) {
        return;
      }
      if (!view.visible) {
        // Hidden views legitimately go quiet — never judge them.
        this.lastWebviewSignal = Date.now();
        return;
      }
      void view.webview.postMessage({ type: "ping", t: Date.now() });
      const silentMs = Date.now() - this.lastWebviewSignal;
      if (silentMs > HEARTBEAT_DEAD_MS) {
        this.recoverWebview(`no heartbeat for ${Math.round(silentMs / 1000)}s`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** Reload the webview's HTML — the only lever that also resurrects a crashed
   * renderer. State lives on the host, so the panel rebuilds via "ready". */
  private recoverWebview(reason: string): void {
    const view = this.webviewView;
    if (!view) {
      return;
    }
    const now = Date.now();
    if (now - this.lastWebviewRecovery < RECOVERY_COOLDOWN_MS) {
      log("WARN", `Webview recovery skipped (cooldown): ${reason}`);
      return;
    }
    this.lastWebviewRecovery = now;
    this.webviewBoot++;
    log("WARN", `Webview recovery #${this.webviewBoot}: ${reason}`);
    perfLog("wv.recovery", { boot: this.webviewBoot, reason });
    view.webview.html = this.getHtmlContent(view.webview);
    this.lastWebviewSignal = Date.now();
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
  <!-- boot ${this.webviewBoot} — changes the html string so recovery re-assignment always reloads -->
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    // Any message from the webview proves its renderer is alive.
    this.lastWebviewSignal = Date.now();
    if (message.type === "pong") {
      return;
    }
    if (message.type === "memStats") {
      perfLog("wv.mem", {
        usedMB: message.usedMB,
        limitMB: message.limitMB,
        pct: message.pct,
      });
      return;
    }
    if (message.type === "perfEvent") {
      // Webview-side lag diagnostics land in the same log as host-side ones.
      perfLog(`wv.${message.event}`, message.fields ?? {});
      return;
    }
    const perfT0 = performance.now();
    try {
      await this.handleWebviewMessageInner(message);
    } finally {
      const ms = performance.now() - perfT0;
      if (ms > 20) {
        // Includes awaited async time, not just CPU — the sw.done / focus.done
        // breakdowns disambiguate for the switch paths.
        perfLog("host.msg.slow", { type: message.type, ms: r1(ms) });
      }
    }
  }

  private async handleWebviewMessageInner(message: WebviewMessage): Promise<void> {
    log("INFO", "Webview message received:", message.type);
    switch (message.type) {
      case "ready": {
        log("INFO", "Webview ready, sending state");
        this.sendPanesSnapshot();
        if (this.paneTabs[1].length > 0) {
          this.ensurePaneTicker();
        }
        this.handleListSessions();
        this.sendAccountsList();
        void this.pollUsageForActive();
        break;
      }

      case "loadEarlier": {
        const key = message.tabId ?? this.activeKey;
        if (!key) {
          break;
        }
        const cur = this.displayWindow.get(key) ?? DISPLAY_WINDOW_DEFAULT;
        this.displayWindow.set(key, cur + DISPLAY_WINDOW_STEP);
        this.refreshConversationViews(key);
        break;
      }

      case "memPressure": {
        log(
          "WARN",
          `Webview heap pressure (${message.usedMB}/${message.limitMB}MB) — collapsing display windows`
        );
        perfLog("wv.mem.pressure", {
          usedMB: message.usedMB,
          limitMB: message.limitMB,
        });
        for (const key of this.paneActive) {
          if (!key) {
            continue;
          }
          const cur = this.displayWindow.get(key) ?? DISPLAY_WINDOW_DEFAULT;
          this.displayWindow.set(key, Math.min(cur, DISPLAY_WINDOW_LEAN));
          this.refreshConversationViews(key);
        }
        break;
      }

      case "memCritical": {
        perfLog("wv.mem.critical", {
          usedMB: message.usedMB,
          limitMB: message.limitMB,
        });
        this.recoverWebview(
          `webview heap critical: ${message.usedMB}/${message.limitMB}MB`
        );
        break;
      }

      case "sendMessage": {
        log("INFO", "sendMessage:", (message as any).text?.slice(0, 100));
        // A composer in the unfocused pane targets ITS conversation: focus
        // follows the send, deterministically, before the message is handled.
        const targetTab = (message as { tabId?: string }).tabId;
        if (targetTab && targetTab !== this.activeKey) {
          const pane = this.paneOf(targetTab);
          if (pane !== undefined && pane !== this.focusedPane) {
            await this.handleFocusPane(pane);
          }
          if (this.paneActive[this.focusedPane] !== targetTab && this.paneOf(targetTab) !== undefined) {
            await this.handleSwitchSession(targetTab);
          }
        }
        await this.handleSendMessage(
          message.text,
          message.images,
          message.mentions
        );
        break;
      }

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

      case "saveDroppedFiles":
        this.handleSaveDroppedFiles(message.files);
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

      case "dismissTask":
        this.handleDismissTask(message.toolUseId);
        break;

      // Mode/model/effort belong to the conversation being looked at; the
      // provider-wide fields only serve as defaults for future conversations.
      case "mode": {
        const runtime = this.getActiveRuntime();
        runtime.mode = message.mode;
        this.mode = message.mode;
        if (runtime.bridge) {
          runtime.bridge.restart({ mode: message.mode });
        }
        this.persistSettingsFor(runtime);
        this.sendState();
        break;
      }

      case "changeModel": {
        const runtime = this.getActiveRuntime();
        runtime.model = message.model;
        runtime.lastContext = undefined;
        this.model = message.model;
        this.context.workspaceState.update("claude-luxure.model", this.model);
        if (runtime.bridge) {
          runtime.bridge.restart({ model: message.model });
        }
        this.persistSettingsFor(runtime);
        this.sendState();
        break;
      }

      case "changeEffort": {
        const runtime = this.getActiveRuntime();
        runtime.effort = message.effort;
        this.effort = message.effort;
        this.context.workspaceState.update("claude-luxure.effort", this.effort);
        if (runtime.bridge) {
          runtime.bridge.restart({ effort: message.effort });
        }
        this.persistSettingsFor(runtime);
        this.sendState();
        break;
      }

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

      case "newWorktreeConversation":
        await this.handleNewWorktreeConversation();
        break;

      case "switchSession":
        await this.handleSwitchSession(
          message.sessionId,
          message.pane === 1 ? 1 : message.pane === 0 ? 0 : undefined,
          message.perfId
        );
        break;

      case "closeTab":
        await this.handleCloseTab(message.sessionId);
        break;

      case "closeAllTabs":
        this.handleCloseAllTabs();
        break;

      case "toggleSplit":
        await this.handleToggleSplit();
        break;

      case "focusPane":
        await this.handleFocusPane(message.pane === 1 ? 1 : 0);
        break;

      case "moveTab":
        await this.handleMoveTab(
          message.tabId,
          message.pane === 1 ? 1 : 0,
          message.index
        );
        break;

      case "listSessions":
        await this.handleListSessions();
        break;

      case "searchFiles":
        await this.handleFileSearch(message.query);
        break;

      case "requestPromptHistory":
        await this.handleRequestPromptHistory();
        break;

      case "suggestPhrase":
        await this.handleSuggestPhrase(
          message.conversationId,
          message.draft,
          message.examples ?? [],
          message.kind ?? "continue",
          message.priorDraft
        );
        break;

      case "openFile": {
        const doc = await vscode.workspace.openTextDocument(message.filePath);
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }

      case "openExternal": {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        } catch (err) {
          log("WARN", "openExternal failed:", String(err));
        }
        break;
      }

      case "openImageInEditor":
        await this.handleOpenImageInEditor(message.dataUrl, message.label);
        break;

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

      case "reauthAccount":
        await this.handleReauthAccount(message.accountId);
        break;

      case "logoutAccount":
        await this.handleLogoutAccount(message.accountId);
        break;

      case "refreshUsage":
        void this.pollUsageForAll();
        break;

      case "setMarkerNote":
        this.handleSetMarkerNote(message.note);
        break;

      case "summarizeSession":
        void this.handleSummarizeSession(message.sessionId);
        break;

      case "annotateResult": {
        const pending = this.pendingAnnotations.get(message.requestId);
        if (pending) {
          this.pendingAnnotations.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.dataUrl) {
            pending.resolve(message.dataUrl);
          } else {
            pending.reject(
              new Error(message.error || "Annotation rendering failed in the webview.")
            );
          }
        }
        break;
      }

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

  /** Accounts the user deliberately disconnected (their stored token was
   * deleted). Persisted, unlike {@link authFailedAccountIds}: once the token is
   * gone there is nothing left to infer the state from, so without this a
   * reloaded window would show a credential-less account as healthy. */
  private getLoggedOutAccountIds(): string[] {
    return (
      this.context.globalState.get<string[]>("claude-luxure.loggedOutAccounts") ||
      []
    );
  }

  private async setLoggedOut(
    accountId: string,
    loggedOut: boolean
  ): Promise<void> {
    const current = this.getLoggedOutAccountIds();
    const next = loggedOut
      ? Array.from(new Set([...current, accountId]))
      : current.filter((id) => id !== accountId);
    if (next.length !== current.length) {
      await this.context.globalState.update(
        "claude-luxure.loggedOutAccounts",
        next
      );
    }
  }

  /** Whether an account has no usable stored login right now: a 401 was already
   * seen, it was deliberately disconnected, or its token is expired beyond
   * refresh. Same judgement the switcher's disconnected dot is built from. */
  private async isAccountDisconnected(accountId: string): Promise<boolean> {
    if (
      this.authFailedAccountIds.has(accountId) ||
      this.getLoggedOutAccountIds().includes(accountId)
    ) {
      return true;
    }
    return this.isOAuthDead(await this.resolveOAuthRecord(accountId));
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
    terminal.sendText(`${this.shellQuote(resolveClaudePath())} auth login`);
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
        resolveClaudePath(),
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
    // Revoke and delete the token before the profile goes — afterwards its
    // config dir is unresolvable and the keychain entry would be orphaned.
    await this.clearStoredCredential(accountId);
    await this.setLoggedOut(accountId, false);
    this.authFailedAccountIds.delete(accountId);
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

  /** Single-quote a path for a POSIX shell so a resolved binary path with spaces
   * (or the bundled-extension path) runs correctly via `terminal.sendText`. */
  private shellQuote(p: string): string {
    return `'${p.replace(/'/g, "'\\''")}'`;
  }

  /** Re-run the browser login for an account — the "Reconnect" action, offered on
   * every row of the switcher. Heals an account whose stored token can no longer
   * authenticate (see {@link isOAuthDead}), and equally recreates a token on
   * demand: log in as a different Claude account when the wrong one ended up in
   * the slot. Same login mechanics as {@link handleAddAccount}, but refreshes an
   * existing account in place instead of creating one.
   *
   * The stored credential is deleted first. That's what makes a wrong-account
   * login actually replaceable, and it's also what makes "a fresh token
   * appeared" (see {@link waitForReconnect}) a truthful completion signal — with
   * a still-valid token in place, that check would pass instantly without the
   * user having logged in at all. */
  private async handleReauthAccount(
    accountId: string,
    opts?: { skipConfirm?: boolean }
  ): Promise<void> {
    const configDir = this.getConfigDirForAccount(accountId);
    const label = this.labelFor(accountId);
    const isDefault = !accountId || accountId === "default";

    // Reconnecting a *working* account throws away a good token, so confirm it.
    // A disconnected one has nothing to lose — keep that path one click.
    if (!opts?.skipConfirm && !(await this.isAccountDisconnected(accountId))) {
      const choice = await vscode.window.showWarningMessage(
        `Reconnect ${label}?`,
        {
          modal: true,
          detail: isDefault
            ? "Signs out the shared login in ~/.claude and starts a fresh browser login — you can log in as a different Claude account. Your terminal `claude` uses this same login, so it will need to log in again too."
            : "Signs this account out and starts a fresh browser login, so you can log in as a different Claude account (or just recreate the token).",
        },
        "Reconnect"
      );
      if (choice !== "Reconnect") {
        return;
      }
    }

    if (configDir) {
      this.linkSharedAssets(configDir);
    }

    // Clear first — see the note above. The switcher shows the account as
    // disconnected for the duration of the login.
    await this.clearStoredCredential(accountId);
    await this.setLoggedOut(accountId, true);
    void this.pollUsageForAll();

    const terminal = vscode.window.createTerminal({
      name: `Reconnect ${label}`,
      env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : undefined,
    });
    terminal.show();
    terminal.sendText(`${this.shellQuote(resolveClaudePath())} auth login`);
    vscode.window.showInformationMessage(
      `Reconnecting ${label} — finish the login in your browser (use an incognito window if it differs from your current claude.ai login). I'll detect it automatically.`
    );

    const ok = await this.waitForReconnect(accountId, configDir);
    terminal.dispose();
    if (!ok) {
      vscode.window.showWarningMessage(
        `Didn't detect a completed login for ${label} — it stays disconnected until you finish one. Click Reconnect to try again.`
      );
      // Re-poll so the bar reflects the still-disconnected state.
      void this.pollUsageForAll();
      return;
    }

    // Fresh token confirmed — clear both disconnected flags so the account
    // stops showing as disconnected.
    this.authFailedAccountIds.delete(accountId);
    await this.setLoggedOut(accountId, false);

    // Refresh the stored profile (subscription/email can change on re-login —
    // and a reconnect is allowed to land on a different Claude account).
    if (configDir) {
      const info = await this.authStatusForDir(configDir);
      if (info?.email) {
        const added = this.getAddedAccounts();
        const acct = added.find((a) => a.id === accountId);
        if (acct) {
          acct.email = info.email;
          acct.label = info.email;
          acct.subscriptionType = info.subscriptionType;
          await this.context.globalState.update("claude-luxure.accounts", added);
        }
      }
    } else {
      // The Default row's label comes from the ambient `auth status`, not from
      // stored state — re-read it so a reconnect as a different account renames
      // the row instead of showing the previous email.
      await this.fetchAccountInfo();
    }

    // Any open conversation bound to this account is still pointing at the dead
    // token — restart its process so it picks up the fresh credential (same
    // mechanism as switch/MCP restart; the conversation is preserved).
    for (const runtime of this.runtimes.values()) {
      if ((runtime.accountId || "default") === accountId && runtime.bridge) {
        runtime.bridge.restart({ configDir: configDir ?? "" });
      }
    }

    this.sendAccountsList();
    void this.pollUsageForAll();
    // Re-read the label: a reconnect is allowed to land on a different account,
    // and the profile refresh above has already stored the new identity.
    const newLabel = this.labelFor(accountId);
    vscode.window.showInformationMessage(
      newLabel === label
        ? `Reconnected ${label}.`
        : `Reconnected as ${newLabel} (was ${label}).`
    );
  }

  /** Poll until a re-login has stored a *fresh* (non-expired) token for the
   * account, or time out (~3 min). Unlike {@link waitForLogin} we can't watch
   * `auth status` (a disconnected account still reports `loggedIn:true` from its
   * stale credential) — so we watch the credential itself appear with a future
   * expiry, invalidating the 60s cache each pass so we read the keychain fresh.
   * Relies on {@link handleReauthAccount} having deleted the old credential
   * first, so any token found here is necessarily the new one. */
  private async waitForReconnect(
    accountId: string,
    configDir: string | undefined,
    attempts = 60
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      this.invalidateKeychainCache(configDir);
      const record = await this.resolveOAuthRecord(accountId);
      const expiresAt =
        typeof record?.expiresAt === "number" ? record.expiresAt : 0;
      if (record?.accessToken && expiresAt > Date.now()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }

  /** Sign an account out without removing it — the "Disconnect" action. The
   * profile and its config dir stay, so Reconnect can log the same or a
   * different Claude account back into the slot. */
  private async handleLogoutAccount(accountId: string): Promise<void> {
    const label = this.labelFor(accountId);
    const isDefault = !accountId || accountId === "default";

    const choice = await vscode.window.showWarningMessage(
      `Disconnect ${label}?`,
      {
        modal: true,
        detail: isDefault
          ? "Deletes the stored token for the shared login in ~/.claude. Your terminal `claude` uses this same login, so it will need to log in again too. Use Reconnect to log back in."
          : "Deletes this account's stored token. The account stays in the list — use Reconnect to log in again, as the same or a different Claude account.",
      },
      "Disconnect"
    );
    if (choice !== "Disconnect") {
      return;
    }

    if (!(await this.clearStoredCredential(accountId))) {
      vscode.window.showErrorMessage(
        `Could not delete the stored login for ${label} — it is still connected. Check the keychain entry (Keychain Access → "Claude Code-credentials").`
      );
      void this.pollUsageForAll();
      return;
    }

    await this.setLoggedOut(accountId, true);
    this.sendAccountsList();
    void this.pollUsageForAll();

    // Any conversation bound to this account has no credential now; its next
    // send would 401. Leave the process alone (a restart would only spawn
    // another token-less one) and offer the fix straight from the toast.
    const next = await vscode.window.showInformationMessage(
      `Disconnected ${label}. Conversations on this account can't send until you reconnect.`,
      "Reconnect"
    );
    if (next === "Reconnect") {
      await this.handleReauthAccount(accountId, { skipConfirm: true });
    }
  }

  /** Delete an account's stored OAuth credential: `claude auth logout` scoped to
   * the account's config dir (so the token is revoked server-side), then the
   * credential stores directly.
   *
   * That second step is load-bearing, not paranoia. Verified against the CLI
   * (2.1.223): `CLAUDE_CONFIG_DIR=<dir> claude auth logout` prints "Successfully
   * logged out", deletes `<dir>/.credentials.json` — and leaves the macOS
   * keychain entry ("Claude Code-credentials-<sha256(dir)[:8]>") in place. That
   * entry is the one {@link resolveOAuthRecord} reads first, so logout alone
   * leaves the account looking (and working) as connected.
   *
   * Returns true once no credential remains — the caller must not report a
   * disconnect it didn't achieve. */
  private async clearStoredCredential(
    accountId: string | undefined
  ): Promise<boolean> {
    const configDir = this.getConfigDirForAccount(accountId);
    await this.runAuthLogout(configDir);
    if (process.platform === "darwin") {
      await this.deleteKeychainItem(
        configDir
          ? this.keychainServiceForConfigDir(configDir)
          : "Claude Code-credentials"
      );
    }
    // Linux/other store the credential in the config dir instead.
    const credFile = path.join(
      configDir ?? path.join(os.homedir(), ".claude"),
      ".credentials.json"
    );
    try {
      fs.rmSync(credFile, { force: true });
    } catch {
      // Non-fatal — the check below is what decides success.
    }
    this.invalidateKeychainCache(configDir);
    const record = await this.resolveOAuthRecord(accountId);
    return !record?.accessToken;
  }

  private runAuthLogout(configDir: string | undefined): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        resolveClaudePath(),
        ["auth", "logout"],
        {
          env: configDir
            ? { ...process.env, CLAUDE_CONFIG_DIR: configDir }
            : process.env,
        },
        (err) => {
          if (err) {
            log("WARN", "claude auth logout failed:", err.message);
          }
          resolve();
        }
      );
    });
  }

  private deleteKeychainItem(service: string): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        "security",
        ["delete-generic-password", "-s", service],
        () => resolve() // Missing item exits non-zero — that's already the goal.
      );
    });
  }

  // ───────────────────────── Usage ─────────────────────────

  /** The full OAuth credential record (accessToken + expiresAt + refreshToken +
   * scopes) for an account: for a config-dir account, its own keychain entry
   * (full scope, so the usage endpoint allows it), falling back to the Linux
   * `.credentials.json`; for the Default account, the auto-refreshed keychain
   * token. Source of truth for both {@link resolveUsageToken} and
   * {@link isOAuthDead}. */
  private async resolveOAuthRecord(
    accountId: string | undefined
  ): Promise<Record<string, any> | undefined> {
    const configDir = this.getConfigDirForAccount(accountId);
    if (configDir) {
      // On macOS the CLI stores a custom-config-dir login in a keychain entry
      // suffixed with sha256(configDir)[:8] — NOT in <configDir>/.credentials.json.
      // (That file only exists on Linux/other.) Read the keychain entry first so
      // added accounts — which have full `user:profile` scope, same as Default —
      // get real usage too. This is the whole reason their bars were blank.
      const fromKeychain = await this.readKeychainRecord(
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
        return JSON.parse(raw)?.claudeAiOauth;
      } catch {
        return undefined;
      }
    }
    return await this.readKeychainRecord();
  }

  /** Access token for GET /api/oauth/usage and for judging connection health. */
  private async resolveUsageToken(
    accountId: string | undefined
  ): Promise<string | undefined> {
    return (await this.resolveOAuthRecord(accountId))?.accessToken;
  }

  /** True when an account's stored login can no longer authenticate AND can't
   * self-heal: an expired access token with no refresh token for the CLI to
   * refresh with. That is exactly what yields "401 Invalid authentication
   * credentials" on every request. The Default account keeps a valid refresh
   * token (auto-refreshed ~hourly), so it isn't flagged; added config-dir
   * accounts whose refresh token went missing are.
   *
   * A missing/unreadable record is deliberately NOT treated as dead: a transient
   * `security` read hiccup must not flag a healthy Default account — it just
   * yields blank bars, as before. */
  private isOAuthDead(record: Record<string, any> | undefined): boolean {
    if (!record?.accessToken) {
      return false;
    }
    const expiresAt =
      typeof record.expiresAt === "number" ? record.expiresAt : 0;
    const expired = expiresAt > 0 && expiresAt < Date.now();
    return expired && !record.refreshToken;
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

  /** Read the keychain OAuth record (macOS). May prompt once for keychain access
   * ("Always Allow" makes subsequent reads silent). */
  private readKeychainRecord(
    service = "Claude Code-credentials"
  ): Promise<Record<string, any> | undefined> {
    // The keychain token is valid ~60min (the CLI refreshes it). Cache for 60s
    // so frequent polls (e.g. after every turn) don't spawn `security` each time.
    const cached = this.cachedKeychainTokens.get(service);
    if (cached && Date.now() - cached.at < 60_000) {
      return Promise.resolve(cached.record);
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
            const record = json?.claudeAiOauth;
            if (record?.accessToken) {
              this.cachedKeychainTokens.set(service, {
                record,
                at: Date.now(),
              });
            }
            resolve(record);
          } catch {
            resolve(undefined);
          }
        }
      );
    });
  }

  /** Drop the cached keychain record so the next read re-fetches from the
   * keychain — call right after a (re)login replaces the stored credential, or
   * the 60s cache would keep serving the old (dead) token. */
  private invalidateKeychainCache(configDir?: string): void {
    this.cachedKeychainTokens.delete(
      configDir
        ? this.keychainServiceForConfigDir(configDir)
        : "Claude Code-credentials"
    );
  }

  private getCliVersion(): Promise<string> {
    if (this.cachedCliVersion) {
      return Promise.resolve(this.cachedCliVersion);
    }
    return new Promise((resolve) => {
      execFile(resolveClaudePath(), ["--version"], (_err, stdout) => {
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
      const loggedOutIds = new Set(this.getLoggedOutAccountIds());
      const entries = await Promise.all(
        accounts.map(async (a) => {
          const record = await this.resolveOAuthRecord(a.id);
          const heuristicDead = this.isOAuthDead(record);
          const token = record?.accessToken;
          const expiresAt =
            typeof record?.expiresAt === "number" ? record.expiresAt : 0;
          const looksRenewed = !!token && expiresAt > Date.now();
          // A real 401 already proved this account's token can't authenticate.
          // Don't spend a request on it again (it just 401s/429s and trips the
          // rate limiter) until its credential looks renewed — at which point we
          // re-probe so an external re-login can clear the flag automatically.
          const wasAuthFailed = this.authFailedAccountIds.has(a.id);
          const shouldFetch =
            !heuristicDead && !!token && (!wasAuthFailed || looksRenewed);
          const usage = shouldFetch ? await this.fetchUsage(token) : null;
          // A successful probe is ground truth that the token works again —
          // including after a re-login done outside the extension, which also
          // undoes a deliberate disconnect.
          let loggedOut = loggedOutIds.has(a.id);
          if (usage) {
            this.authFailedAccountIds.delete(a.id);
            if (loggedOut) {
              await this.setLoggedOut(a.id, false);
              loggedOut = false;
            }
          }
          const dead =
            heuristicDead || this.authFailedAccountIds.has(a.id) || loggedOut;
          return [a.id, usage, dead, loggedOut] as const;
        })
      );
      const usageByAccount: Record<string, UsageInfo | null> = {};
      const disconnected: Record<string, boolean> = {};
      const loggedOut: Record<string, boolean> = {};
      for (const [id, usage, dead, out] of entries) {
        usageByAccount[id] = usage;
        disconnected[id] = dead;
        loggedOut[id] = out;
      }
      this.postMessage({
        type: "usageByAccount",
        usageByAccount,
        disconnected,
        loggedOut,
      });
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
      this.moveDisplayWindow(oldKey, newKey);
      this.runtimes.set(newKey, runtime);
      this.renameTab(oldKey, newKey);
    }
  }

  /** Carry a conversation's widened display window across a key change. */
  private moveDisplayWindow(oldKey: string, newKey: string): void {
    const win = this.displayWindow.get(oldKey);
    this.displayWindow.delete(oldKey);
    if (win !== undefined) {
      this.displayWindow.set(newKey, win);
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
      this.activeKey = runtimeKey; // setter inserts it into the focused strip
      this.sendOpenTabs();
    }
    const runtime = this.getActiveRuntime();

    if (!runtime.sessionName && !runtime.sessionId && !isSlashCommand(text)) {
      runtime.sessionName = sessionNameFromText(text);
    }

    // status alone can lie after process churn (a stale "ready" with no
    // process behind it) — isAlive is the ground truth for respawning.
    if (
      !runtime.bridge ||
      runtime.bridge.status === "stopped" ||
      !runtime.bridge.isAlive
    ) {
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
      this.postMessage({
        type: "message",
        message: this.slimMessage(userMessage),
      });
    }

    const seed =
      seedHistory && seedHistory.length > 0 ? renderSeedHistory(seedHistory) : "";
    const outgoingText = seed ? `${seed}\n\n${resolvedText}` : resolvedText;
    // Edited messages carry externalized images (webview URIs); the CLI only
    // understands base64 blocks, so rehydrate those from the cache files.
    const cliImages = images?.map((img) => {
      const file = this.webviewUriToFile(img);
      if (!file) {
        return img;
      }
      try {
        return this.loadImageAsDataUrl(file);
      } catch {
        return img;
      }
    });
    let sent = runtime.bridge?.sendMessage(outgoingText, cliImages) === true;
    if (!sent) {
      // The process died between the liveness check and the write. Respawn
      // once and retry so the user's message still goes through.
      log("WARN", "sendMessage hit a dead CLI; respawning bridge and retrying");
      await this.startBridge(runtimeKey, runtime);
      sent = runtime.bridge?.sendMessage(outgoingText, cliImages) === true;
    }
    if (!sent) {
      // Never start a phantom turn: without this the message would sit
      // "streaming" for 3 minutes until the watchdog stamps a misleading
      // "turn went quiet" banner, even though the CLI never got the message.
      const failMessage: ChatMessage = {
        id: generateId(),
        role: "assistant",
        content:
          "⚠️ *This message never reached the Claude CLI — its process could not be started. Check the extension logs, then send again.*",
        timestamp: Date.now(),
      };
      runtime.messages.push(failMessage);
      if (this.isActiveKey(runtimeKey)) {
        this.postMessage({ type: "message", message: this.slimMessage(failMessage) });
      }
      this.sendState();
      return;
    }

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

    this.armStreamWatchdog(runtimeKey, runtime);
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
      if (existing && existing.status !== "stopped" && existing.isAlive) {
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

    // A worktree-backed conversation runs in its own checkout with remapped
    // ports; everything else runs in the workspace root as before.
    const cwd = runtime.worktreeCwd || workspacePath;

    // Visual-proof tools: register the bundled "luxure" MCP server for this
    // spawn so the model can push screenshots/annotations into this chat.
    const luxureTools = await this.prepareLuxureTools(runtime);

    const bridge = new ClaudeBridge({
      cwd,
      mode: runtime.mode ?? this.mode,
      model: runtime.model ?? this.model,
      effort: runtime.effort ?? this.effort,
      sessionId: runtime.sessionId,
      sessionName: runtime.sessionName,
      configDir,
      claudePath: resolveClaudePath(),
      env: runtime.worktreeEnv,
      luxureTools,
    });

    runtime.bridge = bridge;
    this.attachBridgeHandlers(runtimeKey, runtime, bridge);

    if (!this.diffWatchStarted) {
      this.diffManager.startWatching(workspacePath);
      this.diffWatchStarted = true;
    }

    await bridge.start();
  }

  // ── Visual-proof tools (screenshots / annotations pushed into the chat) ──

  /** Start (once) the loopback side-channel the luxure MCP server posts to. */
  private async ensureProofChannel(): Promise<ProofChannel | undefined> {
    if (this.proofChannel) {
      return this.proofChannel;
    }
    if (this.proofChannelFailed) {
      return undefined;
    }
    try {
      const channel = new ProofChannel({
        present: (req) => this.handleProofPresent(req),
        annotate: (req) => this.handleProofAnnotate(req),
      });
      await channel.start();
      this.proofChannel = channel;
      return channel;
    } catch (err) {
      // Don't retry every spawn — a bind failure here means no proof tools,
      // not a broken chat.
      this.proofChannelFailed = true;
      log("ERROR", "Proof channel failed to start:", String(err));
      return undefined;
    }
  }

  /** Write the per-spawn --mcp-config for the bundled luxure server and route
   * its bridge id to this conversation. Returns undefined when unavailable
   * (channel bind failure / missing bundle) — the chat works without proofs. */
  private async prepareLuxureTools(
    runtime: SessionRuntime
  ): Promise<{ mcpConfigPath: string; env: Record<string, string> } | undefined> {
    const channel = await this.ensureProofChannel();
    if (!channel) {
      return undefined;
    }
    const serverScript = path.join(
      this.context.extensionUri.fsPath,
      "dist",
      "luxure-mcp.js"
    );
    if (!fs.existsSync(serverScript)) {
      log("WARN", "luxure-mcp.js not built; visual-proof tools disabled");
      return undefined;
    }

    // A restarted bridge gets a fresh id; drop this conversation's old routes.
    for (const [id, rt] of this.proofRoutes) {
      if (rt === runtime) {
        this.proofRoutes.delete(id);
      }
    }
    const bridgeId = crypto.randomUUID();
    this.proofRoutes.set(bridgeId, runtime);

    const env: Record<string, string> = {
      LUXURE_BRIDGE_URL: channel.url,
      LUXURE_BRIDGE_TOKEN: channel.token,
      LUXURE_BRIDGE_ID: bridgeId,
    };
    const config = {
      mcpServers: {
        luxure: {
          // The extension host's own runtime in node mode — works even when
          // no `node` is on the CLI's PATH.
          command: process.execPath,
          args: [serverScript],
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    };

    const dir = path.join(this.context.globalStorageUri.fsPath, "mcp");
    fs.mkdirSync(dir, { recursive: true });
    this.cleanupStaleMcpConfigs(dir);
    const mcpConfigPath = path.join(dir, `luxure-${bridgeId}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
    return { mcpConfigPath, env };
  }

  /** Best-effort removal of config files from long-gone spawns. */
  private cleanupStaleMcpConfigs(dir: string): void {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith("luxure-") || !name.endsWith(".json")) {
          continue;
        }
        const full = path.join(dir, name);
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      }
    } catch {
      // never let cleanup break a spawn
    }
  }

  private runtimeForProof(bridgeId?: string): SessionRuntime {
    const routed = bridgeId ? this.proofRoutes.get(bridgeId) : undefined;
    const runtime =
      routed || (this.activeKey ? this.runtimes.get(this.activeKey) : undefined);
    if (!runtime) {
      throw new Error("No active conversation to attach the image to.");
    }
    return runtime;
  }

  private async handleProofPresent(
    req: ProofPresentRequest
  ): Promise<Record<string, unknown>> {
    const runtime = this.runtimeForProof(req.bridgeId);
    const dataUrl =
      req.dataUrl && req.dataUrl.startsWith("data:image/")
        ? req.dataUrl
        : this.loadImageAsDataUrl(req.path);
    this.emitProof(runtime, [dataUrl], req.caption);
    return { shown: true };
  }

  private async handleProofAnnotate(
    req: ProofAnnotateRequest
  ): Promise<Record<string, unknown>> {
    const runtime = this.runtimeForProof(req.bridgeId);
    if (!this.webview) {
      throw new Error(
        "The Claude Luxure chat panel is not open, so annotations can't be rendered — ask the user to open it and retry."
      );
    }
    const source = this.loadImageAsDataUrl(req.path);
    const annotated = await this.renderAnnotationsInWebview(
      source,
      req.annotations || []
    );
    const savedPath = this.saveAnnotatedPng(annotated, req.outputPath, req.path);
    if (req.show !== false) {
      this.emitProof(runtime, [annotated], req.caption);
    }
    return { savedPath };
  }

  /** Round-trip an image + drawing instructions through the webview canvas
   * (the only place with full 2D drawing + typography, no native deps). */
  private renderAnnotationsInWebview(
    image: string,
    annotations: ProofAnnotation[]
  ): Promise<string> {
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAnnotations.delete(requestId);
        reject(
          new Error(
            "Annotation rendering timed out — the chat panel may be closed or reloading."
          )
        );
      }, 20000);
      this.pendingAnnotations.set(requestId, { resolve, reject, timer });
      this.postMessage({ type: "annotateImage", requestId, image, annotations });
    });
  }

  /** Push a presented image into the conversation as a timeline activity, so
   * it renders exactly where it happened in the assistant's turn. */
  private emitProof(
    runtime: SessionRuntime,
    images: string[],
    caption?: string
  ): void {
    // Externalize at the source: the multi-MB base64 never enters the runtime
    // buffers or the persisted transcript, only the webview-URI reference.
    const activity: ActivityEvent = {
      type: "proof",
      images: images.map((i) => this.externalizeImage(i)),
      caption,
    };
    this.appendActivity(runtime, activity);
    this.pushTimelineActivity(runtime, activity);
    if (runtime.currentStreamText) {
      runtime.pendingParagraphBreak = true;
    }
    for (const [key, rt] of this.runtimes) {
      if (rt === runtime) {
        if (this.isActiveKey(key)) {
          this.postMessage({ type: "activity", activity });
        }
        break;
      }
    }
  }

  private static readonly IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  private loadImageAsDataUrl(p?: string): string {
    if (!p) {
      throw new Error("No image path provided.");
    }
    const abs = path.isAbsolute(p) ? p : path.join(this.getWorkspacePath() || "", p);
    if (!fs.existsSync(abs)) {
      throw new Error(`File not found: ${abs}`);
    }
    const mime = ChatViewProvider.IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime) {
      throw new Error(`Unsupported image type: ${abs} (use PNG/JPEG/WebP/GIF).`);
    }
    const stat = fs.statSync(abs);
    if (stat.size > 10 * 1024 * 1024) {
      throw new Error(
        `Image too large to display (${Math.round(stat.size / 1024 / 1024)}MB > 10MB): ${abs}`
      );
    }
    return `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  }

  /** Persist the burned-in PNG next to the original (or at outputPath),
   * falling back to the tmp dir when the target isn't writable. */
  private saveAnnotatedPng(
    dataUrl: string,
    outputPath: string | undefined,
    sourcePath: string
  ): string {
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) {
      throw new Error("Annotation render returned an unexpected format.");
    }
    const buffer = Buffer.from(match[1], "base64");

    let target: string;
    if (outputPath) {
      target = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(this.getWorkspacePath() || path.dirname(sourcePath), outputPath);
    } else {
      const dir = path.dirname(sourcePath);
      const base = path.basename(sourcePath, path.extname(sourcePath));
      target = path.join(dir, `${base}-annotated.png`);
      for (let n = 2; fs.existsSync(target); n++) {
        target = path.join(dir, `${base}-annotated-${n}.png`);
      }
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      return target;
    } catch {
      const fallback = path.join(
        os.tmpdir(),
        "claude-luxure",
        "screenshots",
        `annotated-${Date.now()}.png`
      );
      fs.mkdirSync(path.dirname(fallback), { recursive: true });
      fs.writeFileSync(fallback, buffer);
      return fallback;
    }
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
          if (this.paneOf(newSessionId) === undefined) {
            this.paneTabs[this.paneOf(runtimeKey) ?? this.focusedPane].unshift(newSessionId);
            this.sendOpenTabs();
          }
        }
        this.context.workspaceState.update("claude-luxure.lastSessionId", newSessionId);
        log("INFO", "Session ID captured:", newSessionId);
      }

      if (status === "stopped" || status === "error") {
        // Covers every path that ends the process (restarts for mode/model/
        // account changes, crashes): running agents died with it.
        const settled = this.settleRunningTasks(
          runtime,
          "Interrupted — the CLI process ended",
          isActive()
        );
        if (runtime.streamingMessageId) {
          this.finalizeStreamingMessage(runtimeKey, runtime, isActive());
        } else if (settled > 0) {
          this.persistRuntime(runtimeKey, runtime);
        }
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
      // A background task finishing re-invokes the model with no user message;
      // open a fresh assistant bubble so that resumed output isn't dropped.
      this.ensureStreamingTurn(runtimeKey, runtime, isActive());
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
      this.ensureStreamingTurn(runtimeKey, runtime, isActive());
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

      // A 401/403 is NOT delivered as an "error" event — the CLI reports it as a
      // result with is_error=true and api_error_status set (the "Failed to
      // authenticate" text arrives just before, as an assistant bubble). Detect it
      // from those structured fields, flag the account, and tag the assistant
      // bubble so a Reconnect button renders directly on it. Restrict to auth
      // statuses so a 429 rate-limit etc. doesn't offer a pointless reconnect.
      const apiErrorStatus = (event as ClaudeEvent & { api_error_status?: number | null })
        .api_error_status;
      const resultText =
        typeof (event as ClaudeEvent & { result?: unknown }).result === "string"
          ? ((event as ClaudeEvent & { result?: string }).result as string)
          : "";
      const isAuthError =
        (event as ClaudeEvent & { is_error?: boolean }).is_error === true &&
        (apiErrorStatus === 401 ||
          apiErrorStatus === 403 ||
          AUTH_ERROR_TEXT.test(resultText));

      let auth: { id: string; label: string } | undefined;
      let taggedBubble = false;
      if (isAuthError) {
        auth = this.noteAuthFailure(runtime.accountId || "default");
        const streamingMsg = runtime.streamingMessageId
          ? runtime.messages.find((m) => m.id === runtime.streamingMessageId)
          : undefined;
        if (streamingMsg) {
          streamingMsg.authErrorAccountId = auth.id;
          streamingMsg.authErrorAccountLabel = auth.label;
          taggedBubble = true;
        }
        this.outputChannel.appendLine(
          `[AUTH] ${auth.id} failed to authenticate (status ${apiErrorStatus}): ${resultText}`
        );
      }

      this.finalizeStreamingMessage(runtimeKey, runtime, isActive());

      // First completed turn: pick the conversation's post-it emoji from the
      // real content (one user message alone is usually not enough context).
      if (
        !runtime.markerEmoji &&
        (event as ClaudeEvent & { is_error?: boolean }).is_error !== true
      ) {
        void this.evaluateMarker(runtime);
      }

      // No assistant bubble to tag (the failure carried no text) — surface a
      // standalone system error that carries the Reconnect button instead.
      if (auth && !taggedBubble && isActive()) {
        this.postMessage({
          type: "error",
          error: resultText || "Failed to authenticate.",
          authErrorAccountId: auth.id,
          authErrorAccountLabel: auth.label,
        });
      }

      // A turn just consumed quota — refresh the usage bars for the active tab.
      // (Auth failures already trigger a re-poll via noteAuthFailure.)
      if (isActive() && !auth) {
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
      if (isStale()) {
        return;
      }

      // A subagent's own tool calls/results (tagged with the id of the Agent
      // call that spawned them) nest under that task card — never in the main
      // feed, where they'd read as the main agent's work.
      if ("parentToolUseId" in activity && activity.parentToolUseId) {
        this.routeChildActivity(runtimeKey, runtime, activity, isActive());
        return;
      }

      // The Agent call's final tool_result belongs to its task card, wherever
      // that card lives (possibly several prose segments back).
      if (activity.type === "tool_result") {
        const owner = this.findTaskActivity(runtime, activity.toolUseId);
        if (owner) {
          const t = owner.task;
          t.result = {
            content:
              (t.result?.content ? `${t.result.content}\n` : "") +
              (activity.content || ""),
            isError: t.result?.isError || activity.isError,
            images:
              activity.images && activity.images.length > 0
                ? [...(t.result?.images || []), ...activity.images]
                : t.result?.images,
          };
          t.status = activity.isError ? "failed" : "completed";
          if (owner.messageId) {
            this.persistRuntime(runtimeKey, runtime);
          }
          this.postTaskUpdate(t, owner.messageId, isActive());
          return;
        }
      }

      // An Agent launch becomes a live task card instead of a dead one-liner.
      let a = activity;
      if (
        a.type === "tool_use" &&
        (a.toolName === "Agent" || a.toolName === "Task")
      ) {
        const input = a.toolInput || {};
        const existing = a.toolUseId
          ? this.findTaskActivity(runtime, a.toolUseId)
          : undefined;
        if (existing) {
          // Second emission of the same call (placeholder → full input): merge
          // into the card already on screen instead of adding a duplicate.
          mergeTaskInto(existing.task, {
            type: "task",
            toolUseId: existing.task.toolUseId,
            status: "running",
            description: input.description ? String(input.description) : undefined,
            subagentType: input.subagent_type ? String(input.subagent_type) : undefined,
            prompt: typeof input.prompt === "string" ? input.prompt : undefined,
            background: input.run_in_background === true,
          });
          this.postTaskUpdate(existing.task, existing.messageId, isActive());
          return;
        }
        a = {
          type: "task",
          toolUseId: a.toolUseId || generateId(),
          description: input.description ? String(input.description) : undefined,
          subagentType: input.subagent_type ? String(input.subagent_type) : undefined,
          prompt: typeof input.prompt === "string" ? input.prompt : undefined,
          background: input.run_in_background === true,
          status: "running",
        };
      }

      // A background task finishing re-invokes the model with no user message;
      // give that resumed output a fresh assistant bubble.
      this.ensureStreamingTurn(runtimeKey, runtime, isActive());

      this.appendActivity(runtime, a);
      this.pushTimelineActivity(runtime, a);
      // A tool call or thinking block means the assistant paused its prose; flag
      // a paragraph break so the next text delta doesn't fuse onto the last one.
      if (
        runtime.currentStreamText &&
        (a.type === "tool_use" ||
          a.type === "thinking" ||
          a.type === "thinking_delta" ||
          a.type === "task")
      ) {
        runtime.pendingParagraphBreak = true;
      }
      if (isActive()) {
        this.postMessage({ type: "activity", activity: this.slimActivity(a) });
      }
    });

    bridge.on("taskUpdate", (update: TaskUpdateEvent) => {
      if (isStale()) {
        return;
      }
      this.applyTaskUpdate(runtimeKey, runtime, update, isActive());
    });

    bridge.on("thinkingTokens", (info: { tokens: number }) => {
      if (isStale() || !isActive()) {
        return;
      }
      this.postMessage({ type: "thinkingTokens", tokens: info.tokens });
    });

    bridge.on("apiRetry", (retry: ApiRetryEvent) => {
      if (isStale() || !isActive()) {
        return;
      }
      const secs = Math.max(1, Math.round((retry.delayMs || 0) / 1000));
      this.postMessage({
        type: "transientStatus",
        status: {
          kind: "retry",
          text: `API ${retry.error || "error"}${retry.status ? ` (${retry.status})` : ""} — retry ${retry.attempt}/${retry.maxRetries} in ${secs}s`,
        },
      });
    });

    bridge.on("rateLimit", (info: Record<string, unknown>) => {
      if (isStale() || !isActive()) {
        return;
      }
      const usingOverage = info.isUsingOverage === true || info.overageInUse === true;
      if (String(info.status || "") !== "rejected" && !usingOverage) {
        return; // within limits — nothing worth a chip
      }
      const bucket = String(info.rateLimitType || "").replace(/_/g, " ");
      this.postMessage({
        type: "transientStatus",
        status: {
          kind: "rate-limit",
          text: usingOverage
            ? `Usage limit reached (${bucket}) — continuing on overage`
            : `Rate limited (${bucket})`,
        },
      });
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
      // A spawn/process-level failure can also be an auth failure (rare; most
      // 401s arrive via the "result" event instead — see bridge.on("result")).
      // Flag the account so the switcher shows it disconnected, and tag the error
      // so the webview renders an inline "Reconnect" button on the message.
      const isAuthError = AUTH_ERROR_TEXT.test(err);
      const auth = isAuthError
        ? this.noteAuthFailure(runtime.accountId || "default")
        : undefined;
      if (isActive()) {
        this.postMessage({
          type: "error",
          error: err,
          ...(auth
            ? {
                authErrorAccountId: auth.id,
                authErrorAccountLabel: auth.label,
              }
            : {}),
        });
      }
      this.outputChannel.appendLine(`[ERROR] ${err}`);
    });

    bridge.on("stderr", (text: string) => {
      log("STDERR", text);
      this.outputChannel.appendLine(`[stderr] ${text}`);
    });

    bridge.on("event", (event: ClaudeEvent) => {
      log("EVENT", event.type, event.subtype || "");
      // Any CLI output means the turn is still alive — push the watchdog out.
      if (!isStale() && runtime.streamingMessageId) {
        this.armStreamWatchdog(runtimeKey, runtime);
      }
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

  /** A turn can start with no user message: when a background task finishes,
   * the CLI injects a task-notification and re-invokes the model on its own.
   * Open a fresh assistant bubble for that resumed output — without one, the
   * tokens have no message to land in and silently vanish. */
  private ensureStreamingTurn(
    runtimeKey: string,
    runtime: SessionRuntime,
    notifyWebview: boolean
  ): void {
    if (runtime.streamingMessageId) {
      return;
    }
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
    if (notifyWebview) {
      this.postMessage({ type: "message", message: assistantMessage });
      this.sendState();
    }
    this.armStreamWatchdog(runtimeKey, runtime);
  }

  /** Find a task card by the spawning Agent call's tool_use id (or the CLI
   * task id) — live turn first, then finalized messages newest-first, since a
   * background agent keeps reporting after its parent turn already ended. */
  private findTaskActivity(
    runtime: SessionRuntime,
    toolUseId?: string,
    taskId?: string
  ): { task: TaskActivity; messageId?: string } | undefined {
    const match = (acts?: ActivityEvent[]): TaskActivity | undefined =>
      (acts || []).find(
        (a): a is TaskActivity =>
          a.type === "task" &&
          ((!!toolUseId && a.toolUseId === toolUseId) ||
            (!!taskId && !!a.taskId && a.taskId === taskId))
      );
    for (const part of runtime.currentTimeline) {
      if (part.type === "activities") {
        const t = match(part.activities);
        if (t) {
          return { task: t };
        }
      }
    }
    const inCurrent = match(runtime.currentActivities);
    if (inCurrent) {
      return { task: inCurrent };
    }
    for (let i = runtime.messages.length - 1; i >= 0; i--) {
      const msg = runtime.messages[i];
      for (const part of msg.timeline || []) {
        if (part.type === "activities") {
          const t = match(part.activities);
          if (t) {
            return { task: t, messageId: msg.id };
          }
        }
      }
      const t = match(msg.activities);
      if (t) {
        return { task: t, messageId: msg.id };
      }
    }
    return undefined;
  }

  /** Send a snapshot of a task card to the webview for an in-place patch.
   * Shallow-copied so later mutations here don't alias the posted object. */
  private postTaskUpdate(
    task: TaskActivity,
    messageId: string | undefined,
    active: boolean
  ): void {
    if (!active) {
      return;
    }
    this.postMessage({
      type: "taskUpdate",
      task: { ...task, children: task.children ? [...task.children] : undefined },
      messageId,
    });
  }

  /** Settle every task card still "running" in this conversation, so the
   * "N agents working" strip can't outlive the work as a ghost. Called when
   * the CLI process ends (its agents die with it) and when the silence
   * watchdog ends a stalled turn. Safe against late truth: if an agent does
   * report in afterwards, its completed/failed patch overrides this settle
   * (mergeTaskInto only ignores "running" statuses). Returns how many cards
   * were settled. */
  private settleRunningTasks(
    runtime: SessionRuntime,
    summary: string,
    active: boolean
  ): number {
    let settled = 0;
    const settle = (acts?: ActivityEvent[], messageId?: string) => {
      for (const a of acts || []) {
        if (a.type === "task" && a.status === "running") {
          a.status = "failed";
          a.progressSummary = summary;
          settled++;
          this.postTaskUpdate(a, messageId, active);
        }
      }
    };
    for (const part of runtime.currentTimeline) {
      if (part.type === "activities") {
        settle(part.activities);
      }
    }
    settle(runtime.currentActivities);
    for (const m of runtime.messages) {
      settle(m.activities, m.id);
      for (const part of m.timeline || []) {
        if (part.type === "activities") {
          settle(part.activities, m.id);
        }
      }
    }
    return settled;
  }

  /** The user clicked ✕ on a stuck agent chip: mark that card settled so the
   * strip lets go of it. Does not (cannot) stop the agent itself — if it later
   * finishes for real, its completion patch still lands on the card. */
  private handleDismissTask(toolUseId: string): void {
    if (!this.activeKey) {
      return;
    }
    const runtime = this.getActiveRuntime();
    const found = this.findTaskActivity(runtime, toolUseId);
    if (!found || found.task.status !== "running") {
      return;
    }
    found.task.status = "failed";
    found.task.progressSummary = "Dismissed";
    if (found.messageId) {
      this.persistRuntime(this.activeKey, runtime);
    }
    this.postTaskUpdate(found.task, found.messageId, this.isActiveKey(this.activeKey));
  }

  /** Fold a system:task_* event into its card. task_progress carries the live
   * one-liner ("Reading a.txt") + usage counters; task_notification marks
   * completion — for background agents that lands after the turn finalized,
   * so the card may live in an already-persisted message. */
  private applyTaskUpdate(
    runtimeKey: string,
    runtime: SessionRuntime,
    u: TaskUpdateEvent,
    active: boolean
  ): void {
    let found = this.findTaskActivity(runtime, u.toolUseId, u.taskId);
    if (!found) {
      // No card yet (e.g. panel reloaded mid-run, or a background shell task
      // that never had an Agent tool_use) — give it one so it's trackable.
      const task: TaskActivity = {
        type: "task",
        toolUseId: u.toolUseId || u.taskId || generateId(),
        status: "running",
      };
      if (runtime.streamingMessageId) {
        this.appendActivity(runtime, task);
        this.pushTimelineActivity(runtime, task);
        found = { task };
      } else {
        const lastAssistant = [...runtime.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (!lastAssistant) {
          return;
        }
        if (!lastAssistant.timeline) {
          lastAssistant.timeline = [];
        }
        let lastPart = lastAssistant.timeline[lastAssistant.timeline.length - 1];
        if (!lastPart || lastPart.type !== "activities") {
          lastPart = { type: "activities", activities: [] };
          lastAssistant.timeline.push(lastPart);
        }
        lastPart.activities.push(task);
        found = { task, messageId: lastAssistant.id };
      }
    }

    const t = found.task;
    if (u.taskId) {
      t.taskId = u.taskId;
    }
    if (u.subagentType) {
      t.subagentType = u.subagentType;
    }
    if (u.prompt && !t.prompt) {
      t.prompt = u.prompt;
    }
    switch (u.kind) {
      case "task_started":
        if (u.description) {
          t.description = u.description;
        }
        t.status = "running";
        break;
      case "task_progress":
        // Here `description` is the live one-liner, not the task's name.
        if (u.description) {
          t.progressSummary = u.description;
        }
        if (u.lastToolName) {
          t.lastToolName = u.lastToolName;
        }
        break;
      case "task_updated":
        if (u.status === "completed" || u.status === "failed") {
          t.status = u.status;
        }
        break;
      case "task_notification":
        t.status = u.status === "failed" ? "failed" : "completed";
        if (u.summary) {
          t.progressSummary = u.summary;
        }
        break;
    }
    if (u.usage) {
      if (typeof u.usage.tool_uses === "number") {
        t.toolUses = u.usage.tool_uses;
      }
      if (typeof u.usage.total_tokens === "number") {
        t.totalTokens = u.usage.total_tokens;
      }
      if (typeof u.usage.duration_ms === "number") {
        t.durationMs = u.usage.duration_ms;
      }
    }

    // Status transitions on an already-finalized message must survive a reload;
    // per-tool progress ticks need not (finalize persists the latest anyway).
    if (
      found.messageId &&
      (u.kind === "task_notification" || u.kind === "task_updated")
    ) {
      this.persistRuntime(runtimeKey, runtime);
    }
    this.postTaskUpdate(t, found.messageId, active);
  }

  /** Nest a subagent's own activity (tagged with parentToolUseId) under its
   * task card instead of the main feed. */
  private routeChildActivity(
    runtimeKey: string,
    runtime: SessionRuntime,
    activity: ActivityEvent,
    active: boolean
  ): void {
    const parentId = (activity as { parentToolUseId?: string }).parentToolUseId;
    const found = this.findTaskActivity(runtime, parentId);
    if (!found) {
      return; // unknown parent — drop rather than misattribute to the main agent
    }
    const t = found.task;
    if (!t.children) {
      t.children = [];
    }
    this.coalesceInto(t.children, activity);
    if (t.children.length > MAX_TASK_CHILDREN) {
      t.children.splice(0, t.children.length - MAX_TASK_CHILDREN);
    }
    this.postTaskUpdate(t, found.messageId, active);
  }

  /** Push (and coalesce) an activity onto the timeline's trailing activity run,
   * starting a new run if the previous segment was prose. */
  private pushTimelineActivity(runtime: SessionRuntime, e: ActivityEvent): void {
    const tl = runtime.currentTimeline;
    let last = tl[tl.length - 1];
    if (!last || last.type !== "activities") {
      last = { type: "activities", activities: [] };
      tl.push(last);
      this.capTimelineParts(tl);
    }
    this.coalesceInto(last.activities, e);
  }

  /** Drop the oldest parts once a turn's timeline exceeds the cap — a runaway
   * turn must not grow the live buffers (and every state push) without bound. */
  private capTimelineParts(tl: TimelinePart[]): void {
    const over = tl.length - MAX_TIMELINE_PARTS;
    if (over > 0) {
      tl.splice(0, over);
    }
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
      this.capTimelineParts(tl);
    }
  }

  /** Coalesce a raw activity event into `acts`: fill tool placeholders, merge
   * contiguous thinking, drop tool_result. Scoped to whatever array is passed,
   * so it serves both the flat list and a single timeline run. */
  private coalesceInto(acts: ActivityEvent[], e: ActivityEvent): void {
    // Display cap: a giant tool output (file dump, log stream) would otherwise
    // ride every state push. The CLI's own session file keeps the full text.
    if (
      e.type === "tool_result" &&
      e.content &&
      e.content.length > MAX_TOOL_RESULT_CHARS
    ) {
      e = {
        ...e,
        content:
          e.content.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n… [${e.content.length - MAX_TOOL_RESULT_CHARS} more chars truncated for display]`,
      };
    }
    const over = acts.length - MAX_RUN_ACTIVITIES;
    if (over > 0) {
      acts.splice(0, over);
    }
    if (e.type === "proof") {
      // Presented screenshots are standalone cards; never merged or deduped.
      acts.push(e);
      return;
    }
    if (e.type === "task") {
      // One card per Agent call: re-emissions merge into the existing card.
      const existing = acts.find(
        (a): a is TaskActivity => a.type === "task" && a.toolUseId === e.toolUseId
      );
      if (existing) {
        mergeTaskInto(existing, e);
      } else {
        acts.push(e);
      }
      return;
    }
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

  /** (Re)start the silence watchdog for a streaming turn. Called when a turn
   * starts and on every CLI event, so it only fires after a true gap. */
  private armStreamWatchdog(runtimeKey: string, runtime: SessionRuntime): void {
    this.clearStreamWatchdog(runtime);
    if (!runtime.streamingMessageId) {
      return;
    }
    runtime.watchdogTimer = setTimeout(() => {
      this.fireStreamWatchdog(runtimeKey, runtime);
    }, STREAM_WATCHDOG_MS);
  }

  private clearStreamWatchdog(runtime: SessionRuntime): void {
    if (runtime.watchdogTimer) {
      clearTimeout(runtime.watchdogTimer);
      runtime.watchdogTimer = undefined;
    }
  }

  /** End a turn that has gone silent too long so the UI isn't trapped. We do NOT
   * kill the bridge — the session stays alive, so a late reply (or the user's
   * next message) still works. */
  private fireStreamWatchdog(runtimeKey: string, runtime: SessionRuntime): void {
    if (!runtime.streamingMessageId) {
      return;
    }
    log("WARN", "Stream watchdog fired; ending stalled turn:", runtimeKey);
    // The CLI (and therefore every agent) has been silent for the whole
    // window — settle their cards along with the turn. If one does finish
    // later, its completion patch still lands on the settled card.
    this.settleRunningTasks(
      runtime,
      "No updates for a while — settled by the watchdog",
      this.isActiveKey(runtimeKey)
    );
    const notice =
      "\n\n---\n⏳ *This turn went quiet. The model may have left work running in the background, which this view can't resume on its own — send a message to continue.*";
    runtime.currentStreamText = (runtime.currentStreamText || "") + notice;
    this.finalizeStreamingMessage(runtimeKey, runtime, this.isActiveKey(runtimeKey));
  }

  /**
   * Record that an account's stored token failed to authenticate (a 401/403 from
   * the CLI). Flags it so the account switcher shows the account disconnected and
   * kicks an immediate re-poll so that state surfaces now instead of on the next
   * tick. Returns the account's id + human label for building a Reconnect button.
   */
  private noteAuthFailure(accountId: string): { id: string; label: string } {
    this.authFailedAccountIds.add(accountId);
    // Re-poll so the disconnected state surfaces immediately in the switcher.
    void this.pollUsageForAll();
    return { id: accountId, label: this.labelFor(accountId) };
  }

  private finalizeStreamingMessage(
    runtimeKey: string,
    runtime: SessionRuntime,
    notifyWebview: boolean
  ): void {
    this.clearStreamWatchdog(runtime);
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
      msg.turnStats = {
        durationMs: Math.max(0, Date.now() - msg.timestamp),
      };
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
    runtime.lastReplyAt = Date.now();

    if (runtime.bridge?.sessionId && !runtime.sessionId) {
      runtime.sessionId = runtime.bridge.sessionId;
    }

    this.persistRuntime(runtimeKey, runtime);
    // Restart this tab's idle counter (and any background tab whose turn just
    // settled) without waiting for the next full state push.
    this.sendOpenTabs();
    const otherPane = (1 - this.focusedPane) as 0 | 1;
    if (this.paneActive[otherPane] === runtimeKey) {
      this.sendPaneState(otherPane);
    }

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

  private readonly llmSuggester = new LlmSuggester();

  /** Vocab model cached per corpus snapshot — loadPromptHistory returns the
   * same array identity within its TTL, so this recomputes at most once a
   * minute. */
  private readonly vocabCache = new WeakMap<
    PromptHistoryEntry[],
    { word: string; weight: number }[]
  >();

  /** The user's learned project vocabulary (corrector-style weights) for
   * steering the local LLM. Empty on any failure — steering is an upgrade,
   * never a dependency. */
  private async projectVocabulary(): Promise<
    { word: string; weight: number }[]
  > {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      return [];
    }
    try {
      const entries = await loadPromptHistory(workspacePath);
      const cached = this.vocabCache.get(entries);
      if (cached) {
        return cached;
      }
      const model = buildVocabModel(entries, Date.now());
      // Fewer, stronger words (≥3 uses) — the bench showed a broad shallow
      // push does more harm than a focused one.
      const vocabulary = topProjectWords(model, 60, 3).map((w) => ({
        word: w.word,
        weight: w.weight,
      }));
      this.vocabCache.set(entries, vocabulary);
      return vocabulary;
    } catch {
      return [];
    }
  }

  /** The user's last sent prompts (newest last) — thread context for the
   * suggester, independent of lexical match: mined transcripts show half of
   * all prompts continue the current thread ("okay, now…", "did you…").
   * loadPromptHistory caches for 60s and sorts by lastUsed, so this is one
   * slice, not a rescan; the just-sent turn reaches the model through the
   * conversation block long before the scanner sees it. */
  private async recentPrompts(): Promise<string[]> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      return [];
    }
    try {
      const entries = await loadPromptHistory(workspacePath);
      return entries
        .slice(0, 3)
        .map((e) => e.text.slice(0, 140))
        .reverse();
    } catch {
      return [];
    }
  }

  /** Local-LLM ("magie") completion of the draft the user is typing. The
   * suggester itself is single-flight and never throws; an unavailable model
   * (file not downloaded) just answers null and the feature stays invisible.
   * Conversation context comes from the runtime's own messages, so it works
   * even when retrieval found no examples. */
  private async handleSuggestPhrase(
    conversationId: string | undefined,
    draft: string,
    examples: string[],
    kind: "continue" | "expand" = "continue",
    priorDraft?: string
  ): Promise<void> {
    const runtime = conversationId
      ? this.runtimes.get(conversationId)
      : this.runtimes.get(this.activeKey);
    const turns = (runtime?.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-4);
    const conversation = turns.map((m, i) => {
      // Turns are cut to their HEAD (what the reply did — beats tail 25.5%
      // vs 22.5% on the replay corpus). One exception, user-reported: when
      // the LAST assistant turn ends on a question ("are you next to the
      // machine?"), the user's next message often answers it and head-only
      // cuts the question off — so that turn gets head AND tail. Benched
      // flat on the replay average (25.0% vs 25.5%, within noise; arms
      // v3tail/v3ht/spliced conditional in replay_eval).
      const isLast = i === turns.length - 1;
      if (
        isLast &&
        m.role === "assistant" &&
        m.content.length > 440 &&
        /\?/.test(m.content.slice(-200))
      ) {
        return {
          role: m.role,
          text: m.content.slice(0, 200) + " … " + m.content.slice(-200),
        };
      }
      return { role: m.role, text: m.content.slice(0, 240) };
    });
    const usedExamples = examples.slice(0, 8);
    const detail = await this.llmSuggester.suggestWithConfidence({
      draft,
      kind,
      // Long earlier lines still fit the 2048 context after truncation, and
      // the tail (closest to the phrase being completed) matters most.
      priorDraft: priorDraft ? priorDraft.slice(-600) : undefined,
      examples: usedExamples,
      conversation,
      recent: await this.recentPrompts(),
      vocabulary: await this.projectVocabulary(),
    });
    this.postMessage({
      type: "phraseSuggestion",
      draft,
      suggestion: detail?.shown ?? null,
      suggestions: detail?.rows.map((r) => r.text) ?? [],
      examples: usedExamples,
      kind,
    });
  }

  /** Past-prompt corpus for the composer's history suggestions. Scanning and
   * caching live in loadPromptHistory; an empty corpus is a normal answer
   * (fresh project), so failures degrade to that rather than surfacing. */
  private async handleRequestPromptHistory(): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      this.postMessage({ type: "promptHistory", entries: [] });
      return;
    }
    try {
      const entries = await loadPromptHistory(workspacePath);
      this.postMessage({ type: "promptHistory", entries });
    } catch (err) {
      log("WARN", "prompt history scan failed:", String(err));
      this.postMessage({ type: "promptHistory", entries: [] });
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
    this.postMessage({ type: "addFile", filePath: relativePath });
  }

  /**
   * Files dragged in from outside VS Code arrive in the webview as content-only
   * blobs — the sandboxed iframe never sees their real filesystem path. Write
   * each one to a temp folder and answer with an `addFile` mention so the
   * composer references the copy (which the CLI can then read).
   */
  private handleSaveDroppedFiles(
    files: { name: string; dataBase64: string }[]
  ): void {
    if (!files || files.length === 0) {
      return;
    }
    const dropDir = path.join(
      os.tmpdir(),
      "claude-luxure-drops",
      crypto.randomBytes(4).toString("hex")
    );
    try {
      fs.mkdirSync(dropDir, { recursive: true });
    } catch (err) {
      log("ERROR", "saveDroppedFiles mkdir failed:", String(err));
      vscode.window.showErrorMessage(
        "Could not create a temp folder for the dropped files."
      );
      return;
    }
    const used = new Set<string>();
    for (const file of files) {
      // Keep the original name readable but @mention-safe: the composer's
      // mention regex stops at spaces and most punctuation.
      const base =
        path.basename(file.name || "file").replace(/[^\w.-]+/g, "-") || "file";
      let name = base;
      for (let i = 2; used.has(name); i++) {
        const ext = path.extname(base);
        name = `${path.basename(base, ext)}-${i}${ext}`;
      }
      used.add(name);
      const dest = path.join(dropDir, name);
      try {
        fs.writeFileSync(dest, Buffer.from(file.dataBase64, "base64"));
        this.postMessage({ type: "addFile", filePath: dest });
      } catch (err) {
        log("ERROR", "saveDroppedFiles write failed:", file.name, String(err));
        vscode.window.showErrorMessage(
          `Could not save dropped file: ${file.name}`
        );
      }
    }
  }

  /** Lightbox "open in editor tab": write the chat image (a data URL) to a
   * temp file and open it in a real editor tab — the native image preview
   * gives a full-window view with its own zoom, which the sidebar can't. */
  private async handleOpenImageInEditor(
    dataUrl: string,
    label?: string
  ): Promise<void> {
    // Externalized images arrive as webview URIs — map back to the cache file
    // and open it directly, no temp copy needed.
    const cached = this.webviewUriToFile(dataUrl);
    if (cached) {
      try {
        await vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(cached),
          vscode.ViewColumn.Active
        );
      } catch (err) {
        log("ERROR", "openImageInEditor failed:", String(err));
      }
      return;
    }
    const match = /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,(.+)$/.exec(
      dataUrl
    );
    if (!match) {
      vscode.window.showErrorMessage(
        "This image can't be opened in an editor tab."
      );
      return;
    }
    try {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const dir = path.join(os.tmpdir(), "claude-luxure-images");
      fs.mkdirSync(dir, { recursive: true });
      const safe =
        (label || "image").replace(/[^\w.-]+/g, "-").slice(0, 40) || "image";
      const filePath = path.join(
        dir,
        `${safe}-${Date.now().toString(36)}.${ext}`
      );
      fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(filePath),
        vscode.ViewColumn.Active
      );
    } catch (err) {
      log("ERROR", "openImageInEditor failed:", String(err));
      vscode.window.showErrorMessage(
        "Could not open the image in an editor tab."
      );
    }
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

  /** Serialize one conversation's full display state — used for the active
   * conversation ("state") and for the one shown in the split pane.
   * Two heap guards apply on the way out: only the trailing display window of
   * messages ships (older ones page in via "loadEarlier"), and base64 images
   * are swapped for webview-URI files (externalizeImage). */
  private buildStateFor(key: string, runtime: SessionRuntime): ExtensionState {
    this.ensureMarker(key, runtime);
    const all = this.decorateForks(runtime);
    const win = this.displayWindow.get(key) ?? DISPLAY_WINDOW_DEFAULT;
    const windowed = all.length > win ? all.slice(all.length - win) : all;
    return {
      historyTruncated: all.length - windowed.length || undefined,
      marker: runtime.markerColor
        ? {
            emoji: runtime.markerEmoji,
            color: runtime.markerColor,
            note: runtime.markerNote,
          }
        : undefined,
      mode: runtime.mode ?? this.mode,
      model: runtime.model ?? this.model,
      effort: runtime.effort ?? this.effort,
      messages: windowed.map((m) => this.slimMessage(m)),
      cliStatus: runtime.bridge?.status || runtime.cliStatus || "stopped",
      pendingDiffs: this.diffManager.getPendingDiffs(),
      sessionId: runtime.sessionId,
      activeTabId: key,
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
      // Live turn buffers — lets the webview restore the in-progress feed
      // when the user switches back to a running conversation.
      liveTimeline: this.slimTimeline(runtime.currentTimeline),
      liveActivities: this.slimActivities(runtime.currentActivities),
    };
  }

  /** Where display images live as files: served to the webview via
   * asWebviewUri so pixels sit in Chromium's image cache instead of V8's heap
   * (base64 data URLs retained in state were the OOM driver). */
  private ensureImageCacheDir(): string | undefined {
    if (this.imageCacheDir) {
      return this.imageCacheDir;
    }
    try {
      const dir = path.join(this.context.globalStorageUri.fsPath, "imgcache");
      fs.mkdirSync(dir, { recursive: true });
      this.imageCacheDir = dir;
      return dir;
    } catch (e) {
      log("WARN", "Image cache dir unavailable:", e);
      return undefined;
    }
  }

  /** Swap a base64 data URL for a webview-URI backed by a cache file. Returns
   * the input untouched when it isn't a data URL or the cache/webview isn't
   * available (the webview renders either form). */
  private externalizeImage(src: string): string {
    if (!src.startsWith("data:image/")) {
      return src;
    }
    const webview = this.webview;
    const dir = webview ? this.ensureImageCacheDir() : undefined;
    if (!webview || !dir) {
      return src;
    }
    // Identity without hashing the multi-MB string on every lookup.
    const key = `${src.length}:${src.slice(0, 96)}:${src.slice(-32)}`;
    const hit = this.imageCacheIndex.get(key);
    if (hit) {
      return hit;
    }
    const m = /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,(.+)$/.exec(src);
    if (!m) {
      return src;
    }
    try {
      const ext = m[1] === "jpg" ? "jpeg" : m[1];
      const name = `img-${crypto
        .createHash("sha1")
        .update(src)
        .digest("hex")
        .slice(0, 24)}.${ext}`;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, Buffer.from(m[2], "base64"));
      }
      const uri = webview.asWebviewUri(vscode.Uri.file(file)).toString();
      this.imageCacheIndex.set(key, uri);
      return uri;
    } catch (e) {
      log("WARN", "externalizeImage failed:", e);
      return src;
    }
  }

  /** Map a webview resource URI back to the local file it serves — only for
   * files inside our image cache (used by "open image in editor tab"). */
  private webviewUriToFile(src: string): string | undefined {
    if (!/^https:\/\/[^/]*vscode-resource[^/]*\//.test(src)) {
      return undefined;
    }
    try {
      const pathname = decodeURIComponent(new URL(src).pathname);
      const dir = this.imageCacheDir;
      if (
        dir &&
        pathname.startsWith(dir + path.sep) &&
        fs.existsSync(pathname)
      ) {
        return pathname;
      }
    } catch {
      // not a parseable URL — treat as unknown
    }
    return undefined;
  }

  private slimImages(images: string[] | undefined): string[] | undefined {
    if (!images || !images.some((i) => i.startsWith("data:image/"))) {
      return images;
    }
    return images.map((i) => this.externalizeImage(i));
  }

  private slimActivity(a: ActivityEvent): ActivityEvent {
    if (a.type === "proof") {
      const images = this.slimImages(a.images) ?? a.images;
      return images === a.images ? a : { ...a, images };
    }
    if (a.type === "tool_use" && a.result?.images) {
      const images = this.slimImages(a.result.images);
      return images === a.result.images
        ? a
        : { ...a, result: { ...a.result, images } };
    }
    if (a.type === "tool_result") {
      const images = this.slimImages(a.images);
      return images === a.images ? a : { ...a, images };
    }
    return a;
  }

  private slimActivities(
    acts: ActivityEvent[] | undefined
  ): ActivityEvent[] | undefined {
    if (!acts) {
      return acts;
    }
    let changed = false;
    const out = acts.map((a) => {
      const slim = this.slimActivity(a);
      changed ||= slim !== a;
      return slim;
    });
    return changed ? out : acts;
  }

  private slimTimeline(
    parts: TimelinePart[] | undefined
  ): TimelinePart[] | undefined {
    if (!parts) {
      return parts;
    }
    let changed = false;
    const out = parts.map((p) => {
      if (p.type !== "activities") {
        return p;
      }
      const slim = this.slimActivities(p.activities);
      if (slim === p.activities) {
        return p;
      }
      changed = true;
      return { ...p, activities: slim ?? [] };
    });
    return changed ? out : parts;
  }

  private slimMessage(msg: ChatMessage): ChatMessage {
    const images = this.slimImages(msg.images);
    const timeline = this.slimTimeline(msg.timeline);
    const activities = this.slimActivities(msg.activities);
    if (
      images === msg.images &&
      timeline === msg.timeline &&
      activities === msg.activities
    ) {
      return msg;
    }
    return { ...msg, images, timeline, activities };
  }

  private sendState(): void {
    const runtime = this.getActiveRuntime();
    const perfId = this.pendingStatePerfId;
    this.pendingStatePerfId = undefined;
    const t0 = performance.now();
    const state = this.buildStateFor(this.activeKey!, runtime);
    const tBuilt = performance.now();
    this.postMessage({
      type: "state",
      state,
      perfId,
      perfSentAt: Date.now(),
    });
    if (PERF) {
      perfLog("state.sent", {
        perfId,
        sid: state.sessionId?.slice(-8),
        ...measureStatePayload(state),
        buildMs: r1(tBuilt - t0),
        postMs: r1(performance.now() - tBuilt),
      });
    }
  }

  getDiffManager(): DiffManager {
    return this.diffManager;
  }

  dispose(): void {
    this.stopUsagePolling();
    this.stopHeartbeat();
    if (this.paneTicker) {
      clearInterval(this.paneTicker);
      this.paneTicker = undefined;
    }
    for (const [key, runtime] of this.runtimes) {
      this.persistRuntime(key, runtime);
      runtime.bridge?.stop();
    }
    // persistRuntime only queued debounced saves — write them before the host dies.
    this.transcripts.flushAll();
    for (const pending of this.pendingAnnotations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension deactivated"));
    }
    this.pendingAnnotations.clear();
    this.proofChannel?.dispose();
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
