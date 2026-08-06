/**
 * Expand-mode eval ("type main words, get the clean prompt"): takes REAL
 * prompts the user sent, strips them down to their content words (what a
 * hurried user would type), runs the production LlmSuggester in kind:
 * "expand", and scores the reconstruction against the prompt they actually
 * wrote.
 *
 * Metrics:
 *   keywordKeep  fraction of the typed keywords surviving in the output —
 *                the feature is useless if the user's specifics get dropped
 *   f1           token F1 vs the real prompt (did it add the right glue?)
 *   vs baseline  the keywords string itself scored the same way — the LLM
 *                must beat raw notes to earn the row
 *
 *   node expand_eval.mjs [--n 60]
 *
 * Reads results/probes.json (replay_eval.mjs --dump). Writes
 * results/expand_eval.json.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { LlmSuggester, isCommonWord } = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf("--n") + 1] || "60");

const probes = JSON.parse(
  fs.readFileSync(path.join(OUT_DIR, "probes.json"), "utf-8")
);

const tok = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}@/.]+$/gu, ""))
    .filter(Boolean);

/** What a hurried user would type: the content words of the real prompt, in
 * order — common English dropped, specifics (paths, names, jargon) kept. */
function keywordsOf(text) {
  const words = tok(text).filter(
    (w) => w.length >= 3 && (!isCommonWord(w) || w.includes("/") || w.includes("@"))
  );
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

function scoreVsTruth(output, truth, keywords) {
  if (!output) return { null: true, keywordKeep: 0, f1: 0 };
  const outToks = tok(output);
  const outSet = new Set(outToks);
  const keep =
    keywords.length === 0
      ? 0
      : keywords.filter((k) => outSet.has(k)).length / keywords.length;
  const truthToks = tok(truth);
  const bag = new Map();
  for (const w of outToks) bag.set(w, (bag.get(w) ?? 0) + 1);
  let overlap = 0;
  for (const w of truthToks) {
    const c = bag.get(w) ?? 0;
    if (c > 0) {
      overlap++;
      bag.set(w, c - 1);
    }
  }
  const p = outToks.length ? overlap / outToks.length : 0;
  const r = truthToks.length ? overlap / truthToks.length : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { null: false, keywordKeep: +keep.toFixed(3), f1: +f1.toFixed(3) };
}

// Deterministic subset with enough substance to have ≥4 keywords.
const cases = [];
for (const p of probes) {
  if (p.cut !== 3) continue; // one case per prompt, not per cut point
  const kw = keywordsOf(p.truth);
  if (kw.length < 4) continue;
  cases.push({ ...p, keywords: kw });
  if (cases.length >= N) break;
}

const suggester = new LlmSuggester();
if (!suggester.available()) {
  console.log(JSON.stringify({ skipped: "model file missing" }));
  process.exit(0);
}
await suggester.suggest({ draft: "warm up the ", examples: [], conversation: [] });

const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const draft = c.keywords.join(" ");
  const t0 = Date.now();
  const output = await suggester.suggest({
    draft,
    kind: "expand",
    examples: c.examples,
    conversation: c.conversation,
    recent: c.recent,
    vocabulary: c.vocabulary,
  });
  const ms = Date.now() - t0;
  results.push({
    keywords: draft,
    truth: c.truth,
    output,
    ms,
    ...scoreVsTruth(output, c.truth, c.keywords),
    baseline: scoreVsTruth(draft, c.truth, c.keywords),
  });
  if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${cases.length}`);
}

const n = results.length;
const nn = results.filter((r) => !r.null);
const ms = nn.map((r) => r.ms).sort((a, b) => a - b);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const agg = {
  arm: "prod:expand",
  cases: n,
  nullRate: +((n - nn.length) / n).toFixed(3),
  keywordKeep: +mean(nn.map((r) => r.keywordKeep)).toFixed(3),
  f1: +mean(nn.map((r) => r.f1)).toFixed(3),
  baselineF1: +mean(results.map((r) => r.baseline.f1)).toFixed(3),
  meanMs: Math.round(mean(ms)),
  p95Ms: ms[Math.floor(ms.length * 0.95)] ?? 0,
};
fs.writeFileSync(
  path.join(OUT_DIR, "expand_eval.json"),
  JSON.stringify({ agg, results }, null, 1)
);
for (const r of results.slice(0, 8)) {
  console.error(`  KW    : ${r.keywords}`);
  console.error(`  OUT   : ${(r.output ?? "∅").slice(0, 100)}`);
  console.error(`  TRUTH : ${r.truth.slice(0, 100)}`);
  console.error("");
}
console.log(JSON.stringify(agg));
