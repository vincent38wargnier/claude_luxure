import { useEffect, useRef } from "react";
import type { SessionInfo } from "../../types";

interface ConversationListProps {
  sessions: SessionInfo[];
  currentSessionId?: string;
  visible: boolean;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "...";
}

export default function ConversationList({
  sessions,
  currentSessionId,
  visible,
  onSelect,
  onNewChat,
  onClose,
}: ConversationListProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 max-h-[360px] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.1)] rounded-lg shadow-2xl overflow-hidden z-50 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.06)]">
        <span className="text-[11px] font-medium text-vscode-fg">
          Conversations
        </span>
        <button
          onClick={onNewChat}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.06)] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>
          New
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-vscode-descriptionFg opacity-50">
            No conversations yet
          </div>
        ) : (
          sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            return (
              <button
                key={session.id}
                onClick={() => {
                  onSelect(session.id);
                  onClose();
                }}
                className={`w-full px-3 py-2 text-left transition-colors border-b border-[rgba(255,255,255,0.03)] last:border-b-0 ${
                  isCurrent
                    ? "bg-[rgba(59,130,246,0.08)]"
                    : "hover:bg-[rgba(255,255,255,0.04)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={`text-[11px] leading-snug flex-1 ${
                      isCurrent ? "text-[#60a5fa]" : "text-vscode-fg"
                    }`}
                  >
                    {truncate(session.firstMessage, 80)}
                  </span>
                  <span className="text-[9px] text-vscode-descriptionFg opacity-50 whitespace-nowrap mt-0.5">
                    {formatRelativeTime(session.modifiedAt)}
                  </span>
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
          })
        )}
      </div>
    </div>
  );
}
