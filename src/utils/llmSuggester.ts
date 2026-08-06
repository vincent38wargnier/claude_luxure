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

const MODELS_DIR = path.join(os.homedir(), ".cache/claude-luxure-models");
/** Per-keystroke completion stays on the smallest model: with the prefill
 * framing the 2B matches the bigger ones on quality (see SYSTEM_PROMPT note)
 * and only it holds the ~130ms-per-boundary budget. */
const MODEL_PATH =
  process.env.CLAUDE_LUXURE_MAGIE_MODEL ||
  path.join(MODELS_DIR, "Qwen3.5-2B-Q4_K_M.gguf");
/** The rewrite lane ("expand") generates freely — no prefill anchor — where
 * model size DOES pay (2B echoes twice as often). It also only fires on
 * typing pauses, so the 4B's ~320ms fits. Falls back to the 2B when the 4B
 * file is absent; loaded lazily on the first expand request. */
function expandModelPath(): string {
  if (process.env.CLAUDE_LUXURE_MAGIE_EXPAND_MODEL) {
    return process.env.CLAUDE_LUXURE_MAGIE_EXPAND_MODEL;
  }
  const fourB = path.join(MODELS_DIR, "Qwen3.5-4B-Q4_K_M.gguf");
  return fs.existsSync(fourB) ? fourB : MODEL_PATH;
}
/** "continue" decodes through the raw confidence-capturing path by default;
 * CLAUDE_LUXURE_MAGIE_ENGINE=session restores the pre-confidence
 * session.prompt path (escape hatch + the parity baseline the bench diffs
 * against). */
const RAW_ENGINE = process.env.CLAUDE_LUXURE_MAGIE_ENGINE !== "session";

/** Prediction is framed as "write the user's next message" with the draft
 * PREFILLED into the model's response (responsePrefix), forcing a literal
 * mid-sentence continuation. The earlier "output the words that continue the
 * draft" instruction made the chat-tuned model fight the task — it answered
 * the draft as the assistant ("I'll fix that right now") or restarted it.
 * Replay-benched on 200 real prompt cuts from this machine's transcripts
 * (scripts/battletest/replay_eval.mjs): next-word accuracy 8.5% → 25.5%,
 * token-F1 0.088 → 0.136, nulls 27% → 8%, and the same framing on Qwen3.5-4B
 * (+2pp, ~3× latency) or 9B (+1pp, ~4×) is not worth the wait — even a
 * frontier-model ceiling probe scored 16.7% next-word on these cuts. */
const SYSTEM_PROMPT = [
  "You write the next message a user will type to their coding assistant.",
  "Predict it from the conversation and the user's past prompts. The message",
  "usually reacts to the assistant's last reply: asking to check, verify,",
  "test, run, fix, push, explain, screenshot or improve something just",
  "discussed. Match the user's casual style, typos and vocabulary exactly.",
  "Write ONLY the message itself, one line, under 30 words.",
  "When asked to rewrite rough notes instead, keep ALL the note words in",
  "the same order and insert only the small connecting words — never new",
  "topics. Examples:",
  '\nNotes: "check ci fix necessary" → check the ci and fix the necessary',
  '\nNotes: "push branch predicator" → can you push that to a new branch called predicator',
  '\nNotes: "screenshot composer states proof" → take a screenshot of the composer states as proof',
].join(" ");

/** Token-bias caps (probability form; node-llama-cpp docs recommend staying
 * within ±0.9 — we stay far below so fluency is never at risk). Bench
 * finding on this machine: fewer, stronger words with a subtler ceiling
 * behaves better than a broad 120-word push. */
const MAX_BIAS_WORDS = 60;
const BIAS_FLOOR = 0.08;
const BIAS_CEIL = 0.25;
const BIAS_PER_WEIGHT = 0.06;

/** Confidence display policy for "continue". The leak audit measured that a
 * single full guessed line (mean 7.4 words) starts wrong 70% of the time —
 * over-commitment is what made rows read as noise — so rows are truncated to
 * the span the model is sure of. The magie block is keyboard-shaped: up to
 * MAGIE_MAX_ROWS candidate rows branched from the model's top first tokens.
 * A row shows when its first continuation word clears CANDIDATE (per-row;
 * candidates are presented as alternatives, so the bar sits below the old
 * single-row 0.5) and extends word-by-word while clearing EXTEND (higher:
 * committing to more words compounds risk). Confidence is the greedy token
 * probability from evaluateWithMetadata, min-pooled per word. EXTEND swept
 * on the 120-probe replay corpus (confidence_sweep.mjs, conf_sweep.json);
 * CANDIDATE swept over the dumped per-row confidences (prod_replay). */
