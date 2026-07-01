// The "worktree replication recipe" — the per-project config an LLM research
// pass produces and the worktree feature later consumes. A `git worktree` only
// checks out git-TRACKED files, so it omits exactly what's needed to *run* the
// project (secrets, deps, caches). This recipe describes how to fill that gap
// cheaply and how to remap ports so parallel copies don't collide.
//
// Kept dependency-free (no zod/ajv in this repo): the validator below is hand
// rolled so a malformed recipe from the model can never reach the provisioner.

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "none";

/** A single provisioning step. The provisioner runs these in order. */
export type ProvisionStep =
  | { action: "copy"; paths: string[]; reason?: string }
  | { action: "clone"; paths: string[]; reason?: string }
  | { action: "symlink"; paths: string[]; reason?: string }
  | { action: "run"; cmd: string; cwd?: string; reason?: string };

export interface PortAssignment {
  /** Env var that carries the port (real, e.g. `PORT`, or synthesized when the
   *  app reads a framework default rather than an env var). */
  var: string;
  /** The main project's value for this port. */
  base: number;
  /** True when the port is embedded inside a URL (e.g. postgres://h:5432/db);
   *  the provisioner rewrites the port in place rather than replacing the value. */
  embedsPort?: boolean;
  /** Logical owner of the port, e.g. "vite", "next", "postgres". */
  service?: string;
  /** Which env file the remapped value should be written to (default .env.local). */
  file?: string;
  reason?: string;
}

export interface PortPlan {
  /** "slot-offset": each worktree gets an integer slot; port = base + slot*offset.
   *  "none": the project binds no ports (library / CLI). */
  strategy: "slot-offset" | "none";
  /** Increment per slot for slot-offset (e.g. 10 → web 3000/3010/3020…). */
  offset?: number;
  assignments: PortAssignment[];
}

/** Per-container tuning for compose mode. Lets the provisioner generate a
 *  per-worktree compose OVERRIDE (merged via COMPOSE_FILE, so the user's own
 *  compose file is never edited) that caps each container's RAM, and lets a
 *  "lean" start skip heavy optional containers (e.g. background workers) so
 *  many worktree stacks fit in a bounded RAM budget. */
export interface ComposeServiceSpec {
  /** Service name EXACTLY as written in the compose file. */
  name: string;
  /** Memory ceiling in docker syntax, e.g. "1g", "512m". Omit = no cap. */
  memLimit?: string;
  /** false = heavy/optional (skipped when a worktree is started in lean mode).
   *  Default true. Mark background workers / dashboards / mocks false. */
  essential?: boolean;
  /** Approx warm-idle RAM (MB) the research pass measured or estimated —
   *  surfaced in UI/notes so the user can budget how many copies fit. */
  estimatedRamMb?: number;
  reason?: string;
}

export interface ServicePlan {
  /** Lightest mode that stops parallel copies from corrupting each other:
   *  - none     : no backing services
   *  - compose  : docker-compose present → `docker compose -p <prefix>-<slot>`
   *  - container: recommend container-use / devcontainer for heavy isolation
   *  - branch-db: create a fresh DB/schema per worktree
   *  - shared   : LAST resort — copies share one DB (state-corruption risk) */
  mode: "none" | "compose" | "container" | "branch-db" | "shared";
  composeFile?: string;
  projectPrefix?: string;
  /** Per-container RAM caps + lean classification (compose mode only). */
  containers?: ComposeServiceSpec[];
  /** When true, the provisioner starts only `essential` containers by default —
   *  the RAM-efficient default for a heavy stack. The user can opt into the full
   *  stack per worktree. */
  leanByDefault?: boolean;
  rationale?: string;
}

export interface DevPlan {
  /** The single command a developer runs to start the dev environment. */
  start?: string;
  cwd?: string;
  /** How to know the worktree is up (used later for readiness/links). */
  readyProbe?: { httpPort?: string; path?: string };
}

export interface WorktreeRecipe {
  version: 1;
  /** Stamped by the generator after the model returns (model can't read a clock). */
  generatedAt?: string;
  projectName?: string;
  packageManager: PackageManager;
  /** Where worktrees are created; relative paths resolve against the repo root.
   *  Defaults to outside the repo to avoid nested-repo / watcher issues. */
  worktreeRoot: string;
  branchPrefix: string;
  provision: ProvisionStep[];
  ports: PortPlan;
  services: ServicePlan;
  dev: DevPlan;
  /** Free-form findings, assumptions, and caveats from the research pass. */
  notes?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** The recipe with defaults backfilled — only meaningful when `valid`. */
  recipe?: WorktreeRecipe;
}

