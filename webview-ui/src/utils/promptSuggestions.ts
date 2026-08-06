import type { PromptHistoryEntry } from "../types";
import {
  bigramContinuationBoost,
  candidateVocabBoost,
  type VocabModel,
} from "./vocabWeights";

/**
 * Ranking for the composer's past-prompt suggestions, over TWO granularities
 * at once (parent-document-retrieval style): whole past prompts, plus the
 * phrases inside them — so a gem buried mid-prompt is still recallable.
 * Lexical match tiers (prefix > word-prefix > substring) with recency,
 * repeat-count, and corrector-style vocabulary-weight boosts. Runs on every
 * keystroke over the whole corpus, so entries carry their normalized text
 * precomputed instead of lowercasing per key.
 */
export interface RankedPrompt extends PromptHistoryEntry {
  norm: string;
  /** undefined = whole prompt; "phrase" = a sub-unit extracted from one. */
  unit?: "phrase";
  /** For phrases: the most recent full prompt it was extracted from. */
  parent?: string;
}

/** One row of the composer suggestion menu: a past prompt from history, or
 * the local LLM's ("magie") completion of the draft. The magie row carries
 * word-provenance segments so the menu can render copied vs invented words
 * differently. */
// `expand: true` marks the rewrite row — the LLM's clean version of rough
// notes, which replaces the phrase instead of extending it.
export type SuggestionRow =
  | { kind: "history"; entry: RankedPrompt }
  | { kind: "magie"; text: string; segments: MagieSegment[]; expand?: boolean };

/** A run of the magie suggestion: `novel` words were introduced by the LLM
 * (from conversation context or its own phrasing); the rest are traceable to
 * the retrieved past prompts or to what the user had already typed. */
export interface MagieSegment {
  text: string;
  novel: boolean;
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Word-level provenance of the magie suggestion against what the model was
 * given: the draft and the retrieved examples. Comparison is case- and
 * punctuation-insensitive; pure-punctuation tokens count as copied so bold
 * only ever lands on real words. Whitespace merges into the preceding run,
 * keeping segments contiguous for rendering. */
export function attributeMagieWords(
  suggestion: string,
  sources: string[]
): MagieSegment[] {
  const known = new Set<string>();
  for (const source of sources) {
    for (const word of source.split(/\s+/)) {
      const w = normalizeWord(word);
      if (w) known.add(w);
    }
  }

  const segments: MagieSegment[] = [];
  for (const piece of suggestion.split(/(\s+)/)) {
    if (!piece) continue;
    const last = segments[segments.length - 1];
    if (/^\s+$/.test(piece)) {
      if (last) last.text += piece;
      else segments.push({ text: piece, novel: false });
      continue;
    }
    const w = normalizeWord(piece);
    const novel = w ? !known.has(w) : false;
    if (last && last.novel === novel) last.text += piece;
    else segments.push({ text: piece, novel });
  }
  return segments;
}

const MAX_CORPUS = 3000;
const MAX_PHRASES = 6000;
const MIN_PHRASE_LEN = 12;
const MAX_PHRASE_LEN = 200;
const MIN_PHRASE_WORDS = 3;
/** At most this many phrase rows among the returned suggestions — whole
 * prompts are the primary product; phrases fill in, never take over. */
const MAX_PHRASE_ROWS = 2;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizePromptHistory(
  entries: PromptHistoryEntry[]
): RankedPrompt[] {
  return entries.map((e) => ({ ...e, norm: normalize(e.text) }));
}

/** Sentence/clause boundaries plus newlines; bullets and leading connectors
 * are stripped afterwards so the chunk reads as an insertable phrase. */
const PHRASE_SPLIT = /\n+|(?<=[.!?])\s+|;\s+/;
const LEADING_NOISE = /^(?:[-*•]\s+|\d+[.)]\s+)?(?:(?:and|then|also|but|so|or)\s+)?/i;

/** The phrase pool: sub-units of every prompt, deduped across parents
 * (same phrase in many prompts → counts add up, which doubles as template
 * mining), excluding anything that already exists as a whole prompt. */
export function buildPhraseCorpus(entries: RankedPrompt[]): RankedPrompt[] {
  const promptNorms = new Set(entries.map((e) => e.norm));
  const byNorm = new Map<string, RankedPrompt>();

  for (const entry of entries) {
    if (entry.text.includes("```")) continue; // code blocks aren't phrases
    for (const rawPiece of entry.text.split(PHRASE_SPLIT)) {
      const piece = rawPiece.replace(LEADING_NOISE, "").trim();
      if (piece.length < MIN_PHRASE_LEN || piece.length > MAX_PHRASE_LEN) {
        continue;
      }
      const norm = normalize(piece);
      if (promptNorms.has(norm)) continue; // the whole-prompt entry wins
      if (norm.split(" ").length < MIN_PHRASE_WORDS) continue;

      const existing = byNorm.get(norm);
      if (existing) {
        existing.count += entry.count;
        if (entry.lastUsed > existing.lastUsed) {
          existing.lastUsed = entry.lastUsed;
          existing.text = piece;
          existing.parent = entry.text;
        }
      } else {
        byNorm.set(norm, {
          text: piece,
          norm,
          count: entry.count,
          lastUsed: entry.lastUsed,
          unit: "phrase",
          parent: entry.text,
        });
      }
    }
  }

  return [...byNorm.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_PHRASES);
}

