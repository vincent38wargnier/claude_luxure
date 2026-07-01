// The worktree provisioner: turns a validated WorktreeRecipe into a real,
// runnable, isolated copy of the project, and tears it back down. This is what
// the app calls behind the yellow "+" to start a conversation in a fresh
// environment. It is deliberately UI-agnostic (no vscode imports) so it can run
// from the extension host OR the standalone CLI (scripts/new-worktree-env.ts).
//
// What it does, in order:
//   1. resolve repo root + branch + a stable per-worktree slot
//   2. `git worktree add` a new branch checkout (outside the repo)
//   3. provision the gitignored runtime bits the worktree lacks
//        copy   → small secrets/config (.env, .mcp.json)
//        clone  → big regenerable dirs via APFS copy-on-write (node_modules)
//        symlink→ shared read-only dirs
//        run    → optional setup command (e.g. `make setup`)  [--run]
//   4. allocate per-worktree ports (slot-offset + free-check) and write them
//      into the worktree's env files (rewriting ports embedded in URLs)
//   5. compose: set COMPOSE_PROJECT_NAME + a generated RAM-cap override so the
//      whole stack is namespaced and bounded; optionally `up -d` (lean) [--start]
//
// It returns the cwd + env the bridge needs so the new conversation's `claude`
// process — and anything it spawns (`make run`) — runs in the right place with
// the right ports.

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { WorktreeRecipe, PortAssignment } from "./recipe-schema";
import { resolveFreePort, computePort } from "./ports";
import {
  buildComposeOverride,
  leanServiceNames,
  OVERRIDE_FILENAME,
} from "./compose-override";
import {
  loadState,
  saveState,
  slotForBranch,
  recordWorktree,
  forgetWorktree,
  type PortRecord,
} from "./state-store";

export interface ProvisionOptions {
  /** The MAIN repo to duplicate from. */
  projectPath: string;
  recipe: WorktreeRecipe;
  /** Human label for the conversation; becomes the branch/worktree name. */
  slug: string;
  /** Force a specific slot (else allocated from state). */
  slot?: number;
  /** Branch/commit the worktree forks from (default: current HEAD). */
  baseRef?: string;
  /** Execute the recipe's `provision[].run` steps (e.g. `make setup`). */
  runSteps?: boolean;
  /** compose mode: bring the stack up detached after provisioning. */
  startServices?: boolean;
  /** compose start: only essential containers. Defaults to recipe.leanByDefault. */
  lean?: boolean;
  /** Plan only — touch nothing on disk, run no commands. */
  dryRun?: boolean;
  /** ISO timestamp for state records (this module never reads a clock). */
  now?: string;
  onProgress?: (line: string) => void;
}

export interface ProvisionResult {
  ok: boolean;
  reused: boolean;
  worktreePath: string;
  branch: string;
  slot: number;
  /** What the bridge should use as `cwd` (worktree root, joined with dev.cwd). */
  cwd: string;
  /** What the bridge should merge into the child env. */
  env: Record<string, string>;
  ports: PortRecord[];
  composeProject?: string;
  urls: { label: string; url: string }[];
  ran: string[];
  started: boolean;
  /** Human-readable record of every step (the whole plan when dryRun). */
  plan: string[];
  warnings: string[];
  /** Files the provisioner generated, with content (for dry-run preview). */
  generatedFiles: { path: string; content: string }[];
}

// ─── small process + fs helpers ──────────────────────────────────────────────

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function execShell(cmd: string, cwd: string, extraEnv?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function sanitizeSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "chat";
}

