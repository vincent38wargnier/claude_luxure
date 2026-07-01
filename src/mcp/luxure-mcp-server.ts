/**
 * The "luxure" MCP server — visual-proof tools the extension hands to the
 * Claude CLI (via --mcp-config) so the model can capture screenshots, draw on
 * them, and show them to the user inside the chat webview.
 *
 * Runs as a stdio child of the CLI (newline-delimited JSON-RPC), bundled to
 * dist/luxure-mcp.js and executed with the extension host's own runtime
 * (ELECTRON_RUN_AS_NODE=1), so it works even when `node` isn't on PATH.
 *
 * Display/annotation happen in the extension over a loopback HTTP side-channel
 * (see proof-channel.ts) whose URL/token arrive via env. Tool results going
 * back to the model are TEXT ONLY — the pixels go to the user via the
 * side-channel, and the model can Read the saved file when it needs to look.
 */
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const BRIDGE_URL = process.env.LUXURE_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.LUXURE_BRIDGE_TOKEN || "";
const BRIDGE_ID = process.env.LUXURE_BRIDGE_ID || "";

const PROTOCOL_FALLBACK = "2024-11-05";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function logErr(...parts: unknown[]): void {
  process.stderr.write(`[luxure-mcp] ${parts.map(String).join(" ")}\n`);
}

function writeMessage(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: unknown, result: Record<string, unknown>): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function execFileAsync(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** POST to the extension's proof channel; throws with a readable message on
 * any transport or handler failure. */
function postChannel(
  route: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL || !BRIDGE_TOKEN) {
      reject(
        new Error(
          "The extension side-channel is not configured (LUXURE_BRIDGE_URL/TOKEN missing)."
        )
      );
      return;
    }
    const body = JSON.stringify({ ...payload, bridgeId: BRIDGE_ID });
    const req = http.request(
      `${BRIDGE_URL}${route}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (parsed.ok) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || `Channel error (HTTP ${res.statusCode})`));
            }
          } catch {
            reject(new Error(`Channel returned invalid JSON (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("Timed out talking to the extension"));
    });
    req.on("error", (err) =>
      reject(new Error(`Cannot reach the Claude Luxure extension: ${err.message}`))
    );
    req.end(body);
  });
}

function resolveImagePath(p: string, mustExist = true): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (mustExist) {
    if (!fs.existsSync(abs)) {
      throw new Error(`File not found: ${abs}`);
    }
    if (!IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      throw new Error(
        `Not a supported image (${path.extname(abs) || "no extension"}); use PNG/JPEG/WebP/GIF.`
      );
    }
  }
  return abs;
}

