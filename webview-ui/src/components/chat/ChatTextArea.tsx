import { useState, useRef, useCallback, useEffect } from "react";
import TextareaAutosize from "react-textarea-autosize";
import {
  Square,
  Paperclip,
  Image as ImageIcon,
  ArrowUpCircle,
  ChevronRight,
} from "lucide-react";
import vscode from "../../vscode";
import type { Mode, ContextInfo } from "../../types";
import { AVAILABLE_MODELS } from "../../types";
import ModeSelector from "./ModeSelector";
import ModelSelector from "./ModelSelector";
import ContextMenu from "./ContextMenu";
import Thumbnails from "../common/Thumbnails";

interface ChatTextAreaProps {
  mode: Mode;
  model?: string;
  cliStatus: string;
  isStreaming: boolean;
  fileCount?: number;
  pendingDiffCount?: number;
  contextInfo: ContextInfo | null;
  accountEmail?: string;
  accountOrg?: string;
  workspacePath?: string;
  externalFiles?: string[];
  onClearExternalFiles?: () => void;
  onSend: (text: string, images?: string[], mentions?: string[]) => void;
  onCancel: () => void;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onReview?: () => void;
}

const MAX_IMAGES = 10;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MENTION_REGEX = /@[\w.\/\-\\]+/g;

function toRelativePath(absPath: string, workspacePath?: string): string {
  if (!workspacePath) return absPath;
  const normalized = absPath.replace(/\\/g, "/");
  const normalizedWs = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(normalizedWs + "/")) {
    return normalized.slice(normalizedWs.length + 1);
  }
  return absPath;
}

function renderHighlightedText(text: string) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }
    const mentionText = match[0];
    const fileName = mentionText.split("/").pop() || mentionText;
    parts.push(
      <span
        key={key++}
        className="inline-flex items-center gap-0.5 bg-[rgba(59,130,246,0.15)] text-[#60a5fa] rounded px-0.5 mx-[1px] align-baseline"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="shrink-0 opacity-70 relative top-[1px]"
        >
          <path d="M13.5 1H4.5L2 3.5V14.5L3.5 16H12.5L14 14.5V2.5L13.5 1ZM13 14.5L12.5 15H3.5L3 14.5V3.5L4.5 2H13V14.5Z" />
        </svg>
        {fileName}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return parts;
}