export const CONF_CANDIDATE_FLOOR = 0.2;
/** Rows 2-3 are visibly ranked ALTERNATIVES under the primary row, so their
 * first-word bar sits far lower — three tokens all above 0.2 would need 60%
 * of the distribution and measured only 1.24 rows/block. The block itself
 * still gates on the primary row clearing CANDIDATE. */
export const CONF_ALT_FLOOR = 0.05;
export const CONF_EXTEND_FLOOR = 0.6;
export const MAGIE_MAX_ROWS = 3;

export interface ConfidentWord {
  word: string;
  /** min probability across the tokens that produced this word */
  confidence: number;
}

/** What production displays for a continuation: the confident prefix of the
 * generated words, or null when even the first word is a guess. Pure — the
 * bench sweeps floors over dumped words without re-decoding. */
export function truncateAtConfidence(
  words: ConfidentWord[],
  showFloor: number = CONF_CANDIDATE_FLOOR,
  extendFloor: number = CONF_EXTEND_FLOOR
): string | null {
  if (words.length === 0 || words[0].confidence < showFloor) {
    return null;
  }
  const kept: string[] = [words[0].word];
  for (let i = 1; i < words.length; i++) {
    if (words[i].confidence < extendFloor) {
      break;
    }
    kept.push(words[i].word);
  }
  return kept.join(" ");
}

/** Shift token char-spans left by `offset` (the regenerated healing
 * fragment) so they line up with the continuation slice; a boundary token
 * spanning fragment→continuation keeps contributing its confidence to the
 * first continuation word via ordinary overlap. */
function shiftSpans(
  spans: { start: number; end: number; confidence: number }[],
  offset: number
): { start: number; end: number; confidence: number }[] {
  return spans.map((s) => ({
    start: s.start - offset,
    end: s.end - offset,
    confidence: s.confidence,
  }));
}

/** Map token-level confidences onto the whitespace words of the decoded text.
 * `spans` are cumulative detokenize char ranges per generated token; a word's
 * confidence is the min over tokens overlapping it. With `completedOnly`, a
 * trailing word still mid-generation (text does not continue past it) is
 * dropped — used by the early-stop check while decoding. */
export function wordsWithConfidence(
  text: string,
  spans: { start: number; end: number; confidence: number }[],
  completedOnly: boolean
): ConfidentWord[] {
  const out: ConfidentWord[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (completedOnly && end === text.length) {
      break;
    }
    let confidence = 1;
    for (const span of spans) {
      if (span.end > start && span.start < end) {
        confidence = Math.min(confidence, span.confidence);
      }
    }
    out.push({ word: match[0], confidence });
  }
  return out;
}

