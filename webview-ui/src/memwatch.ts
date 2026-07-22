import vscode from "./vscode";

/** Chromium-only renderer heap numbers (fine: the webview IS Chromium). */
interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const MB = 1024 * 1024;
const POLL_MS = 30_000;
/** Telemetry cadence: quiet baseline every 5 min, every poll when elevated. */
const REPORT_MS = 300_000;
const ELEVATED_PCT = 0.5;
const PRESSURE_PCT = 0.6;
const CRITICAL_PCT = 0.8;
const PRESSURE_COOLDOWN_MS = 120_000;
const CRITICAL_COOLDOWN_MS = 180_000;

/** Watch the JS heap and warn the host before the renderer OOM-crashes (V8
 * aborts near its limit, leaving a dead gray panel with no VS Code event):
 * `memPressure` lets the host shrink what it sends, `memCritical` asks for a
 * controlled webview reload — a one-second flicker instead of a corpse. */
export function startMemWatch(): void {
  const read = () =>
    (performance as unknown as { memory?: PerformanceMemory }).memory;
  if (!read()?.jsHeapSizeLimit) {
    return;
  }
  let lastReport = 0;
  let lastPressure = 0;
  let lastCritical = 0;
  setInterval(() => {
    const mem = read();
    if (!mem?.usedJSHeapSize || !mem.jsHeapSizeLimit) {
      return;
    }
    const pct = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
    const usedMB = Math.round(mem.usedJSHeapSize / MB);
    const limitMB = Math.round(mem.jsHeapSizeLimit / MB);
    const now = Date.now();
    const reportEvery = pct > ELEVATED_PCT ? POLL_MS - 1000 : REPORT_MS;
    if (now - lastReport > reportEvery) {
      lastReport = now;
      vscode.postMessage({
        type: "memStats",
        usedMB,
        limitMB,
        pct: Math.round(pct * 100),
      });
    }
    if (pct > CRITICAL_PCT) {
      if (now - lastCritical > CRITICAL_COOLDOWN_MS) {
        lastCritical = now;
        vscode.postMessage({ type: "memCritical", usedMB, limitMB });
      }
    } else if (pct > PRESSURE_PCT) {
      if (now - lastPressure > PRESSURE_COOLDOWN_MS) {
        lastPressure = now;
        vscode.postMessage({ type: "memPressure", usedMB, limitMB });
      }
    }
  }, POLL_MS);
}
