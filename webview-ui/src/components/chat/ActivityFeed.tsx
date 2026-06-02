import { useState } from "react";
import type { ActivityEvent } from "../../types";
import FileChangeCard from "../common/FileChangeCard";

interface Step {
  kind: "thinking" | "tool";
  label: string;
  detail?: string;
}

function truncate(value: unknown, max = 80): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Collapse the raw activity stream into clean, de-duplicated steps.
 * - thinking / thinking_delta -> a single "Thinking" step per contiguous run
 * - tool_result -> dropped (it's the result of a tool, not a step)
 * - tool_use emitted twice (content_block_start with empty input, then the
 *   completed assistant event) -> merged into one entry with full input
 */
export function coalesceActivities(events: ActivityEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const e of events) {
    if (e.type === "tool_result") continue;
    if (e.type === "thinking" || e.type === "thinking_delta") {
      const last = out[out.length - 1];
      if (!last || (last.type !== "thinking" && last.type !== "thinking_delta")) {
        out.push({ type: "thinking", text: "" });
      }
      continue;
    }
    if (e.type === "tool_use") {
      const input = e.toolInput || {};
      const hasInput = Object.keys(input).length > 0;
      if (hasInput) {
        const placeholder = out.find(
          (o) =>
            o.type === "tool_use" &&
            o.toolName === e.toolName &&
            Object.keys(o.toolInput || {}).length === 0
        );
        if (placeholder && placeholder.type === "tool_use") {
          placeholder.toolInput = input;
          continue;
        }
        const dup = out.find(
          (o) =>
            o.type === "tool_use" &&
            o.toolName === e.toolName &&
            JSON.stringify(o.toolInput) === JSON.stringify(input)
        );
        if (dup) continue;
      }
      out.push({ type: "tool_use", toolName: e.toolName, toolInput: input });
    }
  }
  return out;
}

function toStep(a: ActivityEvent): Step | null {
  if (a.type === "thinking" || a.type === "thinking_delta") {
    return { kind: "thinking", label: "Thinking" };
  }
  if (a.type === "tool_use") {
    const name = a.toolName;
    const input = a.toolInput || {};
    switch (name) {
      case "WebSearch":
        return { kind: "tool", label: "Searched the web", detail: truncate(input.query) };
      case "WebFetch":
        return { kind: "tool", label: "Fetched", detail: truncate(input.url) };
      case "Read":
      case "read_file":
      case "View":
        return { kind: "tool", label: "Read", detail: truncate(input.file_path || input.path) };
      case "Write":
      case "write_to_file":
      case "WriteToFile":
        return { kind: "tool", label: "Wrote", detail: truncate(input.file_path || input.path) };
      case "Edit":
      case "edit_file":
      case "EditFile":
        return { kind: "tool", label: "Edited", detail: truncate(input.file_path || input.path) };
      case "Bash":
      case "bash":
        return { kind: "tool", label: "Ran", detail: truncate(input.command, 100) };
      case "Grep":
      case "grep":
        return { kind: "tool", label: "Searched code", detail: truncate(input.pattern) };
      case "Glob":
      case "glob":
        return { kind: "tool", label: "Found files", detail: truncate(input.pattern || input.glob_pattern) };
      case "LS":
      case "ls":
        return { kind: "tool", label: "Listed", detail: truncate(input.path || input.directory || ".") };
      case "Task":
        return { kind: "tool", label: "Ran agent", detail: truncate(input.description) };
      case "TodoWrite":
        return { kind: "tool", label: "Updated plan" };
      default:
        return { kind: "tool", label: name };
    }
  }
  return null;
}

interface FileEdit {
  filePath: string;
  preview: string;
  added: number;
  removed: number;
}

const FILE_EDIT_TOOLS = new Set([
  "Write",
  "write_to_file",
  "WriteToFile",
  "Edit",
  "edit_file",
  "EditFile",
  "MultiEdit",
  "apply_diff",
]);

