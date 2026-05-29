import { useEffect, useRef } from "react";
import { FileIcon, FolderIcon } from "lucide-react";

interface ContextMenuProps {
  query: string;
  files: string[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (file: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export default function ContextMenu({
  query,
  files,
  visible,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: ContextMenuProps) {
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

  if (!visible || files.length === 0) {
    return null;
  }

  const filtered = query
    ? files.filter((f) =>
        f.toLowerCase().includes(query.toLowerCase())
      )
    : files;

  if (filtered.length === 0) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="absolute z-50 min-w-[200px] max-w-[400px] max-h-[200px] overflow-y-auto bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-vscode-border rounded-md shadow-lg"
      style={{
        bottom: `calc(100% - ${position.top}px + 4px)`,
        left: position.left,
      }}
    >
      {filtered.slice(0, 20).map((file, i) => {
        const isFolder = file.endsWith("/");
        const name = file.split("/").filter(Boolean).pop() || file;
        return (
          <button
            key={file}
            onClick={() => onSelect(file)}
            className={`flex items-center gap-2 w-full px-2 py-1 text-xs text-left truncate transition-colors ${
              i === selectedIndex
                ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                : "hover:bg-[var(--vscode-list-hoverBackground)]"
            }`}
          >
            {isFolder ? (
              <FolderIcon size={12} className="shrink-0 opacity-60" />
            ) : (
              <FileIcon size={12} className="shrink-0 opacity-60" />
            )}
            <span className="truncate">{name}</span>
            <span className="ml-auto text-[10px] opacity-40 truncate max-w-[150px]">
              {file}
            </span>
          </button>
        );
      })}
    </div>
  );
}
