/**
 * Battle-test runner: executes property self-tests and simulated scenarios
 * against the REAL production suggestion code (bundled from
 * webview-ui/src/utils via core-entry.ts — not a reimplementation).
 *
 *   node runner.mjs --selftest
 *   node runner.mjs --scenarios <batch.json>   → metrics JSON on stdout
 *
 * Scenario model mirrors the webview exactly: prompts are "sent" through
 * recordSentPrompt, the phrase corpus and vocab model are rebuilt on corpus
 * change (like the useMemo pair), and probes rank a partial draft the way a
 * keystroke does. Generated and asserted by simulate.py.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { performance } from "perf_hooks";
import {
  attributeMagieWords,
  buildPhraseCorpus,
  buildVocabModel,
  bigramContinuationBoost,
  candidateVocabBoost,
  isCommonWord,
  normalizePromptHistory,
  rankPromptSuggestions,
  recordSentPrompt,
  topProjectWords,
  vocabTokens,
} from "./.core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic PRNG for fuzzing (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- selftest

function selftest() {
  const failures = [];
  const check = (name, cond, detail = "") => {
    if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    else console.error(`  ok  ${name}`);
  };

  // 1. The two vocabWeights.ts copies must be byte-identical (mirrored file).
  const a = fs.readFileSync(
    path.join(__dirname, "../../src/shared/vocabWeights.ts"),
    "utf8"
  );
  const b = fs.readFileSync(
    path.join(__dirname, "../../webview-ui/src/utils/vocabWeights.ts"),
    "utf8"
  );
  check("vocabWeights mirror is byte-identical", a === b);

  // 2. Attribution is lossless and well-formed under fuzz.
  const rand = rng(42);
  const pool = "add fix the a composer harness tab strip pill run check note emoji ¶ don't (weird) x—y  multi".split(" ");
  let lossless = true;
  let wellFormed = true;
  for (let i = 0; i < 5000; i++) {
    const pick = (n) =>
      Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
    const suggestion = pick(2 + Math.floor(rand() * 12)).join(
      rand() < 0.15 ? "  " : " "
    );
    const sources = Array.from({ length: Math.floor(rand() * 3) }, () =>
      pick(1 + Math.floor(rand() * 8)).join(" ")
    );
    const segs = attributeMagieWords(suggestion, sources);
    if (segs.map((s) => s.text).join("") !== suggestion) lossless = false;
    if (segs.some((s) => s.text === "" || typeof s.novel !== "boolean"))
      wellFormed = false;
  }
  check("attribution lossless over 5000 fuzz cases", lossless);
  check("attribution segments well-formed", wellFormed);

  // 2b. Continuation merge preserves the model's word boundary (the
  // "corr rect?" bug): a space-less continuation completes the draft's last
  // word, a spaced one starts a new word, echoes strip, echo-only → null.
  const { mergeDraftAndContinuation: merge } = createRequire(import.meta.url)(
    "./.host.cjs"
  );
  const mergeCases = [
    ["a new word corr", "ect?", "a new word correct?"],
    ["then push", " the fix.", "then push the fix."],
    ["so all good", ", right?", "so all good, right?"],
    ["add a ", "yellow pill", "add a yellow pill"],
    ["check the", "check the logs and push", "check the logs and push"],
    ["a new word corr", "a new word correct?", "a new word correct?"],
    ["check the", "check the", null],
    ["check the", "   ", null],
  ];
  for (const [draft, raw, want] of mergeCases) {
    const got = merge(draft, raw);
    check(
      `merge(${JSON.stringify(draft)}, ${JSON.stringify(raw)}) → ${JSON.stringify(want)}`,
      got === want,
      `got ${JSON.stringify(got)}`
    );
  }

  // 3. Phrase corpus properties.
  const NOW = 1_800_000_000_000;
  const entries = normalizePromptHistory([
    {
      text: "the panel flickers on switch. run the harness suite and capture a trace. also persist the state after reload.",
      count: 2,
      lastUsed: NOW - 86400000,
    },
    {
      text: "run the harness suite and capture a trace. then fix the composer gate.",
      count: 3,
      lastUsed: NOW,
    },
    { text: "short one.", count: 1, lastUsed: NOW },
    { text: "fix the composer gate.", count: 1, lastUsed: NOW },
  ]);
  const phrases = buildPhraseCorpus(entries);
  const buried = phrases.find((p) =>
    p.norm.startsWith("run the harness suite")
  );
  check("buried phrase extracted", !!buried);
  check(
    "same phrase across parents aggregates counts",
    buried && buried.count === 5,
    buried ? `count=${buried.count}` : "missing"
  );
  check(
    "phrase equal to an existing whole prompt is dropped",
    !phrases.some((p) => p.norm === "fix the composer gate.")
  );
  check(
    "phrase bounds respected",
    phrases.every(
      (p) =>
        p.text.length >= 12 &&
        p.text.length <= 200 &&
        p.norm.split(" ").length >= 3 &&
        p.unit === "phrase" &&
        typeof p.parent === "string"
    )
  );

  // 4. Weights: jargon beats common at equal use; more use → more weight.
  const wEntries = normalizePromptHistory([
    { text: "glorbex glorbex check check", count: 5, lastUsed: NOW },
    { text: "zintra appears here", count: 2, lastUsed: NOW },
  ]);
  const model = buildVocabModel(wEntries, NOW);
  check(
    "jargon outweighs common at equal count",
    model.weights.get("glorbex") > model.weights.get("check"),
    `glorbex=${model.weights.get("glorbex")} check=${model.weights.get("check")}`
  );
  check(
    "weight grows with count",
    model.weights.get("glorbex") > model.weights.get("zintra")
  );
  check(
    "topProjectWords excludes common words",
    topProjectWords(model, 10).every((w) => !isCommonWord(w.word))
  );

  // 5. Bigram continuation boost fires only on complete-word prefix.
  const bg = normalizePromptHistory([
    { text: "run the harness suite now", count: 3, lastUsed: NOW },
  ]);
  const bgModel = buildVocabModel(bg, NOW);
  check(
    "bigram boost on complete word",
    bigramContinuationBoost(bgModel, "run the harness suite now", "run the") > 0
  );
  check(
    "no bigram boost mid-word",
    bigramContinuationBoost(bgModel, "run the harness suite now", "run the har") === 0
  );

  // 6. Ranking: phrase diversity cap ≤2 in top-5.
  const capEntries = normalizePromptHistory(
    Array.from({ length: 6 }, (_, i) => ({
      text: `deploy cluster variant ${i}. and restart the pods carefully mode ${i}.`,
      count: 1,
      lastUsed: NOW - i * 1000,
    }))
  );
  const capCorpus = [...capEntries, ...buildPhraseCorpus(capEntries)];
  const capTop = rankPromptSuggestions("restart the pods", capCorpus, NOW, 5);
  check(
    "≤2 phrase rows in top-5",
    capTop.filter((e) => e.unit === "phrase").length <= 2,
    `got ${capTop.filter((e) => e.unit === "phrase").length}`
  );

  // 7. recordSentPrompt learning mechanics (count bump + prepend).
  let corpus = normalizePromptHistory([]);
  corpus = recordSentPrompt(corpus, "ship the glorbex panel");
  corpus = recordSentPrompt(corpus, "something else entirely here");
  corpus = recordSentPrompt(corpus, "ship the glorbex panel");
  check(
    "recordSentPrompt bumps count and prepends",
    corpus[0].norm === "ship the glorbex panel" && corpus[0].count === 2
  );

  // 8. Determinism: identical inputs → identical ranking (fixed timestamps).
  const det1 = JSON.stringify(
    rankPromptSuggestions("run the", capCorpus, NOW, 5, bgModel)
  );
  const det2 = JSON.stringify(
    rankPromptSuggestions("run the", capCorpus, NOW, 5, bgModel)
  );
  check("ranking deterministic", det1 === det2);

  // 9. Perf: full-size corpus (3000 prompts + phrases) under 5ms p95/rank.
  const prand = rng(7);
  const nouns = "composer harness worktree panel strip pill emoji trace suite gate bridge socket cache".split(" ");
  const verbs = "add fix check run improve update capture persist restart deploy".split(" ");
  const big = normalizePromptHistory(
    Array.from({ length: 3000 }, (_, i) => ({
      text: `${verbs[i % verbs.length]} the ${nouns[(i * 7) % nouns.length]} ${
        nouns[(i * 13) % nouns.length]
      } number ${i}. then ${verbs[(i * 3) % verbs.length]} the ${
        nouns[(i * 5) % nouns.length]
      } carefully.`,
      count: 1 + (i % 4),
      lastUsed: NOW - i * 3_600_000,
    }))
  );
  const bigCorpus = [...big, ...buildPhraseCorpus(big)];
  const bigModel = buildVocabModel(big, NOW);
  const queries = Array.from({ length: 300 }, () => {
    const v = verbs[Math.floor(prand() * verbs.length)];
    const n = nouns[Math.floor(prand() * nouns.length)];
    return `${v} the ${n}`.slice(0, 4 + Math.floor(prand() * 12));
  });
  const times = [];
  for (const q of queries) {
    const t0 = performance.now();
    rankPromptSuggestions(q, bigCorpus, NOW, 5, bigModel);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const p95 = times[Math.floor(times.length * 0.95)];
  const p50 = times[Math.floor(times.length * 0.5)];
  console.error(
    `  perf corpus=${bigCorpus.length} rows: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`
  );
  check("rank p95 < 5ms on 3000+phrases corpus", p95 < 5, `p95=${p95.toFixed(2)}ms`);

  if (failures.length) {
    console.error(`SELFTEST FAILURES:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ selftest: "pass", perf: { p50, p95 } }));
}

// --------------------------------------------------------------- scenarios

/** Executes one scenario: seeded aged entries, then sessions of sends with
 * probes interleaved (probe.afterSend = number of sends already made). */
