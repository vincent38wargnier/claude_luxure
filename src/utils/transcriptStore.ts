import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./logger";
import type { ChatMessage } from "../shared/types";

const MESSAGES_KEY_PREFIX = "claude-luxure.messages.";
/** Transcripts here are a render cache (the real session lives in
 * ~/.claude/projects) — cap what one file can grow to after years of use. */
const MAX_PERSISTED_MESSAGES = 400;
const SAVE_DEBOUNCE_MS = 1000;
const PRUNE_AFTER_DAYS = 90;

/** Per-session transcript persistence as individual JSON files under the
 * extension's storage dir.
 *
 * Transcripts must NOT live in workspaceState: VS Code stores an extension's
 * entire memento as ONE sqlite row that the main process keeps in its V8 heap
 * and re-serializes wholesale on every update. Accumulated sessions (with
 * base64 image attachments and full activity timelines) grew that row to
 * hundreds of MB per workspace and OOM-crashed the main process. Files scale:
 * only opened sessions are read, and a save rewrites one session, not all. */
export class TranscriptStore {
  private readonly dir: string;
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; messages: ChatMessage[] }
  >();

  constructor(context: vscode.ExtensionContext) {
    const base =
      context.storageUri?.fsPath ??
      path.join(context.globalStorageUri.fsPath, "no-workspace");
    this.dir = path.join(base, "transcripts");
  }

  private fileFor(sessionId: string): string {
    return path.join(this.dir, sessionId.replace(/[^\w.-]/g, "_") + ".json");
  }

  load(sessionId: string): ChatMessage[] | undefined {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), "utf8");
      const parsed = JSON.parse(raw) as ChatMessage[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined; // no file yet, or unreadable — caller falls back
    }
  }

  /** Debounced per session: streaming finalizes and task ticks can persist
   * several times in a burst; only the last snapshot within the window hits
   * disk. Writes go through a temp file + rename so a crash mid-write can't
   * truncate an existing transcript. */
  save(sessionId: string, messages: ChatMessage[]): void {
    const existing = this.pending.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    this.pending.set(sessionId, {
      messages,
      timer: setTimeout(() => {
        this.pending.delete(sessionId);
        this.writeNow(sessionId, messages);
      }, SAVE_DEBOUNCE_MS),
    });
  }

  private writeNow(sessionId: string, messages: ChatMessage[]): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(sessionId);
      const tmp = file + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES))
      );
      fs.renameSync(tmp, file);
    } catch (err) {
      log("ERROR", `Transcript save failed for ${sessionId}`, err);
    }
  }

  /** Deactivation path: run every debounced save now, synchronously — the
   * timers won't fire once the extension host is gone. persistRuntime() has
   * already queued the final snapshots by the time dispose calls this. */
  flushAll(): void {
    for (const [sessionId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.writeNow(sessionId, entry.messages);
    }
    this.pending.clear();
  }

  /** One-time move of transcripts out of workspaceState. Deleting each key
   * shrinks the extension's memento row in state.vscdb, which is what stops
   * the main-process heap bloat — without this, existing installs keep
   * crashing no matter what new saves do. Sequential on purpose: one
   * stringify's transient memory at a time. */
  async migrateFromMemento(memento: vscode.Memento): Promise<void> {
    const keys = memento
      .keys()
      .filter((k) => k.startsWith(MESSAGES_KEY_PREFIX));
    if (keys.length === 0) {
      return;
    }
    let moved = 0;
    for (const key of keys) {
      try {
        const sessionId = key.slice(MESSAGES_KEY_PREFIX.length);
        const messages = memento.get<ChatMessage[]>(key);
        if (
          Array.isArray(messages) &&
          messages.length > 0 &&
          !fs.existsSync(this.fileFor(sessionId))
        ) {
          this.writeNow(sessionId, messages);
        }
        await memento.update(key, undefined);
        moved++;
      } catch (err) {
        log("ERROR", `Transcript migration failed for ${key}`, err);
      }
    }
    log(
      "INFO",
      `Migrated ${moved}/${keys.length} session transcripts from workspaceState to ${this.dir}`
    );
  }

  /** Sessions untouched for months are stale render caches — drop the files.
   * mtime refreshes on every save, so anything actively used survives. */
  prune(): void {
    fs.readdir(this.dir, (err, names) => {
      if (err) {
        return; // dir not created yet
      }
      const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      let dropped = 0;
      for (const name of names) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const file = path.join(this.dir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file);
            dropped++;
          }
        } catch {
          // raced with a save/delete — skip
        }
      }
      if (dropped > 0) {
        log("INFO", `Pruned ${dropped} transcript(s) older than ${PRUNE_AFTER_DAYS} days`);
      }
    });
  }
}
