import { useEffect, useRef, useState } from "react";
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

  return (
    <div className="border-t border-[var(--app-border)] bg-[var(--app-surface)]">
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
              startExpanded
              onAccept={() => onAccept(diff.filePath)}
              onReject={() => onReject(diff.filePath)}
            />
          );
        })}
      </div>
    </div>
  );
}
