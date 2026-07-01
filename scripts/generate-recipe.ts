// Prototype runner: drive the recipe research pass against a real project and
// print/inspect the result. Not wired into the extension yet — this exists to
// answer the one risky question: does an LLM pass produce a recipe good enough
// to be worth building the feature around?
//
//   CLAUDE_BIN=/path/to/claude npx esbuild scripts/generate-recipe.ts \
//     --bundle --platform=node --format=esm --outfile=/tmp/gen.mjs && node /tmp/gen.mjs [projectPath]

import * as fs from "fs";
import * as path from "path";
import { generateRecipe } from "../src/worktree/recipe-generator";

async function main() {
  const projectPath = path.resolve(process.argv[2] || process.cwd());
  const claudePath = process.env.CLAUDE_BIN || "claude";

  process.stderr.write(`▶ analyzing ${projectPath}\n  using ${claudePath}\n\n`);

  const started = Date.now();
  const res = await generateRecipe({
    projectPath,
    claudePath,
    onStderr: (s) => {
      // Surface only short status lines, not the full agent chatter.
      const line = s.trim();
      if (line && line.length < 200) process.stderr.write(`  · ${line}\n`);
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n══════════════════════ RAW MODEL OUTPUT (final message) ══════════════════════");
  console.log(res.rawResult.slice(0, 4000));

  console.log("\n══════════════════════ VALIDATION ══════════════════════");
  console.log(`valid: ${res.validation.valid}   ·   ${secs}s   ·   cost: ${res.costUsd != null ? "$" + res.costUsd.toFixed(4) : "n/a"}`);
  if (!res.validation.valid) {
    console.log("errors:");
    for (const e of res.validation.errors) console.log(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }

  // Stamp generatedAt (the model can't read a clock) and persist.
  const recipe = { ...res.validation.recipe!, generatedAt: new Date().toISOString() };
  console.log("\n══════════════════════ VALIDATED RECIPE ══════════════════════");
  console.log(JSON.stringify(recipe, null, 2));

  const outDir = path.join(projectPath, ".claude-luxure");
  const outFile = path.join(outDir, "worktree.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(recipe, null, 2) + "\n");
  console.log(`\n✓ wrote ${path.relative(projectPath, outFile)}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exitCode = 1;
});
