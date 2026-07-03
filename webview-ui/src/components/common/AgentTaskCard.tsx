import { useState } from "react";
import { Bot, Check, ChevronsUpDown, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ActivityEvent, TaskActivity } from "../../types";
import ImageGrid from "./ImageGrid";
import WorkingDots from "./WorkingDots";

function fmtTokens(n?: number): string | null {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tok` : `${n} tok`;
}

function fmtDuration(ms?: number): string | null {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function truncate(value: unknown, max = 90): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Compact one-line label for a child activity (the agent's own tool calls).
 * Local mini version of ActivityFeed's step labels — kept separate to avoid a
 * circular import between the card and the feed. */
function childLabel(a: ActivityEvent): { label: string; detail?: string } | null {
  if (a.type === "thinking" || a.type === "thinking_delta") {
    return { label: "Thinking" };
  }
  if (a.type !== "tool_use") {
    return null;
  }
  const input = a.toolInput || {};
  switch (a.toolName) {
    case "Read":
    case "read_file":
    case "View":
      return { label: "Read", detail: truncate(input.file_path || input.path) };
    case "Write":
    case "write_to_file":
      return { label: "Wrote", detail: truncate(input.file_path || input.path) };
    case "Edit":
    case "edit_file":
    case "MultiEdit":
      return { label: "Edited", detail: truncate(input.file_path || input.path) };
    case "Bash":
    case "bash":
      return { label: "Ran", detail: truncate(input.command, 100) };
    case "Grep":
    case "grep":
      return { label: "Searched", detail: truncate(input.pattern) };
    case "Glob":
    case "glob":
      return { label: "Found files", detail: truncate(input.pattern || input.glob_pattern) };
    case "WebSearch":
      return { label: "Searched the web", detail: truncate(input.query) };
    case "WebFetch":
      return { label: "Fetched", detail: truncate(input.url) };
    case "Task":
    case "Agent":
      return { label: "Spawned agent", detail: truncate(input.description) };
    default:
      return { label: a.toolName };
  }
}

/**
 * A subagent run as a live card: while the agent works it shows a pulsing
 * status row plus the CLI's one-line progress summary ("Reading a.txt") and
 * tool/token/duration counters, all patched in place by taskUpdate messages —
 * including after the parent turn ended (background agents). Expanding reveals
 * the prompt, the agent's own tool calls, and its final report.
 */
export default function AgentTaskCard({
  task,
  live,
}: {
  task: TaskActivity;
  live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = task.status === "running";
  const failed = task.status === "failed";

  const counters = [
    task.toolUses !== undefined ? `${task.toolUses} tool${task.toolUses === 1 ? "" : "s"}` : null,
    fmtTokens(task.totalTokens),
    fmtDuration(task.durationMs),
  ].filter(Boolean);

  const title = task.description || task.prompt?.slice(0, 80) || "Agent task";
  const kind = task.subagentType || "agent";

  return (
    <div
      id={`task-${task.toolUseId}`}
      className={`my-1 scroll-mt-2 rounded-md border overflow-hidden bg-[var(--app-surface)] ${
        failed
          ? "border-[rgba(248,81,73,0.5)]"
          : running
            ? "border-[rgba(139,92,246,0.55)]"
            : "border-[rgba(139,92,246,0.3)]"
      }`}
    >
      {/* Header row */}
      <button
        type="button"
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors text-[13px] text-left select-none"
        onClick={() => setExpanded(!expanded)}
      >
        {failed ? (
          <X size={14} className="shrink-0 text-[#f85149]" />
        ) : running ? (
          <Bot size={14} className="shrink-0 text-[#a78bfa]" />
        ) : (
          <Check size={14} className="shrink-0 text-[#4ade80]" />
        )}

        <span className="truncate min-w-0 text-vscode-descriptionFg">
          <span className="text-[#a78bfa]">{kind}</span>{" "}
          <span className="text-vscode-fg/90">{title}</span>
        </span>

        {task.background && (
          <span
            className="shrink-0 text-[9px] uppercase tracking-wide rounded px-1 py-0.5 border border-[rgba(139,92,246,0.4)] text-[#a78bfa]"
            title="Background agent — keeps running after the turn ends"
          >
            bg
          </span>
        )}

        <div className="flex-1" />

        {counters.length > 0 && (
          <span className="shrink-0 text-[10px] text-vscode-descriptionFg">
            {counters.join(" · ")}
          </span>
        )}

        {running && <WorkingDots color="#a78bfa" />}

        <ChevronsUpDown size={14} className="shrink-0 text-vscode-descriptionFg opacity-50" />
      </button>

      {/* Live progress line — the "what is it doing RIGHT NOW" element. */}
      {running && task.progressSummary && (
        <div className="px-3 pb-2 -mt-1 flex items-center gap-1.5 text-[11px] text-vscode-descriptionFg">
          <span className="w-1 h-1 rounded-full bg-[#a78bfa] animate-pulse shrink-0" />
          <span className="truncate opacity-80">{task.progressSummary}</span>
        </div>
      )}

      {/* Completed summary line (last progress / notification summary). */}
      {!running && !expanded && task.progressSummary && (
        <div className="px-3 pb-2 -mt-1 text-[11px] text-vscode-descriptionFg truncate">
          {task.progressSummary}
        </div>
      )}

      {expanded && (
        <div className="border-t border-[rgba(255,255,255,0.04)]">
          {task.prompt && (
            <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.04)]">
              <SectionLabel>Prompt</SectionLabel>
              <pre className="whitespace-pre-wrap break-words text-[11px] leading-[1.5] text-vscode-fg/70 max-h-40 overflow-y-auto">
                {task.prompt.length > 1200 ? task.prompt.slice(0, 1200) + "\n…" : task.prompt}
              </pre>
            </div>
          )}

          {task.children && task.children.length > 0 && (
            <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.04)]">
              <SectionLabel>
                Activity
                {task.toolUses && task.toolUses > task.children.length
                  ? ` · last ${task.children.length} of ${task.toolUses} calls`
                  : task.toolUses
                    ? ` (${task.toolUses} tool calls)`
                    : ""}
              </SectionLabel>
              <div className="pl-1 space-y-0.5 max-h-56 overflow-y-auto">
                {task.children.map((c, i) => {
                  const st = childLabel(c);
                  if (!st) return null;
                  const isLast = i === task.children!.length - 1;
                  return (
                    <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <span
                        className={`mt-[5px] w-1 h-1 rounded-full shrink-0 ${
                          running && isLast
                            ? "bg-[#a78bfa] animate-pulse"
                            : "bg-[rgba(255,255,255,0.25)]"
                        }`}
                      />
                      <span className="text-vscode-fg/70 min-w-0 truncate">
                        {st.label}
                        {st.detail ? (
                          <span className="text-vscode-descriptionFg opacity-60"> {st.detail}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="px-3 py-2">
            <SectionLabel>Result</SectionLabel>
            {task.result?.images && task.result.images.length > 0 && (
              <div className="pb-2">
                <ImageGrid images={task.result.images} altPrefix="Agent result" />
              </div>
            )}
            {task.result?.content?.trim() ? (
              <div className="md text-[12px] text-vscode-fg max-h-72 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.result.content}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="text-[11px] text-vscode-descriptionFg opacity-60 italic">
                {running ? "Still working…" : failed ? "No result — the agent failed or was interrupted" : "No result captured"}
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
