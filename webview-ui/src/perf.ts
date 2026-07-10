import { useLayoutEffect } from "react";
import vscode from "./vscode";

/** Master switch for the webview half of the lag diagnostics. Events are
 * mirrored to the extension log (via a `perfEvent` message, prefixed `wv.`)
 * so host and webview timings line up in one file. */
export const PERF = true;

export function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function perfLog(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  if (!PERF) {
    return;
  }
  try {
    console.debug(`[perf] ${event}`, fields);
    vscode.postMessage({ type: "perfEvent", event, fields });
  } catch {
    // diagnostics must never break the app
  }
}

// --- Tab-switch waterfall -------------------------------------------------
// markSwitch() stamps a perfId onto the outgoing switchSession message; the
// provider echoes it on the matching state push, letting us log the full
// click → host → state received → painted timeline for one switch.

let pendingSwitch: { id: string; t0: number } | null = null;
let switchSeq = 0;

export function markSwitch(target: string): string {
  if (!PERF) {
    return "";
  }
  const id = `sw${++switchSeq}-${target.slice(-6)}`;
  pendingSwitch = { id, t0: performance.now() };
  perfLog("sw.click", { perfId: id });
  return id;
}

/** Extra fields for the state push that answers a pending switch. */
export function switchExtras(
  perfId?: string
): { perfId: string; sinceClickMs: number } | undefined {
  if (!perfId || pendingSwitch?.id !== perfId) {
    return undefined;
  }
  return { perfId, sinceClickMs: r1(performance.now() - pendingSwitch.t0) };
}

/** Log when the switched-to conversation actually hit the screen: double rAF
 * lands after React's commit and the following paint. */
export function markSwitchPainted(perfId?: string): void {
  if (!perfId || pendingSwitch?.id !== perfId) {
    return;
  }
  const sw = pendingSwitch;
  pendingSwitch = null;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      perfLog("sw.painted", {
        perfId: sw.id,
        totalMs: r1(performance.now() - sw.t0),
      });
    });
  });
}

// --- Message-flood counter ------------------------------------------------
// One line per 5s window, only when the webview is being hammered — shows
// which message types flood the thread (state, paneState, streamToken…).

let msgCounts: Record<string, number> = {};
let msgFlushTimer: ReturnType<typeof setTimeout> | undefined;

export function countMessage(type: string): void {
  if (!PERF) {
    return;
  }
  msgCounts[type] = (msgCounts[type] ?? 0) + 1;
  if (msgFlushTimer === undefined) {
    msgFlushTimer = setTimeout(() => {
      msgFlushTimer = undefined;
      const total = Object.values(msgCounts).reduce((a, b) => a + b, 0);
      if (total >= 25) {
        perfLog("msg.rate5s", msgCounts);
      }
      msgCounts = {};
    }, 5000);
  }
}

// --- Continuous monitors ---------------------------------------------------

/** Long-task observer + event-loop sampler for the webview thread. Returns a
 * cleanup so the caller can mount it in a useEffect. */
export function installPerfMonitors(): () => void {
  if (!PERF) {
    return () => {};
  }
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfLog("longtask", {
          ms: Math.round(entry.duration),
          ...(pendingSwitch ? { during: pendingSwitch.id } : {}),
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask API unavailable here — the sampler below still catches stalls
  }
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - 500;
    last = now;
    // Ignore throttled-while-hidden ticks — only visible stalls are lag.
    if (drift > 100 && drift < 30_000 && document.visibilityState === "visible") {
      perfLog("loopLag", { ms: Math.round(drift) });
    }
  }, 500);
  perfLog("monitors.on", {});
  return () => {
    observer?.disconnect();
    clearInterval(timer);
  };
}

// --- Slow-render probe -----------------------------------------------------

const lastRenderLogAt: Record<string, number> = {};

/** Logs commits of the host component that took real time. Threshold + rate
 * limit keep streaming-time re-renders from flooding the log. */
export function useRenderPerf(
  name: string,
  info: Record<string, unknown>
): void {
  const t0 = performance.now();
  useLayoutEffect(() => {
    if (!PERF) {
      return;
    }
    const ms = performance.now() - t0;
    if (ms < 24) {
      return;
    }
    const now = Date.now();
    if (ms < 100 && now - (lastRenderLogAt[name] ?? 0) < 250) {
      return;
    }
    lastRenderLogAt[name] = now;
    perfLog("render.slow", { c: name, ms: Math.round(ms), ...info });
  });
}
