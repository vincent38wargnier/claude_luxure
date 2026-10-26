import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import type { OrbStyle, VoiceStatus } from "../shared/types";
import { log } from "../utils/logger";
import { cleanForSpeech } from "./textClean";
import { rephraseSystemPrompt, rephraseUserPrompt, type Brevity } from "./rephrase";

/** Runs a headless Haiku one-shot (system + user prompt) under an account. */
export type RephraseFn = (
  system: string,
  user: string,
  accountId?: string
) => Promise<string>;

const CONFIG = "claude-luxure.voice";
const SECRET_KEY = "claude-luxure.elevenlabsApiKey";
const CACHE_LIMIT = 50;
// A reply longer than this is truncated before TTS — the rephrase normally
// keeps speech short, but with rephrase off a huge reply shouldn't drone on.
const MAX_SPOKEN_CHARS = 6000;

interface CacheEntry {
  spoken: string;
  mp3?: string;
}

interface VoiceConfig {
  enabled: boolean;
  backend: "say" | "elevenlabs";
  sayVoice: string;
  sayRate: number;
  elevenlabsVoiceId: string;
  elevenlabsModel: string;
  elevenlabsSpeed: number;
  rephrase: boolean;
  rephraseThreshold: number;
  brevity: Brevity;
  orbStyle: OrbStyle;
}

function readConfig(): VoiceConfig {
  const c = vscode.workspace.getConfiguration(CONFIG);
  return {
    enabled: c.get<boolean>("enabled", false),
    backend: c.get<"say" | "elevenlabs">("backend", "say"),
    sayVoice: c.get<string>("sayVoice", "Samantha"),
    sayRate: c.get<number>("sayRate", 200),
    elevenlabsVoiceId: c.get<string>("elevenlabsVoiceId", "pNInz6obpgDQGcFmaJgB"),
    elevenlabsModel: c.get<string>("elevenlabsModel", "eleven_flash_v2_5"),
    elevenlabsSpeed: c.get<number>("elevenlabsSpeed", 0.9),
    rephrase: c.get<boolean>("rephrase", true),
    rephraseThreshold: c.get<number>("rephraseThreshold", 180),
    brevity: c.get<Brevity>("brevity", "balanced"),
    orbStyle: c.get<OrbStyle>("orbStyle", "plasma"),
  };
}

/** Voice mode: speaks finished replies through macOS `say` or ElevenLabs
 * (played with `afplay`), after an optional Haiku spoken-word rephrase — the
 * claude-voice pipeline, run in-process. Audio plays out of process, so the
 * webview only ever sees state. */