async function gitTopLevel(projectPath: string): Promise<string> {
  const r = await exec("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : path.resolve(projectPath);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0;
}

/** Copy-on-write clone on APFS (`cp -c`), falling back to a plain recursive copy
 *  when the filesystem doesn't support clonefile. Near-instant + zero extra disk
 *  for node_modules-sized trees on macOS. */
async function cloneTree(src: string, dst: string): Promise<{ method: string; ok: boolean; err?: string }> {
  const cow = await exec("cp", ["-cR", src, dst]);
  if (cow.code === 0) {
    return { method: "clonefile", ok: true };
  }
  // Clean up any partial COW attempt, then fall back to a plain copy.
  await exec("rm", ["-rf", dst]);
  const plain = await exec("cp", ["-R", src, dst]);
  return plain.code === 0
    ? { method: "copy", ok: true }
    : { method: "copy", ok: false, err: plain.stderr.trim() };
}

// ─── env-file editing ────────────────────────────────────────────────────────

interface EnvEdit {
  var: string;
  /** Resolved port (as string) — the new value or the new embedded port. */
  value: string;
  /** When true, rewrite the port inside the var's existing URL value rather
   *  than replacing the whole value. */
  embedsPort?: boolean;
  /** The original port to swap out (only used for embedsPort). */
  base?: number;
}

const lineMatcher = (name: string) =>
  new RegExp(`^(\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=)(.*)$`);

/**
 * Apply env edits to a file in place, creating it if missing. Plain edits upsert
 * `VAR=value`; embedsPort edits rewrite `:<base>` → `:<value>` inside the var's
 * existing value (so `postgres://h:5432/db` → `postgres://h:5442/db`). Returns
 * warnings (e.g. an embedsPort var that wasn't present to rewrite).
 */
function applyEnvEdits(filePath: string, edits: EnvEdit[]): string[] {
  const warnings: string[] = [];
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    lines = [];
  }

  for (const edit of edits) {
    const re = lineMatcher(edit.var);
    const idx = lines.findIndex((l) => re.test(l));
    if (edit.embedsPort) {
      if (idx === -1) {
        warnings.push(`embedsPort: ${edit.var} not found in ${path.basename(filePath)} — cannot rewrite port to ${edit.value}`);
        continue;
      }
      const m = lines[idx].match(re)!;
      const swapped = edit.base
        ? m[2].replace(new RegExp(`:${edit.base}\\b`, "g"), `:${edit.value}`)
        : m[2];
      if (edit.base && swapped === m[2]) {
        warnings.push(`embedsPort: ${edit.var} value did not contain :${edit.base} — left unchanged`);
      }
      lines[idx] = `${m[1]}${swapped}`;
    } else {
      if (idx === -1) {
        lines.push(`${edit.var}=${edit.value}`);
      } else {
        const m = lines[idx].match(re)!;
        lines[idx] = `${m[1]}${edit.value}`;
      }
    }
  }

  // Drop trailing empties, keep one terminal newline.
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return warnings;
}

// ─── port resolution ─────────────────────────────────────────────────────────

interface ResolvedPort {
  base: number;
  port: number;
  /** Whether at least one assignment on this base binds a host port. */
  binding: boolean;
}

/**
 * Resolve one port per distinct `base`. Assignments that BIND a host port
 * (embedsPort !== true) are free-checked and reserved; embed-only bases (URLs
 * that merely point at another service) just take the deterministic slot port,
 * so e.g. VITE_BACKEND_DOMAIN stays aligned with the FASTAPI_PORT it references.
 */
async function resolvePorts(
  assignments: PortAssignment[],
  slot: number,
  offset: number
): Promise<Map<number, ResolvedPort>> {
  const byBase = new Map<number, { binding: boolean }>();
  for (const a of assignments) {
    const cur = byBase.get(a.base) ?? { binding: false };
    if (!a.embedsPort) {
      cur.binding = true;
    }
    byBase.set(a.base, cur);
  }

  const taken = new Set<number>();
  const resolved = new Map<number, ResolvedPort>();
  // Resolve binding bases first so embed-only bases can mirror them.
  for (const [base, info] of byBase) {
    if (!info.binding) {
      continue;
    }
    const port = await resolveFreePort(base, slot, offset, taken);
    resolved.set(base, { base, port, binding: true });
  }
  for (const [base, info] of byBase) {
    if (info.binding) {
      continue;
    }
    resolved.set(base, { base, port: computePort(base, slot, offset), binding: false });
  }
  return resolved;
}

// ─── provision ───────────────────────────────────────────────────────────────

