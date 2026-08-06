/**
 * Fits the ranking-fusion weights (RankWeights) on the REAL prompt corpus —
 * the data-driven interpolation the cache-LM / Gboard literature prescribes
 * instead of hand-tuned constants.
 *
 * Replays real prompts cut at word boundaries; for each candidate weight
 * config, ranks the true corpus-as-of-then and measures:
 *   MRR@5   reciprocal rank of the first USEFUL row (a row that extends the
 *           draft with the same next word the user actually typed, or is the
 *           verbatim prompt)
 *   exact@5 verbatim-prompt recall in the top 5
 *
 * Deterministic seeded random search, train (even probes) / held-out (odd
 * probes) split. Search bounds encode prior battle-test findings as
 * constraints (mruBonus ≥ 2, phrasePenalty ≥ 2).
 *
 *   node tune_weights.mjs [--configs 400]
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  normalizePromptHistory,
  buildPhraseCorpus,
  rankPromptSuggestions,
  DEFAULT_RANK_WEIGHTS,
} from "./.core.mjs";

const require = createRequire(import.meta.url);
const { buildVocabModel } = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const N_CONFIGS = Number(argv[argv.indexOf("--configs") + 1] || "400");

// ---------- probes (same construction as replay_eval.mjs) ----------
const rows = fs
  .readFileSync(path.join(OUT_DIR, "all_turns.jsonl"), "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byProject = new Map();
for (const r of rows) {
  if (!byProject.has(r.project)) byProject.set(r.project, []);
  byProject.get(r.project).push(r);
}
for (const list of byProject.values()) list.sort((a, b) => a.ts - b.ts);

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => s.split(/\s+/).filter(Boolean);
const tok = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

function rawPrefix(text, k) {
  const re = /\S+/g;
  let m;
  let count = 0;
  while ((m = re.exec(text))) {
    count++;
    if (count === k) return text.slice(0, m.index + m[0].length);
  }
  return text;
}

const candidates = [];
for (const [project, list] of byProject) {
  const users = list.filter((r) => r.role === "user" && r.reusable);
  const seen = new Map();
  for (const r of users) {
    const w = words(r.text);
    if (r.text.includes("\n")) continue;
    if (w.length < 6 || w.length > 45 || r.text.length > 260) continue;
    if (users.filter((u) => u.ts < r.ts).length < 10) continue;
    seen.set(norm(r.text), { ...r, project });
  }
  candidates.push([...seen.values()].sort((a, b) => b.ts - a.ts));
}
candidates.sort((a, b) => (b[0]?.ts ?? 0) - (a[0]?.ts ?? 0));
const prompts = [];
for (let i = 0; prompts.length < 100; i++) {
  let took = false;
  for (const list of candidates) {
    if (list[i] && prompts.length < 100) {
      prompts.push(list[i]);
      took = true;
    }
  }
  if (!took) break;
}
const probes = prompts.flatMap((p) => {
  const w = words(p.text);
  const cuts = new Set([3, Math.min(w.length - 2, Math.max(4, Math.floor(w.length * 0.6)))]);
  return [...cuts].map((k) => ({ ...p, draft: rawPrefix(p.text, k) }));
});

// ---------- config-independent per-probe context (built once) ----------
console.error(`preparing ${probes.length} probe contexts…`);
const contexts = probes.map((probe) => {
  const list = byProject.get(probe.project);
  const byNorm = new Map();
  for (const u of list) {
    if (u.role !== "user" || !u.reusable || u.ts >= probe.ts) continue;
    const n = norm(u.text);
    const e = byNorm.get(n);
    if (e) {
      e.count++;
      if (u.ts > e.lastUsed) {
        e.lastUsed = u.ts;
        e.text = u.text;
      }
    } else {
      byNorm.set(n, { text: u.text, count: 1, lastUsed: u.ts });
    }
  }
  const entries = [...byNorm.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  const ranked = normalizePromptHistory(entries);
  const corpus = [...ranked, ...buildPhraseCorpus(ranked)];
  const vocabModel = buildVocabModel(entries, probe.ts);
  const draftNorm = norm(probe.draft);
  const truthNorm = norm(probe.text);
  const truthNextWord = tok(probe.text.slice(probe.draft.length))[0] ?? null;
  return { corpus, vocabModel, draftNorm, truthNorm, truthNextWord, probe };
});

// ---------- scoring ----------
function evaluate(weights, subset) {
  let mrrSum = 0;
  let exactHits = 0;
  for (const ctx of subset) {
    const rows5 = rankPromptSuggestions(
      ctx.probe.draft,
      ctx.corpus,
      ctx.probe.ts,
      5,
      ctx.vocabModel,
      weights
    );
    let mrr = 0;
    for (let r = 0; r < rows5.length; r++) {
      const rn = rows5[r].norm;
      const isExact = rn === ctx.truthNorm;
      const extendsDraft = rn.startsWith(ctx.draftNorm) && rn.length > ctx.draftNorm.length;
      const nextWord = extendsDraft
        ? tok(rn.slice(ctx.draftNorm.length))[0] ?? null
        : null;
      if (isExact || (ctx.truthNextWord && nextWord === ctx.truthNextWord)) {
        mrr = 1 / (r + 1);
        if (isExact) exactHits++;
        break;
      }
      if (isExact) exactHits++;
    }
    mrrSum += mrr;
  }
  return {
    mrr: mrrSum / subset.length,
    exactAt5: exactHits / subset.length,
  };
}

// ---------- deterministic random search ----------
let seed = 1234567;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const range = (lo, hi) => lo + rand() * (hi - lo);

function sampleConfig() {
  return {
    contiguous: Math.round(range(0, 30)),
    phrasePenalty: Math.round(range(2, 14)), // battle-test: keep whole-prompt preference
    recencyBase: Math.round(range(4, 24)),
    recencyLog: +range(0.5, 6).toFixed(1),
    mruBonus: Math.round(range(2, 10)), // battle-test: MRU fix stays
    freqScale: +range(0.5, 10).toFixed(1),
    vocabScale: +range(0, 3).toFixed(2),
    bigramScale: +range(0, 3).toFixed(2),
  };
}

const train = contexts.filter((_, i) => i % 2 === 0);
const held = contexts.filter((_, i) => i % 2 === 1);

const baselineTrain = evaluate(DEFAULT_RANK_WEIGHTS, train);
const baselineHeld = evaluate(DEFAULT_RANK_WEIGHTS, held);
console.error(
  `baseline (hand-tuned): train MRR ${baselineTrain.mrr.toFixed(4)} exact@5 ${baselineTrain.exactAt5.toFixed(3)} | held MRR ${baselineHeld.mrr.toFixed(4)} exact@5 ${baselineHeld.exactAt5.toFixed(3)}`
);

const t0 = Date.now();
const results = [];
for (let i = 0; i < N_CONFIGS; i++) {
  const config = sampleConfig();
  const score = evaluate(config, train);
  results.push({ config, train: score });
  if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${N_CONFIGS} configs`);
}
results.sort(
  (a, b) => b.train.mrr - a.train.mrr || b.train.exactAt5 - a.train.exactAt5
);
const top = results.slice(0, 8).map((r) => ({
  ...r,
  held: evaluate(r.config, held),
}));

console.error(`\nsearch: ${N_CONFIGS} configs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.error("top configs (by train MRR) with held-out scores:");
for (const t of top) {
  console.error(
    `  train ${t.train.mrr.toFixed(4)} | held ${t.held.mrr.toFixed(4)} exact ${t.held.exactAt5.toFixed(3)} | ${JSON.stringify(t.config)}`
  );
}

const out = {
  probes: probes.length,
  baseline: { config: DEFAULT_RANK_WEIGHTS, train: baselineTrain, held: baselineHeld },
  top,
};
fs.writeFileSync(path.join(OUT_DIR, "tune_weights.json"), JSON.stringify(out, null, 1));
console.log(
  JSON.stringify({
    baselineHeldMrr: +baselineHeld.mrr.toFixed(4),
    bestHeldMrr: +top[0].held.mrr.toFixed(4),
    relGain: +((top[0].held.mrr - baselineHeld.mrr) / Math.max(1e-9, baselineHeld.mrr)).toFixed(3),
    best: top[0].config,
  })
);