export class VoiceController implements vscode.Disposable {
  private child: ChildProcess | undefined;
  /** Bumped by every speak/stop — a pipeline step that finds it changed was
   * superseded and must not start audio. */
  private generation = 0;
  private preparing = false;
  private speakingMessageId: string | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheDir: string;
  private warnedFallback = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly rephrase: RephraseFn,
    private readonly onState: (status: VoiceStatus) => void
  ) {
    this.cacheDir = path.join(context.globalStorageUri.fsPath, "voice-cache");
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
    } catch {
      // stale cache is harmless
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG)) {
          return;
        }
        if (!readConfig().enabled) {
          this.stop();
        }
        this.emit();
      })
    );
  }

  /** Why voice can't run in this window, if it can't. */
  private unavailableReason(): string | undefined {
    if (vscode.env.remoteName) {
      return "Voice is unavailable in remote windows — audio would play on the remote machine.";
    }
    if (process.platform !== "darwin") {
      return "Voice currently requires macOS (it uses `say` and `afplay`).";
    }
    return undefined;
  }

  status(): VoiceStatus {
    const cfg = readConfig();
    const unavailable = this.unavailableReason();
    const enabled = cfg.enabled && !unavailable;
    let state: VoiceStatus["state"];
    if (this.child) {
      state = "speaking";
    } else if (this.preparing) {
      state = "waking";
    } else {
      state = enabled ? "idle" : "off";
    }
    return {
      enabled,
      state,
      orbStyle: cfg.orbStyle,
      speakingMessageId: this.child || this.preparing ? this.speakingMessageId : undefined,
      unavailable,
    };
  }

  private emit(): void {
    this.onState(this.status());
  }

  isEnabled(): boolean {
    return this.status().enabled;
  }

  async toggle(): Promise<void> {
    const unavailable = this.unavailableReason();
    if (unavailable) {
      void vscode.window.showWarningMessage(unavailable);
      return;
    }
    const next = !readConfig().enabled;
    if (!next) {
      this.stop();
    }
    await vscode.workspace
      .getConfiguration(CONFIG)
      .update("enabled", next, vscode.ConfigurationTarget.Global);
    this.emit();
  }

  async setElevenLabsKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: "ElevenLabs API key",
      prompt: "Stored in VS Code's secret storage. Leave empty to remove it.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) {
      return;
    }
    if (key.trim()) {
      await this.context.secrets.store(SECRET_KEY, key.trim());
      void vscode.window.showInformationMessage(
        "ElevenLabs key saved. Set `claude-luxure.voice.backend` to \"elevenlabs\" to use it."
      );
    } else {
      await this.context.secrets.delete(SECRET_KEY);
      void vscode.window.showInformationMessage("ElevenLabs key removed.");
    }
    // Cached MP3s were rendered with the old voice/key — drop them.
    for (const entry of this.cache.values()) {
      entry.mp3 = undefined;
    }
  }

  /** Auto-speak a finished turn. No-op when voice is off. */
  speak(messageId: string, raw: string, accountId?: string): void {
    if (!this.isEnabled()) {
      return;
    }
    void this.run(messageId, raw, accountId);
  }

  /** Explicit replay — works even when auto-speak is off, and reuses the
   * cached spoken text / MP3 so it costs nothing. */
  replay(messageId: string, raw: string, accountId?: string): void {
    if (this.unavailableReason()) {
      void vscode.window.showWarningMessage(this.unavailableReason()!);
      return;
    }
    void this.run(messageId, raw, accountId);
  }

  stop(): void {
    this.generation++;
    this.preparing = false;
    this.speakingMessageId = undefined;
    this.killChild();
    this.emit();
  }

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  private async run(messageId: string, raw: string, accountId?: string): Promise<void> {
    this.killChild();
    const gen = ++this.generation;
    const superseded = () => gen !== this.generation;
    const cfg = readConfig();
    this.speakingMessageId = messageId;
    this.preparing = true;
    this.emit();

    try {
      let entry = this.cache.get(messageId);
      if (!entry) {
        const spoken = await this.toSpoken(raw, cfg, accountId);
        if (superseded()) {
          return;
        }
        if (!spoken) {
          this.preparing = false;
          this.emit();
          return;
        }
        entry = { spoken };
        this.remember(messageId, entry);
      } else {
        // Refresh LRU position.
        this.cache.delete(messageId);
        this.cache.set(messageId, entry);
      }

      if (cfg.backend === "elevenlabs") {
        const mp3 = entry.mp3 && fs.existsSync(entry.mp3)
          ? entry.mp3
          : await this.fetchElevenLabs(messageId, entry.spoken, cfg);
        if (superseded()) {
          return;
        }
        if (mp3) {
          entry.mp3 = mp3;
          this.play("afplay", [mp3], gen);
          return;
        }
      }
      this.play("say", ["-v", cfg.sayVoice, "-r", String(cfg.sayRate), "--", entry.spoken], gen);
    } catch (err) {
      log("WARN", "voice pipeline failed:", String(err));
      if (!superseded()) {
        this.preparing = false;
        this.emit();
      }
    }
  }

  private async toSpoken(raw: string, cfg: VoiceConfig, accountId?: string): Promise<string> {
    const cleaned = cleanForSpeech(raw);
    if (!cleaned) {
      return "";
    }
    if (cfg.rephrase && cleaned.length > cfg.rephraseThreshold) {
      const t0 = Date.now();
      try {
        const out = (
          await this.rephrase(
            rephraseSystemPrompt(cfg.brevity),
            rephraseUserPrompt(cleaned),
            accountId
          )
        ).trim();
        log("INFO", `voice rephrase ${cleaned.length}→${out.length} chars in ${Date.now() - t0}ms`);
        if (out) {
          return cleanForSpeech(out).slice(0, MAX_SPOKEN_CHARS);
        }
      } catch (err) {
        log("WARN", "voice rephrase failed, speaking cleaned text:", String(err));
      }
    }
    return cleaned.slice(0, MAX_SPOKEN_CHARS);
  }

  private async fetchElevenLabs(
    messageId: string,
    text: string,
    cfg: VoiceConfig
  ): Promise<string | undefined> {
    const key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      this.warnFallback("No ElevenLabs key set — using the system voice. Run \"Claude Luxure: Set ElevenLabs API Key\".");
      return undefined;
    }
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.elevenlabsVoiceId)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": key,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: cfg.elevenlabsModel,
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: cfg.elevenlabsSpeed,
            },
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`ElevenLabs ${res.status}: ${body}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const file = path.join(this.cacheDir, `${messageId.replace(/[^\w-]/g, "_")}.mp3`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      return file;
    } catch (err) {
      log("WARN", "ElevenLabs TTS failed:", String(err));
      this.warnFallback("ElevenLabs unavailable — using the system voice.");
      return undefined;
    }
  }

  private warnFallback(message: string): void {
    if (this.warnedFallback) {
      return;
    }
    this.warnedFallback = true;
    void vscode.window.showWarningMessage(message);
  }

  private play(cmd: string, args: string[], gen: number): void {
    const child = spawn(cmd, args, { stdio: "ignore" });
    this.child = child;
    this.preparing = false;
    this.emit();
    const done = () => {
      if (this.child === child) {
        this.child = undefined;
        if (gen === this.generation) {
          this.speakingMessageId = undefined;
        }
        this.emit();
      }
    };
    child.on("exit", done);
    child.on("error", (err) => {
      log("WARN", `voice: ${cmd} failed:`, String(err));
      done();
    });
  }

  private remember(messageId: string, entry: CacheEntry): void {
    this.cache.set(messageId, entry);
    while (this.cache.size > CACHE_LIMIT) {
      const [oldId, old] = this.cache.entries().next().value as [string, CacheEntry];
      this.cache.delete(oldId);
      if (old.mp3) {
        fs.rm(old.mp3, { force: true }, () => undefined);
      }
    }
  }

  dispose(): void {
    this.generation++;
    this.killChild();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
