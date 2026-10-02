# Voice Lab

A local browser voice prototype for macOS. This checkpoint combines on-device live transcription, streamed Codex subscription replies, and optional Eleven v4 Turbo speech. The user has validated the full flow with a stock voice. **Paid integrations remain disabled by default; private credentials are not included.**

## Run locally

Requirements: Node 24, an Apple Silicon Mac with macOS 26+, Xcode with the macOS 26+ Speech APIs, Google Chrome, and installed speech-language assets. The native build script uses the standard Xcode application location. YAP 1.2.1 must also be installed (`brew install yap`) for the readiness gate and optional conversation adapter.

```sh
npm ci
npm run build:native
bin/yap-live --check --locale en-US
npm run build
npm run mic:background
```

Open **http://localhost:4317/?mode=local**. Opening the page does not start capture. Click **Start session** yourself and allow the macOS Microphone permission for the launching app if prompted. The native helper captures the default Mac microphone; Chrome does not request microphone access in local mode.

- Keep speaking: italic, underlined draft words revise while finalized words remain stable.
- **Stop** ends capture, waits for final words, and closes the session.
- **Emergency mute / Escape** immediately cancels capture. Pending words may be discarded.
- Hiding, reloading, or closing the page also cancels the session.

`mic:background` starts a detached localhost process with provider keys blank, paid services disabled, and local transcription enabled. It does not read `.env`, install a login service, or start the microphone until Start is pressed. Its PID/log are in ignored `.runtime/`. Do not stop or restart that process while recording. It may stop on logout, reboot, or process termination.

For scripted UI exploration without any microphone or services:

```sh
npm run dev
```

Open http://localhost:4317 and use **Demo**. Its quiet synthetic tones stand in for speech. `npm run demo:background` offers the same detached-process arrangement with native capture disabled.

## Local recognition

The project-local `bin/yap-live` adapter is derived from YAP 1.2.1's CC0 native capture path. It enables Apple SpeechTranscriber `volatileResults` and emits complete draft/final snapshots. Each provisional hypothesis replaces the previous one. This is one recognition stream with final refinement, not a second accuracy pass. The Homebrew YAP installation is unchanged; attribution is in [native/NOTICE.md](native/NOTICE.md).

The helper checks for installed language assets and does not download them. `--check` never opens the microphone. Complete native language/permission setup before enabling capture. The unmodified YAP CLI may download Apple language assets on first use; review its setup before running `yap dictate` yourself.

Recognition timing belongs to the Apple engine. Live drafts are supported, but instantaneous text, perfect accuracy, and zero omitted words are not guaranteed. Local transcription runs until Stop with a 100,000-character output bound and a 15-second native finalization deadline. It generates no AI reply and makes no OpenAI or ElevenLabs requests.

## Codex subscription text demo

Run `npm run build && npm run codex:background`, then open **http://localhost:4319/?mode=codex**. This separate server leaves the existing transcription server on 4317 untouched. Stop any existing Local mic session before using the new page. Check the cloud-processing consent box, click Start, and speak. Finalized text is submitted after 1.6 seconds without a provisional draft; use **Send turn** if recognition does not settle. Read the streamed reply, then click **Talk** for the next turn. **Interrupt & talk**, Stop, and Escape cancel the current reply. Microphone capture pauses while the AI responds.

The demo uses your existing ChatGPT-managed Codex sign-in with Astra, high reasoning, and Fast (`priority`). No API key is required. Transcript text goes to OpenAI; microphone audio stays in local YAP recognition. This consumes shared Codex allowance, with higher usage for Fast. ElevenLabs, voice playback, and direct paid API integrations remain off. The standard server defaults to Codex off; the dedicated launcher explicitly enables it. A server cannot start microphone capture until you click Start in the browser.

Available safeguards include an ephemeral Codex thread, an empty project-specific working directory, read-only sandbox, never approving tool/permission requests, disabled shell/apps/plugins/web search, structured per-thread MCP disables, reply-only instructions, and rejecting observable tool events. **These are prototype mitigations, not proven complete tool or instruction isolation.** The app uses the supported Codex app-server interface normally; it never extracts tokens or changes global configuration/authentication. Native app-server requests for client tools or approval cause disconnection, without approval.