const PACKAGE_MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun", "none"];
const PORT_STRATEGIES = ["slot-offset", "none"];
const SERVICE_MODES = ["none", "compose", "container", "branch-db", "shared"];
const PROVISION_ACTIONS = ["copy", "clone", "symlink", "run"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate (and lightly normalize) an untrusted recipe object — typically
 * `JSON.parse` of an LLM's output. Returns the list of problems; when empty,
 * `recipe` holds the value with sane defaults backfilled.
 */
export function validateRecipe(input: unknown): ValidationResult {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (!isObj(input)) {
    return { valid: false, errors: ["recipe must be a JSON object"] };
  }

  if (input.version !== 1) {
    push(`version must be 1 (got ${JSON.stringify(input.version)})`);
  }

  const pm = input.packageManager;
  if (typeof pm !== "string" || !PACKAGE_MANAGERS.includes(pm as PackageManager)) {
    push(`packageManager must be one of ${PACKAGE_MANAGERS.join(", ")} (got ${JSON.stringify(pm)})`);
  }

  // provision
  if (!Array.isArray(input.provision)) {
    push("provision must be an array");
  } else {
    input.provision.forEach((step, i) => {
      if (!isObj(step)) {
        push(`provision[${i}] must be an object`);
        return;
      }
      const action = step.action;
      if (typeof action !== "string" || !PROVISION_ACTIONS.includes(action)) {
        push(`provision[${i}].action must be one of ${PROVISION_ACTIONS.join(", ")} (got ${JSON.stringify(action)})`);
        return;
      }
      if (action === "run") {
        if (typeof step.cmd !== "string" || !step.cmd.trim()) {
          push(`provision[${i}] (run) requires a non-empty "cmd"`);
        }
      } else if (!isStrArray(step.paths) || step.paths.length === 0) {
        push(`provision[${i}] (${action}) requires a non-empty "paths" string array`);
      }
    });
  }

  // ports
  if (!isObj(input.ports)) {
    push("ports must be an object");
  } else {
    const ports = input.ports;
    if (typeof ports.strategy !== "string" || !PORT_STRATEGIES.includes(ports.strategy)) {
      push(`ports.strategy must be one of ${PORT_STRATEGIES.join(", ")} (got ${JSON.stringify(ports.strategy)})`);
    }
    if (!Array.isArray(ports.assignments)) {
      push("ports.assignments must be an array");
    } else {
      ports.assignments.forEach((a, i) => {
        if (!isObj(a)) {
          push(`ports.assignments[${i}] must be an object`);
          return;
        }
        if (typeof a.var !== "string" || !a.var.trim()) {
          push(`ports.assignments[${i}].var must be a non-empty string`);
        }
        if (typeof a.base !== "number" || !Number.isInteger(a.base)) {
          push(`ports.assignments[${i}].base must be an integer port (got ${JSON.stringify(a.base)})`);
        }
      });
    }
    if (ports.strategy === "slot-offset" && ports.offset !== undefined) {
      if (typeof ports.offset !== "number" || ports.offset <= 0) {
        push(`ports.offset must be a positive number (got ${JSON.stringify(ports.offset)})`);
      }
    }
  }

  // services
  if (!isObj(input.services)) {
    push("services must be an object");
  } else {
    const services = input.services;
    if (typeof services.mode !== "string" || !SERVICE_MODES.includes(services.mode as string)) {
      push(`services.mode must be one of ${SERVICE_MODES.join(", ")} (got ${JSON.stringify(services.mode)})`);
    } else if (services.mode === "compose" && typeof services.composeFile !== "string") {
      push('services.mode "compose" requires a "composeFile" path');
    }
    if (services.containers !== undefined) {
      if (!Array.isArray(services.containers)) {
        push("services.containers must be an array");
      } else {
        services.containers.forEach((c, i) => {
          if (!isObj(c)) {
            push(`services.containers[${i}] must be an object`);
            return;
          }
          if (typeof c.name !== "string" || !c.name.trim()) {
            push(`services.containers[${i}].name must be a non-empty string`);
          }
          if (c.memLimit !== undefined && (typeof c.memLimit !== "string" || !/^\d+(\.\d+)?\s*[kmgKMG]?[bB]?$/.test(c.memLimit.trim()))) {
            push(`services.containers[${i}].memLimit must be a docker memory string like "512m" or "1g" (got ${JSON.stringify(c.memLimit)})`);
          }
          if (c.essential !== undefined && typeof c.essential !== "boolean") {
            push(`services.containers[${i}].essential must be a boolean`);
          }
          if (c.estimatedRamMb !== undefined && typeof c.estimatedRamMb !== "number") {
            push(`services.containers[${i}].estimatedRamMb must be a number`);
          }
        });
      }
    }
    if (services.leanByDefault !== undefined && typeof services.leanByDefault !== "boolean") {
      push("services.leanByDefault must be a boolean");
    }
  }

  // dev
  if (!isObj(input.dev)) {
    push("dev must be an object");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Backfill defaults now that the shape is known-good.
  const recipe = input as unknown as WorktreeRecipe;
  const normalized: WorktreeRecipe = {
    ...recipe,
    worktreeRoot: typeof recipe.worktreeRoot === "string" && recipe.worktreeRoot.trim()
      ? recipe.worktreeRoot
      : "../.cl-worktrees",
    branchPrefix: typeof recipe.branchPrefix === "string" && recipe.branchPrefix.trim()
      ? recipe.branchPrefix
      : "cl/",
    ports: {
      ...recipe.ports,
      offset: recipe.ports.strategy === "slot-offset" ? recipe.ports.offset ?? 10 : recipe.ports.offset,
    },
  };

  return { valid: true, errors: [], recipe: normalized };
}
