# PRD — Voice Mode for Claude Luxure

**Branch:** `feature/voice-mode` · **Status:** Approved, built on branch · **Date:** 2026-09-21

## 1. Summary

Give Claude Luxure a voice. When a turn finishes in the tab you're looking at, the extension reads the assistant's final reply aloud. It uses the same pipeline as `../claude-voice`: markdown stripping, an optional Haiku spoken-word rephrase, and macOS `say` or ElevenLabs. It runs entirely inside the extension host, with no separate app, HTTP server or Stop hook. An ambient orb (ported from claude-voice's four CSS styles) sits in the live status strip above the composer. It shows the voice state, and clicking it turns voice on or off.

## 2. Goals / Non-goals

**Goals**
- Replies can be heard without watching the panel (start a task, look away, hear "done — tests pass").
- One-click on/off that survives reloads.
- Replay any assistant message on demand, at no extra cost.
- Match claude-voice's look (orb styles and animation) inside the panel.

**Non-goals (v1)**
- Voice input, mic, or speech-to-text. VS Code webviews don't reliably get `getUserMedia`, so this would need a host-side recorder (a later phase).
- Web Speech backend.
- Word-by-word highlighting of the message text.
- Speaking background tabs, and multi-session prefixes.
- Windows/Linux. Both `say` and `afplay` are macOS-only, so on other platforms the orb shows as unavailable with a tooltip explaining why.

## 3. User experience

### 3.1 The orb
- Always rendered at the left of the live status strip (`ChatView.tsx` ~460–524, next to `RunStatus`), at about 22px.
- **Colour** is tinted by provider through `--session-color`: Claude accounts get a warm coral (`#e0876a`), Codex accounts a cool blue (`#78aaff`).
- **Style** comes from `claude-luxure.voice.orbStyle`: `glass | plasma | iridescent | energy`. The default is `plasma`.
- **States** (a `data-voice-state` attribute on the orb):

| State | When | Visual (from claude-voice) |
|---|---|---|
| `off` | voice disabled | desaturated, 40% opacity, no animation |
| `idle` | enabled, nothing playing | style's base animation only (Plasma spin / Iridescent shift) |
| `waking` | rephrase / TTS request in flight | `orb-waking` scale pulse + `orb-halo-wake` |
| `speaking` | audio playing | `orb-halo` + `orb-bounce` + 3 staggered ripples (+ Energy ring) |

- **Click:**
  - While speaking, a click stops playback. Voice stays on.
  - Otherwise, a click toggles voice on or off.
- **Tooltip:** "Voice on — click to mute", "Speaking — click to stop", and so on.
- **Label:** a short text next to the orb, shown only while waking or speaking ("Preparing…" / "Speaking…").
- **Size:** the core is 18px in a 24px hit target.
- **Reduced motion:** the existing reduced-motion rule (`index.css:271`) disables the keyframes, and the state then shows through opacity and glow only.
- **Ripples:** the `backdrop-filter` blur was dropped. At this size it isn't visible, and it forces a compositing layer.

### 3.2 Replay
- Each finished assistant message gets a small 🔊 (lucide `Volume2`) button in its hover actions.
- Replay works even when voice is off, because it is an explicit request.
- Clicking replay while something is playing stops the current audio and plays the requested message.

### 3.3 When it speaks
- Only for turns that end with a successful `result` event (`is_error !== true`), in the **active tab**, or the **focused pane** when the view is split.
- Cancelled, errored, watchdog-ended and exited turns are not spoken.
- Codex turns are spoken the same way.
- **Interrupts:**
  - Sending a new message in any tab stops playback.
  - Switching tabs does *not* stop it.
  - New speech replaces current speech. There is no queue, because only the active tab speaks.

### 3.4 Settings (package.json `contributes.configuration`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `claude-luxure.voice.enabled` | boolean | `false` | Orb click writes this (Global target) |
| `claude-luxure.voice.backend` | `"say" \| "elevenlabs"` | `"say"` | ElevenLabs falls back to `say` if there's no key or on error |
| `claude-luxure.voice.sayVoice` | string | `"Samantha"` | |
| `claude-luxure.voice.sayRate` | number | `200` | wpm |
| `claude-luxure.voice.elevenlabsVoiceId` | string | `"pNInz6obpgDQGcFmaJgB"` | Adam |
| `claude-luxure.voice.elevenlabsModel` | enum | `"eleven_flash_v2_5"` | also turbo_v2_5, multilingual_v2 |
| `claude-luxure.voice.elevenlabsSpeed` | number | `0.9` | |
| `claude-luxure.voice.rephrase` | boolean | `true` | Haiku spoken-word rewrite |
| `claude-luxure.voice.rephraseThreshold` | number | `180` | chars; shorter replies are spoken as-is |
| `claude-luxure.voice.brevity` | enum | `"balanced"` | detailed / balanced / brief / minimal |
| `claude-luxure.voice.orbStyle` | enum | `"plasma"` | glass / plasma / iridescent / energy |

**Commands**
- `Claude Luxure: Toggle Voice`
- `Claude Luxure: Stop Speaking`
- `Claude Luxure: Set ElevenLabs API Key` stores the key in `context.secrets`. An empty value clears it.

## 4. Technical design

### 4.1 New host module: `src/voice/`
- `textClean.ts`: a port of `text_clean.rs`.
  - Drops fenced code blocks.
  - `` `x` `` becomes `x`, and `[label](url)` becomes `label`.
  - Drops bare URLs.
  - Strips `* # > ~` and `_` **only at word boundaries**. This fixes claude-voice's identifier-mangling bug.
  - Collapses whitespace.
- `rephrase.ts`: the claude-voice system prompt, copied verbatim (`tts.rs:696`), including the `<source>` wrapping and zero-width escaping of `</source>`. The brevity table comes from `tts.rs:662`.
  - It runs through the existing `runClaudePrint` path (`ChatViewProvider.ts:1059`). That path is extended to accept an optional `--system-prompt`, so it keeps working with no API key and falls back to the ambient login for Codex accounts.
  - If the rephrase fails, it falls back to the cleaned text.
  - Anti-repetition is not included in v1.
- `tts.ts`: a `VoicePlayer` with `play(text | mp3Path)`, `stop()` and an `isPlaying` flag.
  - **`say` backend:** `spawn("say", ["-v", voice, "-r", rate, "--", text])`.
  - **ElevenLabs backend:** host-side `fetch` to `POST /v1/text-to-speech/{voice}` (plain MP3, without timestamps since there's no highlighting), writes to `globalStorageUri/voice-cache/{messageId}.mp3`, then plays with `afplay`.
  - `stop()` sends SIGTERM to the child process.
  - A generation counter keeps a late rephrase from starting audio after `stop()` has been called.
- `VoiceController.ts`: the pipeline orchestrator.
  - Implements `speak(messageId, rawText, provider)`, `replay(messageId)` and `stop()`.
  - Keeps an in-memory cache: `messageId → { spokenText, mp3Path? }`, LRU of 50, with MP3s evicted alongside their entries. The disk cache is cleared on activate.
  - Emits state to the provider: `off | idle | waking | speaking`.

### 4.2 Hook points in `ChatViewProvider.ts`
- **`result` handler (~4920):** after `finalizeStreamingMessage()`, if all of these hold:
  - voice is enabled,
  - `!is_error`,
  - the runtime's tab is active or focused,
  - the final content is non-empty,

  then call `voice.speak(msg.id, msg.content, provider)`.
- **`sendMessage` case (~2245):** call `voice.stop()`.
- **New webview → host messages:** `voiceToggle`, `voiceStop`, `voiceReplay {messageId}`.
- **New host → webview message:** `voiceState {state, enabled, orbStyle, provider}`. The same fields are also included in `ExtensionState` so the initial render is correct.
- **`onDidChangeConfiguration` (extension.ts:106):** also watches `claude-luxure.voice` and pushes `voiceState`.
- Types go in both `src/shared/types.ts` and `webview-ui/src/types.ts`.

### 4.3 Webview
- `components/voice/VoiceOrb.tsx`: markup copied from `popup.html:118-126` (core, three ripple spans, label).
- `components/voice/orb.css`: a port of `popup.css:449-741`.
  - `body.speaking` / `body.waking` / `[data-orb-style]` selectors are re-scoped to `.voice-orb[data-state][data-style]`.
  - The core is scaled from 56px to 22px, and ripple and halo sizes are scaled to match.
- Replay button added to the assistant-message action row.
- **CSP:** no change is needed, because audio plays out-of-process (`say` / `afplay`) and not in the webview.

### 4.4 Security and cost
- The ElevenLabs key is kept only in SecretStorage. It is never sent to the webview or written to logs.
- Reply text is passed to `say` as an argument after `--` (no shell) to prevent injection.
- The Haiku rephrase prompt is hardened against injected instructions inside `<source>`.
- An ElevenLabs replay uses the cached MP3, so it is never billed twice.

## 5. Acceptance criteria
1. Voice is off by default, and the orb shows dimmed. Clicking the orb sets it to idle and flips `voice.enabled` to `true`, and the change persists across a window reload.
2. With voice on, a finished Claude turn in the active tab is spoken. The orb goes waking → speaking → idle.
3. A reply of 180 characters or more is rephrased (audibly shorter, with no markdown read out). With `rephrase: false`, the cleaned text is read in full.
4. Code blocks, URLs and markdown symbols are never spoken, and identifiers like `snake_case_name` keep their underscores.
5. A turn finishing in a background tab or unfocused pane is silent. A cancelled or errored turn is silent.
6. Sending a message stops playback within 200ms. Switching tabs does not stop it.
7. Clicking the orb while speaking stops playback and voice stays on.
8. Replay speaks the message using the cached spoken text, with no second Haiku call (verified in the log). An ElevenLabs replay makes no second API call.
9. ElevenLabs with an invalid key or no network falls back to `say` and shows one non-blocking warning.
10. Codex turns are spoken and the orb is blue.
11. All four orb styles render correctly, and `orbStyle` changes apply live.
12. With reduced motion set, there are no keyframe animations.

## 6. Open risks
- **Whether `say` / `afplay` survive remote setups.** Remote-SSH extension hosts run on the remote machine, so audio would play there. For v1, voice is disabled when `vscode.env.remoteName` is set, and a notice explains why.
- **Haiku latency.** `claude -p` added about 10s of cold start before speech when measured on 2026-09-21. Raise `rephraseThreshold`, or turn off `rephrase`, to get faster speech. The orb's `waking` state covers that wait.
- **The 6.5k-line `ChatViewProvider.ts`.** Keep the voice logic in `src/voice/` and add only thin call sites to the provider.

## 7. Future phases
- Voice input: host-side recording (`sox`/`ffmpeg`) sent to ElevenLabs Scribe and inserted into the composer.
- Word highlighting using ElevenLabs `/with-timestamps` alignment.
- Speaking background tabs with a "Tab says…" prefix and a queue.
- The anti-repetition `<recent>` context.
