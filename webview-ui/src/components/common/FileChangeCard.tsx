import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, Check, X } from "lucide-react";
import vscode from "../../vscode";

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
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <button className="shrink-0 opacity-50 hover:opacity-80">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* AI-edit marker */}
        <Sparkles size={12} className="shrink-0 text-[#a78bfa]" />

        {/* File name */}
        <span
          className="text-xs text-vscode-fg hover:text-vscode-linkFg cursor-pointer truncate"
          onClick={(e) => {
            e.stopPropagation();
            openInDiff();
          }}
          title="Open file & view changes"
        >
          {fileName}
        </span>

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

function CodeLine({ line }: { line: string }) {
  // Cursor-style diff: muted tint + left bar on changed lines, syntax colors
  // preserved inside, context left uncolored. The "+ "/"- " (or "  ") prefix
  // keeps every line's content aligned in the same column.
  if (line.startsWith("@@")) {
    return <div className="px-2.5 text-[#6b9fd8] opacity-70">{line}</div>;
  }
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isDel = line.startsWith("-") && !line.startsWith("---");
  if (isAdd) {
    // Warm olive tint (Cursor), green left bar, syntax colors kept.
    return (
      <div className="border-l-2 border-[#5a8a3a] bg-[#3e3b2a] pl-2 pr-2.5">
        <span className="select-none text-[#7fae5a] opacity-80">+ </span>
        {highlightSyntax(line.slice(2))}
      </div>
    );
  }
  if (isDel) {
    // Lighter maroon tint, muted (not crimson) red bar.
    return (
      <div className="border-l-2 border-[#4b1918] bg-[#471b18] pl-2 pr-2.5">
        <span className="select-none text-[#e0817c] opacity-80">- </span>
        {highlightSyntax(line.slice(2))}
      </div>
    );
  }
  return (
    <div className="border-l-2 border-transparent pl-2 pr-2.5 opacity-90">
      {highlightSyntax(line)}
    </div>
  );
}

function highlightSyntax(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  const rules: [RegExp, string][] = [
    [/^(import|export|from|const|let|var|function|class|interface|type|return|async|await|if|else|for|while|switch|case|break|default|new|throw|try|catch|extends|implements)\b/, "#c586c0"],
    [/"[^"]*"|'[^']*'|`[^`]*`/, "#ce9178"],
    [/\/\/.*$/, "#6a9955"],
    [/\b(true|false|null|undefined|void)\b/, "#569cd6"],
    [/\b\d+(\.\d+)?\b/, "#b5cea8"],
    [/\{|\}|\(|\)|\[|\]/, "#ffd700"],
  ];

  while (remaining.length > 0) {
    let matched = false;
    for (const [regex, color] of rules) {
      const match = remaining.match(regex);
      if (match && match.index !== undefined) {
        if (match.index > 0) {
          parts.push(
            <span key={key++}>{remaining.slice(0, match.index)}</span>
          );
        }
        parts.push(
          <span key={key++} style={{ color }}>
            {match[0]}
          </span>
        );
        remaining = remaining.slice(match.index + match[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }
  }

  return <>{parts}</>;
}
