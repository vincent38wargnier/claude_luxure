/**
 * Extracts every user-authored prompt (plus truncated assistant replies, for
 * conversation context) from every Claude Code project on this machine —
 * ~/.claude/projects/<slug>/*.jsonl — using the same authorship filters as
 * src/utils/promptHistory.ts, ordered chronologically per session.
 *
 * Outputs (gitignored):
 *   results/all_turns.jsonl    {project, session, ts, role, text, reusable}
 *   results/corpus_stats.json  global + per-project statistics
 *   results/samples.md         eyeball dump: random + most-recent prompts
 *
 *   node extract_sessions.mjs
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const OUT_DIR = path.join(__dirname, "results");
const MAX_LINE_CHARS = 512 * 1024;
const ASSISTANT_KEEP_CHARS = 2000;

/** Mirrors promptHistory.isReusablePrompt (the production corpus filter). */
function isReusablePrompt(text) {
  if (text.length < 8 || text.length > 1500) return false;
  if (text.startsWith("<")) return false;
  if (text.startsWith("[Request interrupted")) return false;
  if (text.startsWith("Caveat: the messages below")) return false;
  if (text.startsWith("This session is being continued from")) return false;
  return true;
}

/** Looser analysis filter: keep long pasted specs too, but still drop the
 * synthetic wrappers — they are not authored text at all. */
function isAuthored(text) {
  if (text.length < 2 || text.length > 8000) return false;
  if (text.startsWith("<")) return false;
  if (text.startsWith("[Request interrupted")) return false;
  if (/^Caveat: the messages below/i.test(text)) return false;
  if (text.startsWith("This session is being continued from")) return false;
  return true;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function scanFile(filePath, project, session, fallbackMtime, rows) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.length > MAX_LINE_CHARS) return;
      const isUser = line.includes('"type":"user"');
      const isAssistant = !isUser && line.includes('"type":"assistant"');
      if (!isUser && !isAssistant) return;
      try {
        const entry = JSON.parse(line);
        if (entry.isSidechain || entry.isMeta) return;
        if (entry.type !== "user" && entry.type !== "assistant") return;
        const text = textOf(entry.message)?.trim();
        if (!text) return;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (entry.type === "user") {
          if (!isAuthored(text)) return;
          rows.push({
            project,
            session,
            ts: Number.isFinite(ts) ? ts : fallbackMtime,
            role: "user",
            text,
            reusable: isReusablePrompt(text),
          });
        } else {
          rows.push({
            project,
            session,
            ts: Number.isFinite(ts) ? ts : fallbackMtime,
            role: "assistant",
            text: text.slice(0, ASSISTANT_KEEP_CHARS),
          });
        }
      } catch {
        /* malformed line */
      }
    });
    rl.on("close", resolve);
    rl.on("error", () => resolve(undefined));
  });
}

const FRENCH_HINTS =
  /\b(le|la|les|une|des|est|c'est|pas|pour|avec|dans|fais|ajoute|corrige|peux|tu)\b/i;

function firstWords(text, n) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .slice(0, n)
    .join(" ");
}