function screenshotDir(): string {
  const dir = path.join(os.tmpdir(), "claude-luxure", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Escape a string for interpolation inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function frontWindowBounds(
  app: string
): Promise<{ x: number; y: number; w: number; h: number }> {
  const name = appleScriptString(app);
  // Bring it to front first so the capture shows the window, not what covers it.
  try {
    await execFileAsync("osascript", ["-e", `tell application "${name}" to activate`]);
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    // Not scriptable / not running under that name — bounds lookup below will
    // produce the real error if the process doesn't exist either.
  }
  const script = `tell application "System Events" to tell (first process whose name is "${name}") to get {position, size} of front window`;
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  const nums = stdout.trim().split(",").map((v) => parseInt(v.trim(), 10));
  if (nums.length < 4 || nums.some((n) => Number.isNaN(n))) {
    throw new Error(`Could not read window bounds for "${app}" (got: ${stdout.trim()})`);
  }
  return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
}

interface CaptureArgs {
  target?: "screen" | "window" | "region";
  app?: string;
  region?: { x: number; y: number; width: number; height: number };
  display?: number;
  show?: boolean;
  caption?: string;
}

async function captureScreen(args: CaptureArgs) {
  if (process.platform !== "darwin") {
    return textResult(
      "capture_screen currently supports macOS only. On other platforms, produce a screenshot with a browser tool (e.g. chrome-devtools take_screenshot with a filePath) and use present_screenshot.",
      true
    );
  }
  const target = args.target || "screen";
  const outPath = path.join(screenshotDir(), `capture-${Date.now()}.png`);
  const scArgs = ["-x", "-t", "png"];

  if (target === "region") {
    const r = args.region;
    if (!r || [r.x, r.y, r.width, r.height].some((v) => typeof v !== "number")) {
      return textResult("target=region requires region {x, y, width, height} in screen points.", true);
    }
    scArgs.push(`-R${r.x},${r.y},${r.width},${r.height}`);
  } else if (target === "window") {
    if (!args.app) {
      return textResult('target=window requires "app" (the application name, e.g. "Google Chrome").', true);
    }
    const b = await frontWindowBounds(args.app);
    scArgs.push(`-R${b.x},${b.y},${b.w},${b.h}`);
  } else if (typeof args.display === "number") {
    scArgs.push("-D", String(args.display));
  }

  scArgs.push(outPath);
  try {
    await execFileAsync("screencapture", scArgs);
  } catch (err) {
    throw new Error(
      `screencapture failed: ${(err as Error).message}. If the image is black or the call is denied, VS Code needs Screen Recording permission (System Settings → Privacy & Security → Screen Recording).`
    );
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error(
      "screencapture produced no image — VS Code likely lacks Screen Recording permission (System Settings → Privacy & Security → Screen Recording)."
    );
  }

  let shownNote = "";
  if (args.show !== false) {
    await postChannel("/present", { path: outPath, caption: args.caption });
    shownNote = " and displayed it to the user in the chat panel";
  }
  return textResult(
    `Captured ${target} screenshot to ${outPath}${shownNote}. Read that path if you need to inspect it; pass it to annotate_screenshot to point at specifics.`
  );
}

async function presentScreenshot(args: { path?: string; caption?: string }) {
  if (!args.path) {
    return textResult('"path" is required (an image file on disk).', true);
  }
  const abs = resolveImagePath(args.path);
  await postChannel("/present", { path: abs, caption: args.caption });
  return textResult(
    `Displayed ${path.basename(abs)} to the user in the chat panel${args.caption ? ` (caption: "${args.caption}")` : ""}.`
  );
}

async function annotateScreenshot(args: {
  path?: string;
  annotations?: unknown[];
  output_path?: string;
  show?: boolean;
  caption?: string;
}) {
  if (!args.path) {
    return textResult('"path" is required (the image file to annotate).', true);
  }
  if (!Array.isArray(args.annotations) || args.annotations.length === 0) {
    return textResult('"annotations" must be a non-empty array of drawing instructions.', true);
  }
  const abs = resolveImagePath(args.path);
  const result = await postChannel("/annotate", {
    path: abs,
    annotations: args.annotations,
    outputPath: args.output_path,
    show: args.show,
    caption: args.caption,
  });
  const saved = String(result.savedPath || "");
  const shownNote =
    args.show !== false ? " and displayed it to the user in the chat panel" : "";
  return textResult(
    `Annotated image saved to ${saved}${shownNote}. Read that path to verify the annotations landed where intended.`
  );
}

const ANNOTATION_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["rect", "ellipse", "highlight", "arrow", "text", "badge"],
      description:
        "rect/ellipse: outline a zone. highlight: translucent fill over a zone. arrow: from (x1,y1) to (x2,y2), head at the target. text: a label pill at (x,y). badge: a small numbered/lettered disc centered at (x,y).",
    },
    x: { type: "number", description: "Top-left x (rect/ellipse/highlight) or anchor x (text/badge)." },
    y: { type: "number", description: "Top-left y (rect/ellipse/highlight) or anchor y (text/badge)." },
    width: { type: "number" },
    height: { type: "number" },
    x1: { type: "number", description: "Arrow tail x." },
    y1: { type: "number", description: "Arrow tail y." },
    x2: { type: "number", description: "Arrow head x (points at the target)." },
    y2: { type: "number", description: "Arrow head y." },
    text: {
      type: "string",
      description: "Label drawn near the shape; the content for kind=text/badge.",
    },
    color: { type: "string", description: "CSS color (default #FF3B30)." },
    unit: {
      type: "string",
      enum: ["px", "percent"],
      description:
        "percent (recommended): all coordinates/sizes are 0-100 relative to image width/height. px: raw image pixels (beware retina screenshots are 2x their on-screen size).",
    },
  },
  required: ["kind"],
} as const;