function runScenario(sc) {
  let corpus = normalizePromptHistory(sc.seedEntries ?? []);
  let phrases = buildPhraseCorpus(corpus);
  let vocab = buildVocabModel(corpus, Date.now());
  const results = [];
  const allSends = sc.sends;
  const probesByTime = new Map();
  for (const p of sc.probes) {
    const list = probesByTime.get(p.afterSend) ?? [];
    list.push(p);
    probesByTime.set(p.afterSend, list);
  }

  const runProbes = (k) => {
    for (const probe of probesByTime.get(k) ?? []) {
      const now = Date.now();
      const merged = [...corpus, ...phrases];
      const top = rankPromptSuggestions(probe.draft, merged, now, 5, vocab);
      const r = { kind: probe.kind, afterSend: k };

      if (probe.kind === "learning") {
        r.sends = probe.sends;
        r.rank = top.findIndex((e) => e.norm === probe.targetNorm);
        r.draftLen = probe.draft.length;
      } else if (probe.kind === "phrase") {
        const sub = norm(probe.targetSub);
        r.phraseRowRank = top.findIndex(
          (e) => e.unit === "phrase" && e.norm.includes(sub)
        );
        r.anyRowRank = top.findIndex((e) => e.norm.includes(sub));
        const promptsOnly = rankPromptSuggestions(
          probe.draft,
          corpus,
          now,
          5,
          vocab
        );
        r.promptsOnlyRank = promptsOnly.findIndex((e) =>
          e.norm.includes(sub)
        );
      } else if (probe.kind === "jargon") {
        const first = top[0]?.norm ?? null;
        const noVocab = rankPromptSuggestions(probe.draft, merged, now, 5);
        r.withVocabPicksJargon = first === probe.jargonNorm;
        r.noVocabPicksGeneric = (noVocab[0]?.norm ?? null) === probe.genericNorm;
      }
      results.push(r);
    }
  };

  runProbes(0);
  for (let i = 0; i < allSends.length; i++) {
    corpus = recordSentPrompt(corpus, allSends[i]);
    phrases = buildPhraseCorpus(corpus);
    vocab = buildVocabModel(corpus, Date.now());
    runProbes(i + 1);
  }

  // End-of-scenario weight audit: does jargon out-weigh common words?
  const jargonWeights = (sc.jargonWords ?? [])
    .map((w) => vocab.weights.get(w))
    .filter((x) => x !== undefined);
  const commonWeights = [];
  for (const [w, weight] of vocab.weights) {
    if (isCommonWord(w)) commonWeights.push(weight);
  }
  const mean = (xs) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  return {
    id: sc.id,
    probes: results,
    meanJargonWeight: mean(jargonWeights),
    meanCommonWeight: mean(commonWeights),
    topProject: topProjectWords(vocab, 8).map((w) => w.word),
  };
}

// -------------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args[0] === "--selftest") {
  selftest();
} else if (args[0] === "--scenarios") {
  const batch = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const out = [];
  const t0 = performance.now();
  for (const sc of batch.scenarios) {
    out.push(runScenario(sc));
  }
  console.log(
    JSON.stringify({
      results: out,
      wallMs: Math.round(performance.now() - t0),
    })
  );
} else {
  console.error("usage: runner.mjs --selftest | --scenarios <file>");
  process.exit(2);
}
