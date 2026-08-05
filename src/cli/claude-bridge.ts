import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { PERF, perfLog, r1 } from "../utils/perf";
import type { ContextInfo, Mode, EffortLevel } from "../shared/types";
import {
  contextTokensUsed,
  resolveContextWindow,
} from "../shared/context-window";

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

/** Normalized system:task_* event — the CLI's live reporting for subagent runs
 * (Agent tool) and background shell tasks. task_progress carries a live
 * one-line `description` ("Reading a.txt") plus usage counters; task_notification
 * fires on completion (and, for background tasks, precedes an automatic resume
 * of the conversation). Verified against CLI 2.1.197 stream-json output. */
export interface TaskUpdateEvent {
  kind: "task_started" | "task_progress" | "task_updated" | "task_notification";
  taskId?: string;
  /** tool_use id of the spawning Agent call — joins the event to its card. */
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  prompt?: string;
  status?: string;
  summary?: string;
  outputFile?: string;
  lastToolName?: string;
  usage?: { tool_uses?: number; total_tokens?: number; duration_ms?: number };
}

/** system:api_retry — emitted before each retry of a failed API request. */
export interface ApiRetryEvent {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
  status: number | null;
}

export interface ClaudeBridgeOptions {
  cwd: string;
  mode?: Mode;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  forkSession?: boolean;
  sessionName?: string;
  /** Isolated CLAUDE_CONFIG_DIR for the bound account (a full `auth login`).
   * When set, it is injected as CLAUDE_CONFIG_DIR so the spawned process
   * authenticates as that account (full scope); when unset, the process uses
   * the ambient keychain login (the "Default" account). */
  configDir?: string;
  /** Absolute path to the `claude` binary. When unset, falls back to a bare
   * "claude" PATH lookup. Callers should pass a resolved path so the spawn
   * doesn't fail with ENOENT when `claude` isn't on the GUI process PATH. */
  claudePath?: string;
  /** Per-conversation env overrides merged into the spawned child's environment.
   * This is how a worktree-backed chat gets its remapped ports / COMPOSE_PROJECT_NAME
   * (from the provisioner) so the agent — and anything it spawns, e.g. `make run` —
   * binds the right ports and namespaces its docker stack. Merged last, so it
   * wins over the inherited process env. */
  env?: Record<string, string>;
  /** Extension-provided visual-proof tools (screenshot / present / annotate):
   * `mcpConfigPath` is passed via --mcp-config so the CLI spawns the bundled
   * "luxure" MCP server, and `env` (the side-channel URL/token/bridge id) is
   * also merged into the CLI child env as a fallback for CLIs that propagate
   * their environment to stdio servers. */
  luxureTools?: { mcpConfigPath: string; env: Record<string, string> };
}

const PLAN_MODE_SYSTEM_PROMPT = `You are in PLAN MODE. You must ONLY:
1. Read and analyze files (using Read, Grep, Glob, LS tools)
2. Propose changes as a structured markdown plan
3. NEVER write, edit, or execute anything
4. NEVER use Write, Edit, Bash, or any tool that modifies files
Present your analysis and proposed changes clearly in markdown.`;

// The CLI DOES resume the conversation when a tracked background task finishes:
// it injects a task-notification and re-invokes the model (verified against CLI
// 2.1.197 — system:task_notification in stream-json, followed by a fresh turn
// with no user input). The panel renders a live progress card per task, so tell
// the model the truth and let it fan work out instead of forbidding it.
const BACKGROUND_TASKS_SYSTEM_PROMPT = `You are running inside a chat panel that tracks background work. Agents you launch with the Agent tool and background shell tasks each get a LIVE progress card in the chat (status, current action, tool/token counters), and when a background task finishes you are automatically re-invoked with a task-notification carrying its result. Therefore:
- For long or parallelizable work, freely launch agents (including run_in_background) and end your turn with a one-line status of what is running — you WILL be resumed when each task completes; report its results then.
- Only claim work is running in the background if you actually started it this turn as an Agent or background shell task; untracked promises ("I'll get back to you") are never fulfilled.
- For quick work, staying in the foreground remains simpler — don't background trivial commands.`;

