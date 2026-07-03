import type { SessionMarker } from "../../types";

interface SessionPostItProps {
  /** Conversation key — only used to derive a stable per-chat tilt. */
  tabKey: string;
  marker: SessionMarker;
  /** An emoji pick is in flight (initial auto-pick or a click re-pick). */
  busy?: boolean;
  onReevaluate?: () => void;
}

/** Stable little tilt per conversation (-3°..+3°) so stacked windows read as
 * a wall of distinct sticky notes rather than one repeated ornament. */
function tiltFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 7) - 3;
}

/**
 * The conversation's post-it: a pastel sticky pinned to the top-right of the
 * chat, carrying the emoji that identifies this session. Clicking it re-picks
 * the emoji from the recent conversation context (the first message is often
 * not enough to know what a chat is really about).
 */
export default function SessionPostIt({
  tabKey,
  marker,
  busy,
  onReevaluate,
}: SessionPostItProps) {
  const emoji = marker.emoji;
  const label = busy
    ? "Picking an emoji for this chat from its recent context…"
    : emoji
      ? `This chat's emoji: ${emoji}. Click to re-pick from recent context.`
      : "An emoji will label this chat after the first reply. Click to pick one now.";

  return (
    <button
      type="button"
      onClick={onReevaluate}
      disabled={busy || !onReevaluate}
      className="postit group"
      style={{
        backgroundColor: marker.color,
        ["--postit-rot" as string]: `${tiltFor(tabKey)}deg`,
      }}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      <span
        aria-hidden="true"
        className={`text-[19px] leading-none transition-opacity ${
          busy ? "opacity-30" : emoji ? "" : "opacity-40"
        }`}
      >
        {emoji || "?"}
      </span>

      {/* Refresh affordance: spins while picking, appears on hover otherwise. */}
      <span
        aria-hidden="true"
        className={`postit-refresh ${
          busy
            ? "opacity-90"
            : "opacity-0 group-hover:opacity-90 group-focus-visible:opacity-90"
        }`}
      >
        <svg
          className={busy ? "postit-spin" : undefined}
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </span>
    </button>
  );
}
