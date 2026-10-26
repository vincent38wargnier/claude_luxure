import type { CSSProperties } from "react";
import vscode from "../../vscode";
import type { AccountProvider, VoiceStatus } from "../../types";
import "./orb.css";

const PROVIDER_COLOR: Record<AccountProvider, string> = {
  claude: "#ff8a34",
  codex: "#78aaff",
};

const LABEL: Partial<Record<VoiceStatus["state"], string>> = {
  waking: "Preparing…",
  speaking: "Speaking…",
};

/** Ambient voice orb (claude-voice's orb, in the status strip). Click stops
 * speech while it's talking; otherwise toggles voice mode on/off. */
export default function VoiceOrb({
  voice,
  provider,
}: {
  voice: VoiceStatus;
  provider?: AccountProvider;
}) {
  const busy = voice.state === "speaking" || voice.state === "waking";
  const title = voice.unavailable
    ? voice.unavailable
    : busy
      ? `${voice.state === "speaking" ? "Speaking" : "Preparing speech"} — click to stop`
      : voice.enabled
        ? "Voice on — click to mute"
        : "Voice off — click to read replies aloud";

  // Headline + one line of explanation, so the orb explains itself the first
  // time someone hovers it rather than only signalling state.
  const [tipTitle, tipHint] = voice.unavailable
    ? ["Voice unavailable", voice.unavailable]
    : busy
      ? [
          voice.state === "speaking" ? "Speaking" : "Preparing speech",
          "Reading this reply aloud — click to stop.",
        ]
      : voice.enabled
        ? ["Voice on", "Claude reads each finished reply aloud. Click to mute."]
        : ["Voice off", "Click to have Claude read its replies aloud."];

  const onClick = () => {
    vscode.postMessage(busy ? { type: "voiceStop" } : { type: "voiceToggle" });
  };

  const style = {
    "--session-color": PROVIDER_COLOR[provider ?? "claude"],
  } as CSSProperties;

  return (
    <div
      className="voice-orb-wrap relative flex flex-row-reverse items-center gap-1.5 shrink-0"
      style={style}
    >
      <button
        type="button"
        className="voice-orb"
        data-state={voice.state}
        data-style={voice.orbStyle}
        onClick={onClick}
        aria-label={title}
        aria-pressed={voice.enabled}
      >
        <span className="orb-ripples" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="orb-core" aria-hidden="true" />
      </button>
      {LABEL[voice.state] && (
        <span className="voice-orb-label">{LABEL[voice.state]}</span>
      )}
      <span className="voice-orb-tip" role="tooltip">
        <strong>{tipTitle}</strong>
        <span>{tipHint}</span>
      </span>
    </div>
  );
}
