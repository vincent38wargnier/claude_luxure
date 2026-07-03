import { useState } from "react";
import { Check } from "lucide-react";
import type { ActivityEvent, TaskActivity } from "../../types";
import AgentTaskCard from "../common/AgentTaskCard";
import FileChangeCard from "../common/FileChangeCard";
import McpCallCard, { type McpCall } from "../common/McpCallCard";
import ProofCard from "../common/ProofCard";
import WorkingDots from "../common/WorkingDots";

interface Step {
  kind: "thinking" | "tool";
  label: string;
  detail?: string;
}

function truncate(value: unknown, max = 80): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Attach a tool_result to the tool_use it belongs to (matched by id) so the
 * call and its output stay one entry. Multiple result blocks for one call (e.g.
 * an MCP tool_reference block + a text block) concatenate; a later non-empty
 * block is never clobbered by an empty one. */
function attachToolResult(acts: ActivityEvent[], e: ActivityEvent): void {
  if (e.type !== "tool_result" || !e.toolUseId) return;
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.type === "tool_use" && a.toolUseId === e.toolUseId) {
      const images =
        e.images && e.images.length > 0
          ? [...(a.result?.images || []), ...e.images]
          : a.result?.images;
      if (a.result) {
        if (e.content) {
          a.result = {
            content: a.result.content ? `${a.result.content}\n${e.content}` : e.content,
            isError: a.result.isError || e.isError,
            images,
          };
        } else {
          a.result = { ...a.result, isError: a.result.isError || e.isError, images };
        }
      } else {
        a.result = { content: e.content, isError: e.isError, images };
      }
      return;
    }
  }
}

/**
 * Collapse the raw activity stream into clean, de-duplicated steps.
 * - thinking / thinking_delta -> a single "Thinking" step per contiguous run
 * - tool_result -> attached to its tool_use (matched by id), not a step itself
 * - tool_use emitted twice (content_block_start with empty input, then the
 *   completed assistant event) -> merged into one entry with full input
 */
export function coalesceActivities(events: ActivityEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const e of events) {
    if (e.type === "proof") {
      // Presented screenshots are standalone cards; never merged or deduped.
      out.push(e);
      continue;
    }
    if (e.type === "task") {
      // One card per Agent call: re-emissions merge into the existing card,
      // newer non-empty fields winning (status only moves off "running").
      const existing = out.find(
        (o): o is TaskActivity => o.type === "task" && o.toolUseId === e.toolUseId
      );
      if (existing) {
        if (e.taskId) existing.taskId = e.taskId;
        if (e.description) existing.description = e.description;
        if (e.subagentType) existing.subagentType = e.subagentType;
        if (e.prompt && !existing.prompt) existing.prompt = e.prompt;
        if (e.background) existing.background = true;
        if (e.progressSummary) existing.progressSummary = e.progressSummary;
        if (e.lastToolName) existing.lastToolName = e.lastToolName;
        if (e.toolUses !== undefined) existing.toolUses = e.toolUses;
        if (e.totalTokens !== undefined) existing.totalTokens = e.totalTokens;
        if (e.durationMs !== undefined) existing.durationMs = e.durationMs;
        if (e.result) existing.result = e.result;
        if (e.children) existing.children = e.children;
        if (e.status !== "running") existing.status = e.status;
      } else {
        out.push({ ...e });
      }
      continue;
    }
    if (e.type === "tool_result") {
      attachToolResult(out, e);
      continue;
    }
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
          if (e.toolUseId && !placeholder.toolUseId) placeholder.toolUseId = e.toolUseId;
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
      out.push({
        type: "tool_use",
        toolName: e.toolName,
        toolInput: input,
        toolUseId: e.toolUseId,
        result: e.result,
      });
    }
  }
  return out;
}

/** Parse an `mcp__server__tool` call into the pieces the card needs. Returns
 * null for non-MCP tools (native Read/Bash/etc. keep their compact steps). */
function mcpCallFrom(a: ActivityEvent): McpCall | null {
  if (a.type !== "tool_use" || !a.toolName.startsWith("mcp__")) return null;
  const rest = a.toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const server = sep >= 0 ? rest.slice(0, sep) : rest;
  const tool = sep >= 0 ? rest.slice(sep + 2) : "";
  return { server, tool, input: a.toolInput || {}, result: a.result };
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
      // Legacy fallback for messages persisted before task cards existed —
      // new Agent calls become {type:"task"} activities and never reach here.
      case "Task":
      case "Agent":
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

type DiffPart = { sign: " " | "+" | "-"; text: string };

/** Line-level LCS diff so a card shows the real change (context kept once, only
 * changed lines marked) instead of the whole old block then the whole new. */
function diffLines(oldText: string, newText: string): DiffPart[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS is O(n*m); bail to a plain old-then-new dump for huge inputs.
  if (n * m > 250000) {
    return [
      ...a.map((t): DiffPart => ({ sign: "-", text: t })),
      ...b.map((t): DiffPart => ({ sign: "+", text: t })),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: "-", text: a[i] });
      i++;
    } else {
      out.push({ sign: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ sign: "-", text: a[i++] });
  while (j < m) out.push({ sign: "+", text: b[j++] });
  return out;
}

/** Collapse long runs of unchanged context (keep CTX lines around each change)
 * so a small edit inside a large block doesn't list dozens of unchanged lines. */
function condenseDiff(parts: DiffPart[], ctx = 3): DiffPart[] {
  if (parts.length <= 2 * ctx + 4) return parts;
  const keep = new Array(parts.length).fill(false);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].sign !== " ") {
      const lo = Math.max(0, i - ctx);
      const hi = Math.min(parts.length - 1, i + ctx);
      for (let j = lo; j <= hi; j++) keep[j] = true;
    }
  }
  const out: DiffPart[] = [];
  let gap = false;
  for (let i = 0; i < parts.length; i++) {
    if (keep[i]) {
      out.push(parts[i]);
      gap = false;
    } else if (!gap) {
      out.push({ sign: " ", text: "⋯" });
      gap = true;
    }
  }
  return out;
}

