import { useState, useRef, useEffect } from "react";
import type { Mode } from "../../types";

interface ModeSelectorProps {
  mode: Mode;
  onChange: (mode: Mode) => void;
}

const modes: { id: Mode; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
];

function InfinityIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z" />
    </svg>
  );
}

function FileListIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 13H8" />
      <path d="M16 17H8" />
      <path d="M16 13h-2" />
    </svg>
  );
}

export default function ModeSelector({ mode, onChange }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const current = modes.find((m) => m.id === mode) || modes[0];

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-vscode-fg hover:bg-[rgba(255,255,255,0.05)] transition-colors"
      >
        {current.id === "agent" ? (
          <InfinityIcon size={13} />
        ) : (
          <FileListIcon size={13} />
        )}
        <span>{current.label}</span>
        <svg
          width="8"
          height="5"
          viewBox="0 0 8 5"
          className={`ml-0.5 opacity-40 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          <path
            d="M1 1l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[130px] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.08)] rounded-md shadow-xl overflow-hidden z-50">
          {modes.map((m) => {
            const isSelected = m.id === mode;
            return (
              <button
                key={m.id}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-[11px] text-left transition-colors ${
                  isSelected
                    ? "bg-[rgba(255,255,255,0.06)] text-vscode-fg"
                    : "text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.04)] hover:text-vscode-fg"
                }`}
              >
                {m.id === "agent" ? (
                  <InfinityIcon size={13} />
                ) : (
                  <FileListIcon size={13} />
                )}
                <span className="flex-1">{m.label}</span>
                {isSelected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    className="text-vscode-fg"
                  >
                    <path
                      d="M2 6l3 3 5-5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
