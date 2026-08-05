/**
 * Corrector-style word-weight model over the user's own prompt corpus —
 * the "user dictionary" every mobile keyboard keeps, applied to prompting.
 *
 * Frequency (log-damped) × specificity (common English damped, so project
 * jargon gains weight fast) × recency. Weights feed three consumers:
 *   1. suggestion ranking (boost candidates that continue with the user's
 *      high-weight words / likely bigrams),
 *   2. the local LLM (vocabulary hint in the prompt + token bias),
 *   3. the battle-test simulator, which asserts the learning behaves.
 *
 * IMPORTANT: this file is mirrored byte-identically as
 * `src/shared/vocabWeights.ts` (extension host) and
 * `webview-ui/src/utils/vocabWeights.ts` (webview) — the repo has no shared
 * package between the two bundles (same convention as types.ts). It is
 * deliberately importless and side-effect free; `now` is always a parameter
 * so results are deterministic for the simulator. Edit both copies together
 * (the battle-test suite diffs them).
 */

export const VOCAB_WEIGHTS_VERSION = 1;

export interface VocabCorpusEntry {
  text: string;
  count: number;
  lastUsed: number;
}

export interface WordWeight {
  word: string;
  weight: number;
  count: number;
}

export interface VocabModel {
  /** word → weight (frequency × specificity × recency) */
  weights: Map<string, number>;
  /** word → total occurrences (each entry's occurrences × its send count) */
  counts: Map<string, number>;
  /** Words sorted by weight desc, capped — the "project vocabulary". */
  top: WordWeight[];
  /** prev word → next word → occurrences, for next-word boosts. */
  bigrams: Map<string, Map<string, number>>;
  totalWords: number;
}

/** ~420 highest-frequency English words plus coding-chat filler verbs.
 * These are damped, not excluded — "the" still counts, it just can't be
 * what personalization hangs on. Everything NOT here (composer, worktree,
 * paneTabs…) gets full weight, which is how project jargon wins fast. */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    "the be to of and a in that have i it for not on with he as you do at " +
    "this but his by from they we say her she or an will my one all would " +
    "there their what so up out if about who get which go me when make can " +
    "like time no just him know take people into year your good some could " +
    "them see other than then now look only come its over think also back " +
    "after use two how our work first well way even new want because any " +
    "these give day most us is was are were been has had did says said got " +
    "made went gone came those may might must shall should would could need " +
    "needs needed very really quite too much many few little more less own " +
    "same different such here where why while before during again still " +
    "always never sometimes often each every both several all any some none " +
    "everything something anything nothing everyone someone anyone let lets " +
    "please thanks thank yes yeah no okay ok right left top bottom next last " +
    "off down under above below between through around against within " +
    "without across behind beyond near far away once twice keep keeps kept " +
    "put puts start starts started stop stops stopped end ends ended open " +
    "opens opened close closes closed turn turns turned show shows showed " +
    "shown find finds found give gives given tell tells told ask asks asked " +
    "seem seems seemed feel feels felt try tries tried call calls called " +
    "leave leaves left move moves moved play plays played run runs ran " +
    "believe hold holds held bring brings brought happen happens happened " +
    "write writes wrote written sit sits sat stand stands stood lose loses " +
    "lost pay pays paid meet meets met include includes included continue " +
    "continues continued set sets change changes changed lead leads led " +
    "understand understands understood watch watches watched follow follows " +
    "followed create creates created speak speaks spoke read reads add adds " +
    "added remove removes removed fix fixes fixed check checks checked test " +
    "tests tested update updates updated build builds built make makes " +
    "making improve improves improved delete deletes deleted rename renamed " +
    "refactor implement implements implemented instead maybe actually " +
    "basically currently probably possibly definitely exactly directly " +
    "correctly properly slightly small big large long short high low fast " +
    "slow easy hard simple complex better best worse worst wrong broken " +
    "working works worked done doing does file files code line lines word " +
    "words name names part parts thing things case cases point points " +
    "issue issues problem problems error errors bug bugs way ways type " +
    "types kind kinds bit bits lot lots side sides place places number " +
    "numbers example examples list lists item items text texts page pages " +
    "user users data version versions result results state states value " +
    "values order key keys not dont doesnt didnt isnt arent wasnt werent " +
    "wont cant couldnt shouldnt wouldnt havent hasnt hadnt im ive youre " +
    "youve hes shes its were theyre theyve thats whats heres theres wheres " +
    "and/or etc via per using used uses"
  ).split(/\s+/)
);

const MIN_WORD_LEN = 3;
const MAX_WORD_LEN = 30;
const TOP_CAP = 400;
const COMMON_DAMP = 0.3;

