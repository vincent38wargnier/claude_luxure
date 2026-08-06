import { isCommonWord } from "../shared/vocabWeights";
import type { PromptHistoryEntry } from "../shared/types";

/**
 * Conversation-lane retrieval ("parallel chunk search"): finds past prompts
 * related to what the conversation is ABOUT, independent of the draft prefix.
 * The draft-keyed lane answers "prompts that start like this"; this lane
 * answers "prompts from the last time we worked on this topic" — the
 * session-context signal that query-auto-completion literature (context-
 * sensitive QAC, session-aware QAC) shows matters most when the typed prefix
 * is short.
 *
 * Pure lexical tf×idf — no embeddings, no I/O, deterministic given `now`
 * (same contract as vocabWeights so the battle harness can replay it).
 */

export interface ThreadTurn {
  role: string;
  text: string;
}

interface Term {
  word: string;
  weight: number;
}

const TOKEN_RE = /[a-z0-9][a-z0-9_.-]{2,}/g;
const MAX_TERMS = 12;
/** The last assistant reply is what the user's next prompt usually reacts
 * to — its terms count double. */
const LAST_ASSISTANT_BOOST = 2;
/** A candidate must share at least this much weighted evidence with the
 * conversation before it is worth showing the model. */
const MIN_SCORE = 3;
const MAX_RELATED_CHARS = 160;

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const w = m[0];
    if (w.length < 3 || isCommonWord(w) || /^\d+$/.test(w)) {
      continue;
    }
    out.push(w);
  }
  return out;
}

/** Salient terms of the conversation tail, weighted tf × idf against the
 * user's own prompt corpus — terms rare in their history dominate, so the
 * lane keys on "sacrieur"/"memwatch", never on "check"/"file". */
export function conversationTerms(
  conversation: ThreadTurn[],
  entries: PromptHistoryEntry[],
  cap = MAX_TERMS
): Term[] {
  if (conversation.length === 0 || entries.length === 0) {
    return [];
  }
  // Document frequency over the corpus.
  const df = new Map<string, number>();
  for (const entry of entries) {
    for (const w of new Set(tokens(entry.text))) {
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const n = entries.length;

  const lastAssistant = [...conversation]
    .reverse()
    .find((t) => t.role === "assistant");
  const tf = new Map<string, number>();
  for (const turn of conversation.slice(-4)) {
    const boost = turn === lastAssistant ? LAST_ASSISTANT_BOOST : 1;
    for (const w of tokens(turn.text)) {
      tf.set(w, (tf.get(w) ?? 0) + boost);
    }
  }

  const terms: Term[] = [];
  for (const [word, count] of tf) {
    const d = df.get(word) ?? 0;
    if (d === 0) {
      continue; // never used in a past prompt — nothing to retrieve with it
    }
    const idf = Math.log((n + 1) / (d + 1)) + 1;
    terms.push({ word, weight: count * idf });
  }
  terms.sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : 1));
  return terms.slice(0, cap);
}

/** Top past prompts related to the conversation, strongest first, excluding
 * anything already retrieved by the draft lane. Empty when the conversation
 * has no distinctive vocabulary yet — a silent lane, never a noisy one. */
export function rankThreadRelated(
  conversation: ThreadTurn[],
  entries: PromptHistoryEntry[],
  now: number,
  limit = 2,
  exclude: Set<string> = new Set()
): string[] {
  const terms = conversationTerms(conversation, entries);
  if (terms.length === 0) {
    return [];
  }
  const scored: { text: string; score: number; lastUsed: number }[] = [];
  for (const entry of entries) {
    const norm = entry.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (exclude.has(norm)) {
      continue;
    }
    const words = new Set(tokens(entry.text));
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (words.has(term.word)) {
        score += term.weight;
        matched++;
      }
    }
    if (matched === 0 || score < MIN_SCORE) {
      continue;
    }
    const ageDays = Math.max(0, (now - entry.lastUsed) / 86_400_000);
    if (ageDays < 7) {
      score *= 1.25; // same recency shape as the corrector weights
    }
    scored.push({ text: entry.text, score, lastUsed: entry.lastUsed });
  }
  scored.sort((a, b) => b.score - a.score || b.lastUsed - a.lastUsed);
  return scored.slice(0, limit).map((s) => s.text.slice(0, MAX_RELATED_CHARS));
}
