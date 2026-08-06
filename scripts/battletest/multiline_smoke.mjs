/**
 * Multiline smoke: the exact scenario that used to go silent — the user hits
 * return and keeps typing. The suggester must complete the CURRENT LINE,
 * with the earlier lines riding in the response prefill.
 *
 * This asserts the PLUMBING (the full generated completion continues the
 * current line, single line, extends the draft), so it inspects the
 * pre-gate `full` text via suggestWithConfidence — the confidence gate may
 * legitimately suppress any of these synthetic cases from display, and the
 * gated row is printed alongside for the eye.
 *
 *   node multiline_smoke.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { LlmSuggester } = require("./.host.cjs");

const CASES = [
  {
    priorDraft: "the composer suggestions feel slow on large corpora.",
    draft: "can you check the",
  },
  {
    priorDraft:
      "there is another bug to fix, when i change a model in a conversation, it changes for all of them.",
    draft: "also make sure the",
  },
  {
    priorDraft: "check this project idea /Users/vincent/Documents/idea.md",
    draft: "i think we could",
  },
  {
    priorDraft: "the qa tests are failing on ci.\nrun them locally first.",
    draft: "then push",
  },
];

const CONVERSATION = [
  { role: "user", text: "we are improving the prompt suggestion menu in the composer" },
  {
    role: "assistant",
    text: "the lexical ranking and the magie row are wired; the multiline gate is fixed next",
  },
];

const suggester = new LlmSuggester();
if (!suggester.available()) {
  console.log(JSON.stringify({ skipped: "model file missing" }));
  process.exit(0);
}
await suggester.suggest({ draft: "warm up the ", examples: [], conversation: [] });

let ok = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const detail = await suggester.suggestWithConfidence(
    {
      draft: c.draft,
      kind: "continue",
      priorDraft: c.priorDraft,
      examples: [],
      conversation: CONVERSATION,
    },
    { fullDecode: true }
  );
  const ms = Date.now() - t0;
  const full = detail?.full ?? null;
  const pass =
    !!full &&
    full.toLowerCase().startsWith(c.draft.toLowerCase()) &&
    !full.includes("\n") &&
    full.length > c.draft.length + 2;
  if (pass) ok++;
  console.error(
    `${pass ? "PASS" : "FAIL"} ${String(ms).padStart(4)}ms  [${c.priorDraft.slice(0, 40)}…] "${c.draft}" → ${full ?? "∅"}` +
      `\n      gated row: ${detail?.shown ?? "∅ (suppressed)"}`
  );
}
console.log(JSON.stringify({ cases: CASES.length, ok }));
process.exit(ok === CASES.length ? 0 : 1);
