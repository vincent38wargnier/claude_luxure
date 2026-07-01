// The script the app invokes to start a conversation in a fresh, isolated
// environment (the yellow "+"). It reads the per-project recipe at
// `<project>/.claude-luxure/worktree.json` (generating it first if missing and
// --generate is passed), creates + provisions a git worktree, remaps ports, and
// prints a JSON result on stdout that the extension feeds straight into the
// bridge as { cwd, env } for the new conversation. All human-readable progress
// goes to stderr so stdout stays machine-parseable.
//
// Build + run (standalone test harness):
//   CLAUDE_BIN=/path/to/claude npx esbuild scripts/new-worktree-env.ts \
//     --bundle --platform=node --format=esm --outfile=/tmp/wt.mjs && \
//     node /tmp/wt.mjs create <projectPath> --slug "fix login bug" [flags]
//
// Subcommands:
//   create <projectPath> --slug <name> [--run] [--start] [--lean|--no-lean]
//                                      [--slot N] [--generate] [--dry-run]
//   remove <projectPath> --branch <branch> [--keep-volumes] [--keep-branch] [--dry-run]
//   list   <projectPath>
//
// Flags:
//   --run        execute the recipe's run steps (e.g. `make setup`) — heavy
//   --start      compose: `docker compose up -d` the stack after provisioning
//   --lean       compose start: only essential containers (RAM-efficient)
//   --no-lean    compose start: the full stack (override recipe.leanByDefault)
//   --slot N     force a specific port/namespace slot
//   --generate   run the research pass to create the recipe if it's missing
//   --dry-run    print the full plan; touch nothing

import * as fs from "fs";
import * as path from "path";
import { validateRecipe, type WorktreeRecipe } from "../src/worktree/recipe-schema";
import { provisionWorktree, removeWorktree } from "../src/worktree/provisioner";
import { loadState } from "../src/worktree/state-store";
import { generateRecipe } from "../src/worktree/recipe-generator";

