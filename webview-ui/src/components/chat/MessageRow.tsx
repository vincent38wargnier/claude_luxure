import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import vscode from "../../vscode";
import type { ChatMessage, Mode, ActivityEvent, TimelinePart } from "../../types";
import ImageGrid from "../common/ImageGrid";
import EditableUserMessage from "./EditableUserMessage";
import ActivityFeed from "./ActivityFeed";

interface MessageRowProps {
  message: ChatMessage;
  streamingContent?: string;
  liveActivities?: ActivityEvent[];
  liveTimeline?: TimelinePart[];
  isEditing?: boolean;
  canEdit?: boolean;
  /** A turn is currently streaming — submitting an edit will stop it first. */
  editWillStopRun?: boolean;
  mode?: Mode;
  model?: string;
  onStartEdit?: () => void;
  onSubmitEdit?: (text: string, images?: string[]) => void;
  onCancelEdit?: () => void;
  onModeChange?: (mode: Mode) => void;
  onModelChange?: (model: string) => void;
  onSwitchFork?: (anchorId: string, index: number) => void;
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
  editWillStopRun,
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
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(cleanUserContent(message.content))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
  };

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
          initialImages={message.images}
          willStopRun={editWillStopRun}
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
          <div className="mb-2">
            <ImageGrid images={message.images} altPrefix="Attachment" />
          </div>
        )}
        {/* A div, not a button: button text can't be selected, which made
            copying a sent message impossible. Click still opens the editor —
            unless the click ends a text selection (that's a copy gesture). */}
        <div
          className={`group/msg relative w-full text-left bg-[var(--app-surface-2)] rounded-lg px-3 py-2.5 transition-colors ${
            canEdit ? "hover:ring-1 hover:ring-[rgba(255,255,255,0.1)]" : ""
          }`}
        >
          <div
            className="text-sm text-vscode-fg whitespace-pre-wrap select-text cursor-text"
            onClick={
              canEdit && onStartEdit
                ? () => {
                    if (window.getSelection()?.isCollapsed !== false) {
                      onStartEdit();
                    }
                  }
                : undefined
            }
            title={
              canEdit
                ? editWillStopRun
                  ? "Click to edit — resending stops the current run and restarts from here"
                  : "Click to edit and resend from here"
                : undefined
            }
          >
            {cleanContent}
          </div>
          <div className="absolute -top-2.5 right-2 flex gap-0.5 rounded-md border border-[var(--app-border)] bg-[var(--app-surface-2)] px-0.5 py-0.5 shadow-sm opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy message text"
              title={copied ? "Copied" : "Copy"}
              className="p-1 rounded text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {canEdit && onStartEdit && (
              <button
                type="button"
                onClick={onStartEdit}
                aria-label="Edit and resend from here"
                title={
                  editWillStopRun
                    ? "Edit — resending stops the current run"
                    : "Edit and resend from here"
                }
                className="p-1 rounded text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
        </div>
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
      {!message.isStreaming && <TurnSettle message={message} />}
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

/** Render an assistant prose string as markdown. Fenced code stays a code
 * block — real file-edit cards come only from actual Edit/Write tool activity
 * in the timeline, so a card never claims an edit that didn't happen. */
function TextContent({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <div className={MARKDOWN_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

const SETTLE_FILE_TOOLS = new Set([
  "Write",
  "write_to_file",
  "WriteToFile",
  "Edit",
  "edit_file",
  "EditFile",
  "MultiEdit",
  "apply_diff",
]);

/** The quiet anchor at the end of a finished turn: "Done · 4m12s · 23 tools ·
 * 3 files · 2 agents". Turns end by things disappearing otherwise; this line
 * is the settle. Skipped for quick text-only replies. */
function TurnSettle({ message }: { message: ChatMessage }) {
  const stats = message.turnStats;
  if (!stats) return null;

  let tools = 0;
  let agents = 0;
  const files = new Set<string>();
  const scan = (acts?: ActivityEvent[]) => {
    for (const a of acts || []) {
      if (a.type === "task") {
        agents++;
        tools++;
      } else if (a.type === "tool_use") {
        tools++;
        if (SETTLE_FILE_TOOLS.has(a.toolName)) {
          const p = a.toolInput?.file_path || a.toolInput?.path;
          if (p) files.add(String(p));
        }
      }
    }
  };
  if (message.timeline && message.timeline.length > 0) {
    for (const p of message.timeline) {
      if (p.type === "activities") scan(p.activities);
    }
  } else {
    scan(message.activities);
  }

  const durS = stats.durationMs ? Math.round(stats.durationMs / 1000) : 0;
  // A quick prose-only answer doesn't need a settle line.
  if (tools === 0 && durS < 10) return null;

  const bits: string[] = [
    durS >= 60
      ? `${Math.floor(durS / 60)}m${String(durS % 60).padStart(2, "0")}s`
      : `${durS}s`,
  ];
  if (tools > 0) bits.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (files.size > 0) bits.push(`${files.size} file${files.size === 1 ? "" : "s"}`);
  if (agents > 0) bits.push(`${agents} agent${agents === 1 ? "" : "s"}`);

  return (
    <div className="flex items-center gap-1.5 px-1 pt-1 text-[11px] text-vscode-descriptionFg select-none">
      <Check size={12} className="text-[#4ade80] shrink-0" aria-hidden="true" />
      <span>Done · {bits.join(" · ")}</span>
    </div>
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
