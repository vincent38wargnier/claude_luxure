/**
 * The "lightpanda" MCP server — the panel's default browser tool.
 *
 * Boots a private Lightpanda CDP server (one per session, on a free localhost
 * port), then hands this process's stdio to chrome-devtools-mcp connected to
 * it over --wsEndpoint, so the CLI speaks MCP JSON-RPC straight to the
 * adapter. Lightpanda is the vendored submodule at vendor/lightpanda; at
 * runtime the binary resolves in this order:
 *
 *   1. $LIGHTPANDA_BIN — explicit override.
 *   2. vendor/lightpanda/zig-out/bin/lightpanda — a source build of the
 *      submodule (`npm run lightpanda:build`, needs zig).
 *   3. OS cache dir — the official nightly build, downloaded with curl on
 *      first use (~90MB; macOS arm64/x64 and Linux only).
 *
 * Like luxure-mcp, this file is bundled to dist/lightpanda-mcp.js and executed
 * with the extension host's own runtime (ELECTRON_RUN_AS_NODE=1), so it works
 * even when no `node` is on the CLI's PATH.
 */
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/** dist/lightpanda-mcp.js lives one level under the extension root. */
const ROOT = path.join(__dirname, "..");

const NIGHTLY_BASE =
  "https://github.com/lightpanda-io/browser/releases/download/nightly";

function log(...parts: unknown[]): void {
  // stderr only — stdout is the MCP JSON-RPC channel.
  process.stderr.write(`[lightpanda-mcp] ${parts.map(String).join(" ")}\n`);
}

function cacheDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "claude-luxure");
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "claude-luxure"
  );
}

function nightlyAsset(): string | undefined {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const plat =
    process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;
  return arch && plat ? `lightpanda-${arch}-${plat}` : undefined;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find a Lightpanda binary, downloading the nightly as the last resort. */
function resolveLightpanda(): string {
  const explicit = process.env.LIGHTPANDA_BIN;
  if (explicit && isExecutable(explicit)) {
    return explicit;
  }
  const fromSource = path.join(ROOT, "vendor", "lightpanda", "zig-out", "bin", "lightpanda");
  if (isExecutable(fromSource)) {
    return fromSource;
  }
  const cached = path.join(cacheDir(), "lightpanda");
  if (isExecutable(cached)) {
    return cached;
  }

  const asset = nightlyAsset();
  if (!asset) {
    throw new Error(
      `no prebuilt Lightpanda for ${process.platform}/${process.arch}; ` +
        "set LIGHTPANDA_BIN or build the submodule with `npm run lightpanda:build`"
    );
  }
  fs.mkdirSync(cacheDir(), { recursive: true });
  const url = `${NIGHTLY_BASE}/${asset}`;
  log("first use: downloading", url);
  const part = `${cached}.part`;
  const dl = spawnSync("curl", ["-fSL", "--retry", "2", "-o", part, url], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 300_000,
  });
  if (dl.status !== 0) {
    throw new Error(`Lightpanda download failed (curl exit ${dl.status ?? "signal"})`);
  }
  fs.chmodSync(part, 0o755);
  fs.renameSync(part, cached);
  return cached;
}

/** The stdio MCP adapter that translates tool calls into CDP against Lightpanda. */
function resolveAdapter(): string {
  const explicit = process.env.CHROME_DEVTOOLS_MCP_ENTRY;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  const local = path.join(
    ROOT,
    "node_modules",
    "chrome-devtools-mcp",
    "build",
    "src",
    "bin",
    "chrome-devtools-mcp.js"
  );
  if (fs.existsSync(local)) {
    return local;
  }
  throw new Error("chrome-devtools-mcp not found — run `npm install` in the extension repo");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll /json/version until the CDP server answers. */
function waitReady(port: number, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/json/version", timeout: 1_000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        }
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() - started > deadlineMs) {
        reject(new Error("Lightpanda did not become ready in time"));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main(): Promise<void> {
  const bin = resolveLightpanda();
  const adapter = resolveAdapter();
  const port = await freePort();

  let shuttingDown = false;
  let lpExited = false;

  const lp = spawn(bin, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  lp.stderr!.on("data", (d) => process.stderr.write(d));
  lp.on("error", (err) => {
    log("failed to start lightpanda:", String(err));
    process.exit(1);
  });
  lp.on("exit", (code, signal) => {
    lpExited = true;
    if (!shuttingDown) {
      log(`lightpanda exited early (code=${code} signal=${signal})`);
      process.exit(1);
    }
  });

  const killLightpanda = (sig: NodeJS.Signals = "SIGTERM"): void => {
    if (!lpExited) {
      try {
        lp.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  // Belt and braces: never leave a headless browser behind.
  process.on("exit", () => killLightpanda("SIGKILL"));

  try {
    await waitReady(port, 30_000);
  } catch (err) {
    shuttingDown = true;
    killLightpanda("SIGKILL");
    log(String(err));
    process.exit(1);
  }
  log(`lightpanda ready on ws://127.0.0.1:${port}/ (bin: ${bin})`);

  // From here the adapter owns our stdio: the MCP client (the CLI) buffered
  // its first messages in the inherited pipe and the adapter reads them now.
  const mcp = spawn(process.execPath, [adapter, "--wsEndpoint", `ws://127.0.0.1:${port}/`], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  const shutdown = (code: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    killLightpanda();
    process.exit(code);
  };
  mcp.on("error", (err) => {
    log("failed to start chrome-devtools-mcp:", String(err));
    shutdown(1);
  });
  mcp.on("exit", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  process.on("SIGTERM", () => {
    try {
      mcp.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    shutdown(0);
  });
  process.on("SIGINT", () => {
    try {
      mcp.kill("SIGINT");
    } catch {
      /* already gone */
    }
    shutdown(0);
  });
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