function stripEdgePunct(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Lexicon tokens of a prompt: lowercased words, edge punctuation stripped.
 * Skips URLs, pure numbers, and path-length monsters. */
export function vocabTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (raw.includes("://")) continue;
    const w = stripEdgePunct(raw);
    if (w.length < MIN_WORD_LEN || w.length > MAX_WORD_LEN) continue;
    if (!/\p{L}/u.test(w)) continue; // "42", "3.5" alone teach nothing
    out.push(w);
  }
  return out;
}

function recencyMult(lastUsed: number, now: number): number {
  const ageDays = Math.max(0, now - lastUsed) / 86_400_000;
  if (ageDays < 7) return 1.25;
  if (ageDays < 30) return 1.1;
  return 1.0;
}

/** Build the weight model from the prompt corpus. Deterministic in
 * (entries, now). O(total words) — cheap enough to rebuild on corpus change
 * (a 3000-prompt corpus is ~30k words). */
export function buildVocabModel(
  entries: VocabCorpusEntry[],
  now: number
): VocabModel {
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  const bigrams = new Map<string, Map<string, number>>();
  let totalWords = 0;

  for (const entry of entries) {
    const words = vocabTokens(entry.text);
    const mult = Math.max(1, entry.count);
    totalWords += words.length * mult;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      counts.set(w, (counts.get(w) ?? 0) + mult);
      const seen = lastSeen.get(w);
      if (seen === undefined || entry.lastUsed > seen) {
        lastSeen.set(w, entry.lastUsed);
      }
      if (i > 0) {
        const prev = words[i - 1];
        let nexts = bigrams.get(prev);
        if (!nexts) {
          nexts = new Map();
          bigrams.set(prev, nexts);
        }
        nexts.set(w, (nexts.get(w) ?? 0) + mult);
      }
    }
  }

  const weights = new Map<string, number>();
  for (const [word, count] of counts) {
    const specificity = COMMON_WORDS.has(word) ? COMMON_DAMP : 1.0;
    const recency = recencyMult(lastSeen.get(word) ?? 0, now);
    weights.set(word, Math.log(1 + count) * specificity * recency);
  }

  const top = [...weights.entries()]
    .map(([word, weight]) => ({ word, weight, count: counts.get(word) ?? 0 }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count)
    .slice(0, TOP_CAP);

  return { weights, counts, top, bigrams, totalWords };
}

/** The project's distinctive vocabulary: top words that are NOT common
 * English and appeared at least `minCount` times. This is what gets fed to
 * the LLM (prompt hint + token bias). */
export function topProjectWords(
  model: VocabModel,
  k: number,
  minCount = 2
): WordWeight[] {
  const out: WordWeight[] = [];
  for (const ww of model.top) {
    if (COMMON_WORDS.has(ww.word) || ww.count < minCount) continue;
    out.push(ww);
    if (out.length >= k) break;
  }
  return out;
}

/** Ranking boost for a suggestion candidate: how much of the user's
 * high-weight vocabulary its *continuation* (words beyond the draft)
 * carries. Capped so it re-orders within a match tier but never jumps one
 * (tiers are 30/60/100; recency+frequency add ≤~30). */
export function candidateVocabBoost(
  model: VocabModel,
  candidateNorm: string,
  draftNorm: string
): number {
  const draftWords = new Set(vocabTokens(draftNorm));
  let boost = 0;
  const seen = new Set<string>();
  for (const w of vocabTokens(candidateNorm)) {
    if (draftWords.has(w) || seen.has(w)) continue;
    seen.add(w);
    const weight = model.weights.get(w);
    if (weight !== undefined && !COMMON_WORDS.has(w)) {
      boost += weight;
    }
  }
  return Math.min(10, boost * 1.2);
}

/** Bigram continuation boost: the draft's last complete word predicts the
 * candidate's next word (classic corrector next-word logic). Only defined
 * for prefix-tier candidates, where "next word" is unambiguous. */
export function bigramContinuationBoost(
  model: VocabModel,
  candidateNorm: string,
  draftNorm: string
): number {
  const draft = draftNorm.trim();
  if (!draft || !candidateNorm.startsWith(draft)) return 0;
  const rest = candidateNorm.slice(draft.length);
  if (!rest.startsWith(" ")) return 0; // mid-word: prefix tier handles it
  const draftWords = vocabTokens(draft);
  const prev = draftWords[draftWords.length - 1];
  if (!prev) return 0;
  const next = vocabTokens(rest)[0];
  if (!next) return 0;
  const n = model.bigrams.get(prev)?.get(next) ?? 0;
  if (n >= 5) return 6;
  if (n >= 2) return 4;
  return 0;
}

/** True when the word is in the damped common-English list — exported so
 * consumers (and tests) share one definition of "common". */
export function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word);
}
