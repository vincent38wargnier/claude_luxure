import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Pencil,
  ArrowUp,
  Trash2,
} from "lucide-react";
import type { QueuedMessage } from "../../types";

interface QueuedMessagesProps {
  items: QueuedMessage[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  /** Stop the current process and send this queued message right away. */
  onSendNow: (id: string) => void;
}

/** The "N Queued" panel shown above the composer (Cursor-style). Each item can
 * be edited inline, promoted/sent immediately, or removed. */
export default function QueuedMessages({
  items,
  onEdit,
  onRemove,
  onSendNow,
}: QueuedMessagesProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (items.length === 0) return null;

  const startEdit = (m: QueuedMessage) => {
    setEditingId(m.id);
    setDraft(m.text);
  };

  const commitEdit = () => {
    if (editingId) {
      const t = draft.trim();
      if (t) onEdit(editingId, t);
      else onRemove(editingId);
    }
    setEditingId(null);
    setDraft("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <div className="mx-2 mb-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-2)] overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full px-3 py-1.5 text-[11px] text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span>
          {items.length} Queued
        </span>
      </button>

      {!collapsed && (
        <div className="pb-1">
          {items.map((m) => (
            <div
              key={m.id}
              className="group flex items-center gap-2 px-3 py-1"
            >
              <Circle size={11} className="shrink-0 opacity-40" />

              {editingId === m.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={commitEdit}
                  className="flex-1 min-w-0 bg-[rgba(255,255,255,0.06)] text-[13px] text-vscode-fg px-1.5 py-0.5 rounded outline-none border border-[rgba(96,165,250,0.4)]"
                />
              ) : (
                <span
                  className="flex-1 min-w-0 truncate text-[13px] text-vscode-fg"
                  title={m.text}
                >
                  {m.text}
                </span>
              )}

              {editingId !== m.id && (
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(m)}
                    title="Edit"
                    className="p-0.5 rounded text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.1)] transition-colors"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => onSendNow(m.id)}
                    title="Send now (stops the current response)"
                    className="p-0.5 rounded text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.1)] transition-colors"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    onClick={() => onRemove(m.id)}
                    title="Remove"
                    className="p-0.5 rounded text-vscode-descriptionFg hover:text-[#f87171] hover:bg-[rgba(255,255,255,0.1)] transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
