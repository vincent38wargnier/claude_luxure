// The research prompt that drives the one-shot `claude` pass. This is the heart
// of the feature and the thing most worth iterating on: a good prompt turns
// "what does it take to run this project?" into a machine-usable recipe.
//
// The pass is READ-ONLY. It emits a JSON recipe (validated + written by us, so a
// malformed answer can't break provisioning). We inline the schema and a filled
// example so the model emits exactly the shape `validateRecipe` expects.

const SCHEMA_SPEC = `type WorktreeRecipe = {
  version: 1
  projectName?: string
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none"
  worktreeRoot: string          // where worktrees go; prefer OUTSIDE the repo, e.g. "../.cl-worktrees"
  branchPrefix: string          // e.g. "cl/"
  provision: Array<
    | { action: "copy";    paths: string[]; reason?: string }   // small gitignored secrets/config
    | { action: "clone";   paths: string[]; reason?: string }   // big regenerable dirs (copy-on-write)
    | { action: "symlink"; paths: string[]; reason?: string }   // share read-only dirs
    | { action: "run";     cmd: string; cwd?: string; reason?: string } // install/setup command
  >
  ports: {
    strategy: "slot-offset" | "none"   // slot-offset: port = base + slot*offset
    offset?: number                    // default 10
    assignments: Array<{
      var: string            // env var carrying the port (synthesize e.g. "PORT" if it's a framework default)
      base: number           // the main project's current value
      embedsPort?: boolean   // true if port is inside a URL (postgres://h:5432/db)
      service?: string       // "vite" | "next" | "postgres" | ...
      file?: string          // env file to write the remapped value to (default ".env.local")
      reason?: string
    }>
  }
  services: {
    mode: "none" | "compose" | "container" | "branch-db" | "shared"
    composeFile?: string     // required when mode = "compose"
    projectPrefix?: string   // for "docker compose -p <prefix>-<slot>"
    containers?: Array<{     // compose mode: one entry per service, for RAM control
      name: string           // service name EXACTLY as in the compose file
      memLimit?: string      // RAM cap in docker syntax, e.g. "1g" | "512m"
      essential?: boolean    // false = heavy/optional, skipped in lean start (default true)
      estimatedRamMb?: number// approx warm-idle RAM, so the user can budget copies
      reason?: string
    }>
    leanByDefault?: boolean  // true → start only essential containers by default
    rationale?: string
  }
  dev: {
    start?: string           // the single command to start the dev environment
    cwd?: string
    readyProbe?: { httpPort?: string; path?: string }
  }
  notes?: string             // findings, assumptions, caveats
}`;

const EXAMPLE = `{
  "version": 1,
  "projectName": "acme-web",
  "packageManager": "pnpm",
  "worktreeRoot": "../.cl-worktrees",
  "branchPrefix": "cl/",
  "provision": [
    { "action": "copy",  "paths": [".env", ".env.local"], "reason": "gitignored secrets needed at runtime" },
    { "action": "clone", "paths": ["node_modules", "apps/web/node_modules"], "reason": "large + regenerable; copy-on-write is near-instant" },
    { "action": "run",   "cmd": "pnpm install --frozen-lockfile", "reason": "native deps may need rebuild after clone" }
  ],
  "ports": {
    "strategy": "slot-offset",
    "offset": 10,
    "assignments": [
      { "var": "PORT", "base": 3000, "service": "next", "file": ".env.local" },
      { "var": "DATABASE_URL", "base": 5432, "embedsPort": true, "service": "postgres", "file": ".env.local" }
    ]
  },
  "services": {
    "mode": "compose", "composeFile": "docker-compose.yml", "projectPrefix": "acme",
    "containers": [
      { "name": "postgres", "memLimit": "512m", "essential": true,  "estimatedRamMb": 80 },
      { "name": "redis",    "memLimit": "256m", "essential": true,  "estimatedRamMb": 25 },
      { "name": "web",      "memLimit": "1g",   "essential": true,  "estimatedRamMb": 700 },
      { "name": "worker",   "memLimit": "1g",   "essential": false, "estimatedRamMb": 1100, "reason": "background queue worker — not needed for most UI/feature work; skip in lean mode" }
    ],
    "leanByDefault": true,
    "rationale": "Each worktree is its own compose project (docker compose -p acme-<slot>) → isolated Postgres+Redis volumes, zero shared-DB risk. mem caps + lean (skip worker) keep ~5 copies inside a modest RAM budget."
  },
  "dev": { "start": "pnpm dev", "cwd": ".", "readyProbe": { "httpPort": "PORT", "path": "/" } },
  "notes": "Monorepo (pnpm workspaces). Two node_modules. Postgres+Redis via compose."
}`;

/**
 * Build the read-only research prompt. The pass runs with the project as its
 * cwd, so the prompt refers to "the current working directory".
 */
