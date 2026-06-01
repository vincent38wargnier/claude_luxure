import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import type { Mode, EffortLevel } from "../shared/types";

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

export class ClaudeBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _status: "starting" | "ready" | "busy" | "error" | "stopped" = "stopped";
  private _sessionId: string | undefined;
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

    if (this.options.mode === "plan") {
      args.push("--append-system-prompt", PLAN_MODE_SYSTEM_PROMPT);
      args.push(
        "--allowedTools",
        "Read,Grep,Glob,LS,View,BatchTool"
      );
    }

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
      this._status = "ready";
      this.emit("status", this._status);
    }

    if (event.type === "result") {
      this._status = "ready";
      this.emit("status", this._status);
      this.emit("result", event);

      const modelUsage = (event as any).modelUsage;
      if (modelUsage && typeof modelUsage === "object") {
        const models = Object.keys(modelUsage);
        const primary = models.find(m => !m.includes("haiku")) || models[0];
        if (primary && modelUsage[primary]) {
          const mu = modelUsage[primary];
          this.emit("contextUpdate", {
            inputTokens: mu.inputTokens || 0,
            outputTokens: mu.outputTokens || 0,
            cacheReadTokens: mu.cacheReadInputTokens || 0,
            cacheCreationTokens: mu.cacheCreationInputTokens || 0,
            contextWindow: mu.contextWindow || 200000,
            model: primary,
          });
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
              content: typeof block.content === "string" ? block.content?.slice(0, 200) : "",
            });
          }
        }
      }
    }

    if (event.type === "stream_event") {
      const ev = (event as any).event;
      const delta = ev?.delta;
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
