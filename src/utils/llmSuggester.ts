import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "./logger";
import { perfLog } from "./perf";

/**
 * Local-LLM phrase suggestion ("magie"): Qwen3.5-2B (Q4, Metal) completes the
 * prompt the user is typing, grounded in their retrieved past prompts and the
 * current conversation. Latency was spiked on this machine at 90–170ms warm
 * (scripts/spike-local-llm.mjs) — fast enough to answer per typing boundary.
 *
 * node-llama-cpp is ESM-only while the extension bundles to CJS, so it is
 * marked external in esbuild and loaded through a real dynamic import (the
 * Function shim below keeps esbuild from rewriting it to require()).
 */

const MODEL_PATH = path.join(
  os.homedir(),
  ".cache/claude-luxure-models/Qwen3.5-2B-Q4_K_M.gguf"
);

const SYSTEM_PROMPT = [
  "You autocomplete the prompt a user is typing to their coding assistant.",
  "Given the conversation context, the user's past prompts and a draft, output",
  "ONLY the words that continue the draft — not the draft itself, no quotes,",
  "no explanation, one line, at most 15 words. Reuse the user's own vocabulary",
  "and style. If the past prompts are irrelevant, continue naturally from the",
  "conversation context alone.",
].join(" ");

/** Token-bias caps (probability form; node-llama-cpp docs recommend staying
 * within ±0.9 — we stay far below so fluency is never at risk). Bench
 * finding on this machine: fewer, stronger words with a subtler ceiling
 * behaves better than a broad 120-word push. */
const MAX_BIAS_WORDS = 60;
const BIAS_FLOOR = 0.08;
const BIAS_CEIL = 0.25;
const BIAS_PER_WEIGHT = 0.06;

export interface SuggestRequest {
  draft: string;
  /** Top lexical matches from the prompt-history corpus — may be empty; the
   * model then works from the conversation context alone. */
  examples: string[];
  /** Recent conversation turns, oldest first, pre-truncated by the caller. */
  conversation: { role: string; text: string }[];
  /** The user's learned project vocabulary (corrector-style weights),
   * strongest first. Steers the model via a soft logit bias during
   * decoding, and optionally a hint line in the prompt (vocabHint). */
  vocabulary?: { word: string; weight: number }[];
  /** Also spell the vocabulary out in the prompt. Default false — the A/B
   * bench showed the hint line induces quoting artifacts on Qwen3.5-2B,
   * while the invisible bias is side-effect free. */
  vocabHint?: boolean;
}

interface TokenBiasLike {
  set(input: string, bias: number): TokenBiasLike;
}

interface LlamaHandles {
  model: unknown;
  session: {
    setChatHistory(history: unknown[]): void;
    prompt(text: string, options?: Record<string, unknown>): Promise<string>;
  };
  initialHistory: unknown[];
  tokenBiasFor: (model: unknown) => TokenBiasLike;
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<typeof import("node-llama-cpp")>;

export class LlmSuggester {
  private handles: LlamaHandles | null = null;
  private initPromise: Promise<LlamaHandles | null> | null = null;
  private unavailableLogged = false;
  /** Single-flight: the model serializes anyway; keep only the newest waiter
   * so a burst of boundaries doesn't queue a stale backlog. */
  private inFlight: Promise<unknown> = Promise.resolve();
  private newestRequestId = 0;
  /** Token bias rebuilt only when the vocabulary actually changes (the
   * corpus refreshes at most once a minute) — tokenizing 120 words per
   * keystroke would be silly. */
  private biasKey = "";
  private bias: TokenBiasLike | null = null;

  available(): boolean {
    return fs.existsSync(MODEL_PATH);
  }

