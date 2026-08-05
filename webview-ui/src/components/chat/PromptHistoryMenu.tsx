import { useEffect, useRef } from "react";
import type { SuggestionRow } from "../../utils/promptSuggestions";

interface PromptHistoryMenuProps {
  rows: SuggestionRow[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (row: SuggestionRow) => void;
  onClose: () => void;
}

function relAge(lastUsed: number): string {
  const mins = Math.max(0, Date.now() - lastUsed) / 60_000;
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

/** Suggestions above the composer: the local LLM's "magie" completion (blue,
 * when it has answered for the current draft) on top of matches from this
 * project's own past prompts. Ranking and assembly live in the parent so the
 * keyboard handler and the rendered rows always agree. */
export default function PromptHistoryMenu({
  rows,
  visible,
  selectedIndex,
  onSelect,
  onClose,
}: PromptHistoryMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  if (!visible || rows.length === 0) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="absolute z-50 left-0 right-0 bottom-full mb-1 bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-vscode-border rounded-md shadow-lg overflow-hidden"
    >
      {rows.map((row, i) => {
        const selected = i === selectedIndex;
        const rowClass = `flex items-start gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
          selected
            ? "bg-[var(--vscode-list-activeSelectionBackground,rgba(255,255,255,0.1))] text-[var(--vscode-list-activeSelectionForeground,inherit)]"
            : "hover:bg-[var(--vscode-list-hoverBackground,rgba(255,255,255,0.05))]"
        }`;

        if (row.kind === "magie") {
          // Word provenance: words copied from the retrieved past prompts (or
          // the draft itself) render normal; words the LLM introduced are bold.
          return (
            <button
              key="magie"
              onClick={() => onSelect(row)}
              className={rowClass}
            >
              <span className="flex-1 leading-snug line-clamp-2 break-words text-[#60a5fa]">
                {row.segments.map((seg, j) =>
                  seg.novel ? (
                    <strong key={j} className="font-bold">
                      {seg.text}
                    </strong>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  )
                )}
              </span>
              <span className="shrink-0 flex items-center gap-1 text-[9px] uppercase tracking-wide text-[#60a5fa] opacity-70 pt-0.5 select-none">
                ✨ magie
              </span>
            </button>
          );
        }

        const entry = row.entry;
        return (
          <button
            key={(entry.unit === "phrase" ? "p:" : "") + entry.norm}
            onClick={() => onSelect(row)}
            className={rowClass}
            title={entry.unit === "phrase" ? `From: ${entry.parent}` : undefined}
          >
            <span className="flex-1 leading-snug line-clamp-2 break-words">
              {entry.text.replace(/\s+/g, " ")}
            </span>
            <span className="shrink-0 flex items-center gap-1.5 text-[9px] opacity-40 tabular-nums pt-0.5">
              {entry.unit === "phrase" && (
                <span title="Phrase from a longer prompt">¶</span>
              )}
              {entry.count > 1 && <span>×{entry.count}</span>}
              <span>{relAge(entry.lastUsed)}</span>
            </span>
          </button>
        );
      })}
      <div className="px-2.5 py-1 text-[9px] opacity-40 border-t border-[rgba(255,255,255,0.06)] select-none">
        ↑↓ navigate · Tab to insert · Esc to dismiss
      </div>
    </div>
  );
}
