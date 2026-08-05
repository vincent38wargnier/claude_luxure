/**
 * Real-model A/B bench: does corrector-style steering (vocabulary hint in
 * the prompt + soft token bias) actually pull Qwen3.5-2B toward THIS
 * project's vocabulary, and what does it cost in latency?
 *
 * Uses the production LlmSuggester + the project's real transcript corpus.
 * Arms: baseline (no vocabulary) vs steered (vocabulary hint + token bias).
 *
 *   node llm_bench.mjs [--drafts N]
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  normalizePromptHistory,
  buildPhraseCorpus,
  rankPromptSuggestions,
} from "./.core.mjs";

const require = createRequire(import.meta.url);
const {
  loadPromptHistory,
  LlmSuggester,
  buildVocabModel,
  topProjectWords,
  isCommonWord,
} = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");

const DRAFTS = [
  "add a ",
  "check the ",
  "run the har",
  "improve the ",
  "fix the tab",
  "can you take a screen",
  "show me the ",
  "why does the ",
  "make the composer ",
  "update the suggestion ",
  "screenshot the ",
  "test the phrase ",
];

const CONVERSATION = [
  { role: "user", text: "we are improving the prompt suggestion menu in the composer" },
  { role: "assistant", text: "the lexical ranking and the magie row are wired; phrase chunks and vocab weights are next" },
];

const suggester = new LlmSuggester();
if (!suggester.available()) {
  console.log(JSON.stringify({ skipped: "model file missing" }));
  process.exit(0);
}

const entries = await loadPromptHistory(REPO);
if (entries.length === 0) {
  console.log(JSON.stringify({ skipped: "no transcript corpus" }));
  process.exit(0);
}
const ranked = normalizePromptHistory(entries);
const corpus = [...ranked, ...buildPhraseCorpus(ranked)];
const vocabModel = buildVocabModel(entries, Date.now());
const vocabulary = topProjectWords(vocabModel, 120).map((w) => ({
  word: w.word,
  weight: w.weight,
}));
const jargonSet = new Set(
  vocabulary.slice(0, 40).map((v) => v.word)
);

console.error(
  `corpus: ${entries.length} prompts (+${corpus.length - entries.length} phrases), vocab top: ${vocabulary
    .slice(0, 10)
    .map((v) => v.word)
    .join(", ")}`
);

function containsJargon(suggestion, draft) {
  if (!suggestion) return false;
  const continuation = suggestion.slice(draft.trim().length).toLowerCase();
  return continuation
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .some((w) => w.length >= 3 && jargonSet.has(w) && !isCommonWord(w));
}

async function runArm(name, vocab, vocabHint = false) {
  const rows = [];
  for (const draft of DRAFTS) {
    const examples = rankPromptSuggestions(draft, corpus, Date.now(), 5, vocabModel)
      .map((e) => e.text)
      .slice(0, 5);
    const t0 = Date.now();
    const suggestion = await suggester.suggest({
      draft,
      examples,
      conversation: CONVERSATION,
      vocabulary: vocab,
      vocabHint,
    });
    rows.push({
      draft,
      ms: Date.now() - t0,
      suggestion,
      jargon: containsJargon(suggestion, draft),
    });
    console.error(
      `  [${name}] ${String(rows[rows.length - 1].ms).padStart(4)}ms  "${draft}" → ${suggestion ?? "∅"}`
    );
  }
  return rows;
}

// Warm the model (load + Metal pipeline) outside timings.
await suggester.suggest({ draft: "warm up the ", examples: [], conversation: [] });

const baseline = await runArm("baseline ", undefined);
const biasOnly = await runArm("bias-only", vocabulary, false);
const hintBias = await runArm("hint+bias", vocabulary, true);

const stats = (rows) => {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    meanMs: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length),
    p95Ms: ms[Math.floor(ms.length * 0.95)],
    jargonRate: rows.filter((r) => r.jargon).length / rows.length,
    nullRate: rows.filter((r) => !r.suggestion).length / rows.length,
    quoteRate:
      rows.filter((r) => r.suggestion && r.suggestion.includes('"')).length /
      rows.length,
  };
};

const result = {
  drafts: DRAFTS.length,
  vocabWords: vocabulary.length,
  baseline: stats(baseline),
  biasOnly: stats(biasOnly),
  hintBias: stats(hintBias),
  details: { baseline, biasOnly, hintBias },
};
fs.mkdirSync(path.join(__dirname, "results"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "results/llm_bench.json"),
  JSON.stringify(result, null, 2)
);

const ok = result.biasOnly.meanMs < 400 && result.hintBias.meanMs < 400;
const fmt = (s) =>
  `jargon=${(s.jargonRate * 100).toFixed(0)}% null=${(s.nullRate * 100).toFixed(0)}% quotes=${(s.quoteRate * 100).toFixed(0)}% mean=${s.meanMs}ms`;
console.error(
  `\nbaseline : ${fmt(result.baseline)}\nbias-only: ${fmt(result.biasOnly)}\nhint+bias: ${fmt(result.hintBias)}`
);
console.log(JSON.stringify({ ...result, details: undefined, latencyOk: ok }));
process.exit(ok ? 0 : 1);
