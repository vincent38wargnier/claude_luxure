import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import TextareaAutosize from "react-textarea-autosize";
import {
  Square,
  Paperclip,
  Image as ImageIcon,
  ArrowUp,
  ChevronRight,
  RotateCw,
} from "lucide-react";
import vscode from "../../vscode";
import type { Mode, EffortLevel, ContextInfo, McpServerStatus, StoredAccount, UsageInfo } from "../../types";
import { AVAILABLE_MODELS, EFFORT_LEVELS } from "../../types";
import ModeSelector from "./ModeSelector";
import ModelSelector from "./ModelSelector";
import ContextMenu from "./ContextMenu";
import SlashCommandMenu from "./SlashCommandMenu";
import PromptHistoryMenu from "./PromptHistoryMenu";
import {
  attributeMagieWords,
  buildPhraseCorpus,
  normalizePromptHistory,
  rankPromptSuggestions,
  recordSentPrompt,
  type RankedPrompt,
  type SuggestionRow,
} from "../../utils/promptSuggestions";
import { buildVocabModel } from "../../utils/vocabWeights";
import Thumbnails from "../common/Thumbnails";
import {
  MAX_IMAGES,
  MAX_DROP_FILE_MB,
  classifyDrop,
  filesToBase64,
  imageFilesFromClipboard,
  pathsFromUriList,
  toRelativePath,
} from "./imageAttachments";
import AccountSwitcher from "./AccountSwitcher";
import UsageBars from "./UsageBars";
import {
  mergeCliCommands,
  type CliCommand,
} from "../../../../src/shared/cli-commands";
import {
  contextTokensUsed,
  contextUsedPercent,
} from "../../../../src/shared/context-window";

interface ChatTextAreaProps {
  mode: Mode;
  model?: string;
  effort?: EffortLevel;
  cliStatus: string;
  isStreaming: boolean;
  /** Active conversation id — the composer keeps a separate draft per id. */
  activeTabId?: string;
  /** Number of messages currently queued for this conversation. */
  queueCount?: number;
  /** Force-send the first queued message (stops the current response). */
  onForceNext?: () => void;
  fileCount?: number;
  pendingDiffCount?: number;
  contextInfo: ContextInfo | null;
  accountEmail?: string;
  accountOrg?: string;
  workspacePath?: string;
  slashCommands?: string[];
  externalFiles?: string[];
  onClearExternalFiles?: () => void;
  onSend: (text: string, images?: string[], mentions?: string[]) => void;
  onCancel: () => void;
  onModeChange: (mode: Mode) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onReview?: () => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
  onRestartMcp?: () => void;
  mcpServers?: McpServerStatus[];
  accounts?: StoredAccount[];
  activeAccountId?: string;
  usage?: UsageInfo | null;
  usageByAccount?: Record<string, UsageInfo | null>;
  disconnectedAccounts?: Record<string, boolean>;
  loggedOutAccounts?: Record<string, boolean>;
  onSwitchAccount?: (accountId: string) => void;
  onAddAccount?: () => void;
  onRemoveAccount?: (accountId: string) => void;
  onReauthAccount?: (accountId: string) => void;
  onLogoutAccount?: (accountId: string) => void;
}


/** A small colored dot summarizing overall MCP health, derived from the live
 * session lifecycle: green = connected, amber (pulsing) = connecting/restarting,
 * red = session error, gray = stopped. Tool-agnostic — it reflects every server
 * configured in `.mcp.json`, not any one server's credentials. Hover lists the
 * configured servers. */
