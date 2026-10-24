/**
 * api-bridge — Anthropic→OpenAI protocol translator sidecar.
 *
 * The Claude Code CLI speaks only the Anthropic Messages protocol
 * (POST {ANTHROPIC_BASE_URL}/v1/messages, SSE out). This server lets it run
 * against any OpenAI-compatible endpoint (unjailedai, OpenRouter, Ollama,
 * vLLM, …): ClaudeBridge spawns one per "openai"-protocol custom account,
 * points ANTHROPIC_BASE_URL at it, and the sidecar translates both the
 * request and the streaming response. It holds no secret itself — the key the
 * CLI sends (x-api-key or Authorization, per its env var) is forwarded
 * upstream as `Authorization: Bearer`.
 *
 * Mapped surface (what the CLI actually calls, per the claude-code source):
 *   POST /v1/messages[?beta=true]              → {UPSTREAM}/chat/completions
 *   POST /v1/messages/count_tokens[?beta=true] → local chars/4 estimate
 *   system/messages/tools translated; cache_control + beta fields stripped;
 *   server tools (web_search, …: no input_schema) dropped; thinking dropped.
 *   Upstream 401/403 → {"type":"error","error":{"type":"authentication_error"}}
 *   — the exact shape the CLI (and the panel's reconnect flow) detects.
 *
 * Env: API_BRIDGE_UPSTREAM (required) — e.g. https://unjailedai.com/v1
 * Stdout: single "API_BRIDGE_LISTENING <port>" line when ready; logs on stderr.
 */
import * as http from "http";
import * as crypto from "crypto";

const UPSTREAM = (process.env.API_BRIDGE_UPSTREAM || "").replace(/\/+$/, "");

function log(...parts: unknown[]): void {
  process.stderr.write(`[api-bridge] ${parts.map(String).join(" ")}\n`);
}

if (!UPSTREAM) {
  log("API_BRIDGE_UPSTREAM is not set — nothing to translate to");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Deep-remove Anthropic-only decorations OpenAI-compat servers may 400 on. */
function stripAnthropicDecorations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripAnthropicDecorations) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (k === "cache_control") {
        continue;
      }
      out[k] = stripAnthropicDecorations(v);
    }
    return out as T;
  }
  return value;
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((b: Json) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function safeParseJson(s: unknown): Json {
  if (typeof s !== "string" || !s.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    log("tool arguments were not valid JSON; passing {}");
    return {};
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function mapStopReason(finish: unknown): string {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

const warnedOnce = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (!warnedOnce.has(key)) {
    warnedOnce.add(key);
    log(msg);
  }
}

// ── Request translation (Anthropic body → OpenAI body) ───────────────────────

function translateRequest(anthropic: Json): Json {
  const body = stripAnthropicDecorations(anthropic);
  const messages: Json[] = [];

  if (body.system) {
    messages.push({
      role: "system",
      content:
        typeof body.system === "string" ? body.system : textOfBlocks(body.system),
    });
  }

  for (const m of (body.messages as Json[]) || []) {
    const role = m.role as string;
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    const blocks = (m.content as Json[]) || [];
    if (role === "assistant") {
      let text = "";
      const toolCalls: Json[] = [];
      for (const b of blocks) {
        if (b.type === "text") {
          text += b.text ?? "";
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id || newId("call"),
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") {
          warnOnce("thinking", "dropping thinking blocks (no OpenAI equivalent)");
        }
      }
      const msg: Json = { role: "assistant", content: text || null };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
      }
      if (text || toolCalls.length) {
        messages.push(msg);
      }
      continue;
    }
    // user: tool_result blocks become role:"tool" messages and must directly
    // follow the assistant message that carried the matching tool_calls.
    for (const b of blocks) {
      if (b.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: textOfBlocks(b.content) || (b.is_error ? "(tool error)" : "(no output)"),
        });
      }
    }
    const parts: Json[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        parts.push({ type: "text", text: b.text ?? "" });
      } else if (b.type === "image" && (b.source as Json)?.type === "base64") {
        const src = b.source as Json;
        parts.push({
          type: "image_url",
          image_url: { url: `data:${src.media_type};base64,${src.data}` },
        });
      } else if (b.type !== "tool_result") {
        warnOnce(`ublock:${b.type}`, `dropping unsupported user block type "${b.type}"`);
      }
    }
    if (parts.length) {
      messages.push({
        role: "user",
        content: parts.every((p) => p.type === "text")
          ? parts.map((p) => p.text).join("\n")
          : parts,
      });
    }
  }

  // Custom tools only — server tools (web_search_*, code_execution…) have a
  // `type` instead of an input_schema and mean nothing to an OpenAI endpoint.
  const allTools = (body.tools as Json[]) || [];
  const tools = allTools
    .filter((t) => t && t.input_schema)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema,
      },
    }));
  if (allTools.length !== tools.length) {
    warnOnce("servertools", `dropped ${allTools.length - tools.length} server-side tool(s) the upstream can't run`);
  }

  const out: Json = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: !!body.stream,
  };
  if (tools.length) {
    out.tools = tools;
    const tc = body.tool_choice as Json | undefined;
    if (tc?.type === "any") {
      out.tool_choice = "required";
    } else if (tc?.type === "tool") {
      out.tool_choice = { type: "function", function: { name: tc.name } };
    } else if (tc?.type === "auto") {
      out.tool_choice = "auto";
    }
  }
  if (body.temperature !== undefined) {
    out.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    out.top_p = body.top_p;
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }
  if (out.stream) {
    out.stream_options = { include_usage: true };
  }
  return out;
}

