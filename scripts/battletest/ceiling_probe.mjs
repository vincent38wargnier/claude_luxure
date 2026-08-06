/**
 * Quality-ceiling probe: run a SMART model (Claude via headless `claude -p`,
 * the same pattern the post-it emoji picker uses) over a subset of the replay
 * probes. This bounds what any model could achieve on this task — if even a
 * frontier model scores low on exact-match metrics, the feature's value is
 * plausible template completion, not literal prediction, and local-model
 * choices should be judged by eyeball relevance rather than accuracy alone.
 *
 *   node ceiling_probe.mjs [--model claude-haiku-4-5-20251001] [--n 60] [--par 6]
 *
 * Reads results/probes.json (written by replay_eval.mjs --dump).
 * Writes results/replay_ceiling_<model>.json in the same shape.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

/** Same resolution the extension uses (src/utils/claude-path.ts): standalone
 * locations first, then the newest bundled native binary. */
function resolveClaudeBin() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  const roots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  let best = null;
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("anthropic.claude-code-")) continue;
      const bin = path.join(root, name, "resources", "native-binary", "claude");
      try {
        fs.accessSync(bin, fs.constants.X_OK);
      } catch {
        continue;
      }
      const v = (name.match(/(\d+)\.(\d+)\.(\d+)/) ?? [0, 0, 0, 0])
        .slice(1)
        .map(Number);
      if (!best || v.join(".").localeCompare(best.v.join("."), undefined, { numeric: true }) > 0) {
        best = { v, bin };
      }
    }
  }
  return best?.bin ?? "claude";
}

const CLAUDE_BIN = resolveClaudeBin();
const TMP_CWD = fs.realpathSync(os.tmpdir());
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const TMP_SLUG = TMP_CWD.replace(/[^a-zA-Z0-9]/g, "-");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const MODEL = arg("model", "claude-haiku-4-5-20251001");
const N = Number(arg("n", "60"));
const PAR = Number(arg("par", "6"));

const probes = JSON.parse(
  fs.readFileSync(path.join(OUT_DIR, "probes.json"), "utf-8")
);
// Deterministic spread: every k-th probe.
const step = Math.max(1, Math.floor(probes.length / N));
const subset = probes.filter((_, i) => i % step === 0).slice(0, N);

const SYSTEM = [
  "You are the autocomplete engine inside a coding-assistant chat app. You",
  "complete the message the USER is typing to the assistant. You are never the",
  "assistant: never answer it. Predict only how the user's sentence continues.",
  "The user's next message usually reacts to the assistant's last reply.",
  "Match the user's casual lowercase style and vocabulary. Reply with ONLY the",
  "continuation words (not the draft), one line, at most 15 words, no quotes,",
  "no commentary.",
].join(" ");

function promptFor(p) {
  const parts = [SYSTEM, ""];
  if (p.recent?.length) {
    parts.push("The user's most recent prompts (newest last):");
    for (const r of p.recent) parts.push(`- ${r}`);
    parts.push("");
  }
  if (p.conversation?.length) {
    parts.push("Conversation so far:");
    for (const t of p.conversation) parts.push(`${t.role}: ${t.text}`);
    parts.push("");
  }
  if (p.examples?.length) {
    parts.push("Similar past prompts by this user:");
    for (const e of p.examples.slice(0, 3)) parts.push(`- ${e}`);
    parts.push("");
  }
  parts.push(`Draft: "${p.draft}" →`);
  return parts.join("\n");
}

