import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { log } from "./logger";
import { perfLog } from "./perf";
import type { PromptHistoryEntry } from "../shared/types";

/** Corpus cap pushed to the webview — ranked by recency, so the tail that
 * falls off is years-old prompts nobody will re-type. */
const MAX_ENTRIES = 3000;
/** Longer texts are pasted documents/specs, not reusable phrases. */
const MAX_PHRASE_CHARS = 1500;
const MIN_PHRASE_CHARS = 8;
/** Lines beyond this are almost always base64 image attachments — skip them
 * before JSON.parse instead of materializing megabytes per line. */
const MAX_LINE_CHARS = 512 * 1024;
const CACHE_TTL_MS = 60_000;

interface CacheSlot {
  entries: PromptHistoryEntry[];
  scannedAt: number;
}

const cache = new Map<string, CacheSlot>();

function sessionsDirFor(workspacePath: string): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  // Same normalization the Claude CLI uses for transcript dirs (see
  // SessionManager.getProjectSlug): every non-alphanumeric char becomes "-".
  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configDir, "projects", slug);
}

/** True for user-authored prompt text; false for the synthetic user turns a
 * transcript is full of (command wrappers, system reminders, tool results,
 * compact continuations, interrupt markers). */
function isReusablePrompt(text: string): boolean {
  if (text.length < MIN_PHRASE_CHARS || text.length > MAX_PHRASE_CHARS) {
    return false;
  }
  if (text.startsWith("<")) {
    return false; // <command-name>, <local-command-stdout>, <system-reminder>…
  }
  if (text.startsWith("[Request interrupted")) {
    return false;
  }
  if (text.startsWith("Caveat: the messages below")) {
    return false;
  }
  if (text.startsWith("This session is being continued from")) {
    return false; // compact/resume summaries are model-written, not the user's
  }
  return true;
}

/** Text of a user entry: plain string content, or its text blocks joined.
 * Entries whose content is only tool_result blocks yield "". */
function userText(message: { content?: unknown }): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && (b as { type?: string }).type === "text"
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function scanFile(
  filePath: string,
  fallbackMtime: number,
  byNorm: Map<string, PromptHistoryEntry>
): Promise<void> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      // Cheap prefilter: skip assistant/system lines (and giant image lines)
      // without paying for JSON.parse.
      if (line.length > MAX_LINE_CHARS || !line.includes('"type":"user"')) {
        return;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "user" || entry.isSidechain || entry.isMeta) {
          return; // sidechain user turns are agent prompts written by the model
        }
        const text = userText(entry.message)?.trim();
        if (!text || !isReusablePrompt(text)) {
          return;
        }
        const norm = text.toLowerCase().replace(/\s+/g, " ");
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        const lastUsed = Number.isFinite(ts) ? ts : fallbackMtime;
        const existing = byNorm.get(norm);
        if (existing) {
          existing.count++;
          if (lastUsed > existing.lastUsed) {
            existing.lastUsed = lastUsed;
            existing.text = text; // keep the most recent casing/spacing
          }
        } else {
          byNorm.set(norm, { text, count: 1, lastUsed });
        }
      } catch {
        // malformed line — skip
      }
    });

    rl.on("close", resolve);
    rl.on("error", () => resolve(undefined));
  });
}

/** Every prompt the user ever sent in this project, deduped, most recent
 * first. Scans the project's real CLI transcripts (~/.claude/projects/<slug>)
 * and caches briefly — the webview asks once per load, not per keystroke. */
export async function loadPromptHistory(
  workspacePath: string
): Promise<PromptHistoryEntry[]> {
  const dir = sessionsDirFor(workspacePath);
  const cached = cache.get(dir);
  if (cached && Date.now() - cached.scannedAt < CACHE_TTL_MS) {
    return cached.entries;
  }

  const t0 = Date.now();
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));
  } catch {
    return []; // project has no transcripts yet
  }

  const byNorm = new Map<string, PromptHistoryEntry>();
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      await scanFile(filePath, mtime, byNorm);
    } catch (err) {
      log("WARN", `prompt history: failed to scan ${file}:`, String(err));
    }
  }

  const entries = [...byNorm.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_ENTRIES);

  cache.set(dir, { entries, scannedAt: Date.now() });
  perfLog("promptHistory.scan", {
    files: files.length,
    unique: byNorm.size,
    kept: entries.length,
    ms: Date.now() - t0,
  });
  return entries;
}
