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
  return "-" + workspacePath.replace(/\//g, "-").replace(/^-/, "");
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

  async getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; timestamp: string }>> {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const messages: Array<{ role: string; content: string; timestamp: string }> = [];

      rl.on("line", (line) => {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "user" && entry.message?.content) {
            const content = typeof entry.message.content === "string"
              ? entry.message.content
              : JSON.stringify(entry.message.content);
            messages.push({ role: "user", content, timestamp: entry.timestamp || "" });
          }
          if (entry.type === "assistant" && entry.message?.content) {
            let text = "";
            if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === "text" && block.text) {
                  text += block.text;
                }
              }
            } else if (typeof entry.message.content === "string") {
              text = entry.message.content;
            }
            if (text) {
              messages.push({ role: "assistant", content: text, timestamp: entry.timestamp || "" });
            }
          }
        } catch {
          // Skip
        }
      });

      rl.on("close", () => resolve(messages));
      rl.on("error", () => resolve([]));
    });
  }
}
