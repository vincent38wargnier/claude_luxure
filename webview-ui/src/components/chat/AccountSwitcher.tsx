import { useState, useRef, useEffect } from "react";
import { Check, Plus, Trash2, ChevronDown } from "lucide-react";
import type { StoredAccount, UsageInfo } from "../../types";

interface Props {
  accounts?: StoredAccount[];
  activeAccountId?: string;
  /** Per-account subscription usage, keyed by account id (incl. "default"). */
  usageByAccount?: Record<string, UsageInfo | null>;
  /** Shown when the accounts list hasn't loaded yet (keychain email). */
  fallbackEmail?: string;
  fallbackOrg?: string;
  onSwitch?: (accountId: string) => void;
  onAdd?: () => void;
  onRemove?: (accountId: string) => void;
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
 * config-dir accounts) with each account's live session/weekly usage, switch the
 * active conversation's account, add a new one, or remove a stored one. */
export default function AccountSwitcher({
  accounts,
  activeAccountId,
  usageByAccount,
  fallbackEmail,
  fallbackOrg,
  onSwitch,
  onAdd,
  onRemove,
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

  // Nothing to show or do.
  if (!onSwitch && !fallbackEmail) {
    return null;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 text-[10px] text-vscode-descriptionFg opacity-60 hover:opacity-100 transition-opacity max-w-[150px]"
        title={`Account: ${activeLabel}${fallbackOrg ? ` (${fallbackOrg})` : ""}\nClick to switch the account for this conversation`}
      >
        <span className="truncate">{activeLabel}</span>
        <ChevronDown size={10} className="shrink-0 opacity-70" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 min-w-[210px] rounded-md border border-[var(--app-border)] bg-[var(--app-surface-2)] shadow-lg py-1 z-50">
          {list.map((a) => {
            const u = usageByAccount?.[a.id];
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
                  </div>
                  {!a.isDefault && onRemove && (
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-vscode-descriptionFg shrink-0"
                      title="Remove this account"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(a.id);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                {u && <MiniUsage usage={u} />}
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
