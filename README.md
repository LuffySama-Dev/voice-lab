# Voice Lab

A local browser voice prototype for macOS. This checkpoint delivers continuous on-device transcription with revisable live captions. **Paid integrations are disabled by default.**

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

Optional `ASR_PROVIDER=openai` sends microphone audio to OpenAI and is separately disclosed. Local YAP conversation ASR sends only transcript text to OpenAI; generated response text goes to ElevenLabs. API billing is separate from a ChatGPT/Codex subscription. Model/voice access, real service behavior, voice quality, and end-to-end latency remain unverified.

## Architecture and privacy

```text
Browser controls / transcript / PCM playback
              ↕ localhost WebSocket
Node server: 127.0.0.1, one active session
  ├─ Local mic: YAP-derived helper → Apple on-device draft/final snapshots
  └─ Optional paid conversation (disabled)
       YAP final segments → OpenAI Responses SSE → ElevenLabs TTD socket
```

The server checks Host, Origin, a per-process token, payload bounds, and an explicit static-file allowlist. Secrets stay server-side and are excluded from native subprocess environments. Turn epochs and cancellation suppress stale responses and clear scheduled playback. Short committed phrases can stream to speech while the rest of a response is generated.

The app does not save user recordings or transcripts or log prompts, provider output, or credentials. Session text stays in process/browser memory; the last displayed transcript remains until replaced or reloaded. Cloud providers apply their own retention policies if paid mode is enabled. `store:false` is not a guarantee of zero provider retention.

No meeting, phone, system-audio, deployment, or public hosting integration is included. `.gitignore` excludes local environment files, credentials, recordings, screenshots, runtime logs, evidence, dependencies, and build output. The repository checkpoint contains source, tests with synthetic data, dependency lockfile, and generic documentation only.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:ui
```

UI tests use installed Google Chrome via Playwright on separate localhost port 4318. Real microphone capture is blocked/mocked; paid keys are blank. Tests cover repeated start/stop, cancellation, missing setup, audio queue clearing, draft replacement without duplicates, responsive layout, and localhost restrictions. Native adapter tests use synthetic subprocess fixtures.

`npm run test:native` generates synthetic speech using macOS `say` and feeds it to the native engine at real-time pace. It uses no microphone or speaker playback. Generated audio and evidence remain ignored locally. Prior synthetic testing observed provisional output before the audio finished, followed by successful finalization. The user has also accepted the local live transcription behavior. Neither is a comprehensive accuracy benchmark.

## Implementation references

- [YAP 1.2.1 native capture](https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift) and [CC0 license](https://github.com/finnvoor/yap/blob/1.2.1/LICENSE).
- [Apple SpeechAnalyzer and volatile results](https://developer.apple.com/videos/play/wwdc2025/277/).
- [OpenAI response streaming](https://developers.openai.com/api/docs/guides/streaming-responses).
- [ElevenLabs realtime Text-to-Dialogue](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) and [TTS versus TTD protocols](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets).