interface Flags {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Flags } {
  const cmd = argv[0] || "";
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

const recipePath = (project: string) => path.join(project, ".claude-luxure", "worktree.json");

function loadRecipe(project: string): WorktreeRecipe {
  const fp = recipePath(project);
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  const v = validateRecipe(raw);
  if (!v.valid) {
    throw new Error(`recipe at ${fp} is invalid:\n  ${v.errors.join("\n  ")}`);
  }
  return v.recipe!;
}

async function ensureRecipe(project: string, generate: boolean): Promise<WorktreeRecipe> {
  if (fs.existsSync(recipePath(project))) {
    return loadRecipe(project);
  }
  if (!generate) {
    throw new Error(
      `no recipe at ${recipePath(project)}.\n` +
        `Run the research pass first (generate-recipe), or pass --generate to do it now.`
    );
  }
  const claudePath = process.env.CLAUDE_BIN || "claude";
  process.stderr.write(`▶ no recipe found — running research pass (${claudePath})…\n`);
  const res = await generateRecipe({
    projectPath: project,
    claudePath,
    onStderr: (s) => {
      const line = s.trim();
      if (line && line.length < 200) process.stderr.write(`  · ${line}\n`);
    },
  });
  if (!res.validation.valid || !res.recipe) {
    throw new Error(`recipe generation failed:\n  ${res.validation.errors.join("\n  ")}`);
  }
  const recipe = { ...res.recipe, generatedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(project, ".claude-luxure"), { recursive: true });
  fs.writeFileSync(recipePath(project), JSON.stringify(recipe, null, 2) + "\n");
  process.stderr.write(`✓ wrote ${recipePath(project)} (cost ${res.costUsd != null ? "$" + res.costUsd.toFixed(2) : "n/a"})\n\n`);
  return recipe;
}

function emit(result: unknown) {
  // The ONLY thing on stdout — the app parses this.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function cmdCreate(project: string, flags: Flags) {
  const slug = (flags.slug as string) || (flags.name as string);
  if (!slug) {
    throw new Error('create requires --slug "<conversation name>"');
  }
  const recipe = await ensureRecipe(project, !!flags.generate);

  const lean = flags["no-lean"] ? false : flags.lean ? true : undefined;
  const result = await provisionWorktree({
    projectPath: project,
    recipe,
    slug,
    slot: flags.slot ? Number(flags.slot) : undefined,
    runSteps: !!flags.run,
    startServices: !!flags.start,
    lean,
    dryRun: !!flags["dry-run"],
    now: new Date().toISOString(),
    onProgress: (line) => process.stderr.write(`  · ${line}\n`),
  });

  process.stderr.write("\n");
  if (!result.ok) {
    process.stderr.write(`✗ provisioning failed:\n  ${result.warnings.join("\n  ")}\n`);
  } else {
    process.stderr.write(`${flags["dry-run"] ? "DRY-RUN — would provision" : "✓ provisioned"}: ${result.branch} (slot ${result.slot})\n`);
    process.stderr.write(`  cwd: ${result.cwd}\n`);
    if (Object.keys(result.env).length) {
      process.stderr.write(`  env: ${Object.entries(result.env).map(([k, v]) => `${k}=${v}`).join("  ")}\n`);
    }
    for (const u of result.urls) {
      process.stderr.write(`  ${u.label}: ${u.url}\n`);
    }
    if (result.warnings.length) {
      process.stderr.write(`  warnings:\n${result.warnings.map((w) => `    ⚠ ${w}`).join("\n")}\n`);
    }
    // In dry-run, show the files we WOULD generate so the plan is reviewable.
    if (flags["dry-run"]) {
      for (const f of result.generatedFiles) {
        process.stderr.write(`\n  ── would write ${f.path} ──\n${f.content.split("\n").map((l) => "  | " + l).join("\n")}\n`);
      }
    }
  }
  emit(result);
  if (!result.ok) process.exitCode = 1;
}

async function cmdRemove(project: string, flags: Flags) {
  const branch = flags.branch as string;
  if (!branch) {
    throw new Error("remove requires --branch <branch>");
  }
  const result = await removeWorktree({
    projectPath: project,
    branch,
    removeVolumes: !flags["keep-volumes"],
    deleteBranch: !flags["keep-branch"],
    dryRun: !!flags["dry-run"],
    onProgress: (line) => process.stderr.write(`  · ${line}\n`),
  });
  process.stderr.write("\n");
  process.stderr.write(`${flags["dry-run"] ? "DRY-RUN — would remove" : result.ok ? "✓ removed" : "removed with warnings"}: ${branch}\n`);
  if (result.warnings.length) {
    process.stderr.write(result.warnings.map((w) => `    ⚠ ${w}`).join("\n") + "\n");
  }
  emit(result);
}

function cmdList(project: string) {
  const state = loadState(project);
  const entries = Object.values(state.worktrees);
  if (!entries.length) {
    process.stderr.write("no worktrees recorded.\n");
  } else {
    for (const e of entries) {
      process.stderr.write(
        `slot ${e.slot}  ${e.branch}\n    ${e.worktreePath}\n` +
          (e.composeProject ? `    compose: ${e.composeProject}\n` : "") +
          (e.ports.length ? `    ports: ${e.ports.map((p) => `${p.var}=${p.port}`).join(" ")}\n` : "")
      );
    }
  }
  emit({ ok: true, worktrees: entries });
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  const project = path.resolve(positional[0] || process.cwd());

  switch (cmd) {
    case "create":
      await cmdCreate(project, flags);
      break;
    case "remove":
      await cmdRemove(project, flags);
      break;
    case "list":
      cmdList(project);
      break;
    default:
      process.stderr.write(
        "usage:\n" +
          "  new-worktree-env create <projectPath> --slug <name> [--run] [--start] [--lean|--no-lean] [--slot N] [--generate] [--dry-run]\n" +
          "  new-worktree-env remove <projectPath> --branch <branch> [--keep-volumes] [--keep-branch] [--dry-run]\n" +
          "  new-worktree-env list   <projectPath>\n"
      );
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
