import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import type { ContextInfo, Mode, EffortLevel } from "../shared/types";

/**
 * Bridge to the OpenAI Codex CLI, exposing the SAME EventEmitter contract as
 * {@link ClaudeBridge} so ChatViewProvider can drive either one.
 *
 * It does NOT shell out to `codex exec` (one-shot per turn, no interrupt, no
 * token streaming). It speaks `codex app-server` — the long-lived JSON-RPC
 * protocol the official Codex IDE extension uses — over stdio:
 *
 *   initialize → initialized → thread/start | thread/resume → turn/start …
 *
 * Verified against codex-cli 0.145.0/0.154.0 (local) and 0.153.4 (remote box). The
 * protocol is flagged [experimental] and does move between releases; every
 * shape read below is defensive.
 */

export interface CodexEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface CodexBridgeOptions {
  cwd: string;
  mode?: Mode;
  model?: string;
  effort?: EffortLevel;
  /** Codex thread id — the analogue of a Claude session id. */
  sessionId?: string;
  forkSession?: boolean;
  sessionName?: string;
  /** Isolated CODEX_HOME for the bound account — the exact analogue of
   * CLAUDE_CONFIG_DIR. When unset the process uses the ambient ~/.codex. */
  configDir?: string;
  /** Absolute path to the `codex` binary. */
  codexPath?: string;
  /** Per-conversation env overrides (worktree ports, COMPOSE_PROJECT_NAME). */
  env?: Record<string, string>;
  /** Bundled visual-proof MCP server. Codex takes MCP servers as a config
   * overlay on thread/start rather than Claude's `--mcp-config` file. */
  luxureTools?: { mcpConfigPath: string; env: Record<string, string> };
  /** Server definition for the luxure MCP server, injected into the thread
   * config as `mcp_servers.luxure`. */
  luxureServer?: { command: string; args: string[]; env: Record<string, string> };
  /** The bundled Lightpanda browser server (default browser tool), injected
   * as `mcp_servers.lightpanda`. */
  browserServer?: { command: string; args: string[]; env: Record<string, string> };
}

const PLAN_MODE_INSTRUCTIONS = `You are in PLAN MODE. You must ONLY:
1. Read and analyze files
2. Propose changes as a structured markdown plan
3. NEVER write, edit, or execute anything that modifies the workspace
Present your analysis and proposed changes clearly in markdown.`;

const MARKDOWN_STYLE_INSTRUCTIONS = `Format every response as clean, well-structured GitHub-flavored Markdown:
- Use ## and ### headings to organize anything longer than a couple of paragraphs, and keep a blank line around headings, lists, tables, and code blocks.
- Use tables (with a header row) for comparisons or any data with two or more attributes; keep cell text terse.
- Use \`inline code\` for file paths, commands, flags, and identifiers; use fenced code blocks with a language tag for multi-line code or terminal output.
- Use "-" for bullets and "1." for ordered steps; bold only key terms. Keep paragraphs short.
- Do not wrap ordinary prose in code blocks, and do not over-nest lists.`;

const VISUAL_PROOF_INSTRUCTIONS = `This chat panel can display images inline. You have visual-proof tools on the "luxure" MCP server:
- capture_screen: take a screenshot (full screen, a region, or an app's front window — macOS) and show it in the chat.
- present_screenshot: display an existing image file (PNG/JPEG/WebP/GIF) in the chat panel.
- annotate_screenshot: draw arrows, boxes, highlights, labels or numbered badges onto an image file and show the result.
Use them to PROVE visual work: after implementing or fixing UI, capture a screenshot of the result and present it in the chat.`;

const LIGHTPANDA_INSTRUCTIONS = `Your default browser tool is the "lightpanda" MCP server — a bundled headless Lightpanda browser driven over CDP (new_page, navigate_page, take_snapshot, evaluate_script, click, fill, list_network_requests, …). Use it by default for anything web: opening pages, scraping, checking content, filling forms, running JS in a page, inspecting requests. Page tools take a pageId from new_page/list_pages output; rendering is simplified (screenshots are real but text-first and approximately styled).`;

/** Default context window when Codex doesn't report one for the active model. */
const DEFAULT_CODEX_WINDOW = 272_000;

/** Codex thread-item types that read as "the agent used a tool". */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "subAgentActivity",
  "collabAgentToolCall",
  "collabToolCall",
  "plan",
]);

