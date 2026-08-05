// Spike: can Qwen3.5-2B (Q4_K_M, Metal via node-llama-cpp) power the composer's
// AI phrase suggestion within a ~250ms warm budget on this machine?
//
//   node scripts/spike-local-llm.mjs [modelPath]
//
// Measures: model load, one-time Metal warmup, cold full-prompt TTFT/total,
// then the integration's real hot path — same session, only the draft (and
// optionally a changed retrieved set) re-sent, KV cache reused. Prints the
// suggestions for real drafts so quality is eyeballable alongside the numbers.
import { getLlama, LlamaChatSession, QwenChatWrapper } from "node-llama-cpp";
import os from "os";
import path from "path";

const qwenNoThink = () =>
  new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" });

const MODEL_PATH =
  process.argv[2] ??
  path.join(os.homedir(), ".cache/claude-luxure-models/Qwen3.5-2B-Q4_K_M.gguf");

const now = () => performance.now();
const ms = (t) => `${Math.round(t)}ms`;

// Real prompts from this project's corpus (loadPromptHistory scan, 2026-07-30).
const RETRIEVED = [
  "can you add opus 5 to the available models?",
  "check how i can run this claude luxure by default in all my vscode instances",
  "can you take a screenshot on this url and show me what ui i should improve https://app.jarvio.io",
  "each project could have its own local rag, based on previous messages sent, for better prediction?",
  "check this project idea /Users/vincent/Documents/code/magify.fun/code/intent-keyboard-feasibility-review.md",
];

const SYSTEM = [
  "You autocomplete the prompt a user is typing to a coding assistant, inside",
  "the claude_luxure VS Code extension project (React webview chat UI +",
  "extension host, transcripts, composer). Given the user's past prompts and a",
  "draft, output ONLY the words that continue the draft — not the draft itself,",
  "no quotes, no explanation, one line, at most 15 words. Reuse the user's own",
  "vocabulary and style (lowercase, direct).",
].join(" ");

const EXAMPLES_BLOCK = [
  "Conversation topic: we just shipped prompt-history suggestions in the",
  "composer (type to see past prompts, arrows + Tab to insert) and are now",
  "adding a local LLM suggestion layer on top.",
  "",
  "The user's recent prompts in this project:",
  ...RETRIEVED.map((r) => `- ${r}`),
].join("\n");

const DRAFTS = [
  "add a",
  "can you take a screen",
  "improve the tab",
  "check the logs of",
];

async function timedPrompt(session, text, label) {
  let ttft = 0;
  const t0 = now();
  const out = await session.prompt(text, {
    maxTokens: 24,
    temperature: 0,
    customStopTriggers: ["\n"],
    budgets: { thoughtTokens: 0 },
    onTextChunk: () => {
      if (!ttft) ttft = now() - t0;
    },
  });
  const total = now() - t0;
  console.log(
    `  [${label}] ttft ${ms(ttft)} · total ${ms(total)} → "${out.trim()}"`
  );
  return { ttft, total, out };
}

const t0 = now();
const llama = await getLlama();
console.log(`gpu: ${llama.gpu}`);

const tLoad0 = now();
const model = await llama.loadModel({ modelPath: MODEL_PATH });
console.log(`model load: ${ms(now() - tLoad0)} (${MODEL_PATH.split("/").pop()})`);

// One-time Metal shader/pipeline warmup — the real extension pays this once at
// activation, so it must not pollute the per-suggestion numbers.
{
  const tWarm0 = now();
  const ctx = await model.createContext({ contextSize: 512 });
  const s = new LlamaChatSession({ contextSequence: ctx.getSequence() });
  await s.prompt("hi", { maxTokens: 2, temperature: 0 });
  await ctx.dispose();
  console.log(`one-time warmup: ${ms(now() - tWarm0)}`);
}

// --- COLD: fresh context, whole prompt (system + examples + draft) prefilled.
console.log("\n— cold (full prefill, first suggestion of a conversation) —");
{
  const ctx = await model.createContext({ contextSize: 2048 });
  const session = new LlamaChatSession({
    contextSequence: ctx.getSequence(),
    systemPrompt: SYSTEM,
    chatWrapper: qwenNoThink(),
  });
  await timedPrompt(
    session,
    EXAMPLES_BLOCK + `\n\nDraft to continue: "add a"`,
    "cold add a"
  );
  await ctx.dispose();
}

// --- WARM: the real integration path. One session holds system + examples;
// each keystroke boundary sends only the tiny draft turn, so the shared
// prefix stays in the KV cache.
console.log("\n— warm (session keeps context; only the draft is new) —");
{
  const ctx = await model.createContext({ contextSize: 2048 });
  const session = new LlamaChatSession({
    contextSequence: ctx.getSequence(),
    systemPrompt: SYSTEM,
    chatWrapper: qwenNoThink(),
  });
  const tPrime0 = now();
  await session.prompt(EXAMPLES_BLOCK + '\n\nReply with just "ready".', {
    maxTokens: 4,
    temperature: 0,
  });
  console.log(`  [prime context+examples] ${ms(now() - tPrime0)}`);

  const results = [];
  for (const draft of DRAFTS) {
    results.push(
      await timedPrompt(session, `Draft to continue: "${draft}"`, draft)
    );
  }
  const totals = results.map((r) => r.total);
  console.log(
    `  warm avg total: ${ms(totals.reduce((a, b) => a + b, 0) / totals.length)} · worst: ${ms(Math.max(...totals))}`
  );

  // Retrieved set changed mid-conversation (draft's first chars changed):
  // re-send examples + draft in one turn — the realistic upper bound.
  await timedPrompt(
    session,
    `Newer prompts from the user:\n- add a pastel sticky note with a small emoji on each conversation\n- add a yellow time-since-last-reply pill on the tabs\n\nDraft to continue: "add a stick"`,
    "warm + new retrieved"
  );
  await ctx.dispose();
}

console.log(`\nwhole spike: ${ms(now() - t0)}`);