function mergeDraftAndContinuation(draft, raw) {
  let continuation = raw.trim().replace(/\s+/g, " ");
  if (!continuation) return null;
  continuation = continuation.replace(/^[\s"'`→\-–—:]+/, "");
  const normDraft = draft.trim().replace(/\s+/g, " ");
  if (continuation.toLowerCase().startsWith(normDraft.toLowerCase())) {
    continuation = continuation.slice(normDraft.length);
  }
  if (!continuation.trim()) return null;
  const joiner = draft.endsWith(" ") || continuation.startsWith(" ") ? "" : " ";
  const full = (draft + joiner + continuation).replace(/\s+/g, " ").trim();
  return full.length > draft.trim().length ? full : null;
}

const tok = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

function score(draft, truthFull, suggestion) {
  const truthCont = tok(truthFull.slice(draft.length));
  if (!suggestion) return { null: true, nextWord: false, lcp: 0, saved: 0, f1: 0 };
  const sugCont = tok(suggestion.slice(Math.min(draft.trim().length, suggestion.length)));
  if (sugCont.length === 0) return { null: true, nextWord: false, lcp: 0, saved: 0, f1: 0 };
  let lcp = 0;
  while (lcp < sugCont.length && lcp < truthCont.length && sugCont[lcp] === truthCont[lcp]) lcp++;
  const saved = truthCont.slice(0, lcp).reduce((s, w) => s + w.length + 1, 0);
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
  return { null: false, nextWord: sugCont[0] === truthCont[0], lcp, saved, f1 };
}

/** Headless print-mode call, shaped like ChatViewProvider.runClaudePrint:
 * JSON envelope, throwaway tmp cwd (so no project transcript pollution), and
 * the transient session file deleted afterwards. */
function callClaude(promptText) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile(
      CLAUDE_BIN,
      ["-p", promptText, "--model", MODEL, "--output-format", "json"],
      { cwd: TMP_CWD, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let raw = "";
        let e = err ? String(err).slice(0, 120) : null;
        if (!err) {
          try {
            const envelope = JSON.parse(String(stdout).trim());
            raw = typeof envelope.result === "string" ? envelope.result : "";
            if (typeof envelope.session_id === "string") {
              fs.rm(
                path.join(CONFIG_DIR, "projects", TMP_SLUG, `${envelope.session_id}.jsonl`),
                { force: true },
                () => {}
              );
            }
          } catch {
            raw = String(stdout).trim();
          }
        }
        resolve({ raw: raw.split("\n")[0] ?? "", ms: Date.now() - t0, err: e });
      }
    );
    child.stdin?.end();
  });
}

async function main() {
  console.error(`ceiling probe: ${subset.length} probes via ${MODEL}, par=${PAR}`);
  const results = new Array(subset.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < subset.length) {
      const i = next++;
      const p = subset[i];
      const { raw, ms, err } = await callClaude(promptFor(p));
      const suggestion = mergeDraftAndContinuation(p.draft, raw);
      results[i] = {
        project: p.project.replace(/^-Users-vincent-/, ""),
        cut: p.cut,
        draft: p.draft,
        truth: p.truth,
        suggestion,
        ms,
        err,
        ...score(p.draft, p.truth, suggestion),
      };
      done++;
      if (done % 10 === 0) console.error(`  ${done}/${subset.length}`);
    }
  }
  await Promise.all(Array.from({ length: PAR }, worker));

  const n = results.length;
  const nn = results.filter((r) => !r.null);
  const msAll = nn.map((r) => r.ms).sort((a, b) => a - b);
  const agg = {
    arm: `ceiling:${MODEL}`,
    probes: n,
    errRate: +(results.filter((r) => r.err).length / n).toFixed(3),
    nullRate: +(results.filter((r) => r.null).length / n).toFixed(3),
    nextWordAcc: +(results.filter((r) => r.nextWord).length / n).toFixed(3),
    meanLcp: +(results.reduce((s, r) => s + r.lcp, 0) / n).toFixed(2),
    meanSavedChars: +(results.reduce((s, r) => s + r.saved, 0) / n).toFixed(1),
    meanF1: +(results.reduce((s, r) => s + r.f1, 0) / n).toFixed(3),
    meanMs: msAll.length ? Math.round(msAll.reduce((s, x) => s + x, 0) / msAll.length) : 0,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `replay_ceiling_${MODEL.replace(/[^a-z0-9.-]/gi, "_")}.json`),
    JSON.stringify({ agg, results }, null, 1)
  );
  console.error(JSON.stringify(agg));
}

await main();