interface ToolShape {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** One call as the chat draws it — see {@link toolCallsFor}. */
interface ToolCall extends ToolShape {
  toolUseId: string;
  /** What the call's result reports on: the item, or one file's slice of it. */
  item: Record<string, any>;
}

/**
 * Translate a Codex thread item into the {toolName, toolInput} shape the chat
 * renders. Names deliberately mirror Claude's tools so the existing cards
 * (Bash, file-change, MCP) light up instead of falling back to a generic row.
 */
function toolShapeFor(item: Record<string, any>): ToolShape {
  switch (item.type) {
    case "commandExecution":
      return {
        toolName: "Bash",
        toolInput: {
          command: String(item.command ?? ""),
          description: item.cwd ? `in ${item.cwd}` : undefined,
        },
      };
    case "fileChange": {
      // One file per call (toolCallsFor splits a multi-file patch). Codex's
      // `diff` is the new file's text for an add, the old text for a delete,
      // and unified-diff hunks for an update — the card needs it to show the
      // change, so it rides along as Write `content` / Edit `diff`.
      const change = (Array.isArray(item.changes) && item.changes[0]) || {};
      const diff = String(change.diff ?? "");
      if (change.kind?.type === "add") {
        return {
          toolName: "Write",
          toolInput: { file_path: String(change.path ?? ""), content: diff },
        };
      }
      return {
        toolName: "Edit",
        toolInput: {
          // A moved file's card opens it where it now lives.
          file_path: String(change.kind?.move_path || change.path || ""),
          diff:
            change.kind?.type === "delete"
              ? deletionDiff(diff)
              : diff.replace(/\n+Moved to: .*$/, "\n"),
        },
      };
    }
    case "mcpToolCall":
      return {
        toolName: `mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`,
        toolInput: (item.arguments as Record<string, unknown>) || {},
      };
    case "dynamicToolCall":
      return {
        toolName: String(item.tool ?? "tool"),
        toolInput: (item.arguments as Record<string, unknown>) || {},
      };
    case "webSearch":
      return { toolName: "WebSearch", toolInput: { query: String(item.query ?? "") } };
    case "imageView":
      return { toolName: "Read", toolInput: { file_path: String(item.path ?? "") } };
    case "imageGeneration":
      return {
        toolName: "ImageGeneration",
        toolInput: { prompt: String(item.revisedPrompt ?? ""), path: item.savedPath },
      };
    case "subAgentActivity":
      return {
        toolName: "Agent",
        toolInput: {
          description: String(item.kind ?? "subagent"),
          subagent_type: String(item.agentPath ?? ""),
        },
      };
    case "collabAgentToolCall":
    case "collabToolCall":
      return {
        toolName: "Agent",
        toolInput: {
          description: String(item.tool ?? "collab"),
          prompt: typeof item.prompt === "string" ? item.prompt : undefined,
        },
      };
    case "plan":
      return { toolName: "TodoWrite", toolInput: { text: String(item.text ?? "") } };
    default:
      return { toolName: String(item.type ?? "tool"), toolInput: {} };
  }
}

/** A deleted file's old text as one all-removed hunk, so its card lists what
 * went away the same way an update's diff does. */
function deletionDiff(content: string): string {
  if (!content) {
    return "";
  }
  const lines = content.replace(/\n$/, "").split("\n");
  return [`@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`)].join("\n");
}

/**
 * The calls the chat draws for one item. A single Codex patch can touch
 * several files, so a fileChange becomes one call per file — each gets its own
 * diff card, as separate Edit/Write calls do on the Claude side.
 */
function toolCallsFor(item: Record<string, any>): ToolCall[] {
  const id = String(item.id ?? "");
  if (item.type !== "fileChange") {
    return [{ ...toolShapeFor(item), toolUseId: id, item }];
  }
  const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((change, i) => {
    const one = { ...item, changes: [change] };
    return { ...toolShapeFor(one), toolUseId: i === 0 ? id : `${id}:${i}`, item: one };
  });
}

