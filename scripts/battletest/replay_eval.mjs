/**
 * Real-data replay eval: replays the user's ACTUAL prompt history and scores
 * magie suggestions against what they really typed next.
 *
 * For each probe (a real prompt cut at a word boundary):
 *   draft        = the raw prefix (typos, casing preserved)
 *   truth        = the raw rest of that prompt
 *   corpus       = only prompts sent BEFORE it in the same project (no leakage)
 *   examples     = production ranking (two-granularity + vocab boosts), top 5
 *   conversation = last 4 merged turns of the same session, 240 chars each
 *   vocabulary   = production topProjectWords(60, min 3) as of that moment
 *
 * Arms (per --arms):
 *   lexical  no model — top history row that extends the draft (the bar magie must clear)
 *   current  production prompt + token bias (what ships today)
 *   nobias   production prompt, no token bias (isolates bias harm)
 *   v2       improved prompt: recent-prompts context + top-3 examples +
 *            reaction-taxonomy system prompt, no bias
 *
 * Metrics vs truth: next-word hit, word-LCP (accepted-words proxy), saved
 * chars, token F1 (sug vs first-15-words of truth), null rate, latency.
 *
 *   node replay_eval.mjs --model <path.gguf|none> --name 2b --arms current,nobias [--probes 100]
 *
 * Outputs results/replay_<name>_<arm>.json (+ sample dump inside).
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
  buildVocabModel,
  topProjectWords,
  rankThreadRelated,
  mergeDraftAndContinuation,
} = require("./.host.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "results");

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const MODEL_PATH = arg("model", "none");
const NAME = arg("name", "model");
const ARMS = arg("arms", "current").split(",");
const MAX_PROMPTS = Number(arg("probes", "100"));

// ---------- production constants (mirrored from src/utils/llmSuggester.ts) ----------
const SYSTEM_V1 = [
  "You autocomplete the prompt a user is typing to their coding assistant.",
  "Given the conversation context, the user's past prompts and a draft, output",
  "ONLY the words that continue the draft — not the draft itself, no quotes,",
  "no explanation, one line, at most 15 words. Reuse the user's own vocabulary",
  "and style. If the past prompts are irrelevant, continue naturally from the",
  "conversation context alone.",
].join(" ");

// v2: built from mining all 857 real prompts on this machine. Findings the
// prompt encodes: (1) the 2B's dominant failure is answering AS the assistant
// ("I'll fix that right now") instead of continuing the user's typing, so the
// role is hammered; (2) the next prompt usually REACTS to the assistant's
// last message (check/verify/run/push/fix/explain/screenshot); (3) style is
// casual lowercase. Static few-shot demos anchor voice + format and stay in
// the cached KV prefix.
const SYSTEM_V2 = [
  "You are the autocomplete engine inside a coding-assistant chat app. You",
  "complete the message the USER is typing to the assistant. You are never the",
  "assistant: never answer, never acknowledge, never write \"I'll\" or \"Here",
  "is\". Predict only how the user's sentence continues. The user's next",
  "message usually reacts to the assistant's last reply: asking to check,",
  "verify, test, run, fix, push, explain, screenshot or improve something just",
  "discussed. Match the user's casual lowercase style and vocabulary. Output",
  "ONLY the continuation words (not the draft), one line, at most 15 words, no",
  "quotes.",
  "\nExamples:",
  '\nDraft: "can you check the" → logs and tell me why it failed',
  '\nDraft: "okay, now" → make the same fix on the other page',
  '\nDraft: "did you" → run it locally to confirm it works?',
].join(" ");

// v3: response-prefill framing. Instruct models fight string-continuation
// (they restate or answer the draft); prefilling the response with the draft
// forces literal mid-sentence continuation — the standard trick for using a
// chat model as a completion engine.
const SYSTEM_V3 = [
  "You write the next message a user will type to their coding assistant.",
  "Predict it from the conversation and the user's past prompts. The message",
  "usually reacts to the assistant's last reply: asking to check, verify,",
  "test, run, fix, push, explain, screenshot or improve something just",
  "discussed. Match the user's casual lowercase style, typos and vocabulary",
  "exactly. Write ONLY the message itself, one line, under 30 words.",
].join(" ");

const MAX_BIAS_WORDS = 60;
const BIAS_FLOOR = 0.08;
const BIAS_CEIL = 0.25;
const BIAS_PER_WEIGHT = 0.06;

function buildPromptV1(req) {
  const parts = [];
  if (req.conversation.length > 0) {
    parts.push("Conversation so far:");
    for (const t of req.conversation) parts.push(`${t.role}: ${t.text}`);
    parts.push("");
  }
  if (req.examples.length > 0) {
    parts.push("The user's past prompts in this project:");
    for (const e of req.examples) parts.push(`- ${e}`);
    parts.push("");
  }
  parts.push(`Draft to continue: "${req.draft}"`);
  return parts.join("\n");
}

function buildPromptV2(req) {
  const parts = [];
  if (req.recent.length > 0) {
    parts.push("The user's most recent prompts (newest last):");
    for (const r of req.recent) parts.push(`- ${r}`);
    parts.push("");
  }
  if (req.conversation.length > 0) {
    parts.push("Conversation so far:");
    for (const t of req.conversation) parts.push(`${t.role}: ${t.text}`);
    parts.push("");
  }
  const ex = req.examples.slice(0, 3);
  if (ex.length > 0) {
    parts.push("Similar past prompts by this user:");
    for (const e of ex) parts.push(`- ${e}`);
    parts.push("");
  }
  // Mirrors the demo format in SYSTEM_V2 — the model continues after the →.
  parts.push(`Draft: "${req.draft}" →`);
  return parts.join("\n");
}

function buildPromptV3(req, withRelated = false) {
  const parts = [];
  if (req.recent.length > 0) {
    parts.push("The user's most recent prompts (newest last):");
    for (const r of req.recent) parts.push(`- ${r}`);
    parts.push("");
  }
  if (req.conversation.length > 0) {
    parts.push("Conversation so far:");
    for (const t of req.conversation) parts.push(`${t.role}: ${t.text}`);
    parts.push("");
  }
  if (withRelated && req.related && req.related.length > 0) {
    parts.push("The user's past prompts about this topic:");
    for (const r of req.related) parts.push(`- ${r}`);
    parts.push("");
  }
  const ex = req.examples.slice(0, 3);
  if (ex.length > 0) {
    parts.push("Similar past prompts by this user:");
    for (const e of ex) parts.push(`- ${e}`);
    parts.push("");
  }
  parts.push("Write the user's next message.");
  return parts.join("\n");
}

// mergeDraftAndContinuation comes from the production bundle (.host.cjs) —
// it used to be a verbatim copy here and drifted; now it can't.

// ---------- probe construction ----------
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

/** Raw prefix ending after the k-th word (original spacing preserved). */
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
  const seen = new Map(); // norm -> candidate (keep latest = richer corpus)
  for (const r of users) {
    const w = words(r.text);
    if (r.text.includes("\n")) continue;
    if (w.length < 6 || w.length > 45 || r.text.length > 260) continue;
    const before = users.filter((u) => u.ts < r.ts);
    if (before.length < 10) continue;
    seen.set(norm(r.text), { ...r, project });
  }
  const picked = [...seen.values()].sort((a, b) => b.ts - a.ts);
  candidates.push(picked);
}
// Round-robin across projects, most recent first, deterministic.
candidates.sort((a, b) => (b[0]?.ts ?? 0) - (a[0]?.ts ?? 0));
const prompts = [];
for (let i = 0; prompts.length < MAX_PROMPTS; i++) {
  let took = false;
  for (const list of candidates) {
    if (list[i] && prompts.length < MAX_PROMPTS) {
      prompts.push(list[i]);
      took = true;
    }
  }
  if (!took) break;
}

