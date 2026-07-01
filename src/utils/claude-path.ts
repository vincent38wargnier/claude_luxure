import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "./logger";

// Resolve the absolute path to the `claude` CLI binary. The extension used to
// rely solely on `spawn("claude", ...)`, i.e. a bare PATH lookup. That breaks
// whenever the GUI process (VSCode/Cursor) doesn't inherit the shell PATH that
// has `claude` on it — and, increasingly, when the only `claude` on the machine
// is the native binary bundled inside the official Claude Code extension, which
// is never placed on PATH. Both cases surface as `spawn claude ENOENT`.
//
// Resolution order:
//   1. The `claude-luxure.claudePath` setting (explicit override).
//   2. Common standalone-install locations.
//   3. The native binary bundled with the official VSCode/Cursor extension.
//   4. Bare "claude" — preserve the original PATH-lookup behavior as a fallback.

let cached: string | undefined;

export function resolveClaudePath(): string {
  if (cached) {
    return cached;
  }
  cached = computeClaudePath();
  log("INFO", `Resolved claude binary: ${cached}`);
  return cached;
}

/** Drop the cached resolution — call when the `claudePath` setting changes. */
export function clearClaudePathCache(): void {
  cached = undefined;
}

function computeClaudePath(): string {
  // 1. Explicit setting wins.
  const configured = vscode.workspace
    .getConfiguration("claude-luxure")
    .get<string>("claudePath")
    ?.trim();
  if (configured) {
    const expanded = expandHome(configured);
    if (isExecutable(expanded)) {
      return expanded;
    }
    log(
      "WARN",
      `claude-luxure.claudePath is set to "${configured}" but it was not found or is not executable; auto-detecting instead.`
    );
  }

  const home = os.homedir();

  // 2. Common standalone-install locations.
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    path.join(home, ".bun", "bin", "claude"),
    "/opt/homebrew/lib/node_modules/.bin/claude",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      return c;
    }
  }

  // 3. Native binary bundled with the official Claude Code extension.
  const bundled = findBundledBinary(home);
  if (bundled) {
    return bundled;
  }

  // 4. Last resort: rely on PATH (original behavior).
  log(
    "WARN",
    "Could not locate a `claude` binary; falling back to PATH lookup. If sends fail with ENOENT, set claude-luxure.claudePath."
  );
  return "claude";
}

/** Find the highest-versioned native `claude` binary shipped inside the
 * official Claude Code extension across the known editor extension dirs. */
function findBundledBinary(home: string): string | undefined {
  const extRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".cursor-server", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];

  let best: { version: number[]; binPath: string } | undefined;
  for (const root of extRoots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("anthropic.claude-code-")) {
        continue;
      }
      const binPath = path.join(root, name, "resources", "native-binary", "claude");
      if (!isExecutable(binPath)) {
        continue;
      }
      const version = parseVersion(name);
      if (!best || compareVersion(version, best.version) > 0) {
        best = { version, binPath };
      }
    }
  }
  return best?.binPath;
}

function parseVersion(dirName: string): number[] {
  const m = dirName.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) - (b[i] ?? 0);
    }
  }
  return 0;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function isExecutable(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