export async function provisionWorktree(opts: ProvisionOptions): Promise<ProvisionResult> {
  const { recipe, dryRun } = opts;
  const plan: string[] = [];
  const warnings: string[] = [];
  const generatedFiles: { path: string; content: string }[] = [];
  const ran: string[] = [];
  const step = (s: string) => {
    plan.push(s);
    opts.onProgress?.(s);
  };

  const repoRoot = await gitTopLevel(opts.projectPath);
  const slug = sanitizeSlug(opts.slug);
  const branchPrefix = recipe.branchPrefix || "cl/";
  const branch = `${branchPrefix}${slug}`;
  const offset = recipe.ports.offset ?? 10;

  const state = loadState(repoRoot);
  const slot = opts.slot ?? slotForBranch(state, branch);

  // Worktree path: outside the repo, namespaced by repo basename + slug.
  const worktreeRootAbs = path.resolve(repoRoot, recipe.worktreeRoot || "../.cl-worktrees");
  const repoBase = path.basename(repoRoot);
  const existing = state.worktrees[branch];
  const worktreePath = existing?.worktreePath ?? path.join(worktreeRootAbs, repoBase, slug);

  // Compose identity is computed up front: failures and the deferred run steps
  // both reference it before the compose block runs.
  const composeMode = recipe.services.mode === "compose";
  const composeProject = composeMode
    ? `${recipe.services.projectPrefix || repoBase}-${slot}`
    : undefined;
  /** Run steps are deferred until after ports/env are written (see below). */
  const runQueue: { cmd: string; cwd?: string }[] = [];

  const isWorktree = fs.existsSync(path.join(worktreePath, ".git"));
  const pathExists = fs.existsSync(worktreePath);
  if (pathExists && !isWorktree) {
    return fail(`${worktreePath} exists but is not a git worktree; remove it or pick another slug`);
  }
  const reused = isWorktree;

  step(`repo: ${repoRoot}`);
  step(`branch: ${branch}   slot: ${slot}   offset: ${offset}`);
  step(`worktree: ${worktreePath}${reused ? "  (reusing existing)" : ""}`);

  // 1. Create the worktree (skip if reusing).
  if (!reused) {
    const baseRef = opts.baseRef || "HEAD";
    const hasBranch = await branchExists(repoRoot, branch);
    const addArgs = hasBranch
      ? ["-C", repoRoot, "worktree", "add", worktreePath, branch]
      : ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, baseRef];
    step(`git worktree add ${hasBranch ? branch : `-b ${branch} ${baseRef}`}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      const r = await exec("git", addArgs);
      if (r.code !== 0) {
        return fail(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
      }
    }
  }

  // 2. Provision steps — only on a fresh worktree (don't clobber agent work).
  if (!reused) {
    for (const stepDef of recipe.provision) {
      if (stepDef.action === "run") {
        // Defer: run steps (e.g. `make setup`) need the remapped ports + the
        // COMPOSE_PROJECT_NAME already written to .env, which happens below.
        runQueue.push({ cmd: stepDef.cmd, cwd: stepDef.cwd });
        continue;
      }

      for (const rel of stepDef.paths) {
        const src = path.join(repoRoot, rel);
        const dst = path.join(worktreePath, rel);
        if (!fs.existsSync(src)) {
          warnings.push(`${stepDef.action}: source missing, skipped: ${rel}`);
          continue;
        }
        if (fs.existsSync(dst) && stepDef.action !== "copy") {
          step(`${stepDef.action}: ${rel}  (already present, skipped)`);
          continue;
        }
        if (stepDef.action === "copy") {
          step(`copy: ${rel}`);
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            const r = await exec("cp", ["-R", src, dst]);
            if (r.code !== 0) {
              warnings.push(`copy ${rel} failed: ${r.stderr.trim()}`);
            }
          }
        } else if (stepDef.action === "clone") {
          step(`clone (copy-on-write): ${rel}`);
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            const r = await cloneTree(src, dst);
            if (!r.ok) {
              warnings.push(`clone ${rel} failed: ${r.err}`);
            } else if (r.method === "copy") {
              warnings.push(`clone ${rel}: clonefile unsupported here, used a plain copy`);
            }
          }
        } else if (stepDef.action === "symlink") {
          step(`symlink: ${rel} -> ${src}`);
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            try {
              fs.symlinkSync(src, dst);
            } catch (e) {
              warnings.push(`symlink ${rel} failed: ${(e as Error).message}`);
            }
          }
        }
      }
    }
  }

  // 3. Ports — resolve one per base, then build per-file env edits.
  const assignments = recipe.ports.strategy === "none" ? [] : recipe.ports.assignments;
  const resolved = await resolvePorts(assignments, slot, offset);
  const portRecords: PortRecord[] = [];
  const editsByFile = new Map<string, EnvEdit[]>();

  for (const a of assignments) {
    const r = resolved.get(a.base)!;
    const file = a.file || ".env.local";
    const list = editsByFile.get(file) ?? [];
    list.push({ var: a.var, value: String(r.port), embedsPort: a.embedsPort, base: a.base });
    editsByFile.set(file, list);
    // Only record host-binding ports once per var (skip embed mirrors for clarity).
    if (!a.embedsPort && !portRecords.some((p) => p.var === a.var)) {
      portRecords.push({ var: a.var, base: a.base, port: r.port, service: a.service });
    }
  }

  if (assignments.length) {
    step(`ports: ${portRecords.map((p) => `${p.var} ${p.base}->${p.port}`).join(", ") || "(embed-only)"}`);
  }

  // 4. compose: namespace the project + generate a RAM-cap override
  //    (composeMode/composeProject were computed up front).
  const envEdits = editsByFile; // alias for readability below

  if (composeMode) {
    const dotenv = envEdits.get(".env") ?? [];
    dotenv.push({ var: "COMPOSE_PROJECT_NAME", value: composeProject! });

    const overrideContent = buildComposeOverride(recipe.services.containers, composeProject!);
    if (overrideContent) {
      const composeFile = recipe.services.composeFile || "docker-compose.yml";
      dotenv.push({ var: "COMPOSE_FILE", value: `${composeFile}:${OVERRIDE_FILENAME}` });
      const overridePath = path.join(worktreePath, OVERRIDE_FILENAME);
      generatedFiles.push({ path: overridePath, content: overrideContent });
      step(`compose: project "${composeProject}", RAM-cap override ${OVERRIDE_FILENAME} (${recipe.services.containers!.filter((c) => c.memLimit).length} caps)`);
      if (!dryRun) {
        fs.writeFileSync(overridePath, overrideContent);
      }
    } else {
      step(`compose: project "${composeProject}" (no RAM caps in recipe)`);
    }
    envEdits.set(".env", dotenv);
  }

  // 5. Write env files.
  for (const [file, edits] of envEdits) {
    const fp = path.join(worktreePath, file);
    step(`env: write ${edits.map((e) => e.var).join(", ")} -> ${file}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      warnings.push(...applyEnvEdits(fp, edits));
    }
  }

  // 6. Keep the whole Claude Luxure footprint out of the project's git — the
  //    recipe is regenerable and per-developer, so nothing here is pushed.
  if (!dryRun) {
    ensureGitignore(repoRoot, [".claude-luxure/", OVERRIDE_FILENAME]);
  }

  // 6b. Deferred run steps — ports, env files, and COMPOSE_PROJECT_NAME are now
  //     all written, so `make setup`/installs see the correct environment.
  if (!reused && runQueue.length) {
    for (const rs of runQueue) {
      if (!opts.runSteps) {
        step(`skip run "${rs.cmd}"  (pass --run to execute)`);
        continue;
      }
      const cwd = rs.cwd ? path.join(worktreePath, rs.cwd) : worktreePath;
      step(`run: ${rs.cmd}   (cwd ${path.relative(worktreePath, cwd) || "."})`);
      if (!dryRun) {
        const r = await execShell(rs.cmd, cwd, buildEnvMap());
        if (r.code !== 0) {
          warnings.push(`run "${rs.cmd}" exited ${r.code}: ${r.stderr.trim().slice(-400)}`);
        } else {
          ran.push(rs.cmd);
        }
      } else {
        ran.push(rs.cmd);
      }
    }
  }

  // 7. Optionally bring the stack up (compose only).
  let started = false;
  if (composeMode && opts.startServices) {
    const lean = opts.lean ?? recipe.services.leanByDefault ?? false;
    const leanList = lean ? leanServiceNames(recipe.services.containers) : null;
    const upArgs = ["compose", "-p", composeProject!, "up", "-d", ...(leanList ?? [])];
    step(`docker ${upArgs.join(" ")}${lean ? "  (lean: essential only)" : ""}`);
    if (!dryRun) {
      const r = await exec("docker", upArgs, worktreePath, buildEnvMap());
      if (r.code !== 0) {
        warnings.push(`docker compose up failed: ${r.stderr.trim().slice(-400)}`);
      } else {
        started = true;
      }
    } else {
      started = true;
    }
  }

  // Build the env map the bridge injects + the URLs for the UI.
  function buildEnvMap(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const p of portRecords) {
      env[p.var] = String(p.port);
    }
    if (composeProject) {
      env.COMPOSE_PROJECT_NAME = composeProject;
    }
    return env;
  }
  const env = buildEnvMap();

  const urls: { label: string; url: string }[] = [];
  const probePortVar = recipe.dev.readyProbe?.httpPort;
  if (probePortVar) {
    const rec = portRecords.find((p) => p.var === probePortVar);
    if (rec) {
      const p = recipe.dev.readyProbe?.path || "/";
      urls.push({ label: rec.service || "app", url: `http://localhost:${rec.port}${p}` });
    }
  }

  const cwd = recipe.dev.cwd ? path.join(worktreePath, recipe.dev.cwd) : worktreePath;

  // Persist state (skip on dry-run).
  if (!dryRun) {
    recordWorktree(state, {
      branch,
      slug,
      slot,
      worktreePath,
      ports: portRecords,
      composeProject,
      createdAt: existing?.createdAt ?? opts.now,
    });
    saveState(repoRoot, state);
  }

  return {
    ok: true,
    reused,
    worktreePath,
    branch,
    slot,
    cwd,
    env,
    ports: portRecords,
    composeProject,
    urls,
    ran,
    started,
    plan,
    warnings,
    generatedFiles,
  };

  function fail(msg: string): ProvisionResult {
    return {
      ok: false,
      reused: false,
      worktreePath,
      branch,
      slot,
      cwd: worktreePath,
      env: {},
      ports: [],
      composeProject,
      urls: [],
      ran,
      started: false,
      plan,
      warnings: [...warnings, msg],
      generatedFiles,
    };
  }
}