const TOOLS = [
  {
    name: "capture_screen",
    description:
      "Take a screenshot on macOS and (by default) display it to the user in the chat panel. target=screen grabs the main display (or pass display), target=window grabs an app's front window (pass app, e.g. \"Google Chrome\" — the app is brought to front), target=region grabs {x,y,width,height} in screen points. Returns the saved PNG path. Use it to show visual proof of UI work.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["screen", "window", "region"], description: "What to capture (default screen)." },
        app: { type: "string", description: "Application name for target=window." },
        region: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          description: "Screen-point rectangle for target=region.",
        },
        display: { type: "number", description: "1-based display number for target=screen." },
        show: { type: "boolean", description: "Display in the chat immediately (default true). Pass false for intermediate working shots." },
        caption: { type: "string", description: "Short caption shown under the image in the chat." },
      },
    },
  },
  {
    name: "present_screenshot",
    description:
      "Display an existing image file (PNG/JPEG/WebP/GIF) to the user inside the chat panel. Use this to show visual proof — e.g. a screenshot saved by a browser tool (chrome-devtools take_screenshot with filePath) or any image you produced. The user sees the pixels; you only get a text confirmation (Read the file yourself if you need to look at it).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the image file (absolute, or relative to the workspace)." },
        caption: { type: "string", description: "Short caption shown under the image." },
      },
      required: ["path"],
    },
  },
  {
    name: "annotate_screenshot",
    description:
      "Draw annotations (arrows, boxes, ellipses, translucent highlights, text labels, numbered badges) onto an image file, save the result as a new PNG, and (by default) display it to the user in the chat panel. Use it to point at specific UI elements when presenting proof. Prefer unit=percent coordinates (0-100 of image size) — they are robust to retina scaling. Returns the annotated file's path; Read it to verify placement.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The image file to annotate (it is not modified; a new file is written)." },
        annotations: { type: "array", items: ANNOTATION_SCHEMA, description: "Drawing instructions, applied in order." },
        output_path: { type: "string", description: "Where to save the annotated PNG (default: alongside the original as <name>-annotated.png)." },
        show: { type: "boolean", description: "Display in the chat (default true)." },
        caption: { type: "string", description: "Short caption shown under the image." },
      },
      required: ["path", "annotations"],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "capture_screen":
      return captureScreen((args || {}) as CaptureArgs);
    case "present_screenshot":
      return presentScreenshot((args || {}) as { path?: string; caption?: string });
    case "annotate_screenshot":
      return annotateScreenshot(
        (args || {}) as Parameters<typeof annotateScreenshot>[0]
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(msg: Record<string, any>): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "claude-luxure", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return; // notifications: no response
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = String(params?.name || "");
      const args = (params?.arguments || {}) as Record<string, unknown>;
      try {
        reply(id, await callTool(name, args));
      } catch (err) {
        // Tool failures are data for the model, not protocol errors.
        reply(id, textResult(String((err as Error)?.message || err), true));
      }
      return;
    }
    default:
      if (isRequest) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) {
      continue;
    }
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => logErr("handler error:", err?.message || err));
    } catch {
      logErr("skipping non-JSON line:", line.slice(0, 120));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
