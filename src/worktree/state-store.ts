// Persistent per-project worktree state, stored at `.claude-luxure/state.json`
// in the MAIN repo (NOT in any worktree). It records which slot each worktree
// branch owns so ports stay stable across restarts, and tracks enough to tear a
// worktree down cleanly later. This file is local state, not config — it should
// be gitignored (the provisioner ensures `.claude-luxure/state.json` is ignored).

import * as fs from "fs";
import * as path from "path";

export interface PortRecord {
  var: string;
  base: number;
  port: number;
  service?: string;
}

export interface WorktreeEntry {
  branch: string;
  slug: string;
  slot: number;
  worktreePath: string;
  ports: PortRecord[];
  composeProject?: string;
  /** ISO timestamp, stamped by the caller (this module never reads a clock). */
  createdAt?: string;
}

export interface WorktreeState {
  version: 1;
  /** Keyed by branch name. */
  worktrees: Record<string, WorktreeEntry>;
}

export function statePath(projectPath: string): string {
  return path.join(projectPath, ".claude-luxure", "state.json");
}

export function loadState(projectPath: string): WorktreeState {
  try {
    const raw = fs.readFileSync(statePath(projectPath), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.worktrees) {
      return parsed as WorktreeState;
    }
  } catch {
    // Missing or malformed → start fresh.
  }
  return { version: 1, worktrees: {} };
}

export function saveState(projectPath: string, state: WorktreeState): void {
  const dir = path.join(projectPath, ".claude-luxure");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(projectPath), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Slot for a branch: reuse the branch's existing slot if known, else take the
 * lowest free positive integer (slot 0 is reserved for the main repo). Reusing
 * the lowest free slot keeps allocated ports as low/dense as possible even after
 * worktrees are removed. Does NOT persist — the caller records + saves.
 */
export function slotForBranch(state: WorktreeState, branch: string): number {
  const existing = state.worktrees[branch];
  if (existing) {
    return existing.slot;
  }
  const used = new Set(Object.values(state.worktrees).map((w) => w.slot));
  let slot = 1;
  while (used.has(slot)) {
    slot++;
  }
  return slot;
}

export function recordWorktree(state: WorktreeState, entry: WorktreeEntry): void {
  state.worktrees[entry.branch] = entry;
}

export function forgetWorktree(state: WorktreeState, branch: string): void {
  delete state.worktrees[branch];
}