// ─── teardown ────────────────────────────────────────────────────────────────

export interface RemoveOptions {
  projectPath: string;
  branch: string;
  /** compose: `docker compose down -v` to drop the isolated volumes too. */
  removeVolumes?: boolean;
  /** also `git branch -D` the branch (default true). */
  deleteBranch?: boolean;
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface RemoveResult {
  ok: boolean;
  plan: string[];
  warnings: string[];
}

export async function removeWorktree(opts: RemoveOptions): Promise<RemoveResult> {
  const plan: string[] = [];
  const warnings: string[] = [];
  const step = (s: string) => {
    plan.push(s);
    opts.onProgress?.(s);
  };
  const repoRoot = await gitTopLevel(opts.projectPath);
  const state = loadState(repoRoot);
  const entry = state.worktrees[opts.branch];
  if (!entry) {
    warnings.push(`no recorded worktree for branch "${opts.branch}" — attempting git cleanup anyway`);
  }
  const worktreePath = entry?.worktreePath;

  // 1. compose down (best-effort, only if the worktree dir is still there).
  if (entry?.composeProject && worktreePath && fs.existsSync(worktreePath)) {
    const downArgs = ["compose", "-p", entry.composeProject, "down", ...(opts.removeVolumes ? ["-v"] : [])];
    step(`docker ${downArgs.join(" ")}`);
    if (!opts.dryRun) {
      const r = await exec("docker", downArgs, worktreePath);
      if (r.code !== 0) {
        warnings.push(`docker compose down failed: ${r.stderr.trim().slice(-300)}`);
      }
    }
  }

  // 2. git worktree remove.
  if (worktreePath) {
    step(`git worktree remove --force ${worktreePath}`);
    if (!opts.dryRun) {
      const r = await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
      if (r.code !== 0) {
        warnings.push(`git worktree remove failed: ${r.stderr.trim()}`);
      }
    }
  }

  // 3. delete the branch.
  if (opts.deleteBranch !== false) {
    step(`git branch -D ${opts.branch}`);
    if (!opts.dryRun) {
      const r = await exec("git", ["-C", repoRoot, "branch", "-D", opts.branch]);
      if (r.code !== 0) {
        warnings.push(`git branch -D failed: ${r.stderr.trim()}`);
      }
    }
  }

  // 4. forget state.
  if (entry && !opts.dryRun) {
    forgetWorktree(state, opts.branch);
    saveState(repoRoot, state);
  }

  return { ok: warnings.length === 0, plan, warnings };
}

// ─── misc ────────────────────────────────────────────────────────────────────

function ensureGitignore(repoRoot: string, patterns: string[]): void {
  const gi = path.join(repoRoot, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gi, "utf8");
  } catch {
    // no .gitignore yet
  }
  const existing = new Set(content.split("\n").map((l) => l.trim()));
  const missing = patterns.filter((p) => !existing.has(p));
  if (missing.length === 0) {
    return;
  }
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gi, `${prefix}\n# Claude Luxure worktree (local, generated)\n${missing.join("\n")}\n`);
}