export interface SuggestRequest {
  /** The phrase being typed — the CURRENT LINE of the composer, not the
   * whole multiline draft (that arrives as `priorDraft`). */
  draft: string;
  /** "continue" (default) completes the phrase in place — the response is
   * prefilled with the draft so the model continues it mid-sentence.
   * "expand" rewrites rough/keyword notes into the clean phrase the user
   * means (no prefill; the output replaces the phrase). */
  kind?: "continue" | "expand";
  /** Lines of the message already written above the current phrase. For
   * "continue" they join the response prefill so the completion fits what
   * came before; for "expand" they are shown as context. */
  priorDraft?: string;
  /** Top lexical matches from the prompt-history corpus — may be empty; the
   * model then works from the conversation context alone. Only the first 3
   * reach the prompt: weak tail matches actively mislead a small model. */
  examples: string[];
  /** Recent conversation turns, oldest first, pre-truncated by the caller. */
  conversation: { role: string; text: string }[];
  /** The user's last few sent prompts (newest last), regardless of lexical
   * match — mined finding: half of all prompts continue the current thread
   * ("okay, now…", "did you…"), so what was just asked predicts what comes
   * next better than similarity alone. */
  recent?: string[];
  /** Conversation-lane retrieval: past prompts related to what the
   * conversation is ABOUT (tf×idf over the transcript corpus), independent
   * of the draft prefix — the session-context lane from QAC literature.
   * Computed by threadRetrieval.rankThreadRelated. */
  related?: string[];
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

/** Hand-rolled minimal views of node-llama-cpp objects (the package is
 * ESM-only and loaded dynamically, so its types stay out of the compile
 * graph). Token ids are plain numbers here; the real branded Token type never
 * leaves this file. */
interface LlamaHandles {
  model: {
    tokenize(
      text: string,
      specialTokens?: boolean,
      options?: "trimLeadingSpace"
    ): number[];
    detokenize(tokens: number[], specialTokens?: boolean): string;
    readonly tokenizer: unknown;
  };
  /** The context sequence backing `session` — the raw "continue" decoder
   * drives it directly. Safe to share: both LlamaChat and rawContinue align
   * to the sequence's REAL state (adaptStateToTokens) before evaluating. */
  sequence: {
    readonly nextTokenIndex: number;
    adaptStateToTokens(tokens: number[], allowShift?: boolean): Promise<void>;
    eraseContextTokenRanges(
      ranges: { start: number; end: number }[]
    ): Promise<void>;
    evaluateWithMetadata(
      tokens: number[],
      metadata: { confidence: true; probabilities?: boolean },
      options?: Record<string, unknown>
    ): AsyncGenerator<{
      token: number;
      confidence: number;
      /** Full next-token distribution, sorted desc — probe step only. */
      probabilities?: Map<number, number>;
    }>;
  };
  /** The SAME QwenChatWrapper instance the session uses — rendering through
   * it keeps the raw path's template (incl. the thoughts-discourage think
   * block) byte-identical to session.prompt's. */
  wrapper: {
    generateContextState(options: { chatHistory: unknown[] }): {
      contextText: { tokenize(tokenizer: unknown): number[] };
    };
  };
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
  /** One set of handles per model file — "continue" and "expand" may route
   * to different sizes; each loads lazily on its first request. */
  private handlesByPath = new Map<string, LlamaHandles>();
  private initPromises = new Map<string, Promise<LlamaHandles | null>>();
  private unavailableLogged = false;
  /** Single-flight: Metal serializes anyway; keep only the newest waiter
   * PER KIND so a burst of boundaries doesn't queue a stale backlog — and a
   * fresh "expand" request doesn't cancel a live "continue" (they are
   * different rows in the menu, both wanted). */
  private inFlight: Promise<unknown> = Promise.resolve();
  private newestByKind: Record<string, number> = {};
  private requestCounter = 0;
  /** Token bias rebuilt only when the vocabulary actually changes (the
   * corpus refreshes at most once a minute) — tokenizing 120 words per
   * keystroke would be silly. Keyed per model: token ids differ. */
  private biasCache = new Map<
    string,
    { key: string; bias: TokenBiasLike | null }
  >();

  available(): boolean {
    return fs.existsSync(MODEL_PATH);
  }

