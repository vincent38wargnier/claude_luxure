import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Check, X } from "lucide-react";
import vscode from "../../vscode";

const COLLAPSED_PREVIEW_LINES = 3;

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

function getFileIcon(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    ts: "TS",
    tsx: "TX",
    js: "JS",
    jsx: "JX",
    py: "PY",
    rs: "RS",
    go: "GO",
    css: "CS",
    html: "HT",
    json: "{}",
    md: "MD",
    yaml: "YM",
    yml: "YM",
    toml: "TM",
    svg: "SV",
  };
  return icons[ext] || "F";
}

function getIconColor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const colors: Record<string, string> = {
    ts: "#3178c6",
    tsx: "#3178c6",
    js: "#f0db4f",
    jsx: "#f0db4f",
    py: "#3776ab",
    rs: "#dea584",
    go: "#00add8",
    css: "#264de4",
    html: "#e34c26",
    json: "#a8a8a8",
    md: "#ffffff",
    svg: "#ffb13b",
  };
  return colors[ext] || "#888888";
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
  const icon = getFileIcon(filePath);
  const iconColor = getIconColor(filePath);
  const previewLines = codePreview ? codePreview.split("\n") : [];
  const hiddenLines = previewLines.length - COLLAPSED_PREVIEW_LINES;
  const canExpand = !expanded && hiddenLines > 0;

  const openInDiff = () => {
    vscode.postMessage({ type: "openDiff", filePath });
  };

  return (
    <div className="my-1.5 rounded-md overflow-hidden border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)]">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <button className="shrink-0 opacity-50 hover:opacity-80">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* File type badge */}
        <span
          className="shrink-0 text-[9px] font-bold leading-none px-1 py-0.5 rounded"
          style={{
            color: iconColor,
            backgroundColor: `${iconColor}18`,
          }}
        >
          {icon}
        </span>

        {/* File name */}
        <span
          className="text-xs text-vscode-fg hover:text-vscode-linkFg cursor-pointer truncate"
          onClick={(e) => {
            e.stopPropagation();
            openInDiff();
          }}
          title="Open diff (HEAD ↔ Working Tree)"
        >
          {fileName}
        </span>

        {/* Line count badges */}
        {lineCount !== undefined && lineCount > 0 && (
          <span className="text-[10px] text-[#4ade80] font-medium">
            +{lineCount}
          </span>
        )}
        {removedCount !== undefined && removedCount > 0 && (
          <span className="text-[10px] text-[#f87171] font-medium">
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
            className={`text-[11px] leading-[1.5] px-3 py-2 overflow-x-auto font-[var(--vscode-editor-font-family)] bg-[rgba(0,0,0,0.15)] ${
              canExpand ? "cursor-pointer" : ""
            }`}
            onClick={canExpand ? () => setExpanded(true) : undefined}
            title={canExpand ? "Click to expand" : undefined}
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
  // Diff-aware coloring
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <div className="text-[#4ade80] bg-[rgba(34,197,94,0.06)]">{line}</div>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <div className="text-[#f87171] bg-[rgba(239,68,68,0.06)]">{line}</div>
    );
  }
  if (line.startsWith("@@")) {
    return <div className="text-[#60a5fa]">{line}</div>;
  }

  // Simple syntax highlighting for non-diff code
  return <div>{highlightSyntax(line)}</div>;
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
