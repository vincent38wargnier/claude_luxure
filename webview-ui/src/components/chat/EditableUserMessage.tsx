import { useState, useRef, useEffect, useCallback } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { ArrowUpCircle } from "lucide-react";
import type { Mode } from "../../types";
import ModeSelector from "./ModeSelector";
import ModelSelector from "./ModelSelector";

interface EditableUserMessageProps {
  initialText: string;
  mode: Mode;
  model?: string;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export default function EditableUserMessage({
  initialText,
  mode,
  model,
  onModeChange,
  onModelChange,
  onSubmit,
  onCancel,
}: EditableUserMessageProps) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const len = initialText.length;
    textareaRef.current?.setSelectionRange(len, len);
  }, [initialText]);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
  }, [text, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel]
  );

  return (
    <div className="mx-2">
      <div className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-[var(--vscode-input-background)] overflow-hidden">
        <TextareaAutosize
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          minRows={2}
          maxRows={16}
          className="w-full px-3 py-2.5 text-sm text-vscode-fg bg-transparent resize-none outline-none leading-relaxed"
          placeholder="Edit message..."
        />
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[rgba(255,255,255,0.06)]">
          <div className="flex items-center gap-1.5">
            <ModeSelector mode={mode} onChange={onModeChange} />
            <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">
              |
            </span>
            <ModelSelector model={model} onChange={onModelChange} />
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim()}
            className="text-vscode-descriptionFg hover:text-vscode-fg disabled:opacity-30 transition-colors"
            title="Resend from here (Enter)"
          >
            <ArrowUpCircle size={20} />
          </button>
        </div>
      </div>
      <p className="mt-1 px-1 text-[10px] text-vscode-descriptionFg opacity-50">
        Enter to resend · Shift+Enter for newline · Esc to cancel
      </p>
    </div>
  );
}
