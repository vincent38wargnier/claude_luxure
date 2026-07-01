import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { RefreshCw } from "lucide-react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import vscode from "../../vscode";
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

  // When a message is tagged with a failed account (a 401/403 from the CLI), show
  // an inline "Reconnect" button. The tag can land on a system error *or* on the
  // assistant bubble that carries the "Failed to authenticate" text, so render the
  // button from one shared element used by both branches below.
  const authAccountId = message.authErrorAccountId;
  const reconnectButton = authAccountId ? (
    <button
      type="button"
      onClick={() =>
        vscode.postMessage({
          type: "reauthAccount",
          accountId: authAccountId,
        })
      }
      className="flex items-center gap-1 mt-1.5 px-2 py-1 rounded text-[11px] text-[#f87171] border border-[#f87171]/40 hover:bg-[#f87171]/10 transition-colors"
      title={`Sign in again to restore ${message.authErrorAccountLabel || "this account"}`}
    >
      <RefreshCw size={11} className="shrink-0" />
      {message.authErrorAccountLabel
        ? `Reconnect ${message.authErrorAccountLabel}`
        : "Reconnect"}
    </button>
  ) : null;

  if (isSystem) {
    return (
      <div className="mx-2 px-2.5 py-1.5 text-xs text-vscode-descriptionFg bg-[rgba(255,255,255,0.03)] rounded border border-[rgba(255,255,255,0.06)]">
        {content}
        {reconnectButton}
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
      {reconnectButton && <div className="px-1">{reconnectButton}</div>}
    </div>
  );
}

// Markdown prose styling lives in the `.md` class in index.css (the Tailwind
// typography plugin isn't installed, so prose-* utilities are no-ops). Keep the
// base size/color here; everything structural (tables, headings, lists) is CSS.
const MARKDOWN_CLASS = "md px-1 py-0.5 text-sm text-vscode-fg";

const URL_ONLY = /^https?:\/\/\S+$/;

/** Flatten a markdown node's children down to its plain text. */
function nodeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(nodeText).join("");
  return "";
}

// Open http(s) links through the extension host. VS Code usually opens webview
// link clicks externally on its own, but routing it explicitly guarantees it
// (and preventDefault stops any double-open). Returns undefined for non-URLs so
// the anchor behaves normally.
function externalClick(href?: string) {
  if (!href || !/^https?:\/\//i.test(href)) return undefined;
  return (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    vscode.postMessage({ type: "openExternal", url: href });
  };
}

// Custom renderers so links the model sends are actually usable:
//  • <a> opens in the browser and long URLs wrap so they can be selected/copied.
//  • a code span/block that is *just* a URL (the model loves wrapping links in
//    backticks) becomes a real clickable link instead of inert <code> text.
const markdownComponents: Components = {
  a({ node, href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={externalClick(href)}
      >
        {children}
      </a>
    );
  },
  code({ node, className, children, ...props }) {
    const text = nodeText(children).trim();
    if (URL_ONLY.test(text)) {
      return (
        <a
          href={text}
          target="_blank"
          rel="noopener noreferrer"
          className="md-code-link"
          onClick={externalClick(text)}
        >
          {text}
        </a>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

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
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
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
