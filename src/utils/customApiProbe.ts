/**
 * Probe + protocol detection for custom API accounts. The add/reconnect flows
 * call detectKeyAuth() to answer three questions with requests instead of
 * settings: which header carries the key (x-api-key vs Bearer), which wire
 * protocol the endpoint speaks (Anthropic /v1/messages vs OpenAI
 * /chat/completions — the latter runs through the api-bridge translator
 * sidecar), and whether the key actually authenticates. vscode-free so it can
 * be exercised headlessly outside the extension host.
 */
import * as http from "http";
import * as https from "https";
import type { ApiKeyEnvVar, CustomApiProtocol } from "../shared/types";

export interface KeyAuthResult {
  keyEnvVar: ApiKeyEnvVar;
  protocol: CustomApiProtocol;
  /** Set when OpenAI detection succeeded on an adjusted base URL (the user
   * gave the bare host without /v1) — store this as the account's baseUrl. */
  baseUrlOverride?: string;
  /** Unset on success; set to a human-readable reason when nothing worked. */
  probeErr?: string;
}

interface HttpReply {
  status: number;
  body: string;
}

function requestJson(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number
): Promise<HttpReply | { err: string }> {
  return new Promise((resolve) => {
    const mod = url.startsWith("http://") ? http : https;
    let req: http.ClientRequest;
    try {
      req = mod.request(
        url,
        { method, headers: { "content-type": "application/json", ...headers }, timeout: timeoutMs },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
        }
      );
    } catch (err) {
      resolve({ err: String(err instanceof Error ? err.message : err) });
      return;
    }
    req.on("timeout", () => {
      req.destroy();
      resolve({ err: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    });
    req.on("error", (err) => resolve({ err: err.message }));
    req.end(body);
  });
}

/** Failure line for one attempt: status + a short reason, never a raw HTML dump. */
function describeFailure(reply: HttpReply | { err: string }): string {
  if ("err" in reply) {
    return reply.err;
  }
  const trimmed = reply.body.trim();
  const detail = trimmed.startsWith("<")
    ? `an HTML page (${trimmed.length.toLocaleString()} bytes) — this URL is a website route, not an API`
    : trimmed.replace(/\s+/g, " ").slice(0, 200);
  return `HTTP ${reply.status}${detail ? ` — ${detail}` : ""}`;
}

function keyHeaders(apiKey: string, keyEnvVar: ApiKeyEnvVar): Record<string, string> {
  return keyEnvVar === "ANTHROPIC_API_KEY"
    ? { "x-api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}

/** One cheap POST {base}/v1/messages (max_tokens: 1) — exactly the request the
 * CLI will send for the chosen key env var. undefined = authenticated. */
async function probeAnthropic(
  baseUrl: string,
  apiKey: string,
  keyEnvVar: ApiKeyEnvVar,
  model: string
): Promise<string | undefined> {
  const reply = await requestJson(
    `${baseUrl || "https://api.anthropic.com"}/v1/messages`,
    "POST",
    { "anthropic-version": "2023-06-01", ...keyHeaders(apiKey, keyEnvVar) },
    JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    20000
  );
  if (!("err" in reply) && reply.status >= 200 && reply.status < 300) {
    return undefined;
  }
  return describeFailure(reply);
}

/** One cheap POST {base}/chat/completions — the OpenAI-protocol equivalent. */
async function probeOpenAi(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<string | undefined> {
  const reply = await requestJson(
    `${baseUrl}/chat/completions`,
    "POST",
    { Authorization: `Bearer ${apiKey}` },
    JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    20000
  );
  if (!("err" in reply) && reply.status >= 200 && reply.status < 300) {
    return undefined;
  }
  return describeFailure(reply);
}

/** Try the Anthropic protocol with both key headers, then fall back to the
 * OpenAI protocol (on the given base, then base + "/v1"). */
export async function detectKeyAuth(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<KeyAuthResult> {
  const preferred: ApiKeyEnvVar =
    !baseUrl || baseUrl.includes("api.anthropic.com")
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
  const other: ApiKeyEnvVar =
    preferred === "ANTHROPIC_API_KEY" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";

  const firstErr = await probeAnthropic(baseUrl, apiKey, preferred, model);
  if (!firstErr) {
    return { keyEnvVar: preferred, protocol: "anthropic" };
  }
  // Only an auth rejection suggests the *header* was wrong — other failures
  // (bad model, timeout, 404) would just repeat identically.
  if (/^HTTP 40[13]\b/.test(firstErr)) {
    const secondErr = await probeAnthropic(baseUrl, apiKey, other, model);
    if (!secondErr) {
      return { keyEnvVar: other, protocol: "anthropic" };
    }
  }

  // OpenAI-protocol fallback. Users paste bases both with and without the
  // /v1 suffix; try as given first, then with /v1 appended.
  let openAiNote = "";
  if (baseUrl) {
    const candidates = [baseUrl];
    if (!/\/v\d+$/.test(baseUrl)) {
      candidates.push(`${baseUrl}/v1`);
    }
    for (const candidate of candidates) {
      const openAiErr = await probeOpenAi(candidate, apiKey, model);
      if (!openAiErr) {
        return {
          keyEnvVar: "ANTHROPIC_AUTH_TOKEN",
          protocol: "openai",
          baseUrlOverride: candidate !== baseUrl ? candidate : undefined,
        };
      }
      if (!openAiNote) {
        openAiNote = `\nOpenAI protocol (${candidate}/chat/completions): ${openAiErr}`;
      }
    }
  }

  return {
    keyEnvVar: preferred,
    protocol: "anthropic",
    probeErr: `Anthropic protocol (${baseUrl || "https://api.anthropic.com"}/v1/messages): ${firstErr}${openAiNote}`,
  };
}

/** Best-effort model catalog (GET {base}/models, then {base}/v1/models) to
 * prefill the add-flow's model step. Sends both auth headers — servers ignore
 * the one they don't use. Empty array when the endpoint has no such route. */
export async function fetchModelCatalog(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl || "https://api.anthropic.com";
  const candidates = /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  for (const url of candidates) {
    const reply = await requestJson(
      url,
      "GET",
      {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      undefined,
      4000
    );
    if ("err" in reply || reply.status < 200 || reply.status >= 300) {
      continue;
    }
    try {
      const parsed = JSON.parse(reply.body);
      const ids = (Array.isArray(parsed?.data) ? parsed.data : [])
        .map((m: { id?: unknown }) => (typeof m?.id === "string" ? m.id : ""))
        .filter(Boolean);
      if (ids.length) {
        return ids.slice(0, 40);
      }
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return [];
}