// Appended when the bundled "luxure" MCP server is wired in, so the model
// knows the chat panel can display images and actually uses the tools.
const VISUAL_PROOF_SYSTEM_PROMPT = `This chat panel can display images inline. You have visual-proof tools on the "luxure" MCP server:
- mcp__luxure__capture_screen: take a screenshot (full screen, a region, or an app's front window — macOS) and show it in the chat.
- mcp__luxure__present_screenshot: display an existing image file (PNG/JPEG/WebP/GIF) in the chat panel.
- mcp__luxure__annotate_screenshot: draw arrows, boxes, highlights, labels or numbered badges onto an image file and show the result.
Use them to PROVE visual work: after implementing or fixing UI, capture (or save with a browser tool, e.g. chrome-devtools take_screenshot with a filePath) a screenshot of the result and present it in the chat; annotate it first when you want to point at what changed (percent coordinates are the most reliable). These tools show pixels to the USER; to see an image yourself, use the Read tool on its file path.`;

// Always appended so the assistant's prose renders cleanly in the chat webview.
const MARKDOWN_STYLE_SYSTEM_PROMPT = `Format every response as clean, well-structured GitHub-flavored Markdown:
- Use ## and ### headings to organize anything longer than a couple of paragraphs, and keep a blank line around headings, lists, tables, and code blocks.
- Use tables (with a header row) for comparisons or any data with two or more attributes; keep cell text terse.
- Use \`inline code\` for file paths, commands, flags, and identifiers; use fenced code blocks with a language tag for multi-line code or terminal output.
- Use "-" for bullets and "1." for ordered steps; bold only key terms. Keep paragraphs short.
- Do not wrap ordinary prose in code blocks, and do not over-nest lists.`;

function buildContextInfo(
  usage: Record<string, unknown>,
  model: string,
  reportedWindow?: number
): ContextInfo {
  const inputTokens =
    (usage.input_tokens as number) || (usage.inputTokens as number) || 0;
  const outputTokens =
    (usage.output_tokens as number) || (usage.outputTokens as number) || 0;
  const cacheReadTokens =
    (usage.cache_read_input_tokens as number) ||
    (usage.cacheReadInputTokens as number) ||
    0;
  const cacheCreationTokens =
    (usage.cache_creation_input_tokens as number) ||
    (usage.cacheCreationInputTokens as number) ||
    0;

  const used = contextTokensUsed({
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });
  const contextWindow = resolveContextWindow(model, reportedWindow, used);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextWindow,
    model,
  };
}

/**
 * Tool results from MCP servers (and agent/Task tools) arrive as an ARRAY of
 * content blocks, not a plain string — native tools usually return a string.
 * Flatten either form to displayable text: keep text blocks verbatim, inline an
 * embedded resource's text, and leave a short marker for binary/link blocks.
 * Unknown block types (e.g. Claude Code's "tool_reference") are skipped.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, any>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") {
          parts.push(b.text);
        }
        break;
      case "image":
        parts.push(`[image: ${b.mimeType || "image"}]`);
        break;
      case "audio":
        parts.push(`[audio: ${b.mimeType || "audio"}]`);
        break;
      case "resource_link":
        parts.push(`[resource link: ${b.name || b.uri || ""}]`);
        break;
      case "resource": {
        const r = b.resource || {};
        parts.push(typeof r.text === "string" ? r.text : `[resource: ${r.uri || ""}]`);
        break;
      }
      // tool_reference and any unknown block types: skip
    }
  }
  return parts.join("\n");
}

// Keep persisted per-message state bounded: at most 3 images per tool result,
// each at most ~4MB of base64 (~3MB binary — a full-page retina screenshot).
const MAX_RESULT_IMAGES = 3;
const MAX_RESULT_IMAGE_B64 = 4_000_000;

/**
 * Collect the image blocks of a tool result as data URLs so the webview can
 * render the actual screenshot. Handles both the MCP shape
 * ({type:"image", data, mimeType}) and the Claude API shape
 * ({type:"image", source:{type:"base64", media_type, data}}).
 */
function extractToolResultImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, any>;
    if (b.type !== "image") {
      continue;
    }
    let data: string | undefined;
    let mime: string | undefined;
    if (typeof b.data === "string" && b.data) {
      data = b.data;
      mime = b.mimeType || b.mime_type;
    } else if (
      b.source?.type === "base64" &&
      typeof b.source.data === "string"
    ) {
      data = b.source.data;
      mime = b.source.media_type;
    }
    if (!data || data.length > MAX_RESULT_IMAGE_B64) {
      continue;
    }
    images.push(`data:${mime || "image/png"};base64,${data}`);
    if (images.length >= MAX_RESULT_IMAGES) {
      break;
    }
  }
  return images.length > 0 ? images : undefined;
}

export class ClaudeBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _status: "starting" | "ready" | "busy" | "error" | "stopped" = "stopped";
  private _sessionId: string | undefined;
  private _lastContextWindow = 200000;
  private _lastModel = "";
  private cwd: string;

  get status() {
    return this._status;
  }

  /** True when a live CLI process is attached (stdin writable). Callers
   * deciding whether to (re)spawn must check this, not just status — late
   * events from a previous process generation can leave status stale. */
  get isAlive(): boolean {
    return !!this.proc?.stdin;
  }

  get sessionId() {
    return this._sessionId;
  }

  constructor(private options: ClaudeBridgeOptions) {
    super();
    this.cwd = options.cwd;
    this._sessionId = options.sessionId;
  }

  async start(): Promise<void> {
    if (this.proc) {
      this.stop();
    }

    this._status = "starting";
    this.emit("status", this._status);

    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];

    if (this._sessionId) {
      args.push("--resume", this._sessionId);
      if (this.options.forkSession) {
        args.push("--fork-session");
      }
    }

    if (this.options.sessionName) {
      args.push("--name", this.options.sessionName);
    }

    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    if (this.options.effort) {
      args.push("--effort", this.options.effort);
    }

    // Combine into a single --append-system-prompt; the markdown styling is
    // always on, with the plan-mode constraints layered in when relevant.
    const systemPromptParts = [
      MARKDOWN_STYLE_SYSTEM_PROMPT,
      BACKGROUND_TASKS_SYSTEM_PROMPT,
    ];
    if (this.options.mode === "plan") {
      systemPromptParts.push(PLAN_MODE_SYSTEM_PROMPT);
      args.push(
        "--allowedTools",
        "Read,Grep,Glob,LS,View,BatchTool"
      );
    }
    // Visual-proof tools: register the bundled MCP server (additive — the
    // workspace .mcp.json still loads) and tell the model the panel can
    // display images. Skipped in plan mode, whose allowlist is read-only.
    if (this.options.luxureTools && this.options.mode !== "plan") {
      args.push("--mcp-config", this.options.luxureTools.mcpConfigPath);
      systemPromptParts.push(VISUAL_PROOF_SYSTEM_PROMPT);
    }
    args.push("--append-system-prompt", systemPromptParts.join("\n\n"));

    // Build the child env with the bound account's auth. A non-default account
    // gets its own CLAUDE_CONFIG_DIR (isolated full login); we also strip any
    // ambient token/API key so that config dir's login is authoritative. The
    // Default account uses the ambient keychain (clear only an inherited token).
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.configDir) {
      childEnv.CLAUDE_CONFIG_DIR = this.options.configDir;
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_AUTH_TOKEN;
    } else {
      delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    }
    // Side-channel coordinates for the luxure MCP server (fallback path; the
    // authoritative copy lives in the mcp-config's own env block).
    if (this.options.luxureTools) {
      Object.assign(childEnv, this.options.luxureTools.env);
    }
    // Per-conversation env (worktree port remap / COMPOSE_PROJECT_NAME) wins last.
    if (this.options.env) {
      Object.assign(childEnv, this.options.env);
    }

    let spawned: ChildProcess;
    try {
      spawned = spawn(this.options.claudePath || "claude", args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err) {
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Failed to spawn claude CLI: ${err}`);
      return;
    }
    this.proc = spawned;
    // Generation guard: each listener below belongs to THIS spawn. After a
    // restart, the old process's late events (its exit firing after the
    // replacement was assigned, buffered stdout) must not touch the bridge —
    // an unguarded exit handler nulls the NEW proc, wedging the session with
    // status "ready" but nothing to write to, and leaking the live process.
    const owned = () => this.proc === spawned;

    spawned.on("error", (err) => {
      if (!owned()) {
        return;
      }
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Claude CLI error: ${err.message}`);
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

    this._status = "ready";
    this.emit("status", this._status);
  }

  private parseLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: ClaudeEvent;
    // A multi-MB stream line (usually a tool result carrying images) parses
    // synchronously on the extension host — a prime lag suspect, since it
    // stalls every conversation's UI at once.
    const bigLine = PERF && trimmed.length >= 200_000;
    const parseT0 = bigLine ? performance.now() : 0;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.emit("rawOutput", trimmed);
      return;
    }
    if (bigLine) {
      perfLog("bridge.bigLine", {
        kb: Math.round(trimmed.length / 1024),
        type: `${event.type}${event.subtype ? ":" + event.subtype : ""}`,
        parseMs: r1(performance.now() - parseT0),
      });
    }

    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id) {
        this._sessionId = event.session_id as string;
      }
      const initModel = (event as { model?: string }).model;
      if (initModel) {
        this._lastModel = initModel;
        this._lastContextWindow = resolveContextWindow(initModel);
      }
      const slashCommands = (event as any).slash_commands;
      if (Array.isArray(slashCommands)) {
        this.emit("slashCommands", slashCommands as string[]);
      }
      this._status = "ready";
      this.emit("status", this._status);
    }

    if (event.type === "system" && event.subtype === "compact_boundary") {
      this.emit("compactBoundary", event);
    }

    // Live subagent / background-task reporting. task_progress fires on every
    // tool call inside the agent with a one-line summary + usage counters;
    // task_notification fires on completion (for background tasks the CLI then
    // resumes the conversation on its own — a turn with no user input).
    if (
      event.type === "system" &&
      (event.subtype === "task_started" ||
        event.subtype === "task_progress" ||
        event.subtype === "task_updated" ||
        event.subtype === "task_notification")
    ) {
      const ev = event as Record<string, any>;
      const patch = (ev.patch || {}) as Record<string, unknown>;
      const update: TaskUpdateEvent = {
        kind: event.subtype,
        taskId: typeof ev.task_id === "string" ? ev.task_id : undefined,
        toolUseId: typeof ev.tool_use_id === "string" ? ev.tool_use_id : undefined,
        description: typeof ev.description === "string" ? ev.description : undefined,
        subagentType: typeof ev.subagent_type === "string" ? ev.subagent_type : undefined,
        taskType: typeof ev.task_type === "string" ? ev.task_type : undefined,
        prompt: typeof ev.prompt === "string" ? ev.prompt : undefined,
        status:
          typeof ev.status === "string"
            ? ev.status
            : typeof patch.status === "string"
              ? (patch.status as string)
              : undefined,
        summary: typeof ev.summary === "string" ? ev.summary : undefined,
        outputFile: typeof ev.output_file === "string" ? ev.output_file : undefined,
        lastToolName: typeof ev.last_tool_name === "string" ? ev.last_tool_name : undefined,
        usage:
          ev.usage && typeof ev.usage === "object"
            ? (ev.usage as TaskUpdateEvent["usage"])
            : undefined,
      };
      this.emit("taskUpdate", update);
    }

    // Live thinking-token counter while the model reasons (before any output).
    if (event.type === "system" && event.subtype === "thinking_tokens") {
      this.emit("thinkingTokens", {
        tokens: (event as any).estimated_tokens as number || 0,
      });
    }

    // Emitted before each retry of a failed API request — surfaces "why is
    // nothing happening" (overloaded / rate_limit / server_error) to the UI.
    if (event.type === "system" && event.subtype === "api_retry") {
      const ev = event as Record<string, any>;
      const retry: ApiRetryEvent = {
        attempt: (ev.attempt as number) || 0,
        maxRetries: (ev.max_retries as number) || 0,
        delayMs: (ev.retry_delay_ms as number) || 0,
        error: typeof ev.error === "string" ? ev.error : "",
        status: typeof ev.error_status === "number" ? ev.error_status : null,
      };
      this.emit("apiRetry", retry);
    }

    if (event.type === "rate_limit_event") {
      this.emit("rateLimit", ((event as any).rate_limit_info as Record<string, unknown>) || {});
    }

    if (event.type === "result") {
      this._status = "ready";
      this.emit("status", this._status);
      this.emit("result", event);

      // result.modelUsage is CUMULATIVE across every tool-use round-trip in the
      // turn — each round re-reads the cached context, so the cache-token counts
      // sum up. Feeding that into the context % overstates live occupancy and
      // spikes the bar to ~100% at end-of-turn (it snaps back on the next turn
      // when a fresh stream_event reports the real per-request usage). So use it
      // ONLY to refresh the model + window denominator for the next turn; the
      // live context % comes from the stream_event usage handled below.
      const modelUsage = (event as any).modelUsage;
      if (modelUsage && typeof modelUsage === "object") {
        const models = Object.keys(modelUsage);
        const primary = models.find(m => !m.includes("haiku")) || models[0];
        if (primary && modelUsage[primary]) {
          this._lastModel = primary;
          this._lastContextWindow = resolveContextWindow(
            primary,
            modelUsage[primary].contextWindow
          );
        }
      }
    }

    if (event.type === "assistant") {
      this.emit("assistant", event);

      // Set when this message was produced INSIDE a subagent (the id of the
      // Agent call that spawned it) — those activities nest under the task
      // card, and the subagent's prose must never leak into the main answer.
      const parentToolUseId =
        typeof (event as any).parent_tool_use_id === "string"
          ? ((event as any).parent_tool_use_id as string)
          : undefined;

      const message = (event as any).message;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === "text" && block.text && !parentToolUseId) {
            this.emit("assistantText", block.text);
          }
          if (block.type === "tool_use") {
            this.emit("activity", {
              type: "tool_use",
              toolName: block.name as string,
              toolInput: block.input as Record<string, unknown>,
              toolUseId: block.id as string,
              parentToolUseId,
            });
          }
          if (block.type === "thinking") {
            this.emit("activity", {
              type: "thinking",
              text: (block.thinking as string) || "",
              parentToolUseId,
            });
          }
        }
      }
    }

    if (event.type === "tool_result" || (event.type === "user" && (event as any).message?.content)) {
      const parentToolUseId =
        typeof (event as any).parent_tool_use_id === "string"
          ? ((event as any).parent_tool_use_id as string)
          : undefined;
      const content = (event as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            this.emit("activity", {
              type: "tool_result",
              toolUseId: block.tool_use_id,
              // MCP results are arrays of content blocks; flatten to text and
              // cap to keep persisted state bounded (the card shows full text).
              content: extractToolResultText(block.content).slice(0, 10000),
              isError: block.is_error === true,
              // Image blocks (e.g. a browser screenshot) ride along as data
              // URLs so the chat renders the pixels, not a text marker.
              images: extractToolResultImages(block.content),
              parentToolUseId,
            });
          }
        }
      }
    }

    if (event.type === "stream_event") {
      const ev = (event as any).event;
      const delta = ev?.delta;

      const streamUsage =
        (ev?.message as { usage?: Record<string, unknown>; model?: string })
          ?.usage || (ev?.usage as Record<string, unknown> | undefined);
      if (streamUsage) {
        const model =
          (ev?.message as { model?: string })?.model || this._lastModel;
        if (model) {
          this._lastModel = model;
        }
        const ctx = buildContextInfo(
          streamUsage,
          model || this._lastModel || "opus",
          this._lastContextWindow
        );
        this._lastContextWindow = ctx.contextWindow;
        this.emit("contextUpdate", ctx);
      }

      if (delta?.type === "text_delta" && delta.text) {
        this.emit("textDelta", delta.text);
      }
      if (delta?.type === "thinking_delta" && delta.thinking) {
        this.emit("activity", {
          type: "thinking_delta",
          text: delta.thinking as string,
        });
      }
      if (ev?.type === "content_block_start" && ev?.content_block?.type === "tool_use") {
        this.emit("activity", {
          type: "tool_use",
          toolName: ev.content_block.name as string,
          toolInput: ev.content_block.input || {},
          toolUseId: ev.content_block.id as string,
        });
      }
      this.emit("streamEvent", event);
    }

    if (event.type === "control_request" || event.type === "control") {
      this.emit("controlRequest", event);
    }

    this.emit("event", event);
  }

  /** Write a user turn to the CLI. Returns false when there is no live
   * process to write to — the caller must not treat the turn as started. */
  sendMessage(text: string, images?: string[]): boolean {
    if (!this.proc?.stdin || this._status === "stopped") {
      this.emit("error", "Claude CLI is not running");
      return false;
    }

    this._status = "busy";
    this.emit("status", this._status);

    let content: unknown;

    if (images && images.length > 0) {
      const blocks: unknown[] = [];
      for (const img of images) {
        const match = img.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: `image/${match[1]}`,
              data: match[2],
            },
          });
        }
      }
      blocks.push({ type: "text", text });
      content = blocks;
    } else {
      content = text;
    }

    const message = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    this.proc.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  sendControlResponse(response: Record<string, unknown>): void {
    if (!this.proc?.stdin) {
      return;
    }
    this.proc.stdin.write(JSON.stringify(response) + "\n");
  }

  stop(): void {
    // Disown before killing: restart() spawns a replacement immediately, so
    // by the time this process's exit event (or the escalation timer) fires,
    // this.proc may already be the new, healthy CLI. Everything below must
    // act on the captured handle only.
    const proc = this.proc;
    const rl = this.rl;
    this.proc = null;
    this.rl = null;
    rl?.close();
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

  restart(options?: Partial<ClaudeBridgeOptions>): void {
    this.stop();
    if (options) {
      if (options.cwd) { this.cwd = options.cwd; }
      if (options.mode !== undefined) { this.options.mode = options.mode; }
      if (options.model !== undefined) { this.options.model = options.model; }
      if (options.effort !== undefined) { this.options.effort = options.effort; }
      if (options.sessionId !== undefined) { this._sessionId = options.sessionId; }
      if (options.forkSession !== undefined) { this.options.forkSession = options.forkSession; }
      if (options.sessionName !== undefined) { this.options.sessionName = options.sessionName; }
      // An empty string clears it → switch back to the Default account.
      if (options.configDir !== undefined) { this.options.configDir = options.configDir; }
      if (options.env !== undefined) { this.options.env = options.env; }
      if (options.luxureTools !== undefined) { this.options.luxureTools = options.luxureTools; }
    }
    this.start();
  }
}