export function buildRecipePrompt(): string {
  return `You are analyzing a software project to produce a **worktree replication recipe**: a JSON config that lets a tool cheaply duplicate this project into an isolated \`git worktree\` so a coding agent can run it in parallel with other copies of the same repo — without port collisions or missing files.

WHY THIS IS NEEDED: a \`git worktree\` only checks out git-TRACKED files. It omits exactly what's needed to actually RUN the project — gitignored secrets (\`.env\`), dependencies (\`node_modules\`, \`.venv\`), build caches, local config. Your recipe describes how to fill that gap as cheaply as possible, and how to remap ports so two copies running at once don't fight over the same port.

This is a READ-ONLY task. Inspect files; do not modify anything. Investigate the CURRENT working directory thoroughly before answering. Determine:

1. PACKAGE MANAGER & WORKSPACES — inspect lockfiles (package-lock.json→npm, pnpm-lock.yaml→pnpm, yarn.lock→yarn, bun.lockb→bun; none→"none"). Is it a monorepo (workspaces field, multiple package.json)? Note EVERY directory that has its own installed dependencies — each needs its own clone/install.

2. HOW IT RUNS LOCALLY — read package.json "scripts" and any Procfile / Makefile / docker-compose / README "getting started". Identify the SINGLE command a developer runs to start the dev environment, and its working directory.

3. PORTS IT BINDS — which ports does the running app listen on? Check explicit PORT in scripts/configs/.env, then framework defaults (Vite 5173, Next.js 3000, CRA 3000, Express/Nest 3000, Vue 8080, Django 8000, Rails 3000, Postgres 5432, Redis 6379). List each port-bearing thing. If the app reads a framework default rather than an env var, still list it with a synthesized var (e.g. "PORT") and say so in its reason.

4. ENVIRONMENT FILES — list all \`.env*\` files and other local config (e.g. \`.mcp.json\`, \`*.local.*\`, credential files). Cross-check \`.gitignore\`: a file that is gitignored AND needed at runtime must be COPIED into the worktree (it won't be checked out).

5. BACKING SERVICES — does it need a database, redis, queue, etc.? Look for docker-compose.yml, connection strings (DATABASE_URL, REDIS_URL) in .env/.env.example, ORM/migration configs. Decide how a parallel copy gets isolated services.

6. RAM FOOTPRINT (compose only) — duplicating a whole stack multiplies RAM, so each duplicated copy must be made cheap. For EVERY service in the compose file, emit a "containers" entry: (a) a sensible "memLimit" cap; (b) "essential": false for anything not needed for ordinary feature/UI work so a "lean" start can skip it — background/queue workers (celery/sidekiq/bull), schedulers/beat, dashboards (flower), mocks, and one-shot jobs are typically non-essential; databases, caches, the API, and the web/dev server are essential; (c) "estimatedRamMb" — read it from running containers if you can (\`docker stats --no-stream\` / \`docker ps\`), else estimate from the image/role. Set "leanByDefault": true when the full stack is heavy (several hundred MB+ of skippable workers). The goal: many worktree copies fit in a bounded RAM budget. To find names + ports, read the compose file's "services:" keys and their "ports:"/"mem_limit:" if any.

DECISION GUIDANCE:
- provision.copy → small gitignored config/secret files that must be present (.env, .env.local, .mcp.json, credentials). Never list tracked files.
- provision.clone → large, regenerable, gitignored dirs (node_modules, .venv, vendor, build caches). List EACH per-package node_modules in a monorepo. These are copy-on-write cloned (cheap on macOS APFS), so prefer clone over a fresh install.
- provision.run → a dependency-install or setup command, ONLY when a clone isn't enough (native modules needing rebuild, generated clients, etc.). Prefer clone; add run only with a reason.
- ports.strategy → "slot-offset" by default (offset 10). Use "none" only if the project binds NO ports (pure library, or a CLI/extension with no dev server).
- services.mode → choose the LIGHTEST mode that prevents parallel copies from corrupting each other's state: "none" (no services) | "compose" (docker-compose present) | "container" (recommend container-use/devcontainer for heavy isolation) | "branch-db" (fresh DB per worktree) | "shared" (LAST resort — copies share one DB; you MUST flag the corruption risk in rationale).
- services.containers (compose only) → one entry per compose service, with memLimit + essential + estimatedRamMb as described in step 6. These drive a generated per-worktree override (the user's compose file is never edited) and the lean start. Use EXACT service names from the compose file.

Base EVERY field on files you actually read — not assumptions. If something is genuinely indeterminate, pick a sensible default and explain it in "notes".

OUTPUT FORMAT — CRITICAL:
Your ENTIRE final message must be a single JSON object matching this TypeScript type. No markdown code fences. No prose before or after. Just the JSON.

${SCHEMA_SPEC}

Example (values illustrative only — derive yours from THIS project):
${EXAMPLE}`;
}