Limits: six turns per Codex thread, 4,000 input bytes per turn, 12,000 reply bytes per turn, 48,000 cumulative context bytes, a 90-second generation deadline, and 60 seconds of microphone input per turn. These are application bounds, not exact token or spending caps. Interrupting abandons that Codex thread; the next response starts a fresh thread. Automatic submission is a transcript-stability heuristic, not acoustic silence detection. Talk is required for each subsequent turn.

A real synthetic prompt returned a rainbow explanation in 19 text chunks: first text at 8.631 seconds and completion at 9.611 seconds, including connection setup. A second live synthetic test cancelled after the first delta and settled locally in 1 millisecond, discarding further output. These are individual observations, not latency guarantees. No user microphone audio or transcript was used in these tests. The user has since validated the microphone-to-Codex-to-Eleven speech flow with a stock voice; this is not a comprehensive accuracy, voice-quality, or latency benchmark. Native Codex may retain its own operational data under its normal policies; ephemeral mode is not a claim of zero provider retention.

References: [Codex authentication](https://learn.chatgpt.com/docs/auth), [app-server](https://learn.chatgpt.com/docs/app-server), and [hook coverage and limitations](https://learn.chatgpt.com/docs/hooks#tool-coverage).

## Add Eleven v4 Turbo to Codex replies

The Codex path now supports optional Eleven v4 Turbo speech without an OpenAI API key. It uses the Text-to-Dialogue WebSocket, registers one chosen voice, streams committed clauses with `flush`, and waits for the final audio before completing playback. One socket preserves audio order. Interrupted text is never re-sent; completion snapshots do not duplicate previously committed text. Stop/Interrupt cancels generation and synthesis, clears queued PCM, and discards late audio. Microphone capture closes before replies and resumes only through Talk, preventing the model's audio from feeding back into transcription. Use headphones.

A user-initiated live test confirmed the configured stock voice works through the complete local recognition → Codex → Eleven flow. Protocol, cancellation, and UI tests use synthetic data. No voice cloning or sample upload is included. Other voices, cloned-voice quality, access on other accounts, and sustained performance remain unverified.

For a new installation, choose an existing authorized stock or cloned voice and approve use of ElevenLabs credits and local credential storage, then run **`npm run setup:voice` yourself in a local terminal**. Enter the existing authorized voice ID, confirm paid speech, and enter a key with Text to Speech permission at the hidden prompt. Never paste the key in chat or a browser. This command makes no network calls and creates `.env.voice` with owner-only read/write permissions (0600), excluded from git. It refuses to overwrite an existing file. No keys are copied into Codex or native recognition subprocesses. This is private plaintext storage on the Mac, not a keychain; delete the file privately when it is no longer needed.

When the current Codex microphone session is stopped and the existing server on **4319** has been stopped deliberately, run `npm run build && npm run voice:background`. The launcher refuses to replace a running server. Continue using the same canonical page, **http://localhost:4319/?mode=codex**; select **Speak replies with Eleven v4 Turbo (paid)**, then confirm the updated data-flow consent and Start. Voice selection resets consent. The original local-only server on 4317 remains separate. No additional active demo port is introduced.

The voice launcher reads only the explicitly selected `.env.voice` configuration. It keeps direct OpenAI API generation disabled, uses the existing Codex subscription for replies, and separately enables paid ElevenLabs speech. Browser configuration exposes readiness and missing setting names only, never keys or the voice ID. Transcript text goes to OpenAI; generated reply text goes to ElevenLabs; native microphone audio stays on the Mac. The app does not save generated audio. Provider retention policies still apply.

Official protocol: [v4 Turbo realtime dialogue guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) and [TTS versus TTD](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets). Some generated API-reference text still describes older v3 models; the current guide explicitly includes `eleven_v4_turbo`.

## Optional paid conversation pipeline

Provider adapters are included as unverified scaffolding for YAP transcription → GPT Astra responses → Eleven v4 Turbo speech using an existing authorized cloned voice. No credentials or voice IDs are included. No voice cloning/upload occurs.

To configure later, copy `.env.example` to `.env` and enter values privately in a local editor. Never paste secrets into chat, the browser UI, or git. Review costs and provider data handling before explicitly setting `PAID_SERVICES_ENABLED=1`. The example keeps it `0`. Required settings include:

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | Private provider credentials |
| `ELEVENLABS_VOICE_ID` | Existing authorized Professional Voice Clone ID |
| `OPENAI_MODEL` | Defaults to `gpt-6-astra` |
| `OPENAI_REASONING_EFFORT` | Defaults to `high` |
| `OPENAI_SERVICE_TIER` | Requests `fast`; availability and latency are not guaranteed |
| `YAP_READY` | User-controlled native setup gate, default `0` |
| `LOCAL_MIC_ENABLED` | Local-only capture gate, default `0` |
| `LOCAL_PARTIALS_ENABLED` | Selects the built draft-caption helper for Local mic |
| `PAID_SERVICES_ENABLED` | Must explicitly be `1` for paid conversation mode |

After setup, launch with `npm run dev` or `npm run build && npm start`. These commands read `.env`; the detached demo/local launchers deliberately do not. The browser requires disclosure/consent before Live voice starts. Use headphones. Conversation mode uses unmodified YAP final segments and an explicit **Send turn**, then **Talk** for another turn. **Interrupt & talk** aborts generation and clears queued playback. Automatic spoken barge-in is not implemented; capture pauses during generation/playback to avoid feedback.

Optional `ASR_PROVIDER=openai` sends microphone audio to OpenAI and is separately disclosed. Local YAP conversation ASR sends only transcript text to OpenAI; generated response text goes to ElevenLabs. API billing is separate from a ChatGPT/Codex subscription. This separate direct-API generation path remains unverified; the validated conversation uses the Codex subscription path above.

## Architecture and privacy

```text
Browser controls / transcript / PCM playback
              ↕ localhost WebSocket
Node server: 127.0.0.1, one active session
  ├─ Local mic: YAP-derived helper → Apple on-device draft/final snapshots
  ├─ Codex subscription replies → optional Eleven v4 Turbo speech
  └─ Optional direct paid API conversation (disabled)
       YAP final segments → OpenAI Responses SSE → ElevenLabs TTD socket
```

The server checks Host, Origin, a per-process token, payload bounds, and an explicit static-file allowlist. Secrets stay server-side and are excluded from native subprocess environments. Turn epochs and cancellation suppress stale responses and clear scheduled playback. Short committed phrases can stream to speech while the rest of a response is generated.

The app does not save user recordings or transcripts or log prompts, provider output, or credentials. Session text stays in process/browser memory; the last displayed transcript remains until replaced or reloaded. Cloud providers apply their own retention policies when Codex or voice processing is enabled. `store:false` is not a guarantee of zero provider retention.

No meeting, phone, system-audio, deployment, or public hosting integration is included. `.gitignore` excludes local environment files, credentials, recordings, screenshots, runtime logs, evidence, dependencies, and build output. The repository checkpoint contains source, tests with synthetic data, dependency lockfile, and generic documentation only.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:ui
npm run test:setup
```

UI tests use installed Google Chrome via Playwright on separate localhost port 4318. Real microphone capture is blocked/mocked; paid keys are blank. Tests cover repeated start/stop, cancellation, missing setup, audio queue clearing, draft replacement without duplicates, responsive layout, and localhost restrictions. Native adapter tests use synthetic subprocess fixtures.

`npm run test:native` generates synthetic speech using macOS `say` and feeds it to the native engine at real-time pace. It uses no microphone or speaker playback. Generated audio and evidence remain ignored locally. Prior synthetic testing observed provisional output before the audio finished, followed by successful finalization. The user has also accepted the local live transcription behavior. Neither is a comprehensive accuracy benchmark.

## Implementation references

- [YAP 1.2.1 native capture](https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift) and [CC0 license](https://github.com/finnvoor/yap/blob/1.2.1/LICENSE).
- [Apple SpeechAnalyzer and volatile results](https://developer.apple.com/videos/play/wwdc2025/277/).
- [OpenAI response streaming](https://developers.openai.com/api/docs/guides/streaming-responses).
- [ElevenLabs realtime Text-to-Dialogue](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) and [TTS versus TTD protocols](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets).