function probesFor(p) {
  const w = words(p.text);
  const cuts = new Set([3, Math.min(w.length - 2, Math.max(4, Math.floor(w.length * 0.6)))]);
  return [...cuts].map((k) => ({
    ...p,
    cut: k,
    draft: rawPrefix(p.text, k),
  }));
}

const probes = prompts.flatMap(probesFor);

/** Everything the production pipeline would have had at probe time. */
function contextFor(probe) {
  const list = byProject.get(probe.project);
  const beforeUsers = list.filter(
    (r) => r.role === "user" && r.reusable && r.ts < probe.ts
  );
  // Aggregate like promptHistory.ts byNorm
  const byNorm = new Map();
  for (const u of beforeUsers) {
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
  const vocabulary = topProjectWords(vocabModel, 60, 3).map((v) => ({
    word: v.word,
    weight: v.weight,
  }));
  const examples = rankPromptSuggestions(probe.draft, corpus, probe.ts, 5, vocabModel).map(
    (e) => e.text
  );
  // Conversation: same session, merged consecutive roles, last 4 — the
  // PRODUCTION cut (mirrors ChatViewProvider.handleSuggestPhrase): head 240
  // per turn, except a question-ending last assistant turn gets head+tail.
  const sess = list.filter((r) => r.session === probe.session && r.ts < probe.ts);
  const merged = [];
  for (const r of sess) {
    const last = merged[merged.length - 1];
    if (last && last.role === r.role) last.text += " " + r.text;
    else merged.push({ role: r.role, text: r.text });
  }
  const conversation = merged.slice(-4).map((t, i, arr) => {
    const isLast = i === arr.length - 1;
    if (
      isLast &&
      t.role === "assistant" &&
      t.text.length > 440 &&
      /\?/.test(t.text.slice(-200))
    ) {
      return { role: t.role, text: t.text.slice(0, 200) + " … " + t.text.slice(-200) };
    }
    return { role: t.role, text: t.text.slice(0, 240) };
  });
  // Tail arm: keep the END of each turn — an assistant reply's conclusion /
  // question is its reaction surface, and production's head-240 cuts it off.
  const conversationTail = merged.slice(-4).map((t) => ({
    role: t.role,
    text: t.text.length > 240 ? "…" + t.text.slice(-239) : t.text,
  }));
  // Head+tail arm: pure tail LOST to head (22.5% vs 25.5% — the opener says
  // what happened), but the LAST assistant turn's tail carries the ask the
  // next prompt reacts to ("are you next to the machine?"), so that one turn
  // gets head AND tail.
  const conversationHT = merged.slice(-4).map((t, i, arr) => {
    const isLast = i === arr.length - 1;
    if (isLast && t.role === "assistant" && t.text.length > 440) {
      return {
        role: t.role,
        text: t.text.slice(0, 200) + " … " + t.text.slice(-200),
      };
    }
    return { role: t.role, text: t.text.slice(0, 240) };
  });
  const recent = beforeUsers.slice(-3).map((u) => u.text.slice(0, 140));
  // Conversation-lane retrieval (v4): related past prompts by topic, not
  // prefix — excludes what the draft lane already found.
  const exclude = new Set(examples.slice(0, 3).map((e) => norm(e)));
  const related = rankThreadRelated(conversation, entries, probe.ts, 2, exclude);
  return {
    examples,
    conversation,
    conversationTail,
    conversationHT,
    vocabulary,
    recent,
    related,
  };
}

// ---------- scoring ----------
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
  return {
    null: false,
    nextWord: sugCont[0] === truthCont[0],
    lcp,
    saved,
    f1,
  };
}

