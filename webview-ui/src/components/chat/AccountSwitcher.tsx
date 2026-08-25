import { useState, useRef, useEffect } from "react";
import {
  Check,
  Plus,
  Trash2,
  ChevronDown,
  AlertTriangle,
  RefreshCw,
  LogOut,
} from "lucide-react";
import type { StoredAccount, UsageInfo } from "../../types";

interface Props {
  accounts?: StoredAccount[];
  activeAccountId?: string;
  /** Per-account subscription usage, keyed by account id (incl. "default"). */
  usageByAccount?: Record<string, UsageInfo | null>;
  /** Account ids whose login expired and can't refresh → show "Reconnect". */
  disconnected?: Record<string, boolean>;
  /** Account ids the user deliberately disconnected — a subset of
   * {@link disconnected}, worded "disconnected" rather than "session expired". */
  loggedOut?: Record<string, boolean>;
  /** Shown when the accounts list hasn't loaded yet (keychain email). */
  fallbackEmail?: string;
  fallbackOrg?: string;
  onSwitch?: (accountId: string) => void;
  onAdd?: () => void;
  onRemove?: (accountId: string) => void;
  onReauth?: (accountId: string) => void;
  onLogout?: (accountId: string) => void;
}

/** Row action: a per-account icon button. Quiet at rest and full-strength on the
 * hovered row (the cluster carries the opacity), and it must not also switch to
 * the account whose row it sits in. */
function RowAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      className="p-0.5 rounded text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.1)] transition-colors shrink-0"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** A compact session/weekly usage readout shown under each account in the
 * switcher — the same data as the composer's bottom bars, but per account. */
function MiniUsage({ usage }: { usage: UsageInfo }) {
  const bars: { pct: number; color: string }[] = [];
  if (usage.fiveHour) {
    bars.push({ pct: usage.fiveHour.utilization, color: "#fbbf24" });
  }
  if (usage.sevenDay) {
    bars.push({ pct: usage.sevenDay.utilization, color: "#f87171" });
  }
  if (bars.length === 0) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 mt-1 pl-[18px]">
      {bars.map((b, i) => {
        const v = Math.max(0, Math.min(100, Math.round(b.pct)));
        return (
          <div key={i} className="flex items-center gap-1">
            <div className="relative w-7 h-[3px] rounded-full bg-[rgba(255,255,255,0.1)] overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${v}%`, backgroundColor: b.color }}
              />
            </div>
            <span className="text-[9px] text-vscode-descriptionFg opacity-60 tabular-nums">
              {v}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The account indicator in the composer bottom bar. Click to open a switcher
 * listing every configured account (the keychain "Default" first, then added
 * config-dir accounts) with each account's live session/weekly usage. From there:
 * switch the active conversation's account, add one, disconnect one (deletes its
 * token, keeps the row), reconnect one (fresh login — recreates the token, or
 * puts a different Claude account in the slot), or remove an added one. */
export default function AccountSwitcher({
  accounts,
  activeAccountId,
  usageByAccount,
  disconnected,
  loggedOut,
  fallbackEmail,
  fallbackOrg,
  onSwitch,
  onAdd,
  onRemove,
  onReauth,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const list = accounts ?? [];
  const activeId = activeAccountId || "default";
  const active = list.find((a) => a.id === activeId);
  const activeLabel = active?.label || fallbackEmail || "Account";
  const activeDisconnected = !!disconnected?.[activeId];
  const activeLoggedOut = !!loggedOut?.[activeId];

  // Nothing to show or do.
  if (!onSwitch && !fallbackEmail) {
    return null;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          activeDisconnected
            ? "flex items-center gap-1 text-[10px] text-[#f87171] opacity-100 transition-opacity max-w-[150px]"
            : "flex items-center gap-0.5 text-[10px] text-vscode-descriptionFg opacity-80 hover:opacity-100 transition-opacity max-w-[150px]"
        }
        title={
          activeDisconnected
            ? `${activeLabel} — ${activeLoggedOut ? "disconnected" : "session expired"}. Click to reconnect.`
            : `Account: ${activeLabel}${fallbackOrg ? ` (${fallbackOrg})` : ""}\nClick to switch, reconnect or disconnect an account`
        }
      >
        {activeDisconnected && (
          <AlertTriangle size={10} className="shrink-0" />
        )}
        <span className="truncate">
          {activeDisconnected ? `Reconnect ${activeLabel}` : activeLabel}
        </span>
        <ChevronDown size={10} className="shrink-0 opacity-70" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 min-w-[210px] rounded-md border border-[var(--app-border)] bg-[var(--app-surface-2)] shadow-lg py-1 z-50">
          {list.map((a) => {
            const u = usageByAccount?.[a.id];
            const isDead = !!disconnected?.[a.id];
            const isOut = !!loggedOut?.[a.id];
            return (
              <div
                key={a.id}
                className="px-2.5 py-1.5 hover:bg-[rgba(255,255,255,0.05)] cursor-pointer group"
                onClick={() => {
                  onSwitch?.(a.id);
                  setOpen(false);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Check
                      size={12}
                      className={`shrink-0 ${a.id === activeId ? "opacity-100" : "opacity-0"}`}
                    />
                    <span className="truncate text-[11px] text-vscode-fg">
                      {a.label}
                    </span>
                    {a.isDefault && (
                      <span className="text-[9px] text-vscode-descriptionFg opacity-50 shrink-0">
                        default
                      </span>
                    )}
                    {isDead && (
                      <AlertTriangle
                        size={10}
                        className="shrink-0 text-[#f87171]"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                    {onReauth && (
                      <RowAction
                        title="Reconnect — sign out and log in again, as this or another Claude account (recreates the token)"
                        onClick={() => {
                          onReauth(a.id);
                          setOpen(false);
                        }}
                      >
                        <RefreshCw size={11} />
                      </RowAction>
                    )}
                    {onLogout && !isOut && (
                      <RowAction
                        title="Disconnect — delete this account's stored token (the account stays in the list)"
                        onClick={() => {
                          onLogout(a.id);
                          setOpen(false);
                        }}
                      >
                        <LogOut size={11} />
                      </RowAction>
                    )}
                    {!a.isDefault && onRemove && (
                      <RowAction
                        title="Remove this account"
                        onClick={() => onRemove(a.id)}
                      >
                        <Trash2 size={11} />
                      </RowAction>
                    )}
                  </div>
                </div>
                {isDead ? (
                  onReauth && (
                    <button
                      type="button"
                      className="flex items-center gap-1 mt-1 ml-[18px] px-1.5 py-0.5 rounded text-[10px] text-[#f87171] border border-[#f87171]/40 hover:bg-[#f87171]/10 transition-colors"
                      title={
                        isOut
                          ? "Disconnected — log in again to use this account"
                          : "Session expired — log in again to restore this account"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onReauth(a.id);
                        setOpen(false);
                      }}
                    >
                      <RefreshCw size={10} className="shrink-0" />
                      {isOut ? "Reconnect — disconnected" : "Reconnect — session expired"}
                    </button>
                  )
                ) : (
                  u && <MiniUsage usage={u} />
                )}
              </div>
            );
          })}
          {onAdd && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 mt-0.5 border-t border-[var(--app-border)] hover:bg-[rgba(255,255,255,0.05)] cursor-pointer text-[11px] text-vscode-descriptionFg hover:text-vscode-fg"
              onClick={() => {
                onAdd();
                setOpen(false);
              }}
            >
              <Plus size={12} />
              Add account…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
