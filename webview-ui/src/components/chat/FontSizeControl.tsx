import { useState, useRef, useEffect } from "react";

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 14;

/** Composer-bar "Aa" control: sets the text size of the conversation and the
 * message box only, so someone can read comfortably without zooming the whole
 * editor (Cmd +) and shrinking everything else's usable space. */
export default function FontSizeControl({
  size,
  onChange,
}: {
  size: number;
  onChange: (size: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const step = (delta: number) =>
    onChange(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size + delta)));

  const btn =
    "px-1.5 py-0.5 rounded text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-25 disabled:hover:bg-transparent transition-colors";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-[11px] text-vscode-descriptionFg hover:text-vscode-fg transition-colors px-1"
        title="Text size for the conversation and message box"
        aria-label="Text size"
        aria-expanded={open}
      >
        <span className="text-[9px]">A</span>
        <span className="text-[12px]">a</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 flex items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] px-1 py-1 shadow-xl z-50">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={size <= FONT_SIZE_MIN}
            className={btn}
            aria-label="Smaller text"
            title="Smaller"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onChange(FONT_SIZE_DEFAULT)}
            className="min-w-[46px] rounded px-1 py-0.5 text-[11px] tabular-nums text-vscode-fg hover:bg-[rgba(255,255,255,0.06)] transition-colors"
            title="Reset to the default 14px"
          >
            {size}px
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={size >= FONT_SIZE_MAX}
            className={btn}
            aria-label="Larger text"
            title="Larger"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