/** The just-sent prompt becomes suggestible immediately, without waiting for
 * a transcript rescan: bump its entry or prepend a fresh one. */
export function recordSentPrompt(
  entries: RankedPrompt[],
  text: string
): RankedPrompt[] {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 1500) {
    return entries;
  }
  const norm = normalize(trimmed);
  const existing = entries.find((e) => e.norm === norm);
  const rest = entries.filter((e) => e.norm !== norm);
  const updated: RankedPrompt = existing
    ? { ...existing, text: trimmed, count: existing.count + 1, lastUsed: Date.now() }
    : { text: trimmed, norm, count: 1, lastUsed: Date.now() };
  return [updated, ...rest].slice(0, MAX_CORPUS);
}

/** Word starts at the string head or after a space (norm collapsed spaces). */
function matchesWordStart(norm: string, token: string): boolean {
  return norm.startsWith(token) || norm.includes(" " + token);
}

/** The interpolation weights that fuse the ranking signals (match tier +
 * recency + frequency + word-weight boosts) — the λs of a cache-LM-style
 * mixture. Exposed so scripts/battletest/tune_weights.mjs can FIT them on
 * the real replay corpus instead of hand-guessing; production always uses
 * DEFAULT_RANK_WEIGHTS. */
export interface RankWeights {
  /** Bonus when the whole query appears contiguously (base < 100). */
  contiguous: number;
  /** How far a phrase chunk ranks under its whole-prompt siblings. */
  phrasePenalty: number;
  /** Recency curve: max(0, recencyBase − recencyLog·log2(1+ageDays)). */
  recencyBase: number;
  recencyLog: number;
  /** Extra for entries used within the last day (the MRU battle-test fix —
   * keep ≥ 2 or same-session phrases lose to aged lookalikes). */
  mruBonus: number;
  /** frequency = freqScale · log2(1 + min(count, 16)). */
  freqScale: number;
  /** Multipliers on the corrector word-weight boosts. */
  vocabScale: number;
  bigramScale: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  contiguous: 15,
  phrasePenalty: 6,
  recencyBase: 14,
  recencyLog: 3,
  mruBonus: 4,
  freqScale: 4,
  vocabScale: 1,
  bigramScale: 1,
};

export function rankPromptSuggestions(
  query: string,
  entries: RankedPrompt[],
  now: number,
  limit = 5,
  vocab?: VocabModel,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS
): RankedPrompt[] {
  const nq = normalize(query);
  if (!nq) {
    return [];
  }
  const tokens = nq.split(" ");

  const scored: { entry: RankedPrompt; score: number }[] = [];
  for (const entry of entries) {
    if (entry.norm === nq) {
      continue; // suggesting exactly what's already typed helps nobody
    }

    let base = 0;
    if (entry.norm.startsWith(nq)) {
      base = 100;
    } else if (tokens.every((t) => matchesWordStart(entry.norm, t))) {
      base = 60;
    } else if (tokens.every((t) => entry.norm.includes(t))) {
      base = 30;
    } else {
      continue;
    }
    // Contiguous phrase match anywhere beats scattered tokens.
    if (base < 100 && nq.length >= 6 && entry.norm.includes(nq)) {
      base += weights.contiguous;
    }
    // Whole prompts are the primary product; at equal evidence a phrase
    // chunk ranks just under its full-prompt siblings.
    if (entry.unit === "phrase") {
      base -= weights.phrasePenalty;
    }

    const ageDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
    // MRU bonus: what was sent within the last day (usually this session)
    // is the most likely re-send — it must beat week-old repeated prompts
    // even through the phrase penalty. Battle-test finding: without this,
    // a phrase from the current session lost to aged lookalikes on short
    // ambiguous drafts.
    const recency =
      Math.max(
        0,
        weights.recencyBase - weights.recencyLog * Math.log2(1 + ageDays)
      ) + (ageDays < 1 ? weights.mruBonus : 0);
    const frequency =
      weights.freqScale * Math.log2(1 + Math.min(entry.count, 16));

    // Corrector-style personalization: candidates whose continuation carries
    // the user's high-weight project words (and likely next words) win ties
    // within a match tier.
    let vocabBoost = 0;
    if (vocab) {
      vocabBoost =
        weights.vocabScale * candidateVocabBoost(vocab, entry.norm, nq) +
        (base >= 94
          ? weights.bigramScale * bigramContinuationBoost(vocab, entry.norm, nq)
          : 0);
    }

    scored.push({ entry, score: base + recency + frequency + vocabBoost });
  }

  scored.sort(
    (a, b) => b.score - a.score || b.entry.lastUsed - a.entry.lastUsed
  );

  // Diversity cap: phrases fill at most MAX_PHRASE_ROWS of the result.
  const out: RankedPrompt[] = [];
  let phrases = 0;
  for (const s of scored) {
    if (s.entry.unit === "phrase") {
      if (phrases >= MAX_PHRASE_ROWS) continue;
      phrases++;
    }
    out.push(s.entry);
    if (out.length >= limit) break;
  }
  return out;
}
