import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
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

export interface ClaudeBridgeOptions {
  cwd: string;
  mode?: Mode;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  forkSession?: boolean;
  sessionName?: string;
}

const PLAN_MODE_SYSTEM_PROMPT = `You are in PLAN MODE. You must ONLY:
1. Read and analyze files (using Read, Grep, Glob, LS tools)
2. Propose changes as a structured markdown plan
3. NEVER write, edit, or execute anything
4. NEVER use Write, Edit, Bash, or any tool that modifies files
Present your analysis and proposed changes clearly in markdown.`;

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
    const systemPromptParts = [MARKDOWN_STYLE_SYSTEM_PROMPT];
    if (this.options.mode === "plan") {
      systemPromptParts.push(PLAN_MODE_SYSTEM_PROMPT);
      args.push(
        "--allowedTools",
        "Read,Grep,Glob,LS,View,BatchTool"
      );
    }
    args.push("--append-system-prompt", systemPromptParts.join("\n\n"));

    try {
      this.proc = spawn("claude", args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Failed to spawn claude CLI: ${err}`);
      return;
    }

    this.proc.on("error", (err) => {
      this._status = "error";
      this.emit("status", this._status);
      this.emit("error", `Claude CLI error: ${err.message}`);
    });

    this.proc.on("exit", (code, signal) => {
      this._status = "stopped";
      this.emit("status", this._status);
      this.emit("exit", { code, signal });
      this.proc = null;
      this.rl = null;
    });

    if (this.proc.stderr) {
      this.proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        if (text.trim()) {
          this.emit("stderr", text);
        }
      });
    }

    if (this.proc.stdout) {
      this.rl = readline.createInterface({
        input: this.proc.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line: string) => {
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
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.emit("rawOutput", trimmed);
      return;
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

      const message = (event as any).message;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            this.emit("assistantText", block.text);
          }
          if (block.type === "tool_use") {
            this.emit("activity", {
              type: "tool_use",
              toolName: block.name as string,
              toolInput: block.input as Record<string, unknown>,
              toolUseId: block.id as string,
            });
          }
          if (block.type === "thinking") {
            this.emit("activity", {
              type: "thinking",
              text: (block.thinking as string) || "",
            });
          }
        }
      }
    }

    if (event.type === "tool_result" || (event.type === "user" && (event as any).message?.content)) {
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

  sendMessage(text: string, images?: string[]): void {
    if (!this.proc?.stdin || this._status === "stopped") {
      this.emit("error", "Claude CLI is not running");
      return;
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
  }

  sendControlResponse(response: Record<string, unknown>): void {
    if (!this.proc?.stdin) {
      return;
    }
    this.proc.stdin.write(JSON.stringify(response) + "\n");
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc) {
          this.proc.kill("SIGKILL");
        }
      }, 5000);
    }
    this._status = "stopped";
    this.emit("status", this._status);
    this.proc = null;
    this.rl = null;
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
    }
    this.start();
  }
}
