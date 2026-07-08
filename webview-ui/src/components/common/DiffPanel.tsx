import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, Check, X } from "lucide-react";
import type { PendingDiff } from "../../types";
import vscode from "../../vscode";
import { CodeLine, patchToCodeLines } from "./DiffLines";

interface DiffPanelProps {
  diffs: PendingDiff[];
  /** Absolute workspace root — file paths render relative to it. */
  workspacePath?: string;
  onAccept: (filePath: string) => void;
  onReject: (filePath: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

type FileStatus = "A" | "M" | "D";

interface FileEntry {
  filePath: string;
  /** Basename, bright — the part your eye scans for. */
  base: string;
  /** Containing directory relative to the workspace, dimmed. */
  dir: string;
  status: FileStatus;
  adds: number;
  dels: number;
  /** Patch body normalized for CodeLine (headers stripped). */
  lines: string[];
}

const STATUS_STYLE: Record<FileStatus, { color: string; label: string }> = {
  M: { color: "#e2c08d", label: "Modified" },
  A: { color: "#3fb950", label: "Added" },
  D: { color: "#f85149", label: "Deleted" },
};

function parseEntry(diff: PendingDiff, workspacePath?: string): FileEntry {
  const lines = patchToCodeLines(diff.diff);
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.startsWith("+ ")) {
      adds++;
    } else if (l.startsWith("- ")) {
      dels++;
    }
  }
  // Single-hunk whole-file patches identify creations/deletions the same way
  // git does: the old or new side has zero lines.
  const firstHunk = lines.find((l) => l.startsWith("@@")) || "";
  let status: FileStatus = "M";
  if (/^@@ -0,0\b/.test(firstHunk) && dels === 0) {
    status = "A";
  } else if (/\+0,0 @@/.test(firstHunk) && adds === 0) {
    status = "D";
  }

  let rel = diff.filePath;
  if (workspacePath && rel.startsWith(workspacePath)) {
    rel = rel.slice(workspacePath.length).replace(/^\//, "");
  }
  const segs = rel.split("/");
  const base = segs.pop() || rel;
  return { filePath: diff.filePath, base, dir: segs.join("/"), status, adds, dels, lines };
}

/** The Review panel: a git-status-style list of Claude's pending changes.
 * Rows stay collapsed (status letter, path, ±counts); clicking one unfolds
 * the full diff of that file inline. */
export default function DiffPanel({
  diffs,
  workspacePath,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: DiffPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Rejecting everything discards every pending change — one mis-click used to
  // be enough. First click arms; a second within 3s confirms.
  const [confirmingReject, setConfirmingReject] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    []
  );

  const handleRejectAll = () => {
    if (!confirmingReject) {
      setConfirmingReject(true);
      confirmTimer.current = setTimeout(() => setConfirmingReject(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingReject(false);
    onRejectAll();
  };

  const entries = useMemo(
    () => diffs.map((d) => parseEntry(d, workspacePath)),
    [diffs, workspacePath]
  );
  const totalAdds = entries.reduce((n, e) => n + e.adds, 0);
  const totalDels = entries.reduce((n, e) => n + e.dels, 0);

  const toggle = (filePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  return (
    <div className="border-t border-[var(--app-border)] bg-[var(--app-surface)]">
      {/* Header — the summary line git status would give you */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] font-medium text-vscode-fg flex items-center gap-2">
          {entries.length} file{entries.length !== 1 ? "s" : ""} changed
          <span className="text-[10px] font-normal tabular-nums">
            <span className="text-[#3fb950]">+{totalAdds}</span>{" "}
            <span className="text-[#f85149]">−{totalDels}</span>
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAcceptAll}
            className="px-2 py-0.5 text-[10px] rounded font-medium bg-[rgba(34,197,94,0.12)] text-[#4ade80] hover:bg-[rgba(34,197,94,0.2)] transition-colors"
          >
            Accept All
          </button>
          <button
            onClick={handleRejectAll}
            className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
              confirmingReject
                ? "bg-[rgba(239,68,68,0.3)] text-[#fca5a5]"
                : "bg-[rgba(239,68,68,0.12)] text-[#f87171] hover:bg-[rgba(239,68,68,0.2)]"
            }`}
            title={
              confirmingReject
                ? "Click again to discard every pending change"
                : "Discard all pending changes (asks to confirm)"
            }
          >
            {confirmingReject ? "Click to confirm" : "Reject All"}
          </button>
        </div>
      </div>

      {/* File list — click a row to unfold its full diff */}
      <div className="max-h-[45vh] overflow-y-auto px-1.5 pb-1.5">
        {entries.map((entry) => {
          const open = expanded.has(entry.filePath);
          const s = STATUS_STYLE[entry.status];
          return (
            <div key={entry.filePath}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggle(entry.filePath)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(entry.filePath);
                  }
                }}
                title={`${s.label} — click to ${open ? "collapse" : "view"} the diff`}
                className="group flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer hover:bg-[rgba(255,255,255,0.04)] transition-colors"
              >
                <span className="shrink-0 opacity-50">
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span
                  className="shrink-0 w-3 text-center text-[10px] font-bold"
                  style={{ color: s.color }}
                  aria-label={s.label}
                >
                  {entry.status}
                </span>
                <span
                  className={`text-[11px] text-vscode-fg truncate ${
                    entry.status === "D" ? "line-through opacity-60" : ""
                  }`}
                >
                  {entry.base}
                </span>
                {entry.dir && (
                  <span className="text-[10px] text-vscode-descriptionFg opacity-60 truncate shrink-[2] min-w-0">
                    {entry.dir}
                  </span>
                )}
                <div className="flex-1" />
                <span className="shrink-0 text-[10px] tabular-nums text-[#3fb950]">
                  +{entry.adds}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-[#f85149]">
                  −{entry.dels}
                </span>
                <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      vscode.postMessage({ type: "openDiff", filePath: entry.filePath });
                    }}
                    className="p-0.5 rounded hover:bg-[rgba(255,255,255,0.1)] text-vscode-descriptionFg hover:text-vscode-fg transition-all"
                    title="Open in diff editor"
                  >
                    <FileDiff size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAccept(entry.filePath);
                    }}
                    className="p-0.5 rounded hover:bg-[rgba(34,197,94,0.15)] text-[#4ade80] transition-all"
                    title="Accept this file's changes"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onReject(entry.filePath);
                    }}
                    className="p-0.5 rounded hover:bg-[rgba(239,68,68,0.15)] text-[#f87171] transition-all"
                    title="Discard this file's changes"
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>

              {open && (
                <pre className="ml-4 mb-1 max-h-[300px] overflow-auto rounded border border-[rgba(255,255,255,0.05)] bg-[var(--app-bg)] text-[11px] leading-[1.5] py-1.5 font-[var(--vscode-editor-font-family)]">
                  {entry.lines.map((line, i) => (
                    <CodeLine key={i} line={line} />
                  ))}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
