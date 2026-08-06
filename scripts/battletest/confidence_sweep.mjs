/**
 * Confidence-truncation bench for the magie "continue" row.
 *
 * The leak audit showed the full guessed line (mean 7.4 words) starts wrong
 * 70% of the time — over-commitment, not model quality, is what reads as
 * "irrelevant". Fix: show only the confident span. This script tunes and
 * proves that policy on the real replay corpus, through the REAL production
 * LlmSuggester (.host.cjs bundle).
 *
 * Subcommands:
 *   dump    — run the production suggester over replay probes (fullDecode:
 *             all 24 tokens, no early stop) and dump per-word confidences.
 *             --engine session runs the legacy session.prompt path instead
 *             (no confidences) for the parity check.
 *             node confidence_sweep.mjs dump [--n 120] [--engine raw|session]
 *   parity  — diff the raw dump's full text against the session dump's.
 *             Validated 120/120 identical when the raw decoder shipped
 *             (2026-08-05, pre token-healing). Since token healing the raw
 *             path INTENTIONALLY diverges: it regenerates the draft's last
 *             word and suppresses on disagreement — so a re-run is expected
 *             to show diffs on exactly those probes, not decoder drift.
 *             node confidence_sweep.mjs parity
 *   sweep   — offline grid over (showFloor, extendFloor): show rate, shown-
 *             word precision, first-word accuracy, wrong words per row.
 *             node confidence_sweep.mjs sweep
 *
 * Needs results/probes.json (replay_eval.mjs --dump) and the 2B model.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { LlmSuggester, truncateAtConfidence } = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "sweep";
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const tok = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

function subsetProbes(n) {
  const probes = JSON.parse(
    fs.readFileSync(path.join(OUT_DIR, "probes.json"), "utf-8")
  );
  const step = Math.max(1, Math.floor(probes.length / n));
  return probes.filter((_, i) => i % step === 0).slice(0, n);
}

const dumpPath = (engine) => path.join(OUT_DIR, `conf_dump_${engine}.json`);

// ---------- dump ----------
async function dump() {
  const engine = arg("engine", "raw"); // matches CLAUDE_LUXURE_MAGIE_ENGINE
  if (engine === "session" && process.env.CLAUDE_LUXURE_MAGIE_ENGINE !== "session") {
    console.error("re-run with CLAUDE_LUXURE_MAGIE_ENGINE=session for --engine session");
    process.exit(1);
  }
  const subset = subsetProbes(Number(arg("n", "120")));
  const suggester = new LlmSuggester();
  if (!suggester.available()) {
    console.log(JSON.stringify({ skipped: "model file missing" }));
    return;
  }
  await suggester.suggestWithConfidence(
    { draft: "warm up the ", examples: [], conversation: [] },
    { fullDecode: true }
  );
  const rows = [];
  for (let i = 0; i < subset.length; i++) {
    const p = subset[i];
    const t0 = Date.now();
    const detail = await suggester.suggestWithConfidence(
      {
        draft: p.draft,
        examples: p.examples,
        conversation: p.conversation,
        recent: p.recent,
        vocabulary: p.vocabulary,
      },
      { fullDecode: true }
    );
    rows.push({
      draft: p.draft,
      truth: p.truth,
      full: detail?.full ?? null,
      words: detail?.words ?? [],
      ms: Date.now() - t0,
    });
    if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${subset.length}`);
  }
  fs.writeFileSync(dumpPath(engine), JSON.stringify(rows, null, 1));
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      engine,
      probes: rows.length,
      nullRate: +(rows.filter((r) => !r.full).length / rows.length).toFixed(3),
      meanMs: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length),
      p95Ms: ms[Math.floor(ms.length * 0.95)],
      out: dumpPath(engine),
    })
  );
}

// ---------- parity ----------
function parity() {
  const raw = JSON.parse(fs.readFileSync(dumpPath("raw"), "utf-8"));
  const ses = JSON.parse(fs.readFileSync(dumpPath("session"), "utf-8"));
  const n = Math.min(raw.length, ses.length);
  let same = 0;
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if ((raw[i].full ?? "") === (ses[i].full ?? "")) same++;
    else diffs.push({ draft: raw[i].draft, raw: raw[i].full, session: ses[i].full });
  }
  console.log(JSON.stringify({ probes: n, identical: same, rate: +(same / n).toFixed(3) }));
  for (const d of diffs.slice(0, 8)) {
    console.error(`  DRAFT ${d.draft}\n    raw: ${d.raw}\n    ses: ${d.session}`);
  }
}

// ---------- sweep ----------
function scoreShown(rows, showFloor, extendFloor) {
  let shown = 0;
  let shownWords = 0;
  let correctWords = 0;
  let firstWordHits = 0;
  let fullSpanHits = 0;
  let wrongWords = 0;
  for (const r of rows) {
    const cont = truncateAtConfidence(r.words, showFloor, extendFloor);
    if (!cont) continue;
    const sug = tok(cont);
    if (sug.length === 0) continue;
    shown++;
    const truthCont = tok(r.truth.slice(r.draft.length));
    let lcp = 0;
    while (lcp < sug.length && lcp < truthCont.length && sug[lcp] === truthCont[lcp]) lcp++;
    shownWords += sug.length;
    correctWords += lcp;
    wrongWords += sug.length - lcp;
    if (sug[0] === truthCont[0]) firstWordHits++;
    if (lcp === sug.length) fullSpanHits++;
  }
  const n = rows.length;
  return {
    show: showFloor,
    extend: extendFloor,
    showRate: +(shown / n).toFixed(3),
    meanShownWords: shown ? +(shownWords / shown).toFixed(2) : 0,
    wordPrecision: shownWords ? +(correctWords / shownWords).toFixed(3) : 0,
    firstWordAcc: shown ? +(firstWordHits / shown).toFixed(3) : 0,
    fullSpanRate: shown ? +(fullSpanHits / shown).toFixed(3) : 0,
    wrongWordsPerRow: shown ? +(wrongWords / shown).toFixed(2) : 0,
    correctWordsPerProbe: +(correctWords / n).toFixed(3),
  };
}

function sweep() {
  const rows = JSON.parse(fs.readFileSync(dumpPath("raw"), "utf-8"));
  const grid = [];
  for (const show of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const extend of [0, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      grid.push(scoreShown(rows, show, extend));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, "conf_sweep.json"), JSON.stringify(grid, null, 1));
  const cols = [
    "show", "extend", "showRate", "meanShownWords", "wordPrecision",
    "firstWordAcc", "fullSpanRate", "wrongWordsPerRow", "correctWordsPerProbe",
  ];
  console.log(cols.join("\t"));
  for (const g of grid) console.log(cols.map((c) => g[c]).join("\t"));
}

if (cmd === "dump") await dump();
else if (cmd === "parity") parity();
else sweep();
