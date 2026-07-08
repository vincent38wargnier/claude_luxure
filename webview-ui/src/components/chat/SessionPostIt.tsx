import type { SessionMarker } from "../../types";

interface SessionPostItProps {
  /** Conversation key — only used to derive a stable per-chat tilt. */
  tabKey: string;
  marker: SessionMarker;
  /** The initial automatic emoji pick is in flight. */
  busy?: boolean;
  onEditNote?: () => void;
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
 * chat. It shows the user's note when one is set, otherwise the emoji picked
 * from the conversation's content. Clicking it opens the note editor.
 */
export default function SessionPostIt({
  tabKey,
  marker,
  busy,
  onEditNote,
}: SessionPostItProps) {
  const note = marker.note?.trim();
  const emoji = marker.emoji;
  const label = note
    ? `Note: ${note}. Click to edit.`
    : busy
      ? "Picking an emoji for this chat… Click to write a note instead."
      : emoji
        ? `This chat's emoji: ${emoji}. Click to write a note.`
        : "Click to write a note for this chat. An emoji appears after the first reply.";

  return (
    <button
      type="button"
      onClick={onEditNote}
      disabled={!onEditNote}
      className={`postit group ${note ? "postit-noted" : ""}`}
      style={{
        backgroundColor: marker.color,
        ["--postit-rot" as string]: `${tiltFor(tabKey)}deg`,
      }}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      {note ? (
        <span aria-hidden="true" className="postit-note-text">
          {note}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={`text-[19px] leading-none transition-opacity ${
            busy ? "opacity-30" : emoji ? "" : "opacity-40"
          }`}
        >
          {emoji || "?"}
        </span>
      )}

      {/* Corner affordance: spinner while the auto-pick runs, otherwise a
          pencil on hover — the click edits the note. */}
      <span
        aria-hidden="true"
        className={`postit-refresh ${
          busy && !note
            ? "opacity-90"
            : "opacity-0 group-hover:opacity-90 group-focus-visible:opacity-90"
        }`}
      >
        {busy && !note ? (
          <svg
            className="postit-spin"
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
        ) : (
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        )}
      </span>
    </button>
  );
}
