import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../../types";
import Thumbnails from "../common/Thumbnails";
import FileChangeCard from "../common/FileChangeCard";

interface MessageRowProps {
  message: ChatMessage;
  streamingContent?: string;
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

export default function MessageRow({
  message,
  streamingContent,
}: MessageRowProps) {
  const content = streamingContent ?? message.content;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isStreaming = message.isStreaming && streamingContent !== undefined;

  const blocks = useMemo(() => {
    if (isUser || isSystem) {
      return [{ type: "text" as const, content }];
    }
    return parseAssistantContent(content);
  }, [content, isUser, isSystem]);

  if (isSystem) {
    return (
      <div className="mx-2 px-2.5 py-1.5 text-xs text-[#f87171] bg-[rgba(239,68,68,0.06)] rounded border border-[rgba(239,68,68,0.1)]">
        {content}
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="mx-2">
        {message.images && message.images.length > 0 && (
          <Thumbnails images={message.images} />
        )}
        <div className="bg-[var(--vscode-input-background)] rounded-lg px-3 py-2.5">
          <div className="text-sm text-vscode-fg whitespace-pre-wrap">
            {content}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="mx-1 py-1">
      {blocks.map((block, i) => {
        if (block.type === "file" && block.filePath) {
          return (
            <FileChangeCard
              key={i}
              filePath={block.filePath}
              lineCount={block.lineCount}
              codePreview={block.content}
            />
          );
        }

        return (
          <div
            key={i}
            className="px-1 py-0.5 text-sm prose prose-invert prose-sm max-w-none text-vscode-fg [&_pre]:bg-[rgba(0,0,0,0.2)] [&_pre]:rounded [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-[11px] [&_pre]:overflow-x-auto [&_pre]:font-[var(--vscode-editor-font-family)] [&_code]:text-[11px] [&_code]:bg-[rgba(0,0,0,0.2)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_a]:text-vscode-linkFg [&_a]:no-underline [&_a:hover]:underline [&_p]:my-1.5 [&_p]:leading-relaxed [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_table]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-[rgba(255,255,255,0.1)] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:opacity-80"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {block.content}
            </ReactMarkdown>
          </div>
        );
      })}

      {/* Streaming cursor */}
      {isStreaming && (
        <span className="inline-block w-[2px] h-[14px] bg-[#D97706] animate-pulse ml-2 align-text-bottom" />
      )}
    </div>
  );
}