/** Build a real diff preview and changed-line counts from a file-editing tool_use. */
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
  const pushDiff = (oldText: unknown, newText: unknown) => {
    for (const p of condenseDiff(
      diffLines(String(oldText ?? ""), String(newText ?? ""))
    )) {
      lines.push(`${p.sign} ${p.text}`);
      if (p.sign === "+") added++;
      else if (p.sign === "-") removed++;
    }
  };

  if (a.toolName === "MultiEdit" && Array.isArray(input.edits)) {
    (input.edits as Array<Record<string, unknown>>).forEach((ed, idx) => {
      if (idx > 0) lines.push("");
      pushDiff(ed.old_string, ed.new_string);
    });
  } else if (input.old_string != null || input.new_string != null) {
    pushDiff(input.old_string, input.new_string);
  } else {
    for (const line of String(input.content ?? input.file_text ?? "").split("\n")) {
      lines.push(`+ ${line}`);
      added++;
    }
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
const SEARCH_TOOLS = new Set(["Grep", "grep", "Glob", "glob"]);

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
  const mcpCalls: McpCall[] = [];
  const proofs: { images: string[]; caption?: string }[] = [];
  const tasks: TaskActivity[] = [];
  const exploredFiles = new Set<string>();
  let searchCount = 0;
  let commandCount = 0;
  let todos: Todo[] | null = null;
  for (const a of coalesceActivities(activities || [])) {
    // Screenshots Claude presented render as prominent image cards.
    if (a.type === "proof") {
      proofs.push(a);
      continue;
    }
    // Subagent runs render as live cards with their own progress/children.
    if (a.type === "task") {
      tasks.push(a);
      continue;
    }
    const td = todosFrom(a);
    if (td) {
      todos = td; // keep the latest plan state
      continue;
    }
    // MCP calls become their own expandable request/response cards (like file
    // edits) rather than a one-line step.
    const mcp = mcpCallFrom(a);
    if (mcp) {
      mcpCalls.push(mcp);
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
    if (a.type === "tool_use" && SEARCH_TOOLS.has(a.toolName)) searchCount++;
    if (a.type === "tool_use" && (a.toolName === "Bash" || a.toolName === "bash"))
      commandCount++;
    const st = toStep(a);
    if (st) steps.push(st);
  }
  const fileEdits = fileEditOrder.map((p) => fileEditMap.get(p)!);

  if (
    fileEdits.length === 0 &&
    steps.length === 0 &&
    !todos &&
    mcpCalls.length === 0 &&
    proofs.length === 0 &&
    tasks.length === 0
  )
    return null;

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
            aria-expanded={expanded}
            className="flex items-center gap-1.5 max-w-full text-left text-[11px] text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
          >
            <span
              className={`inline-block text-[8px] leading-none transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              ▶
            </span>
            {live && <WorkingDots />}
            <span className="truncate">
              {stepSummary(steps, exploredFiles.size, searchCount, commandCount, !!live)}
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
                    <span className="text-vscode-fg/80 min-w-0">
                      <span className={st.kind === "thinking" ? "italic opacity-80" : ""}>{st.label}</span>
                      {st.detail ? (
                        <span className="text-vscode-descriptionFg"> {st.detail}</span>
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

      {tasks.map((t) => (
        <AgentTaskCard key={t.toolUseId} task={t} live={!!live} />
      ))}

      {mcpCalls.map((m, i) => (
        <McpCallCard key={`${m.server}__${m.tool}__${i}`} call={m} live={!!live} />
      ))}

      {proofs.map((p, i) => (
        <ProofCard key={`proof-${i}`} images={p.images} caption={p.caption} />
      ))}

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
    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.05)] transition-colors"
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
 * generic recap. Counts everything it hides (reads, searches, commands) so the
 * summary never understates the work. File edits are shown separately as cards. */
function stepSummary(
  steps: Step[],
  exploredCount: number,
  searchCount: number,
  commandCount: number,
  live: boolean
): string {
  if (live) {
    if (steps.length > 0) {
      const s = steps[steps.length - 1];
      return s.detail ? `${s.label} ${s.detail}` : s.label;
    }
    return "Working…";
  }
  const bits: string[] = [];
  if (exploredCount > 0) {
    bits.push(`${exploredCount} file${exploredCount === 1 ? "" : "s"}`);
  }
  if (searchCount > 0) {
    bits.push(`${searchCount} search${searchCount === 1 ? "" : "es"}`);
  }
  if (commandCount > 0) {
    bits.push(`${commandCount} command${commandCount === 1 ? "" : "s"}`);
  }
  if (bits.length > 0) {
    return exploredCount > 0
      ? `Explored ${bits.join(", ")}`
      : `Ran ${bits.join(", ")}`;
  }
  if (steps.length === 1) {
    const s = steps[0];
    return s.detail ? `${s.label} ${s.detail}` : s.label;
  }
  const n = steps.length;
  return `Worked for ${n} step${n === 1 ? "" : "s"}`;
}
