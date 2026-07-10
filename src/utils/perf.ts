import { log } from "./logger";

/** Master switch for the lag diagnostics. Every [PERF] line in the log —
 * host-side timings and forwarded webview events alike — goes through here;
 * flip to false to silence them all once the lag is understood. */
export const PERF = true;

export function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** One grep-friendly line: `[ISO] [PERF] <event> {"json fields"}`. */
export function perfLog(event: string, fields: Record<string, unknown> = {}): void {
  if (!PERF) {
    return;
  }
  try {
    log("PERF", event, JSON.stringify(fields));
  } catch {
    // diagnostics must never throw
  }
}

/** Approximate the IPC cost of a state push without paying for a real
 * JSON.stringify: total characters across all strings (≈ payload KB) and how
 * much of that sits in big blobs (base64 images are the usual culprit). */
export function measureStatePayload(state: {
  messages?: unknown[];
  liveTimeline?: unknown[];
  liveActivities?: unknown[];
}): Record<string, number | undefined> {
  const t0 = performance.now();
  const acc = { chars: 0, blobChars: 0, blobs: 0 };
  scanStrings(state, acc, 0);
  return {
    kb: Math.round(acc.chars / 1024),
    blobKb: Math.round(acc.blobChars / 1024),
    blobs: acc.blobs,
    msgs: state.messages?.length ?? 0,
    live:
      (state.liveTimeline?.length ?? 0) + (state.liveActivities?.length ?? 0),
    scanMs: r1(performance.now() - t0),
  };
}

function scanStrings(
  value: unknown,
  acc: { chars: number; blobChars: number; blobs: number },
  depth: number
): void {
  if (value == null || depth > 12) {
    return;
  }
  if (typeof value === "string") {
    acc.chars += value.length;
    if (value.length >= 8192) {
      acc.blobChars += value.length;
      acc.blobs += 1;
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanStrings(item, acc, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    scanStrings((value as Record<string, unknown>)[key], acc, depth + 1);
  }
}

let loopLagTimer: ReturnType<typeof setInterval> | undefined;

/** Samples the extension host's event loop every 500ms; a late tick means
 * something blocked the host synchronously (big JSON.parse of a stream line,
 * sync fs, serializing a huge postMessage payload). */
export function startLoopLagSampler(): void {
  if (!PERF || loopLagTimer) {
    return;
  }
  let last = performance.now();
  loopLagTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - 500;
    last = now;
    if (drift > 100) {
      perfLog("host.loopLag", { ms: Math.round(drift) });
    }
  }, 500);
  loopLagTimer.unref?.();
}
