import { useEffect, useRef } from "react";
import type { CliCommand } from "../../../../src/shared/cli-commands";

interface SlashCommandMenuProps {
  query: string;
  commands: CliCommand[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (command: CliCommand) => void;
  onClose: () => void;
}

export default function SlashCommandMenu({
  query,
  commands,
  visible,
  selectedIndex,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
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

  if (!visible) {
    return null;
  }

  const q = query.toLowerCase();
  const filtered = q
    ? commands.filter(
        (cmd) =>
          cmd.name.slice(1).toLowerCase().startsWith(q) ||
          cmd.name.toLowerCase().includes(q) ||
          cmd.description.toLowerCase().includes(q)
      )
    : commands;

  if (filtered.length === 0) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="absolute z-50 min-w-[260px] max-w-[420px] max-h-[240px] overflow-y-auto bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-vscode-border rounded-md shadow-lg bottom-full left-0 mb-1"
    >
      {filtered.slice(0, 24).map((cmd, i) => (
        <button
          key={cmd.name}
          onClick={() => onSelect(cmd)}
          className={`flex items-start gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
            i === selectedIndex
              ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
              : "hover:bg-[var(--vscode-list-hoverBackground)]"
          }`}
        >
          <span className="font-mono text-[#60a5fa] shrink-0">{cmd.name}</span>
          <span className="opacity-70 leading-snug">{cmd.description}</span>
          {cmd.extension && (
            <span className="ml-auto text-[9px] uppercase tracking-wide opacity-40 shrink-0">
              luxure
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
