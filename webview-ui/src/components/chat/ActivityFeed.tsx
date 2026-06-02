import { useState } from "react";
import { Check } from "lucide-react";
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
  lines: string[];
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

  return { filePath, lines, added, removed };
}

const MAX_PREVIEW_LINES = 60;

/** Cap the merged diff once, after all edits to a file are combined. */
function buildPreview(lines: string[]): string {
  if (lines.length <= MAX_PREVIEW_LINES) return lines.join("\n");
  return (
    lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
    `\n… ${lines.length - MAX_PREVIEW_LINES} more lines`
  );
}

const READ_TOOLS = new Set(["Read", "read_file", "View"]);

interface Todo {
  content: string;
  status: string;
}

/** Pull the plan out of a TodoWrite call so it can render as a checklist. */
function todosFrom(a: ActivityEvent): Todo[] | null {
  if (a.type !== "tool_use" || a.toolName !== "TodoWrite") return null;
  const raw = (a.toolInput as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const todos = raw
    .map((t) => {
      const o = t as { content?: unknown; activeForm?: unknown; status?: unknown };
      return {
        content: String(o.content ?? o.activeForm ?? ""),
        status: String(o.status ?? "pending"),
      };
    })
    .filter((t) => t.content);
  return todos.length > 0 ? todos : null;
}

/** The file a read-like tool touched, for the "Explored N files" summary. */
function readFileTarget(a: ActivityEvent): string | null {
  if (a.type !== "tool_use" || !READ_TOOLS.has(a.toolName)) return null;
  const input = a.toolInput || {};
  const p = input.file_path || input.path;
  return p ? String(p) : null;
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
  // Multiple edits to the same file merge into one card (combined diff + counts)
  // rather than repeating the file once per edit.
  const fileEditMap = new Map<string, FileEdit>();
  const fileEditOrder: string[] = [];
  const steps: Step[] = [];
  const exploredFiles = new Set<string>();
  let todos: Todo[] | null = null;
  for (const a of coalesceActivities(activities || [])) {
    const td = todosFrom(a);
    if (td) {
      todos = td; // keep the latest plan state
      continue;
    }
    const fe = fileEditFrom(a);
    if (fe) {
      const existing = fileEditMap.get(fe.filePath);
      if (existing) {
        if (existing.lines.length && fe.lines.length) existing.lines.push("");
        existing.lines.push(...fe.lines);
        existing.added += fe.added;
        existing.removed += fe.removed;
      } else {
        fileEditMap.set(fe.filePath, { ...fe, lines: [...fe.lines] });
        fileEditOrder.push(fe.filePath);
      }
      continue;
    }
    const read = readFileTarget(a);
    if (read) exploredFiles.add(read);
    const st = toStep(a);
    if (st) steps.push(st);
  }
  const fileEdits = fileEditOrder.map((p) => fileEditMap.get(p)!);

  if (fileEdits.length === 0 && steps.length === 0 && !todos) return null;

  const stepCount = steps.length;
  // File edits are the substance — always shown as cards. The other actions
  // (thinking, reads, greps, bash…) collapse into one discrete, muted line.
  const showSteps = stepCount > 0 || !!live;

  return (
    <div className="mx-1 my-0.5 space-y-1">
      {showSteps && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 max-w-full text-left text-[11px] text-vscode-descriptionFg opacity-50 hover:opacity-90 transition-opacity"
          >
            <span
              className={`inline-block text-[8px] leading-none transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              ▶
            </span>
            {live && (
              <span className="flex gap-0.5 shrink-0">
                <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1 h-1 rounded-full bg-[#f59e0b] animate-bounce" style={{ animationDelay: "300ms" }} />
              </span>
            )}
            <span className="truncate">
              {stepSummary(steps, exploredFiles.size, !!live)}
            </span>
          </button>

          {expanded && stepCount > 0 && (
            <div className="ml-2 mt-1 pl-3 border-l border-[rgba(255,255,255,0.06)] space-y-0.5 py-0.5">
              {steps.map((st, i) => {
                const isLast = i === steps.length - 1;
                return (
                  <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <span
                      className={`mt-[5px] w-1 h-1 rounded-full shrink-0 ${
                        live && isLast ? "bg-[#f59e0b] animate-pulse" : "bg-[rgba(255,255,255,0.25)]"
                      }`}
                    />
                    <span className="text-vscode-fg/70 min-w-0">
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

      {todos && <TodoList todos={todos} />}

      {fileEdits.map((f) => (
        <FileChangeCard
          key={f.filePath}
          filePath={f.filePath}
          codePreview={buildPreview(f.lines)}
          lineCount={f.added}
          removedCount={f.removed}
        />
      ))}
    </div>
  );
}

/** Cursor-style plan checklist from TodoWrite: a quiet "N of M Done" header
 * over the items, completed ones struck through. Collapsible. */
function TodoList({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const allDone = done === total;

  return (
    <div className="rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.03)] transition-colors"
      >
        <span
          className={`inline-block text-[8px] leading-none opacity-70 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className={allDone ? "text-[#4ade80]" : "text-vscode-fg/80"}>
          {done} of {total} {allDone ? "Done" : "done"}
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2 pt-0.5 space-y-1">
          {todos.map((t, i) => {
            const completed = t.status === "completed";
            const active = t.status === "in_progress";
            return (
              <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                {completed ? (
                  <Check size={12} className="mt-[3px] shrink-0 text-[#4ade80]" />
                ) : (
                  <span
                    className={`mt-[5px] w-2.5 h-2.5 rounded-full border shrink-0 ${
                      active
                        ? "border-[#f59e0b] bg-[rgba(245,158,11,0.25)]"
                        : "border-[rgba(255,255,255,0.25)]"
                    }`}
                  />
                )}
                <span
                  className={
                    completed
                      ? "line-through text-vscode-descriptionFg opacity-50"
                      : active
                        ? "text-vscode-fg"
                        : "text-vscode-fg/70"
                  }
                >
                  {t.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The quiet one-liner for the collapsed steps: the current action while live,
 * "Explored N files" for read-heavy runs, a single action verbatim, else a
 * generic recap. File edits are shown separately as cards. */
function stepSummary(steps: Step[], exploredCount: number, live: boolean): string {
  if (live) {
    if (steps.length > 0) {
      const s = steps[steps.length - 1];
      return s.detail ? `${s.label} ${s.detail}` : s.label;
    }
    return "Working…";
  }
  if (exploredCount > 0) {
    return `Explored ${exploredCount} file${exploredCount === 1 ? "" : "s"}`;
  }
  if (steps.length === 1) {
    const s = steps[0];
    return s.detail ? `${s.label} ${s.detail}` : s.label;
  }
  const n = steps.length;
  return `Worked for ${n} step${n === 1 ? "" : "s"}`;
}
