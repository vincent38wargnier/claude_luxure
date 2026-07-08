import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { log } from "../utils/logger";

export interface SessionSummary {
  id: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
  modifiedAt: number;
}

function getProjectSlug(workspacePath: string): string {
  // Match the Claude CLI's own normalization: every non-alphanumeric character
  // (including "/", ".", "_") collapses to "-". Replacing only "/" breaks for
  // paths like ".../magify.fun/code/claude_luxure", whose real transcript dir is
  // "-Users-...-magify-fun-code-claude-luxure".
  return workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
}

function getSessionsDir(workspacePath: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(require("os").homedir(), ".claude");
  return path.join(configDir, "projects", getProjectSlug(workspacePath));
}

export class SessionManager {
  private sessionsDir: string;

  constructor(private workspacePath: string) {
    this.sessionsDir = getSessionsDir(workspacePath);
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.sessionsDir).filter(
      (f) => f.endsWith(".jsonl") && !f.startsWith(".")
    );

    const sessions: SessionSummary[] = [];

    for (const file of files) {
      const filePath = path.join(this.sessionsDir, file);
      try {
        const summary = await this.parseSessionFile(filePath);
        if (summary) {
          sessions.push(summary);
        }
      } catch (err) {
        log("WARN", `Failed to parse session ${file}:`, String(err));
      }
    }

    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return sessions;
  }

  private async parseSessionFile(filePath: string): Promise<SessionSummary | null> {
    const stat = fs.statSync(filePath);
    const sessionId = path.basename(filePath, ".jsonl");

    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let firstUserMessage = "";
      let timestamp = "";
      let messageCount = 0;

      rl.on("line", (line) => {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "user" && entry.message?.content) {
            messageCount++;
            if (!firstUserMessage) {
              const content = typeof entry.message.content === "string"
                ? entry.message.content
                : JSON.stringify(entry.message.content);
              firstUserMessage = content.slice(0, 120);
              timestamp = entry.timestamp || "";
            }
          }
          if (entry.type === "assistant") {
            messageCount++;
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on("close", () => {
        if (!firstUserMessage) {
          resolve(null);
          return;
        }
        resolve({
          id: sessionId,
          firstMessage: firstUserMessage,
          timestamp,
          messageCount,
          modifiedAt: stat.mtimeMs,
        });
      });

      rl.on("error", () => resolve(null));
    });
  }

  /** mtime of a session's transcript, or null when it doesn't exist — the
   * "last activity" proxy for conversations that predate lastReplyAt
   * persistence (or whose transcript lives in another config dir). */
  transcriptMtime(sessionId: string): number | null {
    try {
      return fs.statSync(path.join(this.sessionsDir, `${sessionId}.jsonl`)).mtimeMs;
    } catch {
      return null;
    }
  }

  async getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; timestamp: string }>> {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const messages: Array<{ role: string; content: string; timestamp: string }> = [];
      let lastAssistantText = "";

      rl.on("line", (line) => {
        try {
          const entry = JSON.parse(line);

          if (entry.type === "user" && entry.message?.content) {
            if (typeof entry.message.content === "string") {
              messages.push({ role: "user", content: entry.message.content, timestamp: entry.timestamp || "" });
            } else if (Array.isArray(entry.message.content)) {
              const textParts = entry.message.content
                .filter((b: any) => b.type === "text" && b.text)
                .map((b: any) => b.text);
              if (textParts.length > 0) {
                messages.push({ role: "user", content: textParts.join("\n"), timestamp: entry.timestamp || "" });
              }
            }
          }

          if (entry.type === "assistant" && entry.message?.content) {
            let text = "";
            const toolCalls: string[] = [];

            if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === "text" && block.text) {
                  text += block.text;
                }
                if (block.type === "tool_use") {
                  const name = block.name as string;
                  const input = block.input as Record<string, unknown>;
                  toolCalls.push(this.formatToolCall(name, input));
                }
              }
            } else if (typeof entry.message.content === "string") {
              text = entry.message.content;
            }

            if (text && text !== lastAssistantText) {
              lastAssistantText = text;
              let content = text;
              if (toolCalls.length > 0) {
                content = toolCalls.join("\n") + "\n\n" + text;
              }
              messages.push({ role: "assistant", content, timestamp: entry.timestamp || "" });
            } else if (!text && toolCalls.length > 0) {
              messages.push({ role: "assistant", content: toolCalls.join("\n"), timestamp: entry.timestamp || "" });
            }
          }
        } catch {
          // Skip
        }
      });

      rl.on("close", () => {
        const deduped = this.deduplicateMessages(messages);
        resolve(deduped);
      });
      rl.on("error", () => resolve([]));
    });
  }

  private formatToolCall(name: string, input: Record<string, unknown>): string {
    const filePath = (input.file_path || input.path || "") as string;
    const shortPath = filePath.split("/").slice(-2).join("/");
    if (name === "Read" || name === "read_file") return `> Read \`${shortPath}\``;
    if (name === "Write" || name === "write_to_file" || name === "WriteToFile") return `> Wrote \`${shortPath}\``;
    if (name === "Edit" || name === "edit_file" || name === "EditFile") return `> Edited \`${shortPath}\``;
    if (name === "Bash" || name === "bash") return `> Ran \`${String(input.command || "").slice(0, 80)}\``;
    if (name === "Grep" || name === "grep") return `> Searched for \`${input.pattern || ""}\``;
    if (name === "Glob" || name === "glob") return `> Found files matching \`${input.pattern || input.glob_pattern || ""}\``;
    if (name === "LS" || name === "ls") return `> Listed \`${input.path || input.directory || "."}\``;
    return `> Used \`${name}\``;
  }

  private deduplicateMessages(messages: Array<{ role: string; content: string; timestamp: string }>): Array<{ role: string; content: string; timestamp: string }> {
    const result: typeof messages = [];
    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && last.content === msg.content) continue;
      if (last && last.role === msg.role && msg.role === "assistant" && msg.content.includes(last.content)) {
        result[result.length - 1] = msg;
        continue;
      }
      result.push(msg);
    }
    return result;
  }
}