async function main() {
  const t0 = Date.now();
  const projects = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const rows = [];
  let files = 0;
  for (const project of projects) {
    const dir = path.join(PROJECTS_DIR, project);
    let jsonls = [];
    try {
      jsonls = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));
    } catch {
      continue;
    }
    for (const f of jsonls) {
      files++;
      const fp = path.join(dir, f);
      const mtime = fs.statSync(fp).mtimeMs;
      await scanFile(fp, project, f.replace(/\.jsonl$/, ""), mtime, rows);
    }
  }

  rows.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.ts - b.ts));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, "all_turns.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  // ---- stats over user prompts ----
  const prompts = rows.filter((r) => r.role === "user");
  const reusable = prompts.filter((r) => r.reusable);
  const byProject = {};
  for (const p of prompts) {
    const s = (byProject[p.project] ??= {
      prompts: 0,
      reusable: 0,
      sessions: new Set(),
      firstTs: Infinity,
      lastTs: 0,
    });
    s.prompts++;
    if (p.reusable) s.reusable++;
    s.sessions.add(p.session);
    s.firstTs = Math.min(s.firstTs, p.ts);
    s.lastTs = Math.max(s.lastTs, p.ts);
  }

  const lengths = reusable.map((p) => p.text.length).sort((a, b) => a - b);
  const wordCounts = reusable
    .map((p) => p.text.split(/\s+/).length)
    .sort((a, b) => a - b);
  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0;

  const firstWordCounts = new Map();
  const firstTriCounts = new Map();
  let multiline = 0;
  let question = 0;
  let french = 0;
  let hasPath = 0;
  const normSeen = new Map();
  for (const p of reusable) {
    const fw = firstWords(p.text, 1);
    const ft = firstWords(p.text, 3);
    firstWordCounts.set(fw, (firstWordCounts.get(fw) ?? 0) + 1);
    firstTriCounts.set(ft, (firstTriCounts.get(ft) ?? 0) + 1);
    if (p.text.includes("\n")) multiline++;
    if (/\?\s*$/.test(p.text) || /^(can|could|why|what|how|is|are|do|does|should|where)\b/i.test(p.text)) question++;
    if (FRENCH_HINTS.test(p.text)) french++;
    if (/[\w-]+\.(ts|tsx|py|mjs|json|md)\b|\/[\w-]+\//.test(p.text)) hasPath++;
    const norm = p.text.toLowerCase().replace(/\s+/g, " ");
    normSeen.set(norm, (normSeen.get(norm) ?? 0) + 1);
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const stats = {
    scannedFiles: files,
    ms: Date.now() - t0,
    totalRows: rows.length,
    userPrompts: prompts.length,
    reusablePrompts: reusable.length,
    uniqueNorms: normSeen.size,
    repeatedNorms: [...normSeen.values()].filter((c) => c > 1).length,
    chars: { p10: pct(lengths, 0.1), p50: pct(lengths, 0.5), p90: pct(lengths, 0.9), p99: pct(lengths, 0.99) },
    words: { p10: pct(wordCounts, 0.1), p50: pct(wordCounts, 0.5), p90: pct(wordCounts, 0.9), p99: pct(wordCounts, 0.99) },
    multilineRate: +(multiline / reusable.length).toFixed(3),
    questionRate: +(question / reusable.length).toFixed(3),
    frenchHintRate: +(french / reusable.length).toFixed(3),
    pathRate: +(hasPath / reusable.length).toFixed(3),
    topFirstWords: top(firstWordCounts, 30),
    topFirstTrigrams: top(firstTriCounts, 25),
    topRepeatedPrompts: top(normSeen, 15).filter(([, c]) => c > 1),
    byProject: Object.fromEntries(
      Object.entries(byProject).map(([k, v]) => [
        k,
        {
          prompts: v.prompts,
          reusable: v.reusable,
          sessions: v.sessions.size,
          from: new Date(v.firstTs).toISOString().slice(0, 10),
          to: new Date(v.lastTs).toISOString().slice(0, 10),
        },
      ])
    ),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "corpus_stats.json"),
    JSON.stringify(stats, null, 2)
  );

  // ---- eyeball samples: deterministic spread + most recent in this repo ----
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const shuffled = [...reusable];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const luxure = reusable
    .filter((p) => p.project.includes("claude-luxure"))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 40);
  const md = [
    "# Prompt samples (eyeball set)",
    "",
    "## 40 most recent — claude_luxure",
    ...luxure.map((p) => `- [${new Date(p.ts).toISOString().slice(0, 10)}] ${JSON.stringify(p.text.slice(0, 300))}`),
    "",
    "## 80 random across all projects (seed 42)",
    ...shuffled.slice(0, 80).map((p) => `- [${p.project.replace("-Users-vincent-", "…").slice(0, 40)}] ${JSON.stringify(p.text.slice(0, 300))}`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "samples.md"), md);

  console.log(JSON.stringify({ files, rows: rows.length, prompts: prompts.length, reusable: reusable.length, ms: stats.ms }));
}

await main();
