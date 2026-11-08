import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Chat links that point at local files. Codex links its outputs as bare paths
 * ("/Users/…/report.html", "/repo/src/a.ts:42", now and then a file:// URL or
 * a path relative to its cwd). VS Code's webview only follows http(s), mailto
 * and vscode links itself and silently drops everything else, so the webview
 * hands these to the host, which resolves and opens them.
 */

export interface FileLink {
  /** Absolute path — the first candidate tried when nothing exists. */
  filePath: string;
  /** Set when the path exists on disk. */
  kind?: "file" | "directory";
  /** 1-based position from a ":line[:col]" suffix or a "#L12C3" fragment. */
  line?: number;
  column?: number;
}

/** Resolve a link href to a path on disk. Relative paths are tried against
 * each base directory in order; the href arrives percent-encoded (markdown
 * normalizes link URLs), so it is decoded first. */
export function resolveFileLink(href: string, baseDirs: string[]): FileLink {
  let target = href.trim();
  let line: number | undefined;
  let column: number | undefined;

  // GitHub-style fragment: #L42, #L42C7, #L42-L50.
  const hash = target.indexOf("#");
  if (hash !== -1) {
    const m = /^L(\d+)(?:C(\d+))?/i.exec(target.slice(hash + 1));
    if (m) {
      line = Number(m[1]);
      column = m[2] ? Number(m[2]) : undefined;
    }
    target = target.slice(0, hash);
  }

  target = target.replace(/^file:\/\//i, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    // A literal "%" in the name — keep the path as written.
  }

  // Editor-style position suffix: /a/b.ts:42 or /a/b.ts:42:7.
  const pos = /:(\d+)(?::(\d+))?$/.exec(target);
  if (pos) {
    line ??= Number(pos[1]);
    column ??= pos[2] ? Number(pos[2]) : undefined;
    target = target.slice(0, pos.index);
  }

  if (target === "~" || target.startsWith("~/")) {
    target = path.join(os.homedir(), target.slice(1));
  }

  const candidates = path.isAbsolute(target)
    ? [target]
    : baseDirs.map((dir) => path.resolve(dir, target));
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      return {
        filePath: candidate,
        kind: stat.isDirectory() ? "directory" : "file",
        line,
        column,
      };
    } catch {
      // Not under this base — try the next one.
    }
  }
  return { filePath: candidates[0] ?? target, line, column };
}

/** Files VS Code can only show as source or a "binary" placeholder: the
 * system's default app (browser, Preview, Office…) actually renders them. */
const OPEN_EXTERNALLY = new Set([
  ".html", ".htm", ".pdf",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".key", ".pages", ".numbers",
]);

/** Opening one of these would unpack or mount it — show it in Finder instead. */
const REVEAL_ONLY = new Set([".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".dmg"]);

/** How to open a resolved link: an editor tab (text, images, media — at the
 * linked line), the system's default app, or a reveal in the OS file manager. */
export function fileLinkAction(link: FileLink): "editor" | "external" | "reveal" {
  if (link.kind === "directory") return "external";
  const ext = path.extname(link.filePath).toLowerCase();
  if (REVEAL_ONLY.has(ext)) return "reveal";
  if (OPEN_EXTERNALLY.has(ext)) return "external";
  return "editor";
}
