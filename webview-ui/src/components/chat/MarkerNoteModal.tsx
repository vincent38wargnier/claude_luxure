import { useState, useRef, useEffect, useCallback } from "react";

const NOTE_MAX = 80;

interface MarkerNoteModalProps {
  /** The sticky's color — shown as a swatch so it's clear what's being edited. */
  color: string;
  initialNote: string;
  /** Shown as the fallback the sticky reverts to when the note is cleared. */
  emoji?: string;
  onSave: (note: string) => void;
  onClose: () => void;
}

/**
 * Small dialog for the conversation note shown on the post-it. Enter saves,
 * Esc cancels; saving an empty note clears it, reverting the sticky to its
 * emoji.
 */
export default function MarkerNoteModal({
  color,
  initialNote,
  emoji,
  onSave,
  onClose,
}: MarkerNoteModalProps) {
  const [note, setNote] = useState(initialNote);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = useCallback(() => {
    onSave(note.trim());
    onClose();
  }, [note, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleSave, onClose]
  );

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-16"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Conversation note"
        className="mx-4 w-full max-w-[340px] rounded-lg border border-[rgba(255,255,255,0.12)] bg-[var(--vscode-editor-background)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 pt-3">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: color }}
          />
          <span className="text-xs font-medium text-vscode-fg">
            Conversation note
          </span>
        </div>
        <div className="px-3 py-2.5">
          <input
            ref={inputRef}
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What is this chat about?"
            className="w-full rounded border border-[rgba(255,255,255,0.12)] bg-[var(--vscode-input-background)] px-2.5 py-1.5 text-sm text-vscode-fg outline-none focus:border-[var(--vscode-focusBorder)]"
          />
          <p className="mt-1.5 text-[10px] text-vscode-descriptionFg opacity-70">
            {`Shown on the sticky in place of the emoji. Leave empty to show ${
              emoji ? emoji : "the emoji"
            } again.`}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[rgba(255,255,255,0.06)] px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2.5 py-1 text-xs text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded bg-[var(--vscode-button-background)] px-2.5 py-1 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