// ---------- model ----------
let session = null;
let initialHistory = null;
let TokenBiasCls = null;
let model = null;

async function initModel() {
  const { getLlama, LlamaChatSession, QwenChatWrapper, TokenBias } = await import(
    "node-llama-cpp"
  );
  const llama = await getLlama();
  model = await llama.loadModel({ modelPath: MODEL_PATH });
  TokenBiasCls = TokenBias;
  return { LlamaChatSession, QwenChatWrapper };
}

function biasFor(vocabulary) {
  if (!vocabulary || vocabulary.length === 0 || !TokenBiasCls) return null;
  const bias = TokenBiasCls.for(model);
  for (const { word, weight } of vocabulary.slice(0, MAX_BIAS_WORDS)) {
    bias.set(" " + word, Math.min(BIAS_CEIL, BIAS_FLOOR + BIAS_PER_WEIGHT * weight));
  }
  return bias;
}

async function suggestWith(promptText, tokenBias, responsePrefix) {
  session.setChatHistory(initialHistory);
  const raw = await session.prompt(promptText, {
    maxTokens: 24,
    temperature: 0,
    customStopTriggers: ["\n"],
    ...(tokenBias ? { tokenBias } : {}),
    ...(responsePrefix ? { responsePrefix } : {}),
  });
  return raw;
}