function ContextBadge({ context }: { context: ContextInfo }) {
  const totalTokens =
    context.inputTokens +
    context.outputTokens +
    context.cacheReadTokens +
    context.cacheCreationTokens;
  const pct = Math.min(
    100,
    Math.round((totalTokens / context.contextWindow) * 100)
  );

  let color = "text-[#4ade80]"; // green
  if (pct >= 80) color = "text-[#f87171]"; // red
  else if (pct >= 50) color = "text-[#fbbf24]"; // amber

  const formattedTokens =
    totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(0)}k`
      : `${totalTokens}`;
  const formattedWindow =
    context.contextWindow >= 1000000
      ? `${(context.contextWindow / 1000000).toFixed(0)}M`
      : `${(context.contextWindow / 1000).toFixed(0)}k`;

  return (
    <span
      className={`text-[10px] ${color} opacity-80 tabular-nums cursor-default`}
      title={`${formattedTokens} / ${formattedWindow} tokens (${context.inputTokens.toLocaleString()} in + ${context.outputTokens.toLocaleString()} out + ${context.cacheReadTokens.toLocaleString()} cache)`}
    >
      {pct}%
    </span>
  );
}

export default function ChatTextArea({
  mode,
  model,
  cliStatus,
  isStreaming,
  fileCount = 0,
  pendingDiffCount = 0,
  contextInfo,
  accountEmail,
  accountOrg,
  workspacePath,
  externalFiles,
  onClearExternalFiles,
  onSend,
  onCancel,
  onModeChange,
  onModelChange,
  onReview,
}: ChatTextAreaProps) {
  const [inputValue, setInputValue] = useState("");
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuQuery, setContextMenuQuery] = useState("");
  const [contextMenuFiles, setContextMenuFiles] = useState<string[]>([]);
  const [contextMenuIndex, setContextMenuIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Merge external files at cursor position
  useEffect(() => {
    if (externalFiles && externalFiles.length > 0) {
      const mentions = externalFiles.map((f) => `@${f}`).join(" ");
      insertTextAtCursor(mentions + " ");
      onClearExternalFiles?.();
    }
  }, [externalFiles, onClearExternalFiles]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "fileSearchResults") {
        setContextMenuFiles(event.data.files);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Sync scroll between textarea and highlight overlay
  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const insertTextAtCursor = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      const cursorPos = ta?.selectionStart ?? inputValue.length;
      const before = inputValue.slice(0, cursorPos);
      const after = inputValue.slice(cursorPos);
      const spaceBefore =
        before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n")
          ? " "
          : "";
      const newValue = before + spaceBefore + text + after;
      setInputValue(newValue);

      setTimeout(() => {
        if (ta) {
          const newPos = before.length + spaceBefore.length + text.length;
          ta.selectionStart = newPos;
          ta.selectionEnd = newPos;
          ta.focus();
        }
      }, 0);
    },
    [inputValue]
  );

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text && selectedImages.length === 0) {
      return;
    }

    const mentionRegex = new RegExp(MENTION_REGEX.source, "g");
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      mentions.push(match[0]);
    }

    onSend(
      text,
      selectedImages.length > 0 ? selectedImages : undefined,
      mentions.length > 0 ? mentions : undefined
    );

    setInputValue("");
    setSelectedImages([]);
    setShowContextMenu(false);
  }, [inputValue, selectedImages, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showContextMenu) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setContextMenuIndex((prev) =>
            Math.min(prev + 1, contextMenuFiles.length - 1)
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setContextMenuIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const filtered = contextMenuQuery
            ? contextMenuFiles.filter((f) =>
                f.toLowerCase().includes(contextMenuQuery.toLowerCase())
              )
            : contextMenuFiles;
          if (filtered[contextMenuIndex]) {
            insertMention(filtered[contextMenuIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowContextMenu(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) return;
        handleSend();
      }

      if (e.key === "c" && (e.ctrlKey || e.metaKey) && isStreaming) {
        e.preventDefault();
        onCancel();
      }
    },
    [
      showContextMenu,
      contextMenuFiles,
      contextMenuIndex,
      contextMenuQuery,
      isStreaming,
      handleSend,
      onCancel,
    ]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInputValue(value);

      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);

      const atMatch = textBeforeCursor.match(/@([\w./\-\\]*)$/);
      if (atMatch) {
        const query = atMatch[1];
        setShowContextMenu(true);
        setContextMenuQuery(query);
        setContextMenuIndex(0);
        setMentionStartPos(cursorPos - atMatch[0].length);
        vscode.postMessage({ type: "searchFiles", query });
      } else {
        setShowContextMenu(false);
        setContextMenuQuery("");
      }
    },
    []
  );

  const insertMention = useCallback(
    (file: string) => {
      const mention = `@${file} `;
      const before = inputValue.slice(0, mentionStartPos);
      const cursorEnd =
        textareaRef.current?.selectionStart ?? inputValue.length;
      const after = inputValue.slice(cursorEnd);
      const newValue = before + mention + after;
      setInputValue(newValue);
      setShowContextMenu(false);

      setTimeout(() => {
        if (textareaRef.current) {
          const pos = before.length + mention.length;
          textareaRef.current.selectionStart = pos;
          textareaRef.current.selectionEnd = pos;
          textareaRef.current.focus();
        }
      }, 0);
    },
    [inputValue, mentionStartPos]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageItems = Array.from(items).filter((item) =>
        ACCEPTED_IMAGE_TYPES.includes(item.type)
      );

      if (imageItems.length === 0) return;

      e.preventDefault();
      for (const item of imageItems) {
        if (selectedImages.length >= MAX_IMAGES) break;
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setSelectedImages((prev) =>
            [...prev, dataUrl].slice(0, MAX_IMAGES)
          );
        };
        reader.readAsDataURL(blob);
      }
    },
    [selectedImages]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const imageFiles = Array.from(files).filter((f) =>
          ACCEPTED_IMAGE_TYPES.includes(f.type)
        );
        if (imageFiles.length > 0) {
          for (const file of imageFiles) {
            if (selectedImages.length >= MAX_IMAGES) break;
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              setSelectedImages((prev) =>
                [...prev, dataUrl].slice(0, MAX_IMAGES)
              );
            };
            reader.readAsDataURL(file);
          }
          return;
        }
      }

      const text = e.dataTransfer.getData("text/plain");
      const uriList = e.dataTransfer.getData("application/vnd.code.uri-list");
      const rawPaths = (uriList || text || "").trim();
      if (!rawPaths) return;

      const paths = rawPaths
        .split("\n")
        .map((p: string) => p.trim())
        .filter(Boolean)
        .map((p: string) => {
          if (p.startsWith("file://")) {
            return decodeURIComponent(p.slice(7));
          }
          return p;
        })
        .map((p: string) => toRelativePath(p, workspacePath));

      if (paths.length === 0) return;

      const mentions = paths.map((p: string) => `@${p}`).join(" ");
      insertTextAtCursor(mentions + " ");
    },
    [inputValue, selectedImages, workspacePath, insertTextAtCursor]
  );

  const removeImage = useCallback((index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const canSend =
    !isStreaming &&
    cliStatus !== "starting" &&
    (inputValue.trim().length > 0 || selectedImages.length > 0);

  return (
    <div className="border-t border-[rgba(255,255,255,0.06)]">
      {/* Toolbar row */}
      {(isStreaming || pendingDiffCount > 0 || fileCount > 0) && (
        <div className="flex items-center justify-between px-3 py-1 border-b border-[rgba(255,255,255,0.04)] text-[11px]">
          <div className="flex items-center gap-1">
            {fileCount > 0 && (
              <button className="flex items-center gap-0.5 text-vscode-descriptionFg hover:text-vscode-fg transition-colors">
                <ChevronRight size={10} />
                <span>{fileCount} Files</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isStreaming && (
              <button
                onClick={onCancel}
                className="text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
              >
                Stop <span className="opacity-50">^c</span>
              </button>
            )}
            {pendingDiffCount > 0 && (
              <button
                onClick={onReview}
                className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-vscode-buttonBg text-vscode-buttonFg hover:bg-vscode-buttonHover transition-colors"
              >
                Review
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main input area */}
      <div
        className={`relative px-3 py-2 ${
          isDragOver ? "bg-[rgba(217,119,6,0.06)]" : ""
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ContextMenu
          query={contextMenuQuery}
          files={contextMenuFiles}
          visible={showContextMenu}
          selectedIndex={contextMenuIndex}
          onSelect={insertMention}
          onClose={() => setShowContextMenu(false)}
          position={{ top: 0, left: 0 }}
        />

        {selectedImages.length > 0 && (
          <Thumbnails images={selectedImages} onRemove={removeImage} />
        )}

        {isDragOver && (
          <div className="absolute inset-0 border-2 border-dashed border-[#D97706] rounded flex items-center justify-center bg-[rgba(217,119,6,0.04)] z-10 pointer-events-none">
            <span className="text-xs text-[#D97706]">Drop files here</span>
          </div>
        )}

        {/* Textarea with highlight overlay */}
        <div className="relative">
          {/* Highlight layer — renders styled mentions behind the textarea */}
          <div
            ref={highlightRef}
            className="absolute inset-0 pointer-events-none text-[13px] leading-relaxed whitespace-pre-wrap break-words text-transparent overflow-hidden"
            aria-hidden="true"
          >
            {renderHighlightedText(inputValue)}
          </div>

          <TextareaAutosize
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncScroll}
            placeholder={
              mode === "plan"
                ? "Describe what to analyze..."
                : "Ask Claude anything... (@ to mention files)"
            }
            className="relative w-full bg-transparent text-[13px] resize-none outline-none min-h-[20px] max-h-[160px] leading-relaxed placeholder:text-vscode-descriptionFg"
            style={{
              color: "inherit",
              caretColor: "var(--vscode-editor-foreground)",
              WebkitTextFillColor: "inherit",
            }}
            maxRows={8}
          />
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-[rgba(255,255,255,0.04)]">
        <div className="flex items-center gap-1.5">
          <ModeSelector mode={mode} onChange={onModeChange} />
          <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
          <ModelSelector model={model} onChange={onModelChange} />
          {contextInfo && (
            <>
              <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
              <ContextBadge context={contextInfo} />
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {accountEmail && (
            <span
              className="text-[10px] text-vscode-descriptionFg opacity-50 truncate max-w-[120px]"
              title={`${accountEmail}${accountOrg ? ` (${accountOrg})` : ""}`}
            >
              {accountEmail}
            </span>
          )}
          <button
            className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity text-vscode-fg"
            title="Attach file"
          >
            <Paperclip size={14} />
          </button>
          <button
            className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity text-vscode-fg"
            title="Paste or drag an image"
          >
            <ImageIcon size={14} />
          </button>

          {isStreaming ? (
            <button
              onClick={onCancel}
              className="p-0.5 text-[#f87171] hover:text-[#ef4444] transition-colors"
              title="Stop generation"
            >
              <Square size={20} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`p-0.5 transition-colors ${
                canSend
                  ? "text-vscode-fg hover:text-white"
                  : "text-vscode-descriptionFg opacity-30"
              }`}
              title="Send (Enter)"
            >
              <ArrowUpCircle size={22} strokeWidth={canSend ? 2 : 1.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