// ── Error translation ────────────────────────────────────────────────────────

function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) {
    return "authentication_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status >= 500) {
    return "api_error";
  }
  return "invalid_request_error";
}

function upstreamErrorMessage(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("<")) {
    return `upstream returned an HTML page (HTTP ${status}) — not an API response`;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const msg =
      parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? trimmed;
    return typeof msg === "string" ? msg.slice(0, 500) : JSON.stringify(msg).slice(0, 500);
  } catch {
    return trimmed.slice(0, 500) || `HTTP ${status}`;
  }
}

function sendAnthropicError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: anthropicErrorType(status), message },
    })
  );
}

// ── Response translation ─────────────────────────────────────────────────────

function translateNonStream(data: Json, requestModel: string): Json {
  const choice = ((data.choices as Json[]) || [])[0] || {};
  const msg = (choice.message as Json) || {};
  const content: Json[] = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  for (const tc of (msg.tool_calls as Json[]) || []) {
    const fn = (tc.function as Json) || {};
    content.push({
      type: "tool_use",
      id: tc.id || newId("toolu"),
      name: fn.name || "unknown",
      input: safeParseJson(fn.arguments),
    });
  }
  const usage = (data.usage as Json) || {};
  return {
    id: newId("msg"),
    type: "message",
    role: "assistant",
    model: data.model || requestModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

/** Streaming translator: OpenAI chunk deltas → Anthropic SSE events. */
class StreamTranslator {
  private started = false;
  private blockIndex = -1;
  private blockType: "text" | "tool" | null = null;
  private currentToolIdx: number | null = null;
  private finishReason: unknown = null;
  private usage: Json | null = null;
  private done = false;

  constructor(
    private res: http.ServerResponse,
    private requestModel: string
  ) {}

  private send(event: string, obj: Json): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  private ensureStart(model?: unknown): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    this.send("message_start", {
      type: "message_start",
      message: {
        id: newId("msg"),
        type: "message",
        role: "assistant",
        model: (model as string) || this.requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeBlock(): void {
    if (this.blockType) {
      this.send("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
      this.blockType = null;
      this.currentToolIdx = null;
    }
  }

  handleChunk(chunk: Json): void {
    this.ensureStart(chunk.model);
    if (chunk.usage) {
      this.usage = chunk.usage as Json;
    }
    const choice = ((chunk.choices as Json[]) || [])[0];
    if (!choice) {
      return;
    }
    const delta = (choice.delta as Json) || {};

    if (typeof delta.content === "string" && delta.content.length) {
      if (this.blockType !== "text") {
        this.closeBlock();
        this.blockIndex++;
        this.blockType = "text";
        this.send("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      this.send("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    } else if (delta.content && typeof delta.content !== "string") {
      warnOnce("arraydelta", "upstream sent non-string content delta; ignored");
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      warnOnce("reasoning", "upstream streams reasoning_content; dropped (no Anthropic equivalent without signatures)");
    }

    for (const tc of (delta.tool_calls as Json[]) || []) {
      const idx = (tc.index as number) ?? 0;
      if (this.blockType !== "tool" || this.currentToolIdx !== idx) {
        this.closeBlock();
        this.blockIndex++;
        this.blockType = "tool";
        this.currentToolIdx = idx;
        const fn = (tc.function as Json) || {};
        this.send("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: {
            type: "tool_use",
            id: tc.id || newId("toolu"),
            name: fn.name || "unknown",
            input: {},
          },
        });
      }
      const args = ((tc.function as Json) || {}).arguments;
      if (typeof args === "string" && args.length) {
        this.send("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.ensureStart();
    this.closeBlock();
    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
      usage: {
        input_tokens: this.usage?.prompt_tokens ?? 0,
        output_tokens: this.usage?.completion_tokens ?? 0,
      },
    });
    this.send("message_stop", { type: "message_stop" });
    this.res.end();
  }

  get hasStarted(): boolean {
    return this.started;
  }
}

// ── Upstream call ────────────────────────────────────────────────────────────

function inboundKey(req: http.IncomingMessage): string {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey) {
    return xKey;
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth) {
    return auth.replace(/^Bearer\s+/i, "");
  }
  return "";
}

async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  anthropicBody: Json
): Promise<void> {
  const key = inboundKey(req);
  if (!key) {
    sendAnthropicError(res, 401, "no API key on the request");
    return;
  }
  let openaiBody = translateRequest(anthropicBody);
  const url = `${UPSTREAM}/chat/completions`;

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(openaiBody),
      signal: abort.signal,
    });
    // Some strict servers 400 on stream_options — retry once without it.
    if (upstream.status === 400 && openaiBody.stream_options) {
      const retryBody = { ...openaiBody };
      delete retryBody.stream_options;
      const retry = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(retryBody),
        signal: abort.signal,
      });
      if (retry.ok) {
        warnOnce("streamopts", "upstream rejects stream_options; retried without");
        upstream = retry;
        openaiBody = retryBody;
      } else {
        upstream = retry.status === 400 ? upstream : retry;
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      return;
    }
    sendAnthropicError(res, 502, `could not reach upstream ${url}: ${String(err)}`);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    log(`upstream HTTP ${upstream.status} for model=${String(anthropicBody.model)}`);
    sendAnthropicError(res, upstream.status, upstreamErrorMessage(upstream.status, text));
    return;
  }

  if (!openaiBody.stream) {
    const data = (await upstream.json()) as Json;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(translateNonStream(data, String(anthropicBody.model))));
    return;
  }

  // SSE passthrough with translation.
  const translator = new StreamTranslator(res, String(anthropicBody.model));
  const reader = upstream.body?.getReader();
  if (!reader) {
    sendAnthropicError(res, 502, "upstream sent no body for a streaming request");
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          translator.finish();
          return;
        }
        try {
          translator.handleChunk(JSON.parse(payload));
        } catch {
          warnOnce("badchunk", `unparseable upstream SSE chunk: ${payload.slice(0, 120)}`);
        }
      }
    }
    translator.finish();
  } catch (err) {
    if (abort.signal.aborted) {
      return;
    }
    log("stream error:", String(err));
    if (translator.hasStarted) {
      // Mid-stream failure: close the message so the CLI doesn't hang.
      translator.finish();
    } else {
      sendAnthropicError(res, 502, `upstream stream failed: ${String(err)}`);
    }
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

const MAX_BODY = 64 * 1024 * 1024;

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (req.method !== "POST") {
    sendAnthropicError(res, 404, `no route for ${req.method} ${path}`);
    return;
  }
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BODY && !tooBig) {
      tooBig = true;
      sendAnthropicError(res, 413, "request body too large");
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) {
      return;
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendAnthropicError(res, 400, "request body was not valid JSON");
      return;
    }
    if (path === "/v1/messages") {
      void handleMessages(req, res, parsed).catch((err) => {
        log("handler crashed:", err instanceof Error ? err.stack || err.message : String(err));
        if (!res.headersSent) {
          sendAnthropicError(res, 500, "api-bridge internal error");
        } else {
          res.end();
        }
      });
      return;
    }
    if (path === "/v1/messages/count_tokens") {
      // Local estimate — good enough for the CLI's context bookkeeping, and
      // avoids an upstream protocol it doesn't have.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
      return;
    }
    log(`404 for POST ${path}`);
    sendAnthropicError(res, 404, `no route for POST ${path}`);
  });
});

server.requestTimeout = 120_000; // body receipt only; streamed responses are unaffected
server.keepAliveTimeout = 620_000;
server.headersTimeout = 125_000;

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // The one stdout line ClaudeBridge waits for before spawning the CLI.
  process.stdout.write(`API_BRIDGE_LISTENING ${port}\n`);
  log(`translating Anthropic → OpenAI for ${UPSTREAM} on 127.0.0.1:${port}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