/** Build a +/- diff preview and line counts from a file-editing tool_use. */
function fileEditFrom(a: ActivityEvent): FileEdit | null {
  if (a.type !== "tool_use" || !FILE_EDIT_TOOLS.has(a.toolName)) return null;
  const input = a.toolInput || {};
  const filePath = String(
    input.file_path || input.path || input.filePath || ""
  );
  if (!filePath) return null;

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  const push = (text: unknown, sign: "+" | "-") => {
    for (const line of String(text ?? "").split("\n")) {
      lines.push(`${sign} ${line}`);
      if (sign === "+") added++;
      else removed++;
    }
  };

  if (a.toolName === "MultiEdit" && Array.isArray(input.edits)) {
    for (const ed of input.edits as Array<Record<string, unknown>>) {
      if (ed.old_string != null) push(ed.old_string, "-");
      if (ed.new_string != null) push(ed.new_string, "+");
    }
  } else if (input.old_string != null || input.new_string != null) {
    if (input.old_string != null) push(input.old_string, "-");
    if (input.new_string != null) push(input.new_string, "+");
  } else {
    push(input.content ?? input.file_text ?? "", "+");
  }

  const MAX_LINES = 60;
  let preview = lines.slice(0, MAX_LINES).join("\n");
  if (lines.length > MAX_LINES) {
    preview += `\n… ${lines.length - MAX_LINES} more lines`;
  }
  return { filePath, preview, added, removed };
}

export default function ActivityFeed({
  activities,
  live,
}: {
  activities?: ActivityEvent[];
  live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // File edits become persistent, expandable diff cards; everything else
  // (thinking, reads, greps, bash…) stays in the compact collapsible summary.
  const fileEdits: FileEdit[] = [];
  const steps: Step[] = [];
  for (const a of coalesceActivities(activities || [])) {
    const fe = fileEditFrom(a);
    if (fe) {
      fileEdits.push(fe);
    } else {
      const st = toStep(a);
      if (st) steps.push(st);
    }
  }

  if (fileEdits.length === 0 && steps.length === 0) return null;

  const open = live || expanded;
  const count = steps.length;
  const summary = `${count} step${count === 1 ? "" : "s"}`;

  return (
    <div className="mx-1 my-1 space-y-1">
      {(steps.length > 0 || live) && (
        <div className="rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] overflow-hidden">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.03)] transition-colors"
          >
            <span
              className={`inline-block text-[9px] leading-none transition-transform ${open ? "rotate-90" : ""}`}
            >
              ▶
            </span>
            {live ? (
              <span className="flex items-center gap-1.5">
                <span className="flex gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "300ms" }} />
                </span>
                <span>
                  Working…
                  {count > 0 && <span className="opacity-60"> · {summary}</span>}
                </span>
              </span>
            ) : (
              <span>Worked for {summary}</span>
            )}
          </button>

          {open && count > 0 && (
            <div className="px-2.5 pb-2 pt-0.5 space-y-1">
              {steps.map((st, i) => {
                const isLast = i === steps.length - 1;
                return (
                  <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <span
                      className={`mt-[5px] w-1 h-1 rounded-full shrink-0 ${
                        live && isLast ? "bg-[#f59e0b] animate-pulse" : "bg-[rgba(255,255,255,0.25)]"
                      }`}
                    />
                    <span className="text-vscode-fg/80 min-w-0">
                      <span className={st.kind === "thinking" ? "italic opacity-80" : ""}>{st.label}</span>
                      {st.detail ? (
                        <span className="text-vscode-descriptionFg opacity-60"> {st.detail}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {fileEdits.map((f, i) => (
        <FileChangeCard
          key={`fe-${i}`}
          filePath={f.filePath}
          codePreview={f.preview}
          lineCount={f.added}
          removedCount={f.removed}
        />
      ))}
    </div>
  );
}