function McpStatusDot({ servers }: { servers?: McpServerStatus[] }) {
  if (!servers || servers.length === 0) return null;
  const connecting = servers.some((s) => s.connection === "connecting");
  const errored = servers.some((s) => s.connection === "error");
  const connected = servers.every((s) => s.connection === "connected");

  let color = "#6b7280"; // gray — stopped / not running
  let label = "stopped";
  let pulse = false;
  if (connecting) {
    color = "#f59e0b"; // amber
    label = "connecting…";
    pulse = true;
  } else if (errored) {
    color = "#f85149"; // red
    label = "error";
  } else if (connected) {
    color = "#3fb950"; // green
    label = "connected";
  }

  const count = servers.length;
  const detail = servers.map((s) => `• ${s.name}`).join("\n");

  return (
    <span
      title={`MCP — ${label} (${count} server${count === 1 ? "" : "s"})\n${detail}`}
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${pulse ? "animate-pulse" : ""}`}
      style={{ backgroundColor: color }}
    />
  );
}
const MENTION_REGEX = /@[\w.\/\-\\]+/g;

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

function EffortSelector({
  effort,
  onChange,
}: {
  effort?: EffortLevel;
  onChange: (e: EffortLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[2];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.05)] transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-60">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <span>{current.short}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" className={`ml-0.5 opacity-40 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[120px] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.08)] rounded-md shadow-xl overflow-hidden z-50">
          {EFFORT_LEVELS.map((e) => {
            const isSelected = e.id === (effort || "high");
            return (
              <button
                key={e.id}
                onClick={() => { onChange(e.id); setOpen(false); }}
                className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-[11px] text-left transition-colors ${
                  isSelected
                    ? "bg-[rgba(255,255,255,0.06)] text-vscode-fg"
                    : "text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.04)] hover:text-vscode-fg"
                }`}
              >
                <span className="flex-1">{e.label}</span>
                {isSelected && (
                  <svg width="12" height="12" viewBox="0 0 12 12" className="text-vscode-fg">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContextBadge({ context }: { context: ContextInfo }) {
  const contextUsed = contextTokensUsed(context);
  const pct = contextUsedPercent(contextUsed, context.contextWindow);

  let color = "text-[#4ade80]"; // green
  if (pct >= 80) color = "text-[#f87171]"; // red
  else if (pct >= 50) color = "text-[#fbbf24]"; // amber

  const formattedTokens =
    contextUsed >= 1000
      ? `${(contextUsed / 1000).toFixed(0)}k`
      : `${contextUsed}`;
  const formattedWindow =
    context.contextWindow >= 1000000
      ? `${(context.contextWindow / 1000000).toFixed(0)}M`
      : `${(context.contextWindow / 1000).toFixed(0)}k`;

  return (
    <span
      className={`text-[10px] ${color} opacity-80 tabular-nums cursor-default`}
      title={`${formattedTokens} / ${formattedWindow} input context (${context.inputTokens.toLocaleString()} new + ${context.cacheReadTokens.toLocaleString()} cache read + ${context.cacheCreationTokens.toLocaleString()} cache write). Output this turn: ${context.outputTokens.toLocaleString()}. Updates during streaming.`}
    >
      {pct}%
    </span>
  );
}

export default function ChatTextArea({
  mode,
  model,
  effort,
  cliStatus,
  isStreaming,
  activeTabId,
  queueCount = 0,
  onForceNext,
  fileCount = 0,
  pendingDiffCount = 0,
  contextInfo,
  accountEmail,
  accountOrg,
  workspacePath,
  slashCommands,
  externalFiles,
  onClearExternalFiles,
  onSend,
  onCancel,
  onModeChange,
  onModelChange,
  onEffortChange,
  onReview,
  onOpenSkills,
  onOpenMcp,
  onRestartMcp,
  mcpServers,
  accounts,
  activeAccountId,
  usage,
  usageByAccount,
  disconnectedAccounts,
  loggedOutAccounts,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onReauthAccount,
  onLogoutAccount,
}: ChatTextAreaProps) {
  const [inputValue, setInputValue] = useState("");
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  // Transient composer notice (image cap hit, folder dropped, oversized file…)
  // — these used to fail silently.
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [contextMenuQuery, setContextMenuQuery] = useState("");
  const [slashMenuQuery, setSlashMenuQuery] = useState("");
  const [contextMenuFiles, setContextMenuFiles] = useState<string[]>([]);
  const [contextMenuIndex, setContextMenuIndex] = useState(0);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  // Past-prompt suggestions: corpus of this project's previously sent prompts
  // (scanned from the real CLI transcripts by the host, ranked client-side).
  const [historyEntries, setHistoryEntries] = useState<RankedPrompt[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyDismissed, setHistoryDismissed] = useState(false);
  // Local-LLM ("magie") answers for the phrase being typed — asked at typing
  // boundaries, shown as blue top rows while still relevant. `sources` (the
  // request's draft + the examples the model saw) feed the word-provenance
  // rendering: copied words normal, invented words bold. Two slots: the
  // candidate completions of the phrase (up to 3, confidence-ranked,
  // keyboard-style), and the clean rewrite of it (keywords → prompt).
  const [aiSuggestion, setAiSuggestion] = useState<{
    texts: string[];
    sources: string[];
  } | null>(null);
  const [expandSuggestion, setExpandSuggestion] = useState<{
    text: string;
    sources: string[];
    forDraft: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // --- Per-conversation drafts -------------------------------------------
  // The composer keeps an independent draft (unsent text + pending images) for
  // each conversation. Switching tabs parks the outgoing draft and restores the
  // destination's, so a half-written prompt no longer leaks across conversations
  // or blocks typing in another one. Kept in a ref — not lifted to the parent —
  // so each keystroke only re-renders this component, mirroring how the
  // follow-up queue is scoped per conversation in App.tsx.
  const draftsRef = useRef<Record<string, { text: string; images: string[] }>>({});
  const inputValueRef = useRef(inputValue);
  const selectedImagesRef = useRef(selectedImages);
  inputValueRef.current = inputValue;
  selectedImagesRef.current = selectedImages;
  const draftKey = activeTabId ?? "";
  const draftKeyRef = useRef(draftKey);

  // Swap drafts before paint when the active conversation changes (layout effect
  // avoids a one-frame flash of the previous conversation's text).
  useLayoutEffect(() => {
    const prevKey = draftKeyRef.current;
    if (prevKey === draftKey) return;
    draftKeyRef.current = draftKey;

    const next = draftsRef.current[draftKey];
    // Startup edge: text typed before this conversation had a real id (prevKey
    // is the empty pre-init key). Carry it forward instead of dropping it.
    if (prevKey === "" && !next) return;

    draftsRef.current[prevKey] = {
      text: inputValueRef.current,
      images: selectedImagesRef.current,
    };
    setInputValue(next?.text ?? "");
    setSelectedImages(next?.images ?? []);
    // Any open menus / queries belonged to the previous draft.
    setShowSlashMenu(false);
    setShowContextMenu(false);
    setSlashMenuQuery("");
    setContextMenuQuery("");
    setHistoryDismissed(false);
    setHistoryIndex(0);
    setAiSuggestion(null);
    setExpandSuggestion(null);
  }, [draftKey]);

  const cliCommands = useMemo(
    () => mergeCliCommands(slashCommands),
    [slashCommands]
  );

  const filteredSlashCommands = useMemo(() => {
    const q = slashMenuQuery.toLowerCase();
    if (!q) return cliCommands;
    return cliCommands.filter(
      (cmd) =>
        cmd.name.slice(1).toLowerCase().startsWith(q) ||
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q)
    );
  }, [cliCommands, slashMenuQuery]);

  // The unit of prediction is the CURRENT PHRASE — the last line of the
  // draft — so suggestions keep working after a carriage return instead of
  // going silent on multiline prompts. Prior lines travel as context, and
  // accepting a row only replaces the phrase, never the lines above it.
  // (Last-line semantics, not caret-line: the fast-typing flow this serves
  // appends at the end.)
  const lastNewline = inputValue.lastIndexOf("\n");
  const priorDraft = lastNewline >= 0 ? inputValue.slice(0, lastNewline) : "";
  const currentPhrase =
    lastNewline >= 0 ? inputValue.slice(lastNewline + 1) : inputValue;

  // Plain typing (not a /command or @mention, short phrase) opens the
  // suggestion menu.
  const suggestionGatesOpen =
    !historyDismissed &&
    !showSlashMenu &&
    !showContextMenu &&
    currentPhrase.length <= 200 &&
    currentPhrase.trim().length >= 3 &&
    !inputValue.trimStart().startsWith("/");

  // Two retrieval granularities from one corpus: whole prompts plus the
  // phrases inside them, and a corrector-style word-weight model — all
  // derived once per corpus change, not per keystroke.
  const suggestionCorpus = useMemo(
    () => [...historyEntries, ...buildPhraseCorpus(historyEntries)],
    [historyEntries]
  );
  const vocabModel = useMemo(
    () => buildVocabModel(historyEntries, Date.now()),
    [historyEntries]
  );

  const historyMatches = useMemo(() => {
    if (!suggestionGatesOpen) return [];
    return rankPromptSuggestions(
      currentPhrase,
      suggestionCorpus,
      Date.now(),
      5,
      vocabModel
    );
  }, [suggestionGatesOpen, currentPhrase, suggestionCorpus, vocabModel]);

  // Ask the local LLM at typing boundaries (180ms after the last keystroke).
  // Zero lexical matches is fine — the host falls back to conversation
  // context, so "magie" also fires on prompts unlike anything typed before.
  useEffect(() => {
    if (!suggestionGatesOpen) return;
    const draft = currentPhrase;
    const prior = priorDraft;
    const examples = historyMatches.map((m) => m.text).slice(0, 8);
    const timer = setTimeout(() => {
      vscode.postMessage({
        type: "suggestPhrase",
        conversationId: activeTabId,
        draft,
        examples,
        kind: "continue",
        priorDraft: prior || undefined,
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [suggestionGatesOpen, currentPhrase, priorDraft, historyMatches, activeTabId]);

  // The rewrite lane ("type main words, get the clean prompt"): asked on a
  // longer pause so it rides typing lulls, and only once the phrase has
  // enough substance to mean something.
  useEffect(() => {
    if (!suggestionGatesOpen) return;
    if (currentPhrase.trim().split(/\s+/).length < 3) return;
    const draft = currentPhrase;
    const prior = priorDraft;
    const examples = historyMatches.map((m) => m.text).slice(0, 8);
    const timer = setTimeout(() => {
      vscode.postMessage({
        type: "suggestPhrase",
        conversationId: activeTabId,
        draft,
        examples,
        kind: "expand",
        priorDraft: prior || undefined,
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [suggestionGatesOpen, currentPhrase, priorDraft, historyMatches, activeTabId]);

  // The menu: magie's candidate completions of the phrase (up to 3,
  // confidence-ranked, while they still extend it) on top, then the clean
  // rewrite of it, then the lexical history matches filling the remainder.
  const suggestionRows = useMemo<SuggestionRow[]>(() => {
    if (!suggestionGatesOpen) return [];
    const rows: SuggestionRow[] = [];
    const normPhrase = currentPhrase.replace(/\s+/g, " ").trim().toLowerCase();
    for (const text of aiSuggestion?.texts.slice(0, 3) ?? []) {
      if (
        text.toLowerCase().startsWith(normPhrase) &&
        text.replace(/\s+/g, " ").trim().toLowerCase() !== normPhrase
      ) {
        rows.push({
          kind: "magie",
          text,
          segments: attributeMagieWords(text, aiSuggestion?.sources ?? []),
        });
      }
    }
    if (
      expandSuggestion &&
      // Stale rewrites hide once the phrase moves past what they rewrote
      // (typing more keywords keeps the row: the phrase still starts with
      // the notes the rewrite answered).
      normPhrase.startsWith(
        expandSuggestion.forDraft.replace(/\s+/g, " ").trim().toLowerCase()
      ) &&
      expandSuggestion.text.replace(/\s+/g, " ").trim().toLowerCase() !==
        normPhrase
    ) {
      rows.push({
        kind: "magie",
        expand: true,
        text: expandSuggestion.text,
        segments: attributeMagieWords(
          expandSuggestion.text,
          expandSuggestion.sources
        ),
      });
    }
    // History fills the remainder — the menu stays ≤6 rows tall now that the
    // magie block can hold 3.
    for (const entry of historyMatches.slice(0, Math.max(0, 6 - rows.length))) {
      rows.push({ kind: "history", entry });
    }
    return rows;
  }, [
    suggestionGatesOpen,
    currentPhrase,
    aiSuggestion,
    expandSuggestion,
    historyMatches,
  ]);

  const menuVisible = suggestionRows.length > 0;
  const menuSelected = Math.min(historyIndex, suggestionRows.length - 1);

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
      if (event.data?.type === "promptHistory") {
        setHistoryEntries(normalizePromptHistory(event.data.entries ?? []));
      }
      if (event.data?.type === "phraseSuggestion") {
        // Stored as-is; display gating hides rows once the phrase diverges.
        // Provenance sources are what the model saw: that request's draft
        // (the user's own words) plus the retrieved examples.
        const sources = [
          (event.data.draft ?? "") as string,
          ...((event.data.examples ?? []) as string[]),
        ];
        if (event.data.kind === "expand") {
          setExpandSuggestion(
            event.data.suggestion
              ? {
                  text: event.data.suggestion as string,
                  sources,
                  forDraft: event.data.draft ?? "",
                }
              : null
          );
        } else {
          const texts = ((event.data.suggestions as string[] | undefined) ??
            (event.data.suggestion ? [event.data.suggestion as string] : []))
            .filter(Boolean);
          setAiSuggestion(texts.length > 0 ? { texts, sources } : null);
        }
      }
    };
    window.addEventListener("message", handler);
    // Both split-view composers ask; the host answers from cache after the
    // first, and the push lands on every listener in the window.
    vscode.postMessage({ type: "requestPromptHistory" });
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

    // The prompt just sent is instantly reusable — no transcript rescan.
    setHistoryEntries((prev) => recordSentPrompt(prev, text));
    setAiSuggestion(null);

    setInputValue("");
    setSelectedImages([]);
    setShowContextMenu(false);
    setShowSlashMenu(false);
    // Sent — drop this conversation's stored draft so nothing stale is restored.
    delete draftsRef.current[draftKey];
  }, [inputValue, selectedImages, onSend, draftKey]);

  const insertSlashCommand = useCallback((command: CliCommand) => {
    setInputValue(`${command.name} `);
    setShowSlashMenu(false);
    setSlashMenuQuery("");

    setTimeout(() => {
      if (textareaRef.current) {
        const pos = command.name.length + 1;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    }, 0);
  }, []);

  const acceptSuggestionRow = useCallback((row: SuggestionRow) => {
    const text = row.kind === "magie" ? row.text : row.entry.text;
    // Suggestions operate on the current phrase: replace only the last line,
    // keeping everything already written above it.
    const current = inputValueRef.current;
    const nl = current.lastIndexOf("\n");
    const next = nl >= 0 ? current.slice(0, nl + 1) + text : text;
    setInputValue(next);
    // Stay dismissed until the next edit — the inserted text would otherwise
    // immediately re-match its own neighbors.
    setHistoryDismissed(true);
    setAiSuggestion(null);
    setExpandSuggestion(null);

    setTimeout(() => {
      if (textareaRef.current) {
        const pos = next.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    }, 0);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashMenu) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenuIndex((prev) =>
            Math.min(prev + 1, filteredSlashCommands.length - 1)
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenuIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (filteredSlashCommands[slashMenuIndex]) {
            insertSlashCommand(filteredSlashCommands[slashMenuIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlashMenu(false);
          return;
        }
      }

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

      if (menuVisible) {
        // On multiline drafts the arrows must stay caret movement between
        // lines — the menu is then Tab-accept (top row) / Esc only.
        const multiline = inputValue.includes("\n");
        if (e.key === "ArrowDown" && !multiline) {
          e.preventDefault();
          setHistoryIndex(
            Math.min(menuSelected + 1, suggestionRows.length - 1)
          );
          return;
        }
        if (e.key === "ArrowUp" && !multiline) {
          e.preventDefault();
          setHistoryIndex(Math.max(menuSelected - 1, 0));
          return;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          acceptSuggestionRow(suggestionRows[menuSelected]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryDismissed(true);
          return;
        }
        // Enter falls through on purpose: it sends what's typed, never the
        // suggestion — Tab is the only way to take one.
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const hasContent =
          inputValue.trim().length > 0 || selectedImages.length > 0;
        if (hasContent) {
          // handleSend → onSend; the parent queues it while a turn is in flight.
          handleSend();
        } else if (isStreaming && queueCount > 0) {
          // Empty composer + queued items: force the first one through.
          onForceNext?.();
        }
        return;
      }

      // Ctrl/Cmd+C cancels the run ONLY on an empty selection — with text
      // selected it must stay the OS copy chord, otherwise copying something
      // out of the composer mid-turn silently kills the whole turn.
      if (e.key === "c" && (e.ctrlKey || e.metaKey) && isStreaming) {
        const ta = textareaRef.current;
        const hasSelection = !!ta && ta.selectionStart !== ta.selectionEnd;
        if (!hasSelection) {
          e.preventDefault();
          onCancel();
        }
      }
    },
    [
      showSlashMenu,
      filteredSlashCommands,
      slashMenuIndex,
      showContextMenu,
      contextMenuFiles,
      contextMenuIndex,
      contextMenuQuery,
      menuVisible,
      suggestionRows,
      menuSelected,
      acceptSuggestionRow,
      isStreaming,
      queueCount,
      onForceNext,
      inputValue,
      selectedImages,
      handleSend,
      onCancel,
      insertSlashCommand,
    ]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInputValue(value);
      // Typing (re)arms history suggestions and resets the highlighted row.
      setHistoryDismissed(false);
      setHistoryIndex(0);

      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);

      const slashMatch = value.match(/^\/([\w-]*)$/);
      if (slashMatch && cursorPos === value.length) {
        setShowSlashMenu(true);
        setSlashMenuQuery(slashMatch[1]);
        setSlashMenuIndex(0);
        setShowContextMenu(false);
        setContextMenuQuery("");
        return;
      }

      setShowSlashMenu(false);
      setSlashMenuQuery("");

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

  const showNotice = useCallback((text: string) => {
    setComposerNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setComposerNotice(null), 4000);
  }, []);

  /** Attach image blobs as data-URL thumbnails, surfacing any cut by the cap. */
  const attachImageFiles = useCallback(
    (imageFiles: File[]) => {
      const room = Math.max(0, MAX_IMAGES - selectedImages.length);
      if (imageFiles.length > room) {
        showNotice(
          `Only ${MAX_IMAGES} images per message — ${imageFiles.length - room} not added`
        );
      }
      for (const file of imageFiles.slice(0, room)) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setSelectedImages((prev) =>
            [...prev, dataUrl].slice(0, MAX_IMAGES)
          );
        };
        reader.readAsDataURL(file);
      }
    },
    [selectedImages, showNotice]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const imageFiles = imageFilesFromClipboard(e);
      if (imageFiles.length === 0) return;

      e.preventDefault();
      attachImageFiles(imageFiles);
    },
    [attachImageFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  /** Insert `@path` mentions for a newline-separated path/uri list. */
  const insertPathMentions = useCallback(
    (rawPaths: string) => {
      const paths = pathsFromUriList(rawPaths, workspacePath);

      if (paths.length === 0) return;

      const mentions = paths.map((p: string) => `@${p}`).join(" ");
      insertTextAtCursor(mentions + " ");
    },
    [workspacePath, insertTextAtCursor]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const drop = classifyDrop(e);

      // Drags that carry real paths (VS Code explorer / editor tabs, and any
      // source that sets file:// uris) mention the original file directly.
      if (drop.pathList) {
        insertPathMentions(drop.pathList);
        return;
      }

      if (drop.folderCount > 0) {
        showNotice(
          "Folders can't be dropped from outside VS Code — drop files instead"
        );
      }

      // Drops from outside VS Code (Finder, browsers…) arrive as blobs only —
      // the sandboxed webview never sees their real path.
      if (
        drop.images.length > 0 ||
        drop.sendable.length > 0 ||
        drop.oversizeCount > 0
      ) {
        if (drop.images.length > 0) {
          attachImageFiles(drop.images);
        }
        if (drop.oversizeCount > 0) {
          showNotice(
            `Files over ${MAX_DROP_FILE_MB}MB can't be attached — ${drop.oversizeCount} skipped`
          );
        }
        // Everything else goes to the extension host, which writes a temp
        // copy and answers with an `addFile` → `@mention` for each.
        if (drop.sendable.length > 0) {
          void filesToBase64(drop.sendable).then((files) => {
            if (files.length > 0) {
              vscode.postMessage({ type: "saveDroppedFiles", files });
            }
          });
        }
        return;
      }

      // Last resort: dragged text (a path from a terminal, etc.).
      if (drop.text) {
        insertPathMentions(drop.text);
      }
    },
    [insertPathMentions, attachImageFiles, showNotice]
  );

  const removeImage = useCallback((index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const canSend =
    !isStreaming &&
    cliStatus !== "starting" &&
    (inputValue.trim().length > 0 || selectedImages.length > 0);

  return (
    <div className="composer-shell mx-2 mb-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-2)] transition-colors">
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
                className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-[#313131] text-vscode-fg border border-[var(--app-border)] hover:bg-[#3a3a3a] transition-colors"
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
        <SlashCommandMenu
          query={slashMenuQuery}
          commands={cliCommands}
          visible={showSlashMenu}
          selectedIndex={slashMenuIndex}
          onSelect={insertSlashCommand}
          onClose={() => setShowSlashMenu(false)}
        />

        <PromptHistoryMenu
          rows={suggestionRows}
          visible={menuVisible}
          selectedIndex={menuSelected}
          onSelect={acceptSuggestionRow}
          onClose={() => setHistoryDismissed(true)}
        />

        <ContextMenu
          query={contextMenuQuery}
          files={contextMenuFiles}
          visible={showContextMenu}
          selectedIndex={contextMenuIndex}
          onSelect={insertMention}
          onClose={() => setShowContextMenu(false)}
          position={{ top: 0, left: 0 }}
        />

        {composerNotice && (
          <div className="mb-1.5 text-[10px] text-[#f59e0b]" role="status">
            {composerNotice}
          </div>
        )}

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
              isStreaming
                ? "Add a follow-up… (Enter to queue)"
                : mode === "plan"
                ? "Describe what to analyze... (/ for commands)"
                : "Ask Claude anything... (/ commands, @ files)"
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

      {/* Bottom bar. Wraps at narrow panel widths so the send button and
          account controls never clip off-screen in a docked sidebar. */}
      <div className="composer-bar flex items-center justify-between flex-wrap gap-y-1 px-3 py-1.5 border-t border-[rgba(255,255,255,0.04)]">
        <div className="flex items-center flex-wrap gap-1.5 min-w-0">
          <ModeSelector mode={mode} onChange={onModeChange} />
          <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
          <ModelSelector model={model} onChange={onModelChange} />
          <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
          <EffortSelector effort={effort} onChange={onEffortChange} />
          {contextInfo && (
            <>
              <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
              <ContextBadge context={contextInfo} />
            </>
          )}
          {onOpenSkills && (
            <>
              <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
              <button
                type="button"
                onClick={onOpenSkills}
                className="text-[11px] text-vscode-descriptionFg hover:text-vscode-fg transition-colors px-1"
                title="Manage Claude skills"
              >
                Skills
              </button>
            </>
          )}
          {onOpenMcp && (
            <>
              <span className="text-[10px] text-vscode-descriptionFg opacity-30 select-none">|</span>
              <McpStatusDot servers={mcpServers} />
              <button
                type="button"
                onClick={onOpenMcp}
                className="text-[11px] text-vscode-descriptionFg hover:text-vscode-fg transition-colors px-1"
                title="Edit MCP servers (.mcp.json)"
              >
                MCP
              </button>
              {onRestartMcp && (
                <button
                  type="button"
                  onClick={onRestartMcp}
                  className="flex items-center text-vscode-descriptionFg hover:text-vscode-fg transition-colors px-0.5"
                  title="Restart / reconnect MCP servers (e.g. after refreshing a token)"
                  aria-label="Restart MCP servers"
                >
                  <RotateCw size={11} />
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 min-w-0 ml-auto">
          <AccountSwitcher
            accounts={accounts}
            activeAccountId={activeAccountId}
            usageByAccount={usageByAccount}
            disconnected={disconnectedAccounts}
            loggedOut={loggedOutAccounts}
            fallbackEmail={accountEmail}
            fallbackOrg={accountOrg}
            onSwitch={onSwitchAccount}
            onAdd={onAddAccount}
            onRemove={onRemoveAccount}
            onReauth={onReauthAccount}
            onLogout={onLogoutAccount}
          />
          <button
            className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity text-vscode-fg"
            title="Attach file"
            aria-label="Attach file"
          >
            <Paperclip size={14} />
          </button>
          <button
            className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity text-vscode-fg"
            title="Paste or drag an image"
            aria-label="Paste or drag an image"
          >
            <ImageIcon size={14} />
          </button>

          {isStreaming ? (
            <button
              onClick={onCancel}
              className="p-0.5 text-[#f87171] hover:text-[#ef4444] transition-colors"
              title="Stop generation"
              aria-label="Stop generation"
            >
              <Square size={20} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`flex items-center justify-center w-6 h-6 rounded-full border border-[var(--app-border)] bg-[var(--app-surface-2)] transition-colors ${
                canSend
                  ? "text-vscode-fg hover:bg-[#3a3a3a]"
                  : "text-vscode-descriptionFg opacity-40"
              }`}
              title="Send (Enter)"
              aria-label="Send message"
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      <UsageBars usage={usage ?? null} />
    </div>
  );
}
