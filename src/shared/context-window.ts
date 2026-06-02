/** Native context limits — CLI modelUsage.contextWindow is often stale at 200k for 1M models. */
const ONE_M = 1_000_000;
const DEFAULT_WINDOW = 200_000;

function parseEnvMaxContext(): number | undefined {
  const raw = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Best-effort native window for a model id (aliases included). */
export function nativeContextWindowForModel(modelId: string): number {
  const m = modelId.toLowerCase();

  if (m.includes("haiku")) {
    return DEFAULT_WINDOW;
  }

  // Older Sonnet/Opus 4.0 ids (20250514) — 200k generation
  if (m.includes("20250514")) {
    return DEFAULT_WINDOW;
  }

  // 1M-native families (Opus 4.6+, Sonnet 4.6+, Opus 4.8, etc.)
  if (
    /claude-opus-4-[6-9]/.test(m) ||
    /claude-sonnet-4-[6-9]/.test(m) ||
    m.includes("claude-opus-4-8") ||
    m.includes("claude-opus-4-7") ||
    m.includes("claude-opus-4-6") ||
    m.includes("claude-sonnet-4-6")
  ) {
    return ONE_M;
  }

  // CLI aliases for latest models
  if (m === "opus" || m === "sonnet" || m.startsWith("claude-opus-4")) {
    return ONE_M;
  }

  if (m.startsWith("claude-sonnet-4")) {
    return ONE_M;
  }

  return DEFAULT_WINDOW;
}

/**
 * Resolve the denominator for context % — prefer CLI value when correct,
 * override stale 200k reporting for 1M models (anthropics/claude-code#63447).
 */
export function resolveContextWindow(
  modelId: string,
  reportedFromCli?: number,
  contextUsed?: number
): number {
  const envMax = parseEnvMaxContext();
  if (envMax !== undefined) {
    return envMax;
  }

  const native = nativeContextWindowForModel(modelId);
  let window = reportedFromCli ?? native;

  if (reportedFromCli === DEFAULT_WINDOW && native === ONE_M) {
    window = ONE_M;
  }

  if (window < native) {
    window = native;
  }

  // Session still running above reported cap → true window is larger (CLI registry bug)
  if (
    contextUsed !== undefined &&
    contextUsed > window &&
    window === DEFAULT_WINDOW &&
    native === ONE_M
  ) {
    window = ONE_M;
  }

  return window;
}

/** Input-side tokens in the current context (matches Claude Code statusline formula). */
export function contextTokensUsed(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

export function contextUsedPercent(
  contextUsed: number,
  contextWindow: number
): number {
  if (contextWindow <= 0) return 0;
  return Math.min(100, Math.round((contextUsed / contextWindow) * 100));
}