/** Human-readable result text for a completed tool item. */
function toolResultText(item: Record<string, any>): string {
  switch (item.type) {
    case "commandExecution": {
      const out = String(item.aggregatedOutput ?? "");
      const code = item.exitCode;
      return code !== undefined && code !== null && code !== 0
        ? `${out}\n(exit ${code})`
        : out;
    }
    case "fileChange": {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      return changes
        .map((c) => `${c?.kind?.type ?? "update"} ${c?.path ?? ""}\n${c?.diff ?? ""}`)
        .join("\n");
    }
    case "mcpToolCall":
      if (item.error) {
        return String(item.error);
      }
      return typeof item.result === "string"
        ? item.result
        : JSON.stringify(item.result ?? {}, null, 2);
    case "dynamicToolCall":
      return JSON.stringify(item.contentItems ?? {}, null, 2);
    case "webSearch":
      return JSON.stringify(item.results ?? [], null, 2);
    default:
      return "";
  }
}

function isFailedItem(item: Record<string, any>): boolean {
  if (item.status === "failed" || item.status === "declined") {
    return true;
  }
  if (item.type === "commandExecution") {
    return typeof item.exitCode === "number" && item.exitCode !== 0;
  }
  return !!item.error;
}

export class CodexBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _status: "starting" | "ready" | "busy" | "error" | "stopped" = "stopped";
  private _sessionId: string | undefined;
  private _turnId: string | undefined;
  private _contextWindow = DEFAULT_CODEX_WINDOW;
  private _model = "";
  private cwd: string;

  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  /** Tool items seen this turn, so item/completed can be matched to its card. */
  private readonly openItems = new Map<string, string>();
  /** Agent-message item ids that already streamed at least one delta — their
   * item/completed must NOT re-emit the text or the answer lands twice. */
  private readonly streamedMessages = new Set<string>();
  /** Agent lifetime is keyed by its thread, not a spawn/wait tool-call id.
   * Completing a spawn call only means the agent was launched. */
  private readonly agents = new Map<string, {
    toolUseId: string;
    status: "running" | "completed" | "failed";
    toolUses: number;
    items: Set<string>;
  }>();

  get status() {
    return this._status;
  }

  /** True when a live app-server process is attached — callers deciding whether
   * to (re)spawn must check this, not just status. */
  get isAlive(): boolean {
    return !!this.proc?.stdin && !this.proc.stdin.destroyed &&
      !this.proc.killed && this.proc.exitCode === null;
  }

  get sessionId() {
    return this._sessionId;
  }

  constructor(private options: CodexBridgeOptions) {
    super();
    this.cwd = options.cwd;
    this._sessionId = options.sessionId;
    if (options.model) {
      this._model = options.model;
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<void> {
    if (this.proc) {
      this.stop();
    }

    this._status = "starting";
    this.emit("status", this._status);

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.configDir) {
      childEnv.CODEX_HOME = this.options.configDir;
    }
    // An ambient key would silently outrank the bound account's ChatGPT login —
    // the same trap that cost the Telegram bridge a revoked refresh token.
    delete childEnv.OPENAI_API_KEY;
    if (this.options.luxureTools) {
      Object.assign(childEnv, this.options.luxureTools.env);
    }
    if (this.options.env) {
      Object.assign(childEnv, this.options.env);
    }

    let spawned: ChildProcess;
    try {
      spawned = spawn(this.options.codexPath || "codex", ["app-server"], {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err) {
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Failed to spawn codex CLI: ${err}`);
      return;
    }
    this.proc = spawned;

    // Generation guard — identical reasoning to ClaudeBridge: after a restart,
    // the old process's late events must not touch the bridge.
    const owned = () => this.proc === spawned;

    spawned.on("error", (err) => {
      if (!owned()) {
        return;
      }
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Codex CLI error: ${err.message}`);
    });

    spawned.on("exit", (code, signal) => {
      if (!owned()) {
        return;
      }
      this._status = "stopped";
      this.emit("status", this._status);
      this.emit("exit", { code, signal });
      this.proc = null;
      this.rl = null;
      this.rejectAllPending("codex app-server exited");
    });

    if (spawned.stderr) {
      spawned.stderr.on("data", (data: Buffer) => {
        if (!owned()) {
          return;
        }
        const text = data.toString();
        if (text.trim()) {
          this.emit("stderr", text);
        }
      });
    }

    if (spawned.stdout) {
      this.rl = readline.createInterface({
        input: spawned.stdout,
        crlfDelay: Infinity,
      });
      this.rl.on("line", (line: string) => {
        if (!owned()) {
          return;
        }
        this.parseLine(line);
      });
    }

    try {
      await this.handshake();
    } catch (err) {
      if (!owned()) {
        return;
      }
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Codex app-server handshake failed: ${err}`);
      return;
    }
    if (!owned()) {
      return;
    }

    this._status = "ready";
    this.emit("status", this._status);
  }

  /** initialize → initialized → open (or reopen) the thread. */
  private async handshake(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "claude-luxure", title: "Claude Luxure", version: "0.1.0" },
    });
    this.notify("initialized", {});

    const params = this.threadParams();
    let thread: any;
    if (this._sessionId) {
      try {
        thread = await this.request("thread/resume", {
          threadId: this._sessionId,
          ...params,
        });
      } catch (err) {
        // A thread codex can no longer load (deleted rollout, another CODEX_HOME):
        // fall back to a fresh one rather than wedging the conversation.
        this.emit(
          "stderr",
          `codex thread/resume failed (${err}); starting a fresh thread\n`
        );
        this._sessionId = undefined;
        thread = await this.request("thread/start", params);
      }
    } else {
      thread = await this.request("thread/start", params);
    }

    const id = thread?.thread?.id || thread?.threadId;
    if (typeof id === "string") {
      this._sessionId = id;
    }
    if (typeof thread?.model === "string") {
      this._model = thread.model;
    }
    void this.loadSkills();
  }

  private threadParams(): Record<string, unknown> {
    const instructions = [MARKDOWN_STYLE_INSTRUCTIONS];
    if (this.options.mode === "plan") {
      instructions.push(PLAN_MODE_INSTRUCTIONS);
    } else {
      if (this.options.luxureServer) {
        instructions.push(VISUAL_PROOF_INSTRUCTIONS);
      }
      if (this.options.browserServer) {
        instructions.push(LIGHTPANDA_INSTRUCTIONS);
      }
    }

    const params: Record<string, unknown> = {
      cwd: this.cwd,
      developerInstructions: instructions.join("\n\n"),
      // The panel already runs the CLI unsandboxed by design (it is the same
      // trust model as --dangerously-skip-permissions on the Claude side).
      // Plan mode is the one place we actually want the sandbox on.
      approvalPolicy: "never",
      // NOTE: thread/start takes `sandbox` (a SandboxMode string); it is
      // turn/start that takes `sandboxPolicy` (an object). Passing the object
      // here is silently ignored and the thread stays read-only, which shows up
      // as "patch rejected: writing is blocked by read-only sandbox".
      sandbox: this.options.mode === "plan" ? "read-only" : "danger-full-access",
    };
    if (this.options.model) {
      params.model = this.options.model;
    }
    if (this.options.mode !== "plan") {
      // Codex takes MCP servers as a config overlay, not a --mcp-config file.
      const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
      if (this.options.luxureServer) {
        mcpServers.luxure = {
          command: this.options.luxureServer.command,
          args: this.options.luxureServer.args,
          env: this.options.luxureServer.env,
        };
      }
      if (this.options.browserServer) {
        mcpServers.lightpanda = {
          command: this.options.browserServer.command,
          args: this.options.browserServer.args,
          env: this.options.browserServer.env,
        };
      }
      if (Object.keys(mcpServers).length > 0) {
        params.config = { mcp_servers: mcpServers };
      }
    }
    return params;
  }

  /** Codex skills are the closest thing to Claude's slash commands. */
  private async loadSkills(): Promise<void> {
    try {
      const res = await this.request("skills/list", {});
      const items: any[] = res?.data || res?.skills || [];
      const names = items
        .map((s) => (typeof s === "string" ? s : s?.name))
        .filter((n): n is string => typeof n === "string" && !!n);
      this.emit("slashCommands", names);
    } catch {
      // Older builds don't expose skills/list — an empty menu beats a wrong one.
      this.emit("slashCommands", []);
    }
  }

  // ─────────────────────────── JSON-RPC plumbing ───────────────────────────

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("codex app-server is not running"));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  private respond(id: unknown, result: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private rejectAllPending(reason: string): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit("rawOutput", trimmed);
      return;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (typeof msg.method !== "string") {
      return;
    }

    // Server→client REQUEST (has an id): approvals and friends. We run in the
    // panel's always-approve trust model, so answer affirmatively and keep the
    // turn moving instead of deadlocking on a prompt nobody will see.
    if (msg.id !== undefined) {
      this.handleServerRequest(msg);
      return;
    }

    this.handleNotification(msg.method, msg.params || {});
    this.emit("event", { type: msg.method, ...(msg.params || {}) } as CodexEvent);
  }

  private handleServerRequest(msg: Record<string, any>): void {
    const method: string = msg.method;
    const params = msg.params || {};

    switch (method) {
      case "execCommandApproval":
      case "item/commandExecution/requestApproval":
        this.respond(msg.id, { decision: "approved" });
        return;
      case "applyPatchApproval":
      case "item/fileChange/requestApproval":
        // Snapshot before the patch lands so the diff/revert flow has a "before".
        this.emitFileChangeSnapshot(params);
        this.respond(msg.id, { decision: "approved" });
        return;
      case "item/permissions/requestApproval":
        this.respond(msg.id, { decision: "approved" });
        return;
      case "currentTime/read":
        this.respond(msg.id, { currentTime: new Date().toISOString() });
        return;
      default:
        // Unknown server request: an empty result is safer than silence, which
        // would stall the turn forever.
        this.respond(msg.id, {});
    }
  }

  /** Tell the provider a file is about to change, using the same synthetic
   * "assistant" tool_use event shape it already snapshots from. */
  private emitFileChangeSnapshot(params: Record<string, any>): void {
    const changes = params?.changes || params?.item?.changes;
    const paths: string[] = Array.isArray(changes)
      ? changes.map((c: any) => String(c?.path ?? "")).filter(Boolean)
      : Object.keys(changes || {});
    for (const p of paths) {
      this.emit("assistant", {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: p } }],
        },
      } as CodexEvent);
    }
  }

  // ───────────────────────── notification → events ─────────────────────────

  private updateAgent(
    threadId: string,
    status: string,
    info: { description?: string; prompt?: string; summary?: string; agentPath?: string } = {}
  ): void {
    if (!threadId || threadId === this._sessionId) { return; }
    let agent = this.agents.get(threadId);
    const terminal = status === "completed" ? "completed"
      : ["errored", "failed", "interrupted", "shutdown", "notFound"].includes(status)
        ? "failed" : undefined;
    if (!agent) {
      agent = { toolUseId: `codex-agent-${threadId}`, status: "running", toolUses: 0, items: new Set() };
      this.agents.set(threadId, agent);
      this.emit("taskUpdate", {
        kind: "task_started", taskId: threadId, toolUseId: agent.toolUseId,
        description: info.description || info.agentPath || "Codex agent",
        subagentType: "Codex", prompt: info.prompt, background: true,
      });
    } else if (status === "started") {
      // An explicit resume/follow-up can restart a completed agent. Ordinary
      // delayed "running" snapshots must not undo its terminal status.
      agent.status = "running";
      this.emit("taskUpdate", {
        kind: "task_started", taskId: threadId, toolUseId: agent.toolUseId,
        description: info.description, prompt: info.prompt, background: true,
      });
    }
    if (terminal) {
      agent.status = terminal;
      this.emit("taskUpdate", {
        kind: "task_notification", taskId: threadId, toolUseId: agent.toolUseId,
        status: terminal, summary: info.summary || (terminal === "completed" ? "Completed" : `Agent ${status}`),
      });
    } else if (agent.status === "running") {
      this.emit("taskUpdate", {
        kind: "task_progress", taskId: threadId, toolUseId: agent.toolUseId,
        prompt: info.prompt,
        description: info.summary || info.agentPath || "Working",
        usage: { tool_uses: agent.toolUses },
      });
    }
  }

  /** Both app-server generations report one-shot collaboration items; their
   * contained agent state, not item/completed itself, ends a live task card. */
  private handleAgentItem(item: Record<string, any>, completed: boolean): boolean {
    if (item.type === "subAgentActivity") {
      // Its item start/end bracket the notification, not the agent lifetime.
      if (completed) {
        this.updateAgent(String(item.agentThreadId || ""), String(item.kind || "running"), {
          agentPath: item.agentPath,
        });
      }
      return true;
    }
    if (item.type !== "collabAgentToolCall" && item.type !== "collabToolCall") {
      return false;
    }
    const ids: string[] = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
      : [item.newThreadId || item.receiverThreadId].filter(Boolean);
    const states = item.agentsStates || {};
    for (const id of new Set([...ids, ...Object.keys(states)])) {
      const state = states[id] || item.agentStatus || {};
      const status = typeof state === "string" ? state : state.status;
      const restarting = ["resumeAgent", "followupTask", "resume_agent", "followup_task"].includes(item.tool);
      const nextStatus = restarting && (!status || status === "running" || status === "pendingInit")
        ? "started" : status || "running";
      this.updateAgent(id, nextStatus, {
        description: typeof item.prompt === "string" ? item.prompt.slice(0, 100) : undefined,
        prompt: item.prompt,
        summary: state.message,
      });
    }
    // Failed launches have no child thread to track, but must still be visible.
    if (completed && ids.length === 0 && item.status === "failed") {
      this.emit("activity", {
        type: "tool_use", toolUseId: item.id,
        toolName: "Agent", toolInput: { description: "Launch Codex agent", prompt: item.prompt },
      });
      this.emit("activity", {
        type: "tool_result", toolUseId: item.id, content: "Agent launch failed", isError: true,
      });
    }
    return true;
  }

  /** Child notifications may arrive on the same connection. Their tools nest
   * under the agent card; their replies/status must never mutate the parent. */
  private handleChildNotification(method: string, params: Record<string, any>, threadId: string): void {
    const agent = this.agents.get(threadId);
    if (!agent) { return; }
    if (method === "turn/started") {
      this.updateAgent(threadId, "started");
    } else if (method === "turn/completed") {
      this.updateAgent(threadId, params.turn?.status === "completed" ? "completed" : "failed", {
        summary: params.turn?.error?.message,
      });
    } else if (method === "error" && !params.willRetry) {
      this.updateAgent(threadId, "failed", { summary: params.error?.message });
    } else if (method === "item/started" || method === "item/completed") {
      const item = params.item || {};
      if (item.type === "reasoning") {
        if (method === "item/started") { this.updateAgent(threadId, "running", { summary: "Thinking" }); }
        return;
      }
      if (this.handleAgentItem(item, method === "item/completed") || !TOOL_ITEM_TYPES.has(item.type)) { return; }
      const calls = toolCallsFor(item);
      if (!agent.items.has(item.id) && calls.length > 0) {
        agent.items.add(item.id);
        agent.toolUses++;
        for (const call of calls) {
          this.emit("activity", {
            type: "tool_use", toolName: call.toolName, toolInput: call.toolInput,
            toolUseId: call.toolUseId, parentToolUseId: agent.toolUseId,
          });
        }
        this.updateAgent(threadId, "running", { summary: `Using ${calls[0].toolName}` });
      }
      if (method === "item/completed") {
        for (const call of calls) {
          this.emit("activity", {
            type: "tool_result", toolUseId: call.toolUseId, parentToolUseId: agent.toolUseId,
            content: toolResultText(call.item).slice(0, 10000), isError: isFailedItem(call.item),
          });
        }
      }
    }
  }

  private handleNotification(method: string, params: Record<string, any>): void {
    const threadId = params.threadId || (method === "thread/started" ? params.thread?.id : undefined);
    if (threadId && this._sessionId && threadId !== this._sessionId) {
      this.handleChildNotification(method, params, threadId);
      return;
    }
    switch (method) {
      case "thread/started": {
        const id = params?.thread?.id;
        if (typeof id === "string") {
          this._sessionId = id;
        }
        return;
      }

      case "turn/started":
        this._turnId = params?.turn?.id;
        this.openItems.clear();
        this.streamedMessages.clear();
        this._status = "busy";
        this.emit("status", this._status);
        return;

      case "item/agentMessage/delta":
        if (typeof params.delta === "string" && params.delta) {
          if (typeof params.itemId === "string") {
            this.streamedMessages.add(params.itemId);
          }
          this.emit("textDelta", params.delta);
        }
        return;

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        if (typeof params.delta === "string" && params.delta) {
          this.emit("activity", { type: "thinking_delta", text: params.delta });
        }
        return;

      case "item/plan/delta":
        return; // superseded by turn/plan/updated

      case "turn/plan/updated":
        this.emit("activity", {
          type: "tool_use", toolName: "TodoWrite",
          toolUseId: `codex-plan-${params.turnId}`,
          toolInput: { todos: (Array.isArray(params.plan) ? params.plan : []).map((step: any) => ({
            content: step.step,
            status: step.status === "inProgress" ? "in_progress" : step.status,
          })) },
        });
        return;

      case "item/started": {
        const item = params.item || {};
        if (item.type === "reasoning") {
          // Many Codex models send no readable reasoning deltas at all.
          this.emit("activity", { type: "thinking", text: "" });
          return;
        }
        if (this.handleAgentItem(item, false)) { return; }
        if (TOOL_ITEM_TYPES.has(item.type)) {
          const id = String(item.id ?? "");
          const calls = toolCallsFor(item);
          // A fileChange is drawn from its changes; if it starts without
          // any, item/completed draws it instead.
          if (id && !this.openItems.has(id) && calls.length > 0) {
            this.openItems.set(id, item.type);
            if (item.type === "fileChange") {
              this.emitFileChangeSnapshot(item);
            }
            for (const call of calls) {
              this.emit("activity", {
                type: "tool_use",
                toolName: call.toolName,
                toolInput: call.toolInput,
                toolUseId: call.toolUseId,
              });
            }
          }
        }
        return;
      }

      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return; // the completed item carries the full output

      case "item/completed": {
        const item = params.item || {};
        const id = String(item.id ?? "");
        if (this.handleAgentItem(item, true)) { return; }

        if (item.type === "agentMessage") {
          // Deltas already streamed the text; only speak up if none arrived
          // (short answers occasionally complete without a delta).
          if (!this.streamedMessages.has(id) && typeof item.text === "string") {
            this.emit("assistantText", item.text);
          }
          this.streamedMessages.delete(id);
          return;
        }
        if (item.type === "contextCompaction") {
          this.emit("compactBoundary", { type: "compact_boundary" } as CodexEvent);
          return;
        }
        if (!TOOL_ITEM_TYPES.has(item.type)) {
          return;
        }
        const calls = toolCallsFor(item);
        if (id && !this.openItems.has(id)) {
          // Completed without a start (fast tools) — render the call first.
          this.openItems.set(id, item.type);
          for (const call of calls) {
            this.emit("activity", {
              type: "tool_use",
              toolName: call.toolName,
              toolInput: call.toolInput,
              toolUseId: call.toolUseId,
            });
          }
        }
        for (const call of calls) {
          this.emit("activity", {
            type: "tool_result",
            toolUseId: call.toolUseId,
            content: toolResultText(call.item).slice(0, 10000),
            isError: isFailedItem(call.item),
          });
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage || {};
        const last = usage.last || {};
        const window =
          typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0
            ? usage.modelContextWindow
            : this._contextWindow;
        this._contextWindow = window;
        const ctx: ContextInfo = {
          // Codex reports input_tokens inclusive of the cached prefix, so the
          // cache fields stay at 0 to avoid double-counting the context bar.
          inputTokens: Number(last.inputTokens) || 0,
          outputTokens: Number(last.outputTokens) || 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: window,
          model: this._model || this.options.model || "codex",
        };
        this.emit("contextUpdate", ctx);
        return;
      }

      case "account/rateLimits/updated":
        this.emitRateLimit(params.rateLimits || {});
        return;

      case "turn/completed": {
        const turn = params.turn || {};
        if (this._turnId && turn.id && turn.id !== this._turnId) { return; }
        this._status = "ready";
        this.emit("status", this._status);
        this.emit("result", {
          type: "result",
          subtype: turn.status === "failed" ? "error" : "success",
          is_error: turn.status === "failed",
          result: turn.error?.message || "",
          duration_ms: turn.durationMs,
        } as CodexEvent);
        return;
      }

      case "error": {
        const err = params.error || {};
        const message =
          err.message || (typeof params.message === "string" ? params.message : "");
        if (params.willRetry) {
          this.emit("apiRetry", {
            attempt: 0,
            maxRetries: 0,
            delayMs: 0,
            error: message,
            status: null,
          });
          return;
        }
        this._status = "ready";
        this.emit("status", this._status);
        this.emit("result", {
          type: "result",
          subtype: "error",
          is_error: true,
          result: message,
          api_error_status: this.authStatusFor(message),
        } as CodexEvent);
        return;
      }

      case "thread/status/changed": {
        const status = params?.status?.type;
        if (status === "idle" && this._status === "busy") {
          this._status = "ready";
          this.emit("status", this._status);
        }
        return;
      }

      case "warning":
      case "configWarning":
      case "guardianWarning":
        if (typeof params.message === "string") {
          this.emit("stderr", params.message + "\n");
        }
        return;

      default:
        return;
    }
  }

  /** Codex reports quota structurally; map it onto the chat's rate-limit chip. */
  private emitRateLimit(rl: Record<string, any>): void {
    const windows = [rl.primary, rl.secondary].filter(Boolean);
    const exhausted = windows.find(
      (w: any) => typeof w?.usedPercent === "number" && w.usedPercent >= 100
    );
    this.emit("rateLimit", {
      status: exhausted || rl.rateLimitReachedType ? "rejected" : "allowed",
      rateLimitType: rl.rateLimitReachedType || rl.limitName || rl.limitId || "codex",
      isUsingOverage: rl.credits?.hasCredits === true && !!exhausted,
    });
  }

  /** 401-shaped so the provider's existing auth handling (Reconnect button,
   * account marked disconnected) fires for Codex too. */
  private authStatusFor(message: string): number | null {
    return /unauthor|not logged in|log ?in|401|credential|token (has )?expired/i.test(
      message
    )
      ? 401
      : null;
  }

  // ────────────────────────────── turn control ──────────────────────────────

  sendMessage(text: string, images?: string[]): boolean {
    if (!this.proc?.stdin || this._status === "stopped") {
      this.emit("error", "Codex CLI is not running");
      return false;
    }
    if (!this._sessionId) {
      this.emit("error", "Codex thread is not ready yet");
      return false;
    }

    this._status = "busy";
    this.emit("status", this._status);

    const input: unknown[] = [];
    for (const img of images || []) {
      // Codex takes images as data URLs or paths; the composer hands us data URLs.
      input.push({ type: "image", url: img });
    }
    input.push({ type: "text", text });

    this.request("turn/start", {
      threadId: this._sessionId,
      input,
      // turn/start takes the OBJECT form (SandboxPolicy), unlike thread/start.
      // Re-asserting it per turn keeps a resumed thread from inheriting the
      // read-only default recorded in its rollout.
      sandboxPolicy:
        this.options.mode === "plan"
          ? { type: "readOnly", networkAccess: false }
          : { type: "dangerFullAccess" },
      approvalPolicy: "never",
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
    })
      .then((res) => {
        const id = res?.turn?.id;
        if (typeof id === "string") {
          this._turnId = id;
        }
      })
      .catch((err) => {
        this._status = "ready";
        this.emit("status", this._status);
        this.emit("error", `Codex turn failed to start: ${err.message || err}`);
      });

    return true;
  }

  /** Stop the in-flight turn without killing the process. */
  interruptTurn(): void {
    if (!this._sessionId || !this._turnId) {
      return;
    }
    this.request("turn/interrupt", {
      threadId: this._sessionId,
      turnId: this._turnId,
    }).catch(() => {
      /* the turn may already be over */
    });
  }

  /** Claude's control protocol has no Codex analogue — approvals are answered
   * inline in {@link handleServerRequest}. Kept so the two bridges are
   * interchangeable from the provider's point of view. */
  sendControlResponse(_response: Record<string, unknown>): void {
    /* no-op */
  }

  stop(): void {
    const proc = this.proc;
    const rl = this.rl;
    this.proc = null;
    this.rl = null;
    this.agents.clear();
    rl?.close();
    this.rejectAllPending("bridge stopped");
    if (proc) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }
    this._status = "stopped";
    this.emit("status", this._status);
  }

  restart(options?: Partial<CodexBridgeOptions>): void {
    this.stop();
    if (options) {
      if (options.cwd) { this.cwd = options.cwd; }
      if (options.mode !== undefined) { this.options.mode = options.mode; }
      if (options.model !== undefined) { this.options.model = options.model; }
      if (options.effort !== undefined) { this.options.effort = options.effort; }
      if (options.sessionId !== undefined) { this._sessionId = options.sessionId; }
      if (options.sessionName !== undefined) { this.options.sessionName = options.sessionName; }
      // An empty string clears it → back to the ambient ~/.codex.
      if (options.configDir !== undefined) {
        this.options.configDir = options.configDir || undefined;
      }
      if (options.env !== undefined) { this.options.env = options.env; }
      if (options.luxureTools !== undefined) { this.options.luxureTools = options.luxureTools; }
      if (options.luxureServer !== undefined) { this.options.luxureServer = options.luxureServer; }
      if (options.browserServer !== undefined) { this.options.browserServer = options.browserServer; }
    }
    void this.start();
  }
}