// ---------- run ----------
async function main() {
  console.error(`probes: ${prompts.length} prompts → ${probes.length} cut points`);
  const contexts = probes.map(contextFor);

  if (argv.includes("--dump")) {
    fs.writeFileSync(
      path.join(OUT_DIR, "probes.json"),
      JSON.stringify(
        probes.map((p, i) => ({
          project: p.project,
          cut: p.cut,
          draft: p.draft,
          truth: p.text,
          ...contexts[i],
        })),
        null,
        1
      )
    );
    console.error(`dumped ${probes.length} probes to results/probes.json`);
    return;
  }

  const needModel = ARMS.some((a) => a !== "lexical");
  let sessionsByArm = {};
  if (needModel && MODEL_PATH !== "none") {
    const { LlamaChatSession, QwenChatWrapper } = await initModel();
    // Arms run sequentially; each gets a fresh context (a 2048 context has a
    // single sequence) — dispose the previous one to keep VRAM flat.
    let liveContext = null;
    const mkSession = async (sys) => {
      if (liveContext) await liveContext.dispose();
      liveContext = await model.createContext({ contextSize: 2048 });
      const s = new LlamaChatSession({
        contextSequence: liveContext.getSequence(),
        systemPrompt: sys,
        chatWrapper: new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" }),
      });
      await s.prompt("hi", { maxTokens: 2, temperature: 0 });
      return { session: s, initialHistory: s.getChatHistory() };
    };
    sessionsByArm = { mkSession };
  }

  for (const armName of ARMS) {
    const t0 = Date.now();
    const results = [];
    if (armName !== "lexical") {
      const sys =
        armName.startsWith("v3") || armName === "v4"
          ? SYSTEM_V3
          : armName === "v2"
            ? SYSTEM_V2
            : SYSTEM_V1;
      const made = await sessionsByArm.mkSession(sys);
      session = made.session;
      initialHistory = made.initialHistory;
    }
    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i];
      const ctx = contexts[i];
      let suggestion = null;
      let ms = 0;
      if (armName === "lexical") {
        const dn = norm(probe.draft);
        const hit = ctx.examples.find(
          (e) => norm(e).startsWith(dn) && norm(e).length > dn.length
        );
        suggestion = hit ?? null;
      } else {
        // Ablation arms: what carries the signal — conversation or chunks?
        const req =
          armName === "v3noex"
            ? { ...ctx, examples: [], draft: probe.draft }
            : armName === "v3noconv"
              ? { ...ctx, conversation: [], recent: [], draft: probe.draft }
              : armName === "v3tail"
                ? { ...ctx, conversation: ctx.conversationTail, draft: probe.draft }
                : armName === "v3ht"
                  ? { ...ctx, conversation: ctx.conversationHT, draft: probe.draft }
                  : { ...ctx, draft: probe.draft };
        const isV3 = armName.startsWith("v3") || armName === "v4";
        const promptText = isV3
          ? buildPromptV3(req, armName === "v4")
          : armName === "v2"
            ? buildPromptV2(req)
            : buildPromptV1(req);
        const tokenBias =
          armName === "current" ||
          armName === "v3bias" ||
          armName === "v3tail" ||
          armName === "v3ht" ||
          armName === "v4" ||
          armName === "v3noex" ||
          armName === "v3noconv"
            ? biasFor(ctx.vocabulary)
            : null;
        const s0 = Date.now();
        try {
          let raw = await suggestWith(
            promptText,
            tokenBias,
            isV3 ? probe.draft : undefined
          );
          ms = Date.now() - s0;
          if (armName === "v2") raw = raw.replace(/^[\s"'`→\-–—:]+/, "");
          suggestion = mergeDraftAndContinuation(probe.draft, raw);
        } catch (err) {
          ms = Date.now() - s0;
          console.error(`  ERR probe ${i}: ${String(err).slice(0, 120)}`);
        }
      }
      const sc = score(probe.draft, probe.text, suggestion);
      results.push({
        project: probe.project.replace(/^-Users-vincent-/, ""),
        cut: probe.cut,
        draft: probe.draft,
        truth: probe.text,
        suggestion,
        ms,
        hasConv: ctx.conversation.length > 0,
        nExamples: ctx.examples.length,
        ...sc,
      });
      if ((i + 1) % 25 === 0) console.error(`  [${armName}] ${i + 1}/${probes.length}`);
    }
    const n = results.length;
    const nn = results.filter((r) => !r.null);
    const msAll = nn.map((r) => r.ms).sort((a, b) => a - b);
    const agg = {
      arm: `${NAME}:${armName}`,
      probes: n,
      nullRate: +(results.filter((r) => r.null).length / n).toFixed(3),
      nextWordAcc: +(results.filter((r) => r.nextWord).length / n).toFixed(3),
      nextWordAccNonNull: +(nn.filter((r) => r.nextWord).length / Math.max(1, nn.length)).toFixed(3),
      meanLcp: +(results.reduce((s, r) => s + r.lcp, 0) / n).toFixed(2),
      meanSavedChars: +(results.reduce((s, r) => s + r.saved, 0) / n).toFixed(1),
      meanF1: +(results.reduce((s, r) => s + r.f1, 0) / n).toFixed(3),
      meanMs: msAll.length ? Math.round(msAll.reduce((s, x) => s + x, 0) / msAll.length) : 0,
      p95Ms: msAll.length ? msAll[Math.floor(msAll.length * 0.95)] : 0,
      wallS: +((Date.now() - t0) / 1000).toFixed(1),
    };
    fs.writeFileSync(
      path.join(OUT_DIR, `replay_${NAME}_${armName}.json`),
      JSON.stringify({ agg, results }, null, 1)
    );
    console.error(JSON.stringify(agg));
  }
}

await main();
