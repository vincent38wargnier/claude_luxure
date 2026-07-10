import { useState, useRef, useEffect, useCallback } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { ArrowUpCircle } from "lucide-react";
import vscode from "../../vscode";
import type { Mode } from "../../types";
import ModeSelector from "./ModeSelector";
import ModelSelector from "./ModelSelector";
import Thumbnails from "../common/Thumbnails";
import {
  MAX_IMAGES,
  MAX_DROP_FILE_MB,
  classifyDrop,
  filesToBase64,
  imageFilesFromClipboard,
  pathsFromUriList,
} from "./imageAttachments";

interface EditableUserMessageProps {
  initialText: string;
  /** Attachments already on the message — kept on resend unless removed here. */
  initialImages?: string[];
  /** A run is in flight — submitting stops it before resending from here. */
  willStopRun?: boolean;
  mode: Mode;
  model?: string;
  workspacePath?: string;
  /** Temp-copy paths answered by the host for files dropped from outside
   * VS Code — routed here (instead of the composer) while this editor is open. */
  externalFiles?: string[];
  onClearExternalFiles?: () => void;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onSubmit: (text: string, images?: string[]) => void;
  onCancel: () => void;
}

export default function EditableUserMessage({
  initialText,
  initialImages,
  willStopRun,
  mode,
  model,
  workspacePath,
  externalFiles,
  onClearExternalFiles,
  onModeChange,
  onModelChange,
  onSubmit,
  onCancel,
}: EditableUserMessageProps) {
  const [text, setText] = useState(initialText);
  const [images, setImages] = useState<string[]>(initialImages ?? []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const len = initialText.length;
    textareaRef.current?.setSelectionRange(len, len);
  }, [initialText]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Transient cap notice, shown in place of the hint line under the box.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const attachImageFiles = useCallback(
    (files: File[]) => {
      const room = Math.max(0, MAX_IMAGES - images.length);
      if (files.length > room) {
        showNotice(
          `Only ${MAX_IMAGES} images per message — ${files.length - room} not added`
        );
      }
      for (const file of files.slice(0, room)) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setImages((prev) => [...prev, dataUrl].slice(0, MAX_IMAGES));
        };
        reader.readAsDataURL(file);
      }
    },
    [images.length, showNotice]
  );

  /** Same behavior as the composer: pasted screenshots attach as thumbnails. */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = imageFilesFromClipboard(e);
      if (files.length === 0) {
        return; // plain text — let the textarea take it
      }
      e.preventDefault();
      attachImageFiles(files);
    },
    [attachImageFiles]
  );

  /** Insert a snippet at the caret (append when the caret is unknown). */
  const insertSnippet = useCallback((snippet: string) => {
    const ta = textareaRef.current;
    const pos = ta && ta.selectionStart != null ? ta.selectionStart : undefined;
    setText((prev) => {
      const at = pos ?? prev.length;
      const before = prev.slice(0, at);
      const after = prev.slice(at);
      const pad = before && !/\s$/.test(before) ? " " : "";
      return before + pad + snippet + after;
    });
  }, []);

  const insertPathMentions = useCallback(
    (raw: string) => {
      const paths = pathsFromUriList(raw, workspacePath);
      if (paths.length === 0) {
        return;
      }
      insertSnippet(paths.map((p) => `@${p}`).join(" ") + " ");
    },
    [workspacePath, insertSnippet]
  );

  // The host's answer to saveDroppedFiles — becomes @mentions in the edit
  // text, exactly like the composer's flow.
  useEffect(() => {
    if (externalFiles && externalFiles.length > 0) {
      insertSnippet(externalFiles.map((f) => `@${f}`).join(" ") + " ");
      onClearExternalFiles?.();
    }
  }, [externalFiles, onClearExternalFiles, insertSnippet]);

  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  /** Same drop rules as the composer: explorer/editor drops become @mentions,
   * image blobs become thumbnails, other files round-trip through the host. */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const drop = classifyDrop(e);

      if (drop.pathList) {
        insertPathMentions(drop.pathList);
        return;
      }
      if (drop.folderCount > 0) {
        showNotice(
          "Folders can't be dropped from outside VS Code — drop files instead"
        );
      }
      if (
        drop.images.length > 0 ||
        drop.sendable.length > 0 ||
        drop.oversizeCount > 0
      ) {
        if (drop.images.length > 0) {
          attachImageFiles(drop.images);
        }
        if (drop.oversizeCount > 0) {
          showNotice(
            `Files over ${MAX_DROP_FILE_MB}MB can't be attached — ${drop.oversizeCount} skipped`
          );
        }
        if (drop.sendable.length > 0) {
          void filesToBase64(drop.sendable).then((files) => {
            if (files.length > 0) {
              vscode.postMessage({ type: "saveDroppedFiles", files });
            }
          });
        }
        return;
      }
      if (drop.text) {
        insertPathMentions(drop.text);
      }
    },
    [insertPathMentions, attachImageFiles, showNotice]
  );

  const canSubmit = text.trim().length > 0 || images.length > 0;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) {
      return;
    }
    onSubmit(trimmed, images.length > 0 ? images : undefined);
  }, [text, images, onSubmit]);

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
      {/* onPaste on the card (not just the textarea) so a paste with focus
          on a thumbnail's remove button still attaches. */}
      <div
        className={`rounded-lg border overflow-hidden ${
          isDragOver
            ? "border-[#D97706] bg-[rgba(217,119,6,0.08)]"
            : "border-[rgba(255,255,255,0.12)] bg-[var(--vscode-input-background)]"
        }`}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {images.length > 0 && (
          <div className="px-3 pt-2.5 -mb-1">
            <Thumbnails images={images} onRemove={removeImage} />
          </div>
        )}
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
            disabled={!canSubmit}
            className="text-vscode-descriptionFg hover:text-vscode-fg disabled:opacity-30 transition-colors"
            title={
              willStopRun
                ? "Stop the current run and resend from here (Enter)"
                : "Resend from here (Enter)"
            }
          >
            <ArrowUpCircle size={20} />
          </button>
        </div>
      </div>
      <p
        className={`mt-1 px-1 text-[10px] ${
          notice || isDragOver
            ? "text-amber-400"
            : "text-vscode-descriptionFg opacity-50"
        }`}
      >
        {isDragOver
          ? "Drop to attach — images become thumbnails, files become @mentions"
          : notice ??
            (willStopRun
              ? "Enter stops the current run and resends from here · Esc to cancel"
              : "Enter to resend · Shift+Enter for newline · Esc to cancel")}
      </p>
    </div>
  );
}
