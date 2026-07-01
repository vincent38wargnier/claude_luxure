import { spawn } from "child_process";
import { buildRecipePrompt } from "./recipe-prompt";
import { validateRecipe, type WorktreeRecipe, type ValidationResult } from "./recipe-schema";

// Drives a one-shot, read-only `claude` run that analyzes the project and emits
// a WorktreeRecipe. We run in `--print --output-format json` mode (a single JSON
// envelope on stdout), pull the model's final text out of `.result`, extract the
// recipe JSON, and validate it. We never let the model write the recipe file
// itself — validate-then-write keeps a bad answer from reaching the provisioner.

export interface GenerateOptions {
  /** Project to analyze; becomes the child's cwd. */
  projectPath: string;
  /** Absolute path to the `claude` binary (callers resolve via resolveClaudePath). */
  claudePath: string;
  /** Optional model override (else the CLI default). */
  model?: string;
  /** Abort the run (also kills the child). */
  signal?: AbortSignal;
  /** Safety cap on agentic turns. */
  maxTurns?: number;
  /** Notified as raw stderr arrives — useful for surfacing progress in a UI. */
  onStderr?: (chunk: string) => void;
}

export interface GenerateResult {
  validation: ValidationResult;
  /** The model's final text (the part we tried to parse as JSON). */
  rawResult: string;
  /** Total cost in USD if the CLI reported it. */
  costUsd?: number;
  /** Convenience: the validated recipe, or undefined when invalid. */
  recipe?: WorktreeRecipe;
}

/** Pull the first balanced top-level JSON object out of arbitrary text. Handles
 *  the model wrapping its answer in ```json fences or adding stray prose despite
 *  instructions, and ignores braces inside strings. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;

  const start = haystack.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return haystack.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Run the research pass and return the validated recipe (or the errors). */
export function generateRecipe(opts: GenerateOptions): Promise<GenerateResult> {
  const prompt = buildRecipePrompt();
  const args = [
    "--print",
    "--output-format",
    "json",
    // Read-only by construction: only inspection tools are pre-approved, so in
    // non-interactive mode any write/edit attempt is auto-denied (never hangs).
    "--allowedTools",
    "Read,Grep,Glob,LS,Bash",
    "--max-turns",
    String(opts.maxTurns ?? 40),
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push(prompt);

  return new Promise<GenerateResult>((resolve, reject) => {
    const child = spawn(opts.claudePath, args, {
      cwd: opts.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(-2000)}`));
        return;
      }

      // `--output-format json` wraps the final answer: { type, result, total_cost_usd, ... }
      let resultText = stdout;
      let costUsd: number | undefined;
      try {
        const envelope = JSON.parse(stdout);
        if (envelope && typeof envelope.result === "string") {
          resultText = envelope.result;
        }
        if (typeof envelope?.total_cost_usd === "number") {
          costUsd = envelope.total_cost_usd;
        }
      } catch {
        // Not the JSON envelope (e.g. text output) — fall back to raw stdout.
      }

      const jsonStr = extractJsonObject(resultText);
      if (!jsonStr) {
        resolve({
          validation: { valid: false, errors: ["no JSON object found in model output"] },
          rawResult: resultText,
          costUsd,
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        resolve({
          validation: { valid: false, errors: [`recipe JSON did not parse: ${(e as Error).message}`] },
          rawResult: resultText,
          costUsd,
        });
        return;
      }

      const validation = validateRecipe(parsed);
      resolve({ validation, rawResult: resultText, costUsd, recipe: validation.recipe });
    });
  });
}
