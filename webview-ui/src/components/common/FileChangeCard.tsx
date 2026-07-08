import { useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, Check, X } from "lucide-react";
import vscode from "../../vscode";
import { CodeLine } from "./DiffLines";

// Real diffs are condensed (context collapsed around changes), so a small edit
// fits in full; only genuinely large diffs collapse behind "Show N more lines".
const COLLAPSED_PREVIEW_LINES = 12;

interface FileChangeCardProps {
  filePath: string;
  lineCount?: number;
  removedCount?: number;
  codePreview?: string;
  language?: string;
  showActions?: boolean;
  startExpanded?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}

export default function FileChangeCard({
  filePath,
  lineCount,
  removedCount,
  codePreview,
  language,
  showActions,
  startExpanded,
  onAccept,
  onReject,
}: FileChangeCardProps) {
  const [expanded, setExpanded] = useState(startExpanded ?? false);
  const fileName = filePath.split("/").pop() || filePath;
  const previewLines = codePreview ? codePreview.split("\n") : [];
  const hiddenLines = previewLines.length - COLLAPSED_PREVIEW_LINES;
  const canExpand = !expanded && hiddenLines > 0;

  const openInDiff = () => {
    vscode.postMessage({ type: "openDiff", filePath });
  };

  return (
    <div className="my-1.5 rounded-md overflow-hidden border border-[var(--app-border)] bg-[var(--app-surface)]">
      {/* Header. The div click is a pointer convenience; the chevron is the
          real (keyboard-reachable) expand control, so no nested-button issue. */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} diff of ${fileName}`}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="shrink-0 opacity-50 hover:opacity-80"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <FileDiff size={12} className="shrink-0 text-vscode-descriptionFg" />

        {/* File name */}
        <button
          type="button"
          className="text-xs text-vscode-fg hover:text-vscode-linkFg cursor-pointer truncate"
          onClick={(e) => {
            e.stopPropagation();
            openInDiff();
          }}
          title="Open file & view changes"
        >
          {fileName}
        </button>

        {/* Line count badges */}
        {lineCount !== undefined && lineCount > 0 && (
          <span className="text-[10px] text-[#3fb950] font-medium">
            +{lineCount}
          </span>
        )}
        {removedCount !== undefined && removedCount > 0 && (
          <span className="text-[10px] text-[#f85149] font-medium">
            -{removedCount}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Accept/Reject actions */}
        {showActions && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAccept?.();
              }}
              className="p-0.5 rounded hover:bg-[rgba(34,197,94,0.15)] text-[#4ade80] opacity-60 hover:opacity-100 transition-all"
              title="Accept"
            >
              <Check size={13} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReject?.();
              }}
              className="p-0.5 rounded hover:bg-[rgba(239,68,68,0.15)] text-[#f87171] opacity-60 hover:opacity-100 transition-all"
              title="Reject"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      {/* Code preview — short preview when collapsed, full when expanded */}
      {codePreview && (
        <div className="border-t border-[rgba(255,255,255,0.04)]">
          <pre
            className={`text-[11px] leading-[1.5] py-2 overflow-x-auto font-[var(--vscode-editor-font-family)] bg-[var(--app-bg)] ${
              canExpand ? "cursor-pointer" : ""
            }`}
            onClick={canExpand ? () => setExpanded(true) : undefined}
          >
            {(expanded
              ? previewLines
              : previewLines.slice(0, COLLAPSED_PREVIEW_LINES)
            ).map((line, i) => (
              <CodeLine key={i} line={line} />
            ))}
          </pre>
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full text-left px-3 py-1 text-[10px] text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.03)] border-t border-[rgba(255,255,255,0.04)]"
            >
              Show {hiddenLines} more line{hiddenLines === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// CodeLine (the per-line diff renderer) lives in DiffLines.tsx, shared with
// the Review panel.
