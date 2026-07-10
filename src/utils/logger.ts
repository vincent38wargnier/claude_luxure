import * as fs from "fs";
import * as path from "path";

// __dirname is the bundled dist/ — one level up lands the log at the repo
// root (it used to escape to the repo's PARENT directory).
const LOG_FILE = path.join(__dirname, "..", "claude-luxure.log");

export function log(level: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  const line = `[${timestamp}] [${level}] ${msg}\n`;

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }
}

export function clearLog(): void {
  try {
    fs.writeFileSync(LOG_FILE, "");
  } catch {
    // ignore
  }
}
