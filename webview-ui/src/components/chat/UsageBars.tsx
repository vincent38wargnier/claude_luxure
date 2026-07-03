import type { UsageInfo, UsageBucket } from "../../types";

/** Humanize the time until a rate-limit window resets, e.g. "45m", "3h", "4d". */
function resetLabel(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) {
    return "now";
  }
  const mins = Math.round(ms / 60000);
  if (mins < 60) {
    return `${mins}m`;
  }
  const hrs = Math.round(mins / 60);
  if (hrs < 24) {
    return `${hrs}h`;
  }
  return `${Math.round(hrs / 24)}d`;
}

function Bar({
  label,
  bucket,
  color,
}: {
  label: string;
  bucket: UsageBucket;
  color: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(bucket.utilization)));
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1 h-[3px] rounded-full bg-[rgba(255,255,255,0.07)] overflow-hidden">
        {/* scaleX, not width — layout properties shouldn't animate. */}
        <div
          className="absolute inset-0 rounded-full origin-left transition-transform duration-500"
          style={{ transform: `scaleX(${pct / 100})`, backgroundColor: color }}
        />
      </div>
      <span className="text-[9px] text-vscode-descriptionFg opacity-70 tabular-nums whitespace-nowrap">
        {pct}% {label} · {resetLabel(bucket.resetsAt)}
      </span>
    </div>
  );
}

/** Two thin subscription-usage bars at the bottom of the composer: a yellow
 * 5-hour session bar and a red 7-day weekly bar — the data behind Claude Code's
 * official "Account & Usage" panel, fetched per the active conversation's
 * account. Renders nothing until usage data arrives. */
export default function UsageBars({ usage }: { usage: UsageInfo | null }) {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 px-3 pb-2 pt-0.5">
      {usage.fiveHour && (
        <Bar label="session" bucket={usage.fiveHour} color="#fbbf24" />
      )}
      {usage.sevenDay && (
        <Bar label="weekly" bucket={usage.sevenDay} color="#f87171" />
      )}
    </div>
  );
}
