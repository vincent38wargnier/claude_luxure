import * as http from "http";
import * as crypto from "crypto";
import type { ProofAnnotation } from "../shared/types";
import { log } from "../utils/logger";

/**
 * The luxure MCP server runs as a child of the Claude CLI, not of the
 * extension host, so it has no direct line to the webview. This channel is
 * that line: a loopback-only HTTP server with a per-instance bearer token.
 * The MCP server gets the URL/token via env baked into its --mcp-config entry
 * and POSTs here; the extension pushes the result into the chat.
 */

export interface ProofPresentRequest {
  bridgeId?: string;
  /** Absolute (or CLI-cwd-relative, pre-resolved by the tool) image path. */
  path?: string;
  /** Alternative to path: the image inline as a data URL. */
  dataUrl?: string;
  caption?: string;
}

export interface ProofAnnotateRequest {
  bridgeId?: string;
  path: string;
  annotations: ProofAnnotation[];
  outputPath?: string;
  /** Present the annotated image in the chat (default true). */
  show?: boolean;
  caption?: string;
}

export interface ProofChannelHandlers {
  present(req: ProofPresentRequest): Promise<Record<string, unknown>>;
  annotate(req: ProofAnnotateRequest): Promise<Record<string, unknown>>;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // data-URL presents can be large

export class ProofChannel {
  readonly token = crypto.randomBytes(16).toString("hex");
  private server: http.Server | undefined;
  private _port = 0;

  constructor(private readonly handlers: ProofChannelHandlers) {}

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.respond(res, 500, { ok: false, error: String(err?.message || err) });
        });
      });
      server.on("error", (err) => {
        if (!this._port) {
          reject(err);
        } else {
          log("ERROR", "Proof channel error:", String(err));
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
          this.server = server;
          log("INFO", "Proof channel listening on", this.url);
          resolve();
        } else {
          reject(new Error("Proof channel failed to bind"));
        }
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.method !== "POST") {
      return this.respond(res, 405, { ok: false, error: "POST only" });
    }
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${this.token}`) {
      return this.respond(res, 401, { ok: false, error: "Bad token" });
    }

    const body = await this.readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return this.respond(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    try {
      if (req.url === "/present") {
        const result = await this.handlers.present(parsed as ProofPresentRequest);
        return this.respond(res, 200, { ok: true, ...result });
      }
      if (req.url === "/annotate") {
        const result = await this.handlers.annotate(parsed as ProofAnnotateRequest);
        return this.respond(res, 200, { ok: true, ...result });
      }
      return this.respond(res, 404, { ok: false, error: `Unknown route ${req.url}` });
    } catch (err) {
      // Handler errors are expected data (bad path, panel closed…): report them
      // to the tool as a message, not a socket-level failure.
      return this.respond(res, 200, {
        ok: false,
        error: String((err as Error)?.message || err),
      });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("Body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private respond(
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}
