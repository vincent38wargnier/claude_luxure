/**
 * End-to-end proof on SHIPPED code: replays real probes (results/probes.json,
 * from replay_eval.mjs --dump) through the production LlmSuggester bundled in
 * .host.cjs — same class, same prompt builder, same prefill — and scores
 * against what the user actually typed.
 *
 * Since the confidence gate, production shows only the model's CONFIDENT
 * SPAN (or nothing) — so the honest metrics are show rate, precision of what
 * is shown, and latency (early-stop makes suppressed rows the fastest).
 * The ungated ~25% next-word parity lives in confidence_sweep.mjs (fullDecode
 * dump); the raw-vs-session decoder parity check lives there too.
 *
 *   node prod_replay.mjs [--n 60]
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { LlmSuggester } = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf("--n") + 1] || "60");

const probes = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "probes.json"), "utf-8"));
const step = Math.max(1, Math.floor(probes.length / N));
const subset = probes.filter((_, i) => i % step === 0).slice(0, N);

const tok = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

function score(draft, truthFull, suggestion) {
  const truthCont = tok(truthFull.slice(draft.length));
  if (!suggestion)
    return { null: true, nextWord: false, lcp: 0, f1: 0, nWords: 0 };
  const sugCont = tok(suggestion.slice(Math.min(draft.trim().length, suggestion.length)));
  if (sugCont.length === 0)
    return { null: true, nextWord: false, lcp: 0, f1: 0, nWords: 0 };
  let lcp = 0;
  while (lcp < sugCont.length && lcp < truthCont.length && sugCont[lcp] === truthCont[lcp]) lcp++;
  const truthWindow = truthCont.slice(0, 15);
  const sugSet = new Map();
  for (const w of sugCont) sugSet.set(w, (sugSet.get(w) ?? 0) + 1);
  let overlap = 0;
  for (const w of truthWindow) {
    const c = sugSet.get(w) ?? 0;
    if (c > 0) {
      overlap++;
      sugSet.set(w, c - 1);
    }
  }
  const p = overlap / sugCont.length;
  const r = overlap / Math.max(1, truthWindow.length);
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return {
    null: false,
    nextWord: sugCont[0] === truthCont[0],
    lcp,
    f1,
    nWords: sugCont.length,
  };
}

const suggester = new LlmSuggester();
if (!suggester.available()) {
  console.log(JSON.stringify({ skipped: "model file missing" }));
  process.exit(0);
}

// Warm load + Metal pipeline outside timings.
await suggester.suggest({ draft: "warm up the ", examples: [], conversation: [] });

const results = [];
for (let i = 0; i < subset.length; i++) {
  const p = subset[i];
  const t0 = Date.now();
  const detail = await suggester.suggestWithConfidence({
    draft: p.draft,
    examples: p.examples,
    conversation: p.conversation,
    recent: p.recent,
    vocabulary: p.vocabulary,
  });
  const rows = detail?.rows ?? [];
  const suggestion = rows[0]?.text ?? null;
  // recall@k: is the word the user actually typed next offered by ANY of
  // the candidate rows' first continuation words?
  const truthNext = tok(p.truth.slice(p.draft.length))[0];
  const rowFirstWords = rows.map(
    (r) => tok(r.text.slice(Math.min(p.draft.trim().length, r.text.length)))[0]
  );
  results.push({
    draft: p.draft,
    truth: p.truth,
    suggestion,
    rows,
    anyRowHit: truthNext != null && rowFirstWords.includes(truthNext),
    ms: Date.now() - t0,
    ...score(p.draft, p.truth, suggestion),
  });
  if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${subset.length}`);
}

const n = results.length;
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const shown = results.filter((r) => !r.null);
const shownWords = shown.reduce((s, r) => s + r.nWords, 0);
const withRows = results.filter((r) => r.rows.length > 0);
const agg = {
  arm: "prod:shipped(candidate-rows)",
  probes: n,
  blockShowRate: +(withRows.length / n).toFixed(3),
  meanRows: withRows.length
    ? +(
        withRows.reduce((s, r) => s + r.rows.length, 0) / withRows.length
      ).toFixed(2)
    : 0,
  recall3Shown: withRows.length
    ? +(
        withRows.filter((r) => r.anyRowHit).length / withRows.length
      ).toFixed(3)
    : 0,
  recall3All: +(results.filter((r) => r.anyRowHit).length / n).toFixed(3),
  showRate: +(shown.length / n).toFixed(3),
  firstWordAccShown: +(
    shown.filter((r) => r.nextWord).length / Math.max(1, shown.length)
  ).toFixed(3),
  fullSpanRateShown: +(
    shown.filter((r) => r.lcp === r.nWords).length / Math.max(1, shown.length)
  ).toFixed(3),
  meanShownWords: shown.length
    ? +(shownWords / shown.length).toFixed(2)
    : 0,
  wordPrecisionShown: shownWords
    ? +(shown.reduce((s, r) => s + r.lcp, 0) / shownWords).toFixed(3)
    : 0,
  meanMs: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length),
  p95Ms: ms[Math.floor(ms.length * 0.95)],
};
fs.writeFileSync(
  path.join(OUT_DIR, "replay_prod_shipped.json"),
  JSON.stringify({ agg, results }, null, 1)
);
for (const r of results.slice(0, 8)) {
  console.error(
    `  "${r.draft.slice(0, 50)}" → ${r.suggestion ? r.suggestion.slice(r.draft.length, r.draft.length + 60) : "∅"}`
  );
}
console.log(JSON.stringify(agg));
