import { useState } from "react";
import { Waypoints, ChevronsUpDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ImageGrid from "./ImageGrid";
import WorkingDots from "./WorkingDots";

export interface McpCall {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean; images?: string[] };
}

/**
 * An MCP tool call rendered exactly like Cursor's: a compact one-line row —
 * "<nodes icon> Ran <Humanized Tool> in <server>" with a ChevronsUpDown affordance
 * on the right — that expands to show the call parameters and the result
 * (rendered as markdown). While streaming it reads "Running …" until the result
 * block arrives (MCP results are atomic — they don't stream in piece by piece).
 */
export default function McpCallCard({
  call,
  live,
}: {
  call: McpCall;
  live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { server, tool, input, result } = call;
  const hasInput = Object.keys(input).length > 0;
  const running = !result && !!live;
  const isError = !!result?.isError;
  const verb = running ? "Running" : "Ran";

  // Amber marks *working* only — a finished call settles to the neutral card
  // border so the status color never lies about what's still running.
  const borderClass = isError
    ? "border-[rgba(248,81,73,0.5)]"
    : running
      ? "border-[rgba(245,158,11,0.5)]"
      : "border-[var(--app-border)]";
  const iconClass = isError
    ? "text-[#f85149]"
    : running
      ? "text-[#f59e0b]"
      : "text-vscode-descriptionFg";

  return (
    <div className={`my-1 rounded-md border ${borderClass} bg-[var(--app-surface)] overflow-hidden`}>
      {/* Collapsed row — Cursor style */}
      <button
        type="button"
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors text-[13px] text-left select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <Waypoints size={14} className={`shrink-0 ${iconClass}`} />

        <span className="truncate min-w-0 text-vscode-descriptionFg">
          {verb} <span className="text-vscode-fg/90">{humanizeTool(tool)}</span> in{" "}
          <span className="text-vscode-fg/70">{server}</span>
        </span>

        <div className="flex-1" />

        {running && <WorkingDots />}

        <ChevronsUpDown size={14} className="shrink-0 text-vscode-descriptionFg opacity-50" />
      </button>

      {/* Result images (e.g. a browser screenshot) are the payload the user
          cares about — always visible, no expand needed. */}
      {result?.images && result.images.length > 0 && (
        <div className="px-3 pb-2">
          <ImageGrid images={result.images} altPrefix={`${tool} result`} />
        </div>
      )}

      {/* Expanded — parameters + result */}
      {expanded && (
        <div className="border-t border-[rgba(255,255,255,0.04)]">
          {hasInput && (
            <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.04)]">
              <SectionLabel>Parameters</SectionLabel>
              <pre className="whitespace-pre-wrap break-words text-[11px] leading-[1.5] text-vscode-fg/80 font-[var(--vscode-editor-font-family)]">
                {formatInput(input)}
              </pre>
            </div>
          )}
          <div className="px-3 py-2">
            <SectionLabel>Result</SectionLabel>
            {result ? (
              result.content.trim() ? (
                <div className="md text-[12px] text-vscode-fg">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="text-[11px] text-vscode-descriptionFg opacity-60 italic">
                  (empty result)
                </span>
              )
            ) : (
              <span className="text-[11px] text-vscode-descriptionFg opacity-60 italic">
                {live ? "Running…" : "No result captured"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-vscode-descriptionFg opacity-60 mb-1">
      {children}
    </div>
  );
}

/** snake_case / kebab / camelCase tool name -> "Title Case With Spaces",
 * matching how Cursor humanizes MCP tool names (reset_jarvio_v2_chat ->
 * "Reset Jarvio V2 Chat"). */
function humanizeTool(tool: string): string {
  return tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Pretty-print the call arguments; never let a circular value throw. */
function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
