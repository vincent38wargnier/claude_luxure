// Per-worktree port allocation. Each worktree gets a stable integer `slot`
// (0 = the main repo, 1.. = worktrees), and a port is derived as
//   base + slot * offset
// so the same worktree keeps the same ports across restarts (bookmarkable URLs).
// We then free-check the derived port and linear-probe upward on collision, so a
// port already taken by something unrelated on the host doesn't break the copy.

import * as net from "net";

/** Deterministic candidate port for a (base, slot) pair. */
export function computePort(base: number, slot: number, offset: number): number {
  return base + slot * offset;
}

/** Is `port` free to bind on the host right now? Checks IPv4 0.0.0.0 — enough
 *  for the docker-published / dev-server case we care about. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "0.0.0.0");
  });
}

/**
 * Resolve a free port for an assignment: start at the deterministic slot port,
 * then probe upward until one is free (or give up after `maxProbes`). `taken`
 * lets the caller reserve ports allocated earlier in the same run so two
 * assignments in one worktree can't land on the same number.
 */
export async function resolveFreePort(
  base: number,
  slot: number,
  offset: number,
  taken: Set<number>,
  maxProbes = 200
): Promise<number> {
  let candidate = computePort(base, slot, offset);
  for (let i = 0; i < maxProbes; i++) {
    if (!taken.has(candidate) && (await isPortFree(candidate))) {
      taken.add(candidate);
      return candidate;
    }
    candidate += 1;
  }
  // Exhausted the probe window — return the deterministic port anyway and let
  // the caller surface the collision rather than silently looping forever.
  const fallback = computePort(base, slot, offset);
  taken.add(fallback);
  return fallback;
}