  private async init(): Promise<LlamaHandles | null> {
    if (this.handles) {
      return this.handles;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.available()) {
          if (!this.unavailableLogged) {
            this.unavailableLogged = true;
            log(
              "INFO",
              `magie suggestions off — model not found at ${MODEL_PATH} ` +
                "(download Qwen3.5-2B-Q4_K_M.gguf there to enable)"
            );
          }
          return null;
        }
        const t0 = Date.now();
        try {
          const { getLlama, LlamaChatSession, QwenChatWrapper, TokenBias } =
            await dynamicImport("node-llama-cpp");
          const llama = await getLlama();
          const model = await llama.loadModel({ modelPath: MODEL_PATH });
          const context = await model.createContext({ contextSize: 2048 });
          const session = new LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt: SYSTEM_PROMPT,
            chatWrapper: new QwenChatWrapper({
              variation: "3.5",
              thoughts: "discourage",
            }),
          });
          // Metal pipeline warmup so the first real suggestion isn't slow.
          await session.prompt("hi", { maxTokens: 2, temperature: 0 });
          const initialHistory = session.getChatHistory();
          const handles = {
            model,
            session,
            initialHistory,
            tokenBiasFor: (m: unknown) =>
              TokenBias.for(m as Parameters<typeof TokenBias.for>[0]),
          } as unknown as LlamaHandles;
          this.handles = handles;
          perfLog("magie.init", { ms: Date.now() - t0, gpu: String(llama.gpu) });
          return handles;
        } catch (err) {
          log("ERROR", "magie init failed:", String(err));
          return null;
        }
      })();
    }
    return this.initPromise;
  }

  /** Best-effort completion of `draft`; null when unavailable, superseded, or
   * the model produced nothing usable. Never throws. */
  async suggest(request: SuggestRequest): Promise<string | null> {
    if (!this.available()) {
      void this.init(); // logs the pointer once
      return null;
    }
    const requestId = ++this.newestRequestId;

    const run = this.inFlight.then(async (): Promise<string | null> => {
      if (requestId !== this.newestRequestId) {
        return null; // a newer boundary already replaced this one
      }
      const handles = await this.init();
      if (!handles || requestId !== this.newestRequestId) {
        return null;
      }
      const t0 = Date.now();
      try {
        // Reset to the warmed system-only history: the system prefix KV is
        // reused, examples + draft are the only prefill (~135ms measured).
        handles.session.setChatHistory(handles.initialHistory);
        const tokenBias = this.biasFor(handles, request.vocabulary);
        const raw = await handles.session.prompt(buildPrompt(request), {
          maxTokens: 24,
          temperature: 0,
          customStopTriggers: ["\n"],
          ...(tokenBias ? { tokenBias } : {}),
        });
        const suggestion = mergeDraftAndContinuation(request.draft, raw);
        perfLog("magie.suggest", {
          ms: Date.now() - t0,
          draftChars: request.draft.length,
          examples: request.examples.length,
          vocab: request.vocabulary?.length ?? 0,
          out: suggestion ? suggestion.length : 0,
        });
        return suggestion;
      } catch (err) {
        log("WARN", "magie suggest failed:", String(err));
        return null;
      }
    });

    this.inFlight = run.catch(() => undefined);
    return run;
  }

  /** Soft decoding bias toward the user's project vocabulary — the same
   * nudge a keyboard corrector gives its user dictionary. Words are biased
   * in their in-sentence form (leading space) so word-start tokens are the
   * ones favored; magnitude scales with learned weight but is hard-capped
   * well below where it could distort fluency. */
  private biasFor(
    handles: LlamaHandles,
    vocabulary: SuggestRequest["vocabulary"]
  ): TokenBiasLike | null {
    if (!vocabulary || vocabulary.length === 0) {
      return null;
    }
    const words = vocabulary.slice(0, MAX_BIAS_WORDS);
    const key = words
      .map((v) => `${v.word}:${v.weight.toFixed(2)}`)
      .join("|");
    if (key === this.biasKey && this.bias) {
      return this.bias;
    }
    try {
      const bias = handles.tokenBiasFor(handles.model);
      for (const { word, weight } of words) {
        const p = Math.min(BIAS_CEIL, BIAS_FLOOR + BIAS_PER_WEIGHT * weight);
        bias.set(" " + word, p);
      }
      this.biasKey = key;
      this.bias = bias;
      return bias;
    } catch (err) {
      log("WARN", "magie token bias failed (continuing unbiased):", String(err));
      this.biasKey = key;
      this.bias = null;
      return null;
    }
  }
}

function buildPrompt(request: SuggestRequest): string {
  const parts: string[] = [];
  // Most-stable content first so the KV prefix survives across boundaries:
  // vocabulary changes with the corpus (~1/min), conversation per turn,
  // examples per boundary, draft always.
  if (request.vocabHint && request.vocabulary && request.vocabulary.length > 0) {
    const words = request.vocabulary.slice(0, 18).map((v) => v.word);
    parts.push(`Words this user often uses in this project: ${words.join(", ")}`);
    parts.push("");
  }
  if (request.conversation.length > 0) {
    parts.push("Conversation so far:");
    for (const turn of request.conversation) {
      parts.push(`${turn.role}: ${turn.text}`);
    }
    parts.push("");
  }
  if (request.examples.length > 0) {
    parts.push("The user's past prompts in this project:");
    for (const example of request.examples) {
      parts.push(`- ${example}`);
    }
    parts.push("");
  }
  parts.push(`Draft to continue: "${request.draft}"`);
  return parts.join("\n");
}

/** The model is told to output only the continuation but sometimes echoes the
 * draft anyway — merge both shapes into one full suggested prompt. */
export function mergeDraftAndContinuation(
  draft: string,
  raw: string
): string | null {
  let continuation = raw.trim().replace(/\s+/g, " ");
  if (!continuation) {
    return null;
  }
  const normDraft = draft.trim().replace(/\s+/g, " ");
  if (continuation.toLowerCase().startsWith(normDraft.toLowerCase())) {
    continuation = continuation.slice(normDraft.length);
  }
  if (!continuation.trim()) {
    return null; // echoed the draft and nothing more
  }
  const joiner =
    draft.endsWith(" ") || continuation.startsWith(" ") ? "" : " ";
  const full = (draft + joiner + continuation).replace(/\s+/g, " ").trim();
  return full.length > draft.trim().length ? full : null;
}
