import type { PendingDiff } from "../../types";
import FileChangeCard from "./FileChangeCard";

interface DiffPanelProps {
  diffs: PendingDiff[];
  onAccept: (filePath: string) => void;
  onReject: (filePath: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

export default function DiffPanel({
  diffs,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: DiffPanelProps) {
  return (
    <div className="border-t border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.1)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] font-medium text-vscode-fg">
          {diffs.length} file{diffs.length !== 1 ? "s" : ""} changed
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAcceptAll}
            className="px-2 py-0.5 text-[10px] rounded font-medium bg-[rgba(34,197,94,0.12)] text-[#4ade80] hover:bg-[rgba(34,197,94,0.2)] transition-colors"
          >
            Accept All
          </button>
          <button
            onClick={onRejectAll}
            className="px-2 py-0.5 text-[10px] rounded font-medium bg-[rgba(239,68,68,0.12)] text-[#f87171] hover:bg-[rgba(239,68,68,0.2)] transition-colors"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="max-h-[280px] overflow-y-auto px-2 pb-2">
        {diffs.map((diff) => {
          const lineCount = diff.diff
            .split("\n")
            .filter(
              (l) => l.startsWith("+") && !l.startsWith("+++")
            ).length;

          return (
            <FileChangeCard
              key={diff.filePath}
              filePath={diff.filePath}
              lineCount={lineCount}
              codePreview={diff.diff}
              showActions
              onAccept={() => onAccept(diff.filePath)}
              onReject={() => onReject(diff.filePath)}
            />
          );
        })}
      </div>
    </div>
  );
}
