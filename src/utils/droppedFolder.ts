import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

/**
 * Folders dragged in from outside VS Code (Finder, Explorer, a browser) reach
 * the webview as a `FileSystemDirectoryEntry` with no filesystem path — the
 * sandboxed iframe only learns the folder's name and its listing. This module
 * turns that back into a real absolute path: find directories with that name
 * (Spotlight, then the workspace, then the usual drop sources) and keep the
 * ones whose contents match the listing that was dropped.
 */

/** What the webview can see of a dropped folder. */
export interface DroppedFolderInfo {
  /** Folder name (last path segment). */
  name: string;
  /** Immediate child names — the fingerprint used to pick the right match. */
  entries: string[];
  /** The listing was cut by the webview's read cap, so it is a prefix only. */
  truncated?: boolean;
}

export interface FolderCandidate {
  dirPath: string;
  /** Share of the dropped listing found in this directory (0..1). */
  score: number;
  /** Every dropped entry name was found here. */
  full: boolean;
  /** The name matched but there was no listing to check it against. */
  nameOnly: boolean;
  inWorkspace: boolean;
}

/** Directories never worth walking when hunting for a dropped folder. */
const SKIP_DIRS = new Set([
  "node_modules",
  "Library",
  "Applications",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
]);

/** A folder with nothing in it (or whose listing we never got) can't be
 * fingerprinted — treat name-only matches as half-confident. */
const NAME_ONLY_SCORE = 0.5;
const MIN_SCORE = 0.6;

const SEARCH_TIMEOUT_MS = 5000;
const MAX_SEARCH_HITS = 400;

/** Resolve a dropped folder to the directories on disk it could be, best
 * first. Empty when nothing matched. */
export async function findDroppedFolder(
  info: DroppedFolderInfo,
  workspaceRoots: string[]
): Promise<FolderCandidate[]> {
  const name = path.basename((info.name ?? "").trim());
  if (!name || name === "." || name === "..") {
    return [];
  }
  const entries = info.entries ?? [];
  const seen = new Set<string>();
  const kept: FolderCandidate[] = [];

  /** Score a batch of paths; answer true once one matched the listing fully,
   * which means later (slower, broader) rounds can be skipped. */
  const consider = (paths: string[]): boolean => {
    let gotFull = false;
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const candidate = scoreCandidate(resolved, entries, workspaceRoots);
      if (!candidate) {
        continue;
      }
      kept.push(candidate);
      gotFull = gotFull || candidate.full;
    }
    return gotFull;
  };

  // Spotlight knows about every indexed volume and answers from an index, so
  // it beats walking the filesystem when it is available.
  if (process.platform === "darwin" && consider(await spotlightSearch(name))) {
    return rank(kept);
  }

  // The workspace is the most likely home for a folder dropped into a chat
  // about that workspace, and it is cheap to walk.
  const workspaceBudget = { dirs: 15000 };
  const fromWorkspace: string[] = [];
  for (const root of workspaceRoots) {
    fromWorkspace.push(...walkForName(root, name, 8, workspaceBudget));
  }
  if (consider(fromWorkspace)) {
    return rank(kept);
  }

  // Then the places drags usually come from.
  const home = os.homedir();
  const commonBudget = { dirs: 6000 };
  const fromCommon: string[] = [];
  for (const [root, depth] of [
    [home, 2],
    [path.join(home, "Desktop"), 4],
    [path.join(home, "Downloads"), 4],
    [path.join(home, "Documents"), 5],
    [path.join(home, "Projects"), 4],
    [path.join(home, "code"), 4],
    ["/Volumes", 3],
  ] as [string, number][]) {
    fromCommon.push(...walkForName(root, name, depth, commonBudget));
  }
  if (consider(fromCommon) || process.platform === "win32") {
    return rank(kept);
  }

  // Last resort: a bounded `find` over the home directory (macOS gets here
  // only when Spotlight is off or the volume is unindexed).
  consider(await findSearch(name, home));
  return rank(kept);
}

/** Rank best-first and drop the candidates whose contents disagree with the
 * dropped listing. */
function rank(candidates: FolderCandidate[]): FolderCandidate[] {
  return candidates
    .filter((c) => c.nameOnly || c.score >= MIN_SCORE)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.full) - Number(a.full) ||
        Number(b.inWorkspace) - Number(a.inWorkspace) ||
        depthOf(a.dirPath) - depthOf(b.dirPath) ||
        a.dirPath.localeCompare(b.dirPath)
    );
}

/** Candidates that tie with the best one — the caller has to ask which. */
export function tiedCandidates(candidates: FolderCandidate[]): FolderCandidate[] {
  if (candidates.length === 0) {
    return [];
  }
  const best = candidates[0];
  return candidates.filter(
    (c) => c.score === best.score && c.full === best.full
  );
}

function depthOf(p: string): number {
  return p.split(path.sep).length;
}

/** How much of the dropped listing this directory actually contains. */
function scoreCandidate(
  dirPath: string,
  entries: string[],
  workspaceRoots: string[]
): FolderCandidate | null {
  let names: Set<string>;
  try {
    if (!fs.statSync(dirPath).isDirectory()) {
      return null;
    }
    names = new Set(fs.readdirSync(dirPath));
  } catch {
    return null;
  }
  const inWorkspace = workspaceRoots.some(
    (root) => root && (dirPath === root || dirPath.startsWith(root + path.sep))
  );
  if (entries.length === 0) {
    return {
      dirPath,
      score: NAME_ONLY_SCORE,
      full: false,
      nameOnly: true,
      inWorkspace,
    };
  }
  let hits = 0;
  for (const entry of entries) {
    if (names.has(entry)) {
      hits++;
    }
  }
  return {
    dirPath,
    score: hits / entries.length,
    full: hits === entries.length,
    nameOnly: false,
    inWorkspace,
  };
}

/** Breadth-first hunt for directories named `name`, pruning the usual heavy
 * trees and never following symlinks (Dirent.isDirectory is false for them). */
function walkForName(
  root: string,
  name: string,
  maxDepth: number,
  budget: { dirs: number }
): string[] {
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (budget.dirs <= 0) {
        return found;
      }
      budget.dirs--;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) {
          continue;
        }
        const full = path.join(dir, dirent.name);
        // Match before pruning, so a dropped `.config` is still findable.
        if (dirent.name === name) {
          found.push(full);
        }
        if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith(".")) {
          continue;
        }
        next.push(full);
      }
    }
    level = next;
  }
  return found;
}

/** Exact-name Spotlight lookup (macOS). */
function spotlightSearch(name: string): Promise<string[]> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return execLines("mdfind", [`kMDItemFSName == "${escaped}"`]);
}

/** Bounded `find` fallback for unindexed volumes and Linux. */
function findSearch(name: string, root: string): Promise<string[]> {
  return execLines("find", [
    root,
    "-maxdepth",
    "6",
    "(",
    "-name",
    "node_modules",
    "-o",
    "-name",
    "Library",
    ")",
    "-prune",
    "-o",
    "-type",
    "d",
    "-name",
    name,
    "-print",
  ]);
}

/** Run a search command and return its stdout lines; failures answer empty. */
function execLines(cmd: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout) => {
        resolve(
          String(stdout ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, MAX_SEARCH_HITS)
        );
      }
    );
  });
}
