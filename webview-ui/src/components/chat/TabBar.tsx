import { useRef, useEffect, useState, useMemo } from "react";
import type { SessionInfo } from "../../types";

interface TabBarProps {
  sessions: SessionInfo[];
  openTabIds: string[];
  currentTabId?: string;
  runningSessionIds: string[];
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNewChat: () => void;
  onListSessions: () => void;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "\u2026";
}

function isDraftTab(id: string): boolean {
  return id.startsWith("draft-");
}

function groupByTime(sessions: SessionInfo[]): { label: string; items: SessionInfo[] }[] {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekAgo = todayStart.getTime() - 7 * 86400000;

  const today: SessionInfo[] = [];
  const week: SessionInfo[] = [];
  const older: SessionInfo[] = [];

  for (const s of sessions) {
    if (s.modifiedAt >= todayStart.getTime()) today.push(s);
    else if (s.modifiedAt >= weekAgo) week.push(s);
    else older.push(s);
  }

  const groups: { label: string; items: SessionInfo[] }[] = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (week.length) groups.push({ label: "Previous 7 days", items: week });
  if (older.length) groups.push({ label: "Older", items: older });
  return groups;
}

export default function TabBar({
  sessions,
  openTabIds,
  currentTabId,
  runningSessionIds,
  onSelect,
  onClose,
  onNewChat,
  onListSessions,
}: TabBarProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [search, setSearch] = useState("");
  const historyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showHistory) return;
    const handle = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
        setSearch("");
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handle), 30);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handle);
    };
  }, [showHistory]);

  useEffect(() => {
    if (showHistory) searchRef.current?.focus();
  }, [showHistory]);

  const sessionMap = useMemo(() => {
    const m = new Map<string, SessionInfo>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const runningSet = useMemo(() => new Set(runningSessionIds), [runningSessionIds]);

  const tabs = useMemo(() => {
    return openTabIds.map((id) => {
      const session = sessionMap.get(id);
      if (session) {
        return { id, label: truncate(session.firstMessage, 22), isDraft: false };
      }
      if (isDraftTab(id)) {
        return { id, label: "New chat", isDraft: true };
      }
      return { id, label: truncate(id.slice(0, 8), 22), isDraft: false };
    });
  }, [openTabIds, sessionMap]);

  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) => s.firstMessage.toLowerCase().includes(q));
  }, [sessions, search]);

  const groups = useMemo(() => groupByTime(filteredSessions), [filteredSessions]);

  return (
    <div className="flex items-center border-b border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.15)] min-h-[32px]">
      <div className="flex-1 flex items-center overflow-x-auto no-scrollbar">
        {tabs.map((tab) => {
          const isCurrent = tab.id === currentTabId;
          const running = runningSet.has(tab.id);

          return (
            <div
              key={tab.id}
              className={`group relative flex items-center gap-1 pl-3 pr-1 py-1.5 text-[11px] whitespace-nowrap border-r border-[rgba(255,255,255,0.04)] transition-colors shrink-0 cursor-pointer ${
                isCurrent
                  ? "bg-[var(--vscode-editor-background)] text-vscode-fg"
                  : "text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.03)]"
              }`}
              onClick={() => onSelect(tab.id)}
            >
              {isCurrent && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#60a5fa]" />
              )}
              {running && !isCurrent && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0 animate-pulse"
                  title="Running in background"
                />
              )}
              <span className={`truncate max-w-[130px] ${tab.isDraft ? "italic opacity-70" : ""}`}>
                {tab.label}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[rgba(255,255,255,0.1)] transition-all"
                title="Close tab"
              >
                <svg width="10" height="10" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center shrink-0 border-l border-[rgba(255,255,255,0.06)] px-1 gap-0.5">
        <button
          onClick={onNewChat}
          className="p-1 rounded text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.06)] transition-colors"
          title="New conversation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        <div className="relative" ref={historyRef}>
          <button
            onClick={() => {
              onListSessions();
              setShowHistory((prev) => !prev);
              setSearch("");
            }}
            className={`p-1 rounded transition-colors ${
              showHistory
                ? "text-vscode-fg bg-[rgba(255,255,255,0.06)]"
                : "text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.06)]"
            }`}
            title="History"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>

          {showHistory && (
            <div className="absolute top-full right-0 mt-1 w-[280px] max-h-[400px] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.1)] rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden">
              <div className="px-2 py-1.5 border-b border-[rgba(255,255,255,0.06)]">
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full bg-[rgba(255,255,255,0.04)] text-[11px] text-vscode-fg placeholder:text-vscode-descriptionFg px-2 py-1 rounded border border-[rgba(255,255,255,0.06)] outline-none focus:border-[rgba(96,165,250,0.4)]"
                />
              </div>

              <div className="flex-1 overflow-y-auto">
                {groups.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-vscode-descriptionFg opacity-50">
                    {search ? "No matches" : "No conversations yet"}
                  </div>
                ) : (
                  groups.map((group) => (
                    <div key={group.label}>
                      <div className="px-3 py-1 text-[9px] font-semibold text-vscode-descriptionFg uppercase tracking-wider opacity-60 sticky top-0 bg-[var(--vscode-dropdown-background,var(--vscode-input-background))]">
                        {group.label}
                      </div>
                      {group.items.map((session) => {
                        const isCurrent = session.id === currentTabId;
                        const isOpen = openTabIds.includes(session.id);
                        const isRunning = runningSet.has(session.id);
                        return (
                          <button
                            key={session.id}
                            onClick={() => {
                              onSelect(session.id);
                              setShowHistory(false);
                              setSearch("");
                            }}
                            className={`w-full px-3 py-1.5 text-left transition-colors flex items-center gap-2 ${
                              isCurrent
                                ? "bg-[rgba(59,130,246,0.08)]"
                                : "hover:bg-[rgba(255,255,255,0.04)]"
                            }`}
                          >
                            {isRunning && (
                              <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0 animate-pulse" />
                            )}
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-40">
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            <div className="flex-1 min-w-0">
                              <div className={`text-[11px] leading-snug truncate ${
                                isCurrent ? "text-[#60a5fa]" : "text-vscode-fg"
                              }`}>
                                {truncate(session.firstMessage, 45)}
                              </div>
                            </div>
                            {isOpen && (
                              <span className="text-[8px] text-vscode-descriptionFg opacity-40 shrink-0">
                                open
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
