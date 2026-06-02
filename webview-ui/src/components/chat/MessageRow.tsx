import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, Mode, ActivityEvent, TimelinePart } from "../../types";
import Thumbnails from "../common/Thumbnails";
import FileChangeCard from "../common/FileChangeCard";
import EditableUserMessage from "./EditableUserMessage";
import ActivityFeed from "./ActivityFeed";

interface MessageRowProps {
  message: ChatMessage;
  streamingContent?: string;
  liveActivities?: ActivityEvent[];
  liveTimeline?: TimelinePart[];
  isEditing?: boolean;
  canEdit?: boolean;
  mode?: Mode;
  model?: string;
  onStartEdit?: () => void;
  onSubmitEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  onModeChange?: (mode: Mode) => void;
  onModelChange?: (model: string) => void;
  onSwitchFork?: (anchorId: string, index: number) => void;
}

interface ParsedBlock {
  type: "text" | "file";
  content: string;
  filePath?: string;
  lineCount?: number;
}

function parseAssistantContent(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const fileBlockRegex =
    /```[\w]*\n[\s\S]*?```|(?:(?:Created|Modified|Wrote|Updated|Edited|Reading|Read)\s+(?:file\s+)?[`"]?([^\s`"]+\.\w+)[`"]?)/gi;

  let lastIndex = 0;
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) {
        blocks.push({ type: "text", content: textBefore });
      }
    }

    const lang = match[1] || "";
    const code = match[2] || "";

    const linesBefore = content.slice(
      Math.max(0, match.index - 200),
      match.index
    );
    const fileHint = linesBefore.match(
      /[`"]?([^\s`"]+\.\w{1,6})[`"]?\s*(?:\n|$)/
    );

    if (fileHint) {
      blocks.push({
        type: "file",
        filePath: fileHint[1],
        content: code,
        lineCount: code.split("\n").length,
      });
    } else if (lang && !["bash", "sh", "shell", "diff"].includes(lang)) {
      blocks.push({
        type: "file",
        filePath: `snippet.${lang}`,
        content: code,
        lineCount: code.split("\n").length,
      });
    } else {
      blocks.push({
        type: "text",
        content: match[0],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      blocks.push({ type: "text", content: remaining });
    }
  }

  if (blocks.length === 0 && content.trim()) {
    blocks.push({ type: "text", content });
  }

  return blocks;
}

