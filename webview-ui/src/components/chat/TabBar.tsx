import { useRef, useEffect, useState } from "react";
import type { SessionInfo } from "../../types";

interface TabBarProps {
  sessions: SessionInfo[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onListSessions: () => void;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "\u2026";
}

export default function TabBar({
  sessions,
  currentSessionId,
  onSelect,
  onNewChat,
  onListSessions,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handle), 30);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handle); };
  }, [showMenu]);

  const visibleTabs = sessions.slice(0, 8);

  return (
    <div className="flex items-center border-b border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.15)] min-h-[32px]">
      {/* Scrollable tabs */}
      <div
        ref={scrollRef}
        className="flex-1 flex items-center overflow-x-auto no-scrollbar"
      >
        {visibleTabs.map((session) => {
          const isCurrent = session.id === currentSessionId;
          return (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              className={`group relative flex items-center gap-1 px-3 py-1.5 text-[11px] whitespace-nowrap border-r border-[rgba(255,255,255,0.04)] transition-colors shrink-0 ${
                isCurrent
                  ? "bg-[var(--vscode-editor-background)] text-vscode-fg"
                  : "text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.03)]"
              }`}
            >
              {isCurrent && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#60a5fa]" />
              )}
              <span className="truncate max-w-[140px]">
                {truncate(session.firstMessage, 24)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Action buttons */}
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

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => {
              onListSessions();
              setShowMenu((prev) => !prev);
            }}
            className={`p-1 rounded transition-colors ${
              showMenu
                ? "text-vscode-fg bg-[rgba(255,255,255,0.06)]"
                : "text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.06)]"
            }`}
            title="All conversations"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="6" r="1.5" fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="12" cy="18" r="1.5" fill="currentColor" />
            </svg>
          </button>

          {showMenu && sessions.length > 0 && (
            <div className="absolute top-full right-0 mt-1 w-[260px] max-h-[320px] overflow-y-auto bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.1)] rounded-lg shadow-2xl z-50">
              <div className="px-3 py-1.5 border-b border-[rgba(255,255,255,0.06)] text-[10px] font-medium text-vscode-descriptionFg uppercase tracking-wider">
                All conversations
              </div>
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <button
                    key={session.id}
                    onClick={() => {
                      onSelect(session.id);
                      setShowMenu(false);
                    }}
                    className={`w-full px-3 py-2 text-left transition-colors border-b border-[rgba(255,255,255,0.03)] last:border-b-0 ${
                      isCurrent
                        ? "bg-[rgba(59,130,246,0.08)]"
                        : "hover:bg-[rgba(255,255,255,0.04)]"
                    }`}
                  >
                    <div className={`text-[11px] leading-snug truncate ${
                      isCurrent ? "text-[#60a5fa]" : "text-vscode-fg"
                    }`}>
                      {truncate(session.firstMessage, 60)}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[9px] text-vscode-descriptionFg opacity-40">
                        {session.messageCount} msgs
                      </span>
                      {isCurrent && (
                        <span className="text-[8px] text-[#60a5fa] opacity-60 font-medium">
                          ACTIVE
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