  private async init(modelPath: string): Promise<LlamaHandles | null> {
    const ready = this.handlesByPath.get(modelPath);
    if (ready) {
      return ready;
    }
    let pending = this.initPromises.get(modelPath);
    if (!pending) {
      pending = (async () => {
        if (!fs.existsSync(modelPath)) {
          if (!this.unavailableLogged) {
            this.unavailableLogged = true;
            log(
              "INFO",
              `magie suggestions off — model not found at ${modelPath} ` +
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
          const model = await llama.loadModel({ modelPath });
          const context = await model.createContext({ contextSize: 2048 });
          const sequence = context.getSequence();
          const wrapper = new QwenChatWrapper({
            variation: "3.5",
            thoughts: "discourage",
          });
          const session = new LlamaChatSession({
            contextSequence: sequence,
            systemPrompt: SYSTEM_PROMPT,
            chatWrapper: wrapper,
          });
          // Metal pipeline warmup so the first real suggestion isn't slow.
          await session.prompt("hi", { maxTokens: 2, temperature: 0 });
          const initialHistory = session.getChatHistory();
          const handles = {
            model,
            sequence,
            wrapper,
            session,
            initialHistory,
            tokenBiasFor: (m: unknown) =>
              TokenBias.for(m as Parameters<typeof TokenBias.for>[0]),
          } as unknown as LlamaHandles;
          this.handlesByPath.set(modelPath, handles);
          perfLog("magie.init", {
            ms: Date.now() - t0,
            gpu: String(llama.gpu),
            model: path.basename(modelPath),
          });
          return handles;
        } catch (err) {
          log("ERROR", "magie init failed:", String(err));
          return null;
        }
      })();
      this.initPromises.set(modelPath, pending);
    }
    return pending;
  }

  /** Best-effort suggestion for the phrase in `request.draft`; null when
   * unavailable, superseded, or the model produced nothing usable. Never
   * throws. "continue" answers the CONFIDENT SPAN of the completed phrase
   * (starts with the draft; truncated where token confidence collapses);
   * "expand" answers a clean rewrite of it (free-standing). */
  async suggest(request: SuggestRequest): Promise<string | null> {
    const detail = await this.suggestWithConfidence(request);
    return detail?.shown ?? null;
  }

  /** suggest() plus the pre-truncation detail the bench needs: the full
   * generated completion, its per-word confidences, and the candidate rows
   * (greedy branch first, then runner-up branches — each already truncated
   * to its confident span, deduped, with its first-word confidence).
   * `fullDecode` disables the production early-stop so every token of the
   * greedy branch gets generated — bench only. */
  async suggestWithConfidence(
    request: SuggestRequest,
    options?: { fullDecode?: boolean }
  ): Promise<{
    shown: string | null;
    full: string | null;
    words: ConfidentWord[];
    rows: { text: string; w1: number }[];
  } | null> {
    if (!this.available()) {
      void this.init(MODEL_PATH); // logs the pointer once
      return null;
    }
    const kind = request.kind ?? "continue";
    const modelPath = kind === "expand" ? expandModelPath() : MODEL_PATH;
    const requestId = ++this.requestCounter;
    this.newestByKind[kind] = requestId;

    const run = this.inFlight.then(
      async (): Promise<{
        shown: string | null;
        full: string | null;
        words: ConfidentWord[];
        rows: { text: string; w1: number }[];
      } | null> => {
        if (requestId !== this.newestByKind[kind]) {
          return null; // a newer boundary already replaced this one
        }
        const handles = await this.init(modelPath);
        if (!handles || requestId !== this.newestByKind[kind]) {
          return null;
        }
        const t0 = Date.now();
        try {
          const tokenBias = this.biasFor(
            handles,
            request.vocabulary,
            modelPath
          );
          const promptText = buildPrompt(request, kind);
          if (kind === "expand" || !RAW_ENGINE) {
            // Session path: "expand" always (free generation, no per-word
            // gating), and "continue" too under the escape hatch
            // CLAUDE_LUXURE_MAGIE_ENGINE=session (the pre-confidence
            // behavior; also the parity baseline for confidence_sweep.mjs).
            // Reset to the warmed system-only history: the system prefix KV
            // is reused, examples + draft are the only prefill.
            handles.session.setChatHistory(handles.initialHistory);
            const prefill =
              kind === "continue"
                ? (request.priorDraft ? request.priorDraft + "\n" : "") +
                  request.draft
                : undefined;
            const raw = await handles.session.prompt(promptText, {
              maxTokens: kind === "expand" ? 48 : 24,
              temperature: 0,
              customStopTriggers: ["\n"],
              ...(prefill ? { responsePrefix: prefill } : {}),
              ...(tokenBias ? { tokenBias } : {}),
            });
            const suggestion =
              kind === "expand"
                ? cleanExpandedPhrase(request.draft, raw)
                : mergeDraftAndContinuation(
                    request.draft,
                    prefill && raw.startsWith(prefill)
                      ? raw.slice(prefill.length)
                      : raw
                  );
            perfLog("magie.suggest", {
              kind,
              model: path.basename(modelPath),
              ms: Date.now() - t0,
              draftChars: request.draft.length,
              examples: request.examples.length,
              vocab: request.vocabulary?.length ?? 0,
              out: suggestion ? suggestion.length : 0,
            });
            return {
              shown: suggestion,
              full: suggestion,
              words: [],
              rows: suggestion ? [{ text: suggestion, w1: 1 }] : [],
            };
          }
          // "continue": the whole draft written so far (prior lines + the
          // current phrase) is prefilled so decoding extends the current
          // line and the newline stop ends it.
          const prefill =
            (request.priorDraft ? request.priorDraft + "\n" : "") +
            request.draft;
          const { primary, alternatives } = await this.rawContinue(
            handles,
            promptText,
            prefill,
            tokenBias,
            24,
            options?.fullDecode
              ? undefined
              : {
                  showFloor: CONF_CANDIDATE_FLOOR,
                  extendFloor: CONF_EXTEND_FLOOR,
                }
          );
          const full = mergeDraftAndContinuation(
            request.draft,
            primary.continuation
          );
          // Each branch becomes a candidate row: its confident span merged
          // onto the draft. truncateAtConfidence returns bare words, so the
          // branch continuation's leading boundary is restored first — a
          // mid-word completion stays fused ("…corr" + "rect?" →
          // "…correct?"), a new word stays spaced.
          const rows: { text: string; w1: number }[] = [];
          const seenRows = new Set<string>();
          const branchList = [primary, ...alternatives];
          for (let i = 0; i < branchList.length; i++) {
            const branch = branchList[i];
            const confident = truncateAtConfidence(
              branch.words,
              i === 0 ? CONF_CANDIDATE_FLOOR : CONF_ALT_FLOOR
            );
            if (confident === null || !/[\p{L}\p{N}]/u.test(confident)) {
              // Below floor, or adds bare punctuation — not a row. A failed
              // PRIMARY hides the whole block: alternatives are by
              // construction weaker than the greedy pick, so a block whose
              // best option missed the bar is pure noise.
              if (i === 0) {
                break;
              }
              continue;
            }
            const merged = mergeDraftAndContinuation(
              request.draft,
              (/^\s/.test(branch.continuation) ? " " : "") + confident
            );
            if (!merged) {
              continue;
            }
            const norm = merged.replace(/\s+/g, " ").trim().toLowerCase();
            if (seenRows.has(norm)) {
              continue;
            }
            seenRows.add(norm);
            rows.push({
              text: merged,
              w1: branch.words[0]?.confidence ?? 0,
            });
            if (rows.length >= MAGIE_MAX_ROWS) {
              break;
            }
          }
          const shown = rows[0]?.text ?? null;
          perfLog("magie.suggest", {
            kind,
            model: path.basename(modelPath),
            ms: Date.now() - t0,
            draftChars: request.draft.length,
            examples: request.examples.length,
            vocab: request.vocabulary?.length ?? 0,
            out: shown ? shown.length : 0,
            fullOut: full ? full.length : 0,
            rows: rows.length,
            of: primary.words.length,
            w1: primary.words[0] ? +primary.words[0].confidence.toFixed(2) : -1,
          });
          return { shown, full, words: primary.words, rows };
        } catch (err) {
          log("WARN", "magie suggest failed:", String(err));
          return null;
        }
      }
    );

    this.inFlight = run.catch(() => undefined);
    return run;
  }

  /** Low-level twin of session.prompt(..., {responsePrefix}) for "continue":
   * renders the SAME chat template through the session's wrapper (so the
   * thoughts-discourage think block and message framing stay byte-identical
   * — parity asserted by scripts/battletest/confidence_sweep.mjs), aligns
   * the sequence KV to the longest shared prefix exactly like LlamaChat does
   * internally, then greedy-decodes with per-token confidence. Returns the
   * greedy branch plus up to MAGIE_MAX_ROWS-1 alternatives branched on the
   * probe's runner-up first tokens. Each branch stops at newline, EOG or
   * maxTokens — or, with `earlyStop`, at the first completed word below its
   * display floor: nothing past it can ever show, so decoding further is
   * pure latency. */
  private async rawContinue(
    handles: LlamaHandles,
    promptText: string,
    prefill: string,
    tokenBias: TokenBiasLike | null,
    maxTokens: number,
    earlyStop?: { showFloor: number; extendFloor: number }
  ): Promise<{
    primary: { continuation: string; words: ConfidentWord[] };
    alternatives: { continuation: string; words: ConfidentWord[] }[];
  }> {
    const chatHistory = [
      ...handles.initialHistory,
      { type: "user", text: promptText },
      { type: "model", response: [] },
    ];
    const { contextText } = handles.wrapper.generateContextState({
      chatHistory,
    });
    const contextTokens = contextText.tokenize(handles.model.tokenizer);
    const tokens = contextTokens.concat(
      prefill ? handles.model.tokenize(prefill, false, "trimLeadingSpace") : []
    );
    // Probe: ONE decode step with the full next-token distribution — the
    // greedy winner plus the runner-up first tokens that candidate rows
    // branch on (the keyboard's top-3 pattern). Each branch then continues
    // greedily from the shared prompt KV; between branches only the branch's
    // own few tokens get erased, so the extra cost is a handful of decode
    // steps.
    const midWordRisk = /\S$/.test(prefill);
    const probe = await this.probeFirstToken(handles, tokens, tokenBias);
    if (!probe) {
      return { primary: { continuation: "", words: [] }, alternatives: [] };
    }
    if (midWordRisk && /^[\p{L}\p{N}]/u.test(probe.text)) {
      // The greedy continuation fuses letters onto the draft's last word —
      // the token-split hazard: a prefill cut mid-word tokenizes differently
      // than the finished word, so the model re-derives it from a bad split
      // ("…corr" + "rect" → "corrrect"). Token healing: back the prefill off
      // to the last word boundary (never across a newline); the model
      // regenerates the fragment itself — its output must start with it,
      // else no suggestion — and only what follows counts ("…screensh" →
      // " screenshot of…" → continuation "ot of…"). Healing must NOT run
      // unconditionally: forcing the model to re-guess a COMPLETE last word
      // collapsed the show rate 18%→7% on the replay corpus. Single branch:
      // alternatives would need their own healed decodes.
      const fragment = prefill.match(/(?:[^\S\n])?\S+$/)?.[0] ?? "";
      const healedPrefill = prefill.slice(0, prefill.length - fragment.length);
      const healed = await this.decodeOnce(
        handles,
        contextTokens.concat(
          healedPrefill
            ? handles.model.tokenize(healedPrefill, false, "trimLeadingSpace")
            : []
        ),
        fragment,
        tokenBias,
        maxTokens,
        earlyStop
      );
      return { primary: healed, alternatives: [] };
    }
    const starts = [
      { token: probe.token, text: probe.text, confidence: probe.confidence },
      ...probe.alternatives.filter(
        (alt) => !(midWordRisk && /^[\p{L}\p{N}]/u.test(alt.text))
      ),
    ].slice(0, MAGIE_MAX_ROWS);
    const primary = await this.decodeOnce(
      handles,
      tokens,
      "",
      tokenBias,
      maxTokens,
      earlyStop,
      starts[0]
    );
    // A primary that cannot form a row hides the whole block (alternatives
    // are weaker by construction) — skip their decodes entirely.
    const w1 = primary.words[0];
    if (
      !w1 ||
      w1.confidence < CONF_CANDIDATE_FLOOR ||
      !/[\p{L}\p{N}]/u.test(w1.word)
    ) {
      return { primary, alternatives: [] };
    }
    const alternatives: { continuation: string; words: ConfidentWord[] }[] =
      [];
    for (const start of starts.slice(1)) {
      alternatives.push(
        await this.decodeOnce(
          handles,
          tokens,
          "",
          tokenBias,
          8,
          // Alternatives gate their first word at the lower ALT floor —
          // mirrored in the display truncation in suggestWithConfidence.
          earlyStop ? { ...earlyStop, showFloor: CONF_ALT_FLOOR } : earlyStop,
          start
        )
      );
    }
    return { primary, alternatives };
  }

  /** Align the sequence KV to `tokens`, keeping at least one token free to
   * evaluate (logits require evaluating something): a fully-covered state —
   * identical request replayed, or a stale generated tail — gets its last
   * token erased. */
  private async alignSequence(
    handles: LlamaHandles,
    tokens: number[]
  ): Promise<void> {
    await handles.sequence.adaptStateToTokens(tokens, false);
    if (handles.sequence.nextTokenIndex >= tokens.length) {
      await handles.sequence.eraseContextTokenRanges([
        { start: tokens.length - 1, end: handles.sequence.nextTokenIndex },
      ]);
    }
  }

  /** One decode step over the prompt with the full distribution: the greedy
   * first token plus the runner-up tokens worth branching candidate rows on
   * (already filtered to displayable ones above the candidate floor). */
  private async probeFirstToken(
    handles: LlamaHandles,
    tokens: number[],
    tokenBias: TokenBiasLike | null
  ): Promise<{
    token: number;
    text: string;
    confidence: number;
    alternatives: { token: number; text: string; confidence: number }[];
  } | null> {
    await this.alignSequence(handles, tokens);
    const delta = tokens.slice(handles.sequence.nextTokenIndex);
    const iterator = handles.sequence.evaluateWithMetadata(
      delta,
      { confidence: true, probabilities: true },
      { temperature: 0, ...(tokenBias ? { tokenBias } : {}) }
    );
    try {
      const first = await iterator.next();
      if (first.done) {
        return null; // immediate EOG — the model ends the message here
      }
      const { token, confidence, probabilities } = first.value;
      const alternatives: {
        token: number;
        text: string;
        confidence: number;
      }[] = [];
      if (probabilities) {
        for (const [alt, p] of probabilities) {
          if (p < CONF_ALT_FLOOR) {
            break; // sorted desc — nothing below the floor can ever display
          }
          if (alt === token) {
            continue;
          }
          const text = handles.model.detokenize([alt]);
          if (!text || text.includes("\n")) {
            continue; // EOG/special tokens detokenize empty; newline = end
          }
          alternatives.push({ token: alt, text, confidence: p });
          if (alternatives.length >= MAGIE_MAX_ROWS - 1) {
            break;
          }
        }
      }
      return {
        token,
        text: handles.model.detokenize([token]),
        confidence,
        alternatives,
      };
    } finally {
      await iterator.return?.(undefined);
    }
  }

  /** One greedy decode pass. `fragment` is the token-healing tail the model
   * must regenerate before the continuation starts (empty = none). `forced`
   * seeds the branch's first continuation token (from the probe) — it is
   * evaluated as input and its text/probability seed the continuation. */
  private async decodeOnce(
    handles: LlamaHandles,
    tokens: number[],
    fragment: string,
    tokenBias: TokenBiasLike | null,
    maxTokens: number,
    earlyStop: { showFloor: number; extendFloor: number } | undefined,
    forced?: { token: number; text: string; confidence: number }
  ): Promise<{ continuation: string; words: ConfidentWord[] }> {
    const evalTokens = forced ? tokens.concat([forced.token]) : tokens;
    await this.alignSequence(handles, evalTokens);
    const delta = evalTokens.slice(handles.sequence.nextTokenIndex);
    const seed = forced?.text ?? "";
    const generated: number[] = [];
    const spans: { start: number; end: number; confidence: number }[] =
      forced
        ? [{ start: 0, end: seed.length, confidence: forced.confidence }]
        : [];
    let genCount = forced ? 1 : 0;
    let text = seed;
    for await (const step of handles.sequence.evaluateWithMetadata(
      delta,
      { confidence: true },
      { temperature: 0, ...(tokenBias ? { tokenBias } : {}) }
    )) {
      generated.push(step.token);
      genCount++;
      const soFar = seed + handles.model.detokenize(generated);
      spans.push({
        start: text.length,
        end: soFar.length,
        confidence: step.confidence,
      });
      const newline = soFar.indexOf("\n");
      if (newline >= 0) {
        text = soFar.slice(0, newline);
        break;
      }
      text = soFar;
      if (genCount >= maxTokens) {
        break;
      }
      if (text.length <= fragment.length) {
        if (
          text.toLowerCase() !== fragment.slice(0, text.length).toLowerCase()
        ) {
          text = "";
          break; // model disagrees with the user's partial word — bail early
        }
      } else if (earlyStop) {
        const completed = wordsWithConfidence(
          text.slice(fragment.length),
          shiftSpans(spans, fragment.length),
          true
        );
        const bad = completed.findIndex(
          (w, i) =>
            w.confidence <
            (i === 0 ? earlyStop.showFloor : earlyStop.extendFloor)
        );
        if (bad >= 0) {
          break;
        }
      }
    }
    if (fragment && !text.toLowerCase().startsWith(fragment.toLowerCase())) {
      return { continuation: "", words: [] };
    }
    const continuation = text.slice(fragment.length);
    return {
      continuation,
      words: wordsWithConfidence(
        continuation,
        shiftSpans(spans, fragment.length),
        false
      ),
    };
  }

  /** Soft decoding bias toward the user's project vocabulary — the same
   * nudge a keyboard corrector gives its user dictionary. Words are biased
   * in their in-sentence form (leading space) so word-start tokens are the
   * ones favored; magnitude scales with learned weight but is hard-capped
   * well below where it could distort fluency. */
  private biasFor(
    handles: LlamaHandles,
    vocabulary: SuggestRequest["vocabulary"],
    modelPath: string
  ): TokenBiasLike | null {
    if (!vocabulary || vocabulary.length === 0) {
      return null;
    }
    const words = vocabulary.slice(0, MAX_BIAS_WORDS);
    const key = words
      .map((v) => `${v.word}:${v.weight.toFixed(2)}`)
      .join("|");
    const cached = this.biasCache.get(modelPath);
    if (cached && cached.key === key) {
      return cached.bias;
    }
    try {
      const bias = handles.tokenBiasFor(handles.model);
      for (const { word, weight } of words) {
        const p = Math.min(BIAS_CEIL, BIAS_FLOOR + BIAS_PER_WEIGHT * weight);
        bias.set(" " + word, p);
      }
      this.biasCache.set(modelPath, { key, bias });
      return bias;
    } catch (err) {
      log("WARN", "magie token bias failed (continuing unbiased):", String(err));
      this.biasCache.set(modelPath, { key, bias: null });
      return null;
    }
  }
}

function buildPrompt(
  request: SuggestRequest,
  kind: "continue" | "expand"
): string {
  const parts: string[] = [];
  // Most-stable content first so the KV prefix survives across boundaries:
  // vocabulary changes with the corpus (~1/min), recent prompts per send,
  // conversation per turn, examples per boundary. The draft itself is NOT
  // here — it rides in as the response prefix.
  if (request.vocabHint && request.vocabulary && request.vocabulary.length > 0) {
    const words = request.vocabulary.slice(0, 18).map((v) => v.word);
    parts.push(`Words this user often uses in this project: ${words.join(", ")}`);
    parts.push("");
  }
  if (request.recent && request.recent.length > 0) {
    parts.push("The user's most recent prompts (newest last):");
    for (const r of request.recent) {
      parts.push(`- ${r}`);
    }
    parts.push("");
  }
  if (request.conversation.length > 0) {
    parts.push("Conversation so far:");
    for (const turn of request.conversation) {
      parts.push(`${turn.role}: ${turn.text}`);
    }
    parts.push("");
  }
  if (request.related && request.related.length > 0) {
    parts.push("The user's past prompts about this topic:");
    for (const r of request.related) {
      parts.push(`- ${r}`);
    }
    parts.push("");
  }
  const examples = request.examples.slice(0, 3);
  if (examples.length > 0) {
    parts.push("Similar past prompts by this user:");
    for (const example of examples) {
      parts.push(`- ${example}`);
    }
    parts.push("");
  }
  if (kind === "expand") {
    if (request.priorDraft) {
      parts.push(`The user's message so far: "${request.priorDraft}"`);
      parts.push("");
    }
    parts.push(`Notes: "${request.draft}" →`);
  } else {
    parts.push("Write the user's next message.");
  }
  return parts.join("\n");
}

/** Post-processing for "expand": the model writes a free-standing phrase.
 * Rejected when it adds nothing over the notes (echo — punctuation-blind,
 * commas around the same words are not a rewrite) or when it DROPS the
 * user's words (a rewrite that loses their specifics is worse than none:
 * benched 40% of free-form 2B rewrites hallucinated or echoed before these
 * gates + the in-prompt demos anchored the transform). */
export function cleanExpandedPhrase(
  draft: string,
  raw: string
): string | null {
  let phrase = raw.trim().replace(/\s+/g, " ");
  // Strip wrapping quotes, arrows and a leftover "Notes:"-style label.
  phrase = phrase.replace(/^(?:notes:)?[\s"'`→\-–—]+/i, "");
  phrase = phrase.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!phrase) {
    return null;
  }
  const letters = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (letters(phrase) === letters(draft)) {
    return null; // echo — commas sprinkled on the notes are not a rewrite
  }
  const outWords = new Set(letters(phrase).split(" "));
  const noteWords = letters(draft).split(" ").filter((w) => w.length >= 3);
  if (noteWords.length > 0) {
    const kept = noteWords.filter((w) => outWords.has(w)).length;
    if (kept / noteWords.length < 0.6) {
      return null; // lost the user's own words — off-topic rewrite
    }
  }
  return phrase;
}

/** Merge the model's continuation into one full suggested prompt. With the
 * prefill framing, `raw` is literally the text that follows the draft, so
 * its leading boundary is meaningful: a space-less start COMPLETES the
 * draft's last word ("…corr" + "rect?" → "…correct?", "…good" + ", right?")
 * while a spaced start begins a new word. The old trim-then-rejoin always
 * inserted a space, so word completions displayed as a bogus extra word.
 * Echoes of the draft (the model restating it despite the prefill) are
 * stripped first. */
export function mergeDraftAndContinuation(
  draft: string,
  raw: string
): string | null {
  // Collapse whitespace runs but keep the leading boundary.
  let continuation = raw.replace(/\s+/g, " ").trimEnd();
  const normDraft = draft.trim().replace(/\s+/g, " ");
  const unindented = continuation.trimStart();
  if (unindented.toLowerCase().startsWith(normDraft.toLowerCase())) {
    continuation = unindented.slice(normDraft.length);
  }
  if (!continuation.trim()) {
    return null; // empty, or echoed the draft and nothing more
  }
  const full = (draft + continuation).replace(/\s+/g, " ").trim();
  return full.length > draft.trim().length ? full : null;
}