function cleanUserContent(content: string): string {
  return content
    .replace(/<file path="[^"]*">\n[\s\S]*?\n<\/file>/g, "")
    .replace(/\[{"tool_use_id".*$/s, "")
    .trim();
}

export default function MessageRow({
  message,
  streamingContent,
  liveActivities,
  liveTimeline,
  isEditing,
  canEdit,
  mode,
  model,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onModeChange,
  onModelChange,
  onSwitchFork,
}: MessageRowProps) {
  const content = streamingContent ?? message.content;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isStreaming = message.isStreaming && streamingContent !== undefined;

  if (isSystem) {
    return (
      <div className="mx-2 px-2.5 py-1.5 text-xs text-vscode-descriptionFg bg-[rgba(255,255,255,0.03)] rounded border border-[rgba(255,255,255,0.06)]">
        {content}
      </div>
    );
  }

  if (isUser) {
    const cleanContent = cleanUserContent(content);
    if (!cleanContent && !message.images?.length) return null;

    if (isEditing && onSubmitEdit && onCancelEdit && onModeChange && onModelChange) {
      return (
        <EditableUserMessage
          initialText={cleanContent}
          mode={mode || "agent"}
          model={model}
          onModeChange={onModeChange}
          onModelChange={onModelChange}
          onSubmit={onSubmitEdit}
          onCancel={onCancelEdit}
        />
      );
    }

    return (
      <div className="mx-2">
        {message.forkInfo && message.forkInfo.total > 1 && (
          <div className="flex items-center gap-0.5 mb-1 ml-0.5 select-none">
            <button
              type="button"
              onClick={() =>
                message.forkInfo &&
                onSwitchFork?.(
                  message.forkInfo.anchorId,
                  message.forkInfo.index - 1
                )
              }
              disabled={message.forkInfo.index === 0}
              className="text-vscode-descriptionFg hover:text-vscode-fg disabled:opacity-25 disabled:cursor-default text-sm leading-none px-1"
              title="Previous version"
            >
              ‹
            </button>
            <span className="text-[10px] text-vscode-descriptionFg tabular-nums">
              {message.forkInfo.index + 1}/{message.forkInfo.total}
            </span>
            <button
              type="button"
              onClick={() =>
                message.forkInfo &&
                onSwitchFork?.(
                  message.forkInfo.anchorId,
                  message.forkInfo.index + 1
                )
              }
              disabled={message.forkInfo.index === message.forkInfo.total - 1}
              className="text-vscode-descriptionFg hover:text-vscode-fg disabled:opacity-25 disabled:cursor-default text-sm leading-none px-1"
              title="Next version"
            >
              ›
            </button>
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <Thumbnails images={message.images} />
        )}
        <button
          type="button"
          onClick={canEdit ? onStartEdit : undefined}
          disabled={!canEdit}
          className={`w-full text-left bg-[var(--app-surface-2)] rounded-lg px-3 py-2.5 transition-colors ${
            canEdit
              ? "cursor-pointer hover:ring-1 hover:ring-[rgba(255,255,255,0.1)]"
              : "cursor-default"
          }`}
          title={canEdit ? "Click to edit and resend from here" : undefined}
        >
          <div className="text-sm text-vscode-fg whitespace-pre-wrap">
            {cleanContent}
          </div>
        </button>
      </div>
    );
  }

  // Assistant message — render the ordered timeline (prose + activity in the
  // order they happened) when present; older messages fall back to the feed.
  const timeline = isStreaming ? liveTimeline : message.timeline;

  return (
    <div className="mx-1 py-1">
      {timeline && timeline.length > 0 ? (
        <Timeline parts={timeline} isStreaming={!!isStreaming} />
      ) : (
        <>
          <ActivityFeed
            activities={liveActivities ?? message.activities}
            live={isStreaming}
          />
          <TextContent content={content} />
          {isStreaming && <StreamingCursor />}
        </>
      )}
    </div>
  );
}

const MARKDOWN_CLASS =
  "px-1 py-0.5 text-sm prose prose-invert prose-sm max-w-none text-vscode-fg [&_pre]:bg-[rgba(0,0,0,0.2)] [&_pre]:rounded [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-[11px] [&_pre]:overflow-x-auto [&_pre]:font-[var(--vscode-editor-font-family)] [&_code]:text-[11px] [&_code]:bg-[rgba(0,0,0,0.2)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_a]:text-vscode-linkFg [&_a]:no-underline [&_a:hover]:underline [&_p]:my-1.5 [&_p]:leading-relaxed [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_table]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-[rgba(255,255,255,0.1)] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:opacity-80";

/** Render an assistant prose string: fenced code that looks like a file edit
 * becomes a card, everything else renders as markdown. */
function TextContent({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <>
      {parseAssistantContent(content).map((block, i) =>
        block.type === "file" && block.filePath ? (
          <FileChangeCard
            key={i}
            filePath={block.filePath}
            lineCount={block.lineCount}
            codePreview={block.content}
          />
        ) : (
          <div key={i} className={MARKDOWN_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {block.content}
            </ReactMarkdown>
          </div>
        )
      )}
    </>
  );
}

function StreamingCursor() {
  return (
    <span className="inline-block w-[2px] h-[14px] bg-[#D97706] animate-pulse ml-2 align-text-bottom" />
  );
}

/** Walk the ordered timeline, rendering each prose run as text and each
 * activity run as its own feed, so edits appear exactly where they happened. */
function Timeline({
  parts,
  isStreaming,
}: {
  parts: TimelinePart[];
  isStreaming: boolean;
}) {
  return (
    <>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        if (part.type === "activities") {
          return (
            <ActivityFeed
              key={i}
              activities={part.activities}
              live={isStreaming && isLast}
            />
          );
        }
        return (
          <div key={i}>
            <TextContent content={part.text} />
            {isStreaming && isLast && <StreamingCursor />}
          </div>
        );
      })}
    </>
  );
}
