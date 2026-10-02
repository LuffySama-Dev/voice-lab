# Voice Lab

A local browser voice prototype for macOS. The Codex path combines continuous on-device transcription, automatic turns, streamed subscription replies, and optional Eleven v4 Turbo speech. The new hands-free loop has synthetic test coverage and still needs a user-initiated live microphone test. The user has validated the full flow with a stock voice. **Paid integrations remain disabled by default; private credentials are not included.**

## Project status: paused prototype

Development is paused at this checkpoint because the current experience is not yet reliable or responsive enough for natural conversation:

- **Response delay:** the user observed excessive end-to-end waiting. Synthetic Astra-low samples took 6.65 seconds cold and 5.12 seconds warm to first text; speech recognition, turn-end detection, voice synthesis, and playback add time. Those samples do not measure the complete microphone-to-audible-reply delay or guarantee future latency.
- **Interruption and echo reliability:** turn boundaries, draft alignment, activity detection, and text-based leakage rejection are heuristics. Background noise can interrupt a reply; quiet speech or major transcript revisions can be mishandled. Headphones are required for this prototype; it is not a robust speakerphone or acoustic echo-cancellation implementation.
- **Hindi input:** Hindi is not supported by the current Apple ASR integration/configuration, which uses the installed `en-US` path. Multilingual recognition has not been implemented or validated.
- **Operational dependence:** the Mac must remain awake, the local server/native capture processes must stay available, and provider sessions, access, network connectivity, and services must remain healthy. There is no hosted service, automatic recovery, or production availability guarantee.
- **Demo maturity:** automated and synthetic checks do not replace sustained real conversation testing. The newer hands-free and expressive-delivery behavior still needs live acceptance across interruptions, voice delivery, and recognition errors. The Codex tool restrictions are prototype mitigations, not verified isolation; credentials use ignored owner-only local files rather than a keychain. There is no meeting or phone integration.

This is a saved checkpoint, not a production-ready voice agent. Pausing development does not stop an already running local server; the user retains Start, Stop, and Emergency mute control. No further optimization work is planned until the project is resumed.

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

Run `npm run build:continuous && npm run build && npm run codex:background`, then open **http://localhost:4319/?mode=codex**. This separate server leaves the existing transcription server on 4317 untouched. Stop any existing Local mic session before using the new page. Check the cloud-processing consent box, click Start, and speak. Start once: speak, pause, receive a reply, and speak again without clicking Talk. The same native capture stays active during generation and playback. Sustained input activity can interrupt after about 300 ms, without waiting for transcription; shorter recognized speech can also interrupt. **Interrupt & talk** remains a manual fallback. Stop, Emergency mute, Escape, tab hiding, and disconnection terminate capture and queued audio.

The demo uses your existing ChatGPT-managed Codex sign-in with Astra, low reasoning, and Fast (`priority`) for conversation. This runtime setting is separate from the coding assistant’s Astra/high/Fast preference. No API key is required. Transcript text goes to OpenAI; microphone audio stays in local YAP recognition. This consumes shared Codex allowance, with higher usage for Fast. ElevenLabs, voice playback, and direct paid API integrations remain off. The standard server defaults to Codex off; the dedicated launcher explicitly enables it. A server cannot start microphone capture until you click Start in the browser.

Available safeguards include an ephemeral Codex thread, an empty project-specific working directory, read-only sandbox, never approving tool/permission requests, disabled shell/apps/plugins/web search, structured per-thread MCP disables, reply-only instructions, and rejecting observable tool events. **These are prototype mitigations, not proven complete tool or instruction isolation.** The app uses the supported Codex app-server interface normally; it never extracts tokens or changes global configuration/authentication. Native app-server requests for client tools or approval cause disconnection, without approval.

Limits: six attempted replies per Start session, 4,000 input bytes per user turn, 12,000 generated reply bytes, 48,000 cumulative new input/output bytes, bounded 12-message context, and a 90-second generation deadline. Limits survive cancelled connections. Three minutes without a completed user turn stops idle capture; a reply/playback timeout also stops the session. Start again to begin a new session. These are application bounds, not exact token or spending caps. Each reply receives a bounded authoritative history in a fresh ephemeral Codex thread. Interrupted drafts are retained with an explicit warning that playback/delivery was not confirmed.

A real synthetic prompt returned a rainbow explanation in 19 text chunks: first text at 8.631 seconds and completion at 9.611 seconds, including connection setup. A second live synthetic test cancelled after the first delta and settled locally in 1 millisecond, discarding further output. These are individual observations, not latency guarantees. No user microphone audio or transcript was used in these tests. The user has since validated the microphone-to-Codex-to-Eleven speech flow with a stock voice; this is not a comprehensive accuracy, voice-quality, or latency benchmark. Native Codex may retain its own operational data under its normal policies; ephemeral mode is not a claim of zero provider retention.

References: [Codex authentication](https://learn.chatgpt.com/docs/auth), [app-server](https://learn.chatgpt.com/docs/app-server), and [hook coverage and limitations](https://learn.chatgpt.com/docs/hooks#tool-coverage).

## Conversation latency

Conversation replies default to **Astra low / Fast**. `CODEX_REASONING_EFFORT=high` restores deeper runtime reasoning; `medium` is also supported. `CODEX_MODEL=gpt-6-luna` optionally selects Luna. These server environment settings do not change the coding assistant’s model or effort. For example, set them before `npm run voice:background` after deliberately stopping the existing server. Do not edit or expose private credentials to change these nonsecret settings.

A bounded comparison used one harmless fixed question, one cold and one warm request per setting, and the same `priority` tier. Cold includes app-server initialization, account/MCP setup, and thread creation; warm reuses the app-server connection with a fresh ephemeral thread.

| Runtime | Cold first text | Warm first text |
| --- | ---: | ---: |
| Astra high | 9.90 s | 7.10 s |
| Astra low | 6.65 s | 5.12 s |
| Luna low | 5.83 s | 4.56 s |

Astra low keeps the preferred model while improving this small sample. Thread creation took 58–137 ms; setup took 1.2–1.8 s. Most measured time was waiting for model output. The first committed phrase followed first text by about 0.25 s for Astra low. Voice connection setup now overlaps text generation instead of delaying its start. Answers default to one or two concise sentences.

These are single samples, with cache, load, and request-order effects uncontrolled. They are not latency guarantees or a quality comparison. Silence detection adds about 0.95 s for final text or 1.6 s for a stable draft, plus recognition timing; these thresholds were not shortened. Eleven synthesis/network latency and time to audible playback were not benchmarked. The earlier disconnected run had no recoverable result artifact; the completed comparison saved each result as it finished. Aggregate evidence is in ignored `evidence/latency-comparison.json`; no personal transcript or generated answer is stored there.

## Add Eleven v4 Turbo to Codex replies

The Codex path now supports optional Eleven v4 Turbo speech without an OpenAI API key. It uses the Text-to-Dialogue WebSocket, registers one chosen voice, streams committed clauses with `flush`, and waits for the final audio before completing playback. One socket preserves audio order. Interrupted text is never re-sent; completion snapshots do not duplicate previously committed text. Stop/Interrupt cancels generation and synthesis, clears queued PCM, and discards late audio. Microphone capture remains active during replies so spoken barge-in can cancel generation, synthesis, and queued playback. Browser playback completion returns the UI to listening automatically. **Headphones are required.** The app does not capture system audio; a conservative, time-scoped text match rejects some output leakage, but this is not acoustic echo cancellation or a speakerphone solution. Loud background sound can interrupt a reply, and very quiet speech can be missed.

A user-initiated live test confirmed the configured stock voice works through the complete local recognition → Codex → Eleven flow. Protocol, cancellation, and UI tests use synthetic data. No voice cloning or sample upload is included. Other voices, cloned-voice quality, access on other accounts, and sustained performance remain unverified.

For a new installation, choose an existing authorized stock or cloned voice and approve use of ElevenLabs credits and local credential storage, then run **`npm run setup:voice` yourself in a local terminal**. Enter the existing authorized voice ID, confirm paid speech, and enter a key with Text to Speech permission at the hidden prompt. Never paste the key in chat or a browser. This command makes no network calls and creates `.env.voice` with owner-only read/write permissions (0600), excluded from git. It refuses to overwrite an existing file. No keys are copied into Codex or native recognition subprocesses. This is private plaintext storage on the Mac, not a keychain; delete the file privately when it is no longer needed.

When the current Codex microphone session is stopped and the existing server on **4319** has been stopped deliberately, run `npm run build:continuous && npm run build && npm run voice:background`. The launcher refuses to replace a running server. Continue using the same canonical page, **http://localhost:4319/?mode=codex**; select **Speak replies with Eleven v4 Turbo (paid)**, then confirm the updated data-flow consent and Start. Voice selection resets consent. The original local-only server on 4317 remains separate. No additional active demo port is introduced.

The voice launcher reads only the explicitly selected `.env.voice` configuration. It keeps direct OpenAI API generation disabled, uses the existing Codex subscription for replies, and separately enables paid ElevenLabs speech. Browser configuration exposes readiness and missing setting names only, never keys or the voice ID. Transcript text goes to OpenAI; generated reply text goes to ElevenLabs; native microphone audio stays on the Mac. The app does not save generated audio. Provider retention policies still apply.

Official protocol: [v4 Turbo realtime dialogue guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) and [TTS versus TTD](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets). Some generated API-reference text still describes older v3 models; the current guide explicitly includes `eleven_v4_turbo`.

## Expressive v4 delivery

Voice replies can include zero to two restrained, context-appropriate delivery cues: warmly, curious, thoughtful, excited, whispers, or chuckles. Neutral delivery is the default. The model generates one canonical answer with reserved metadata such as `[[voice:warmly]]Good to hear.` The incremental parser produces clean display/context text (`Good to hear.`) and speech text (`[warmly] Good to hear.`). It does not generate two separate answers or strip arbitrary bracketed prose.

Markers can span streamed deltas. The parser buffers partial metadata, accepts only the cue whitelist, attaches cues to following spoken words, drops trailing cue-only content, and flushes once. Ordinary literal brackets remain intact. Malformed reserved metadata is discarded through its closing marker or newline with bounded buffering. Cancellation discards uncommitted text and metadata. These cues apply only to the Codex voice path; text-only replies request plain text.

Delivery cues precede the affected words; reactions appear where the sound belongs. Tag interpretation and scope remain voice/model dependent, so a user listening test is required. No voice settings or SSML were added, and no Eleven credits were spent testing these changes. The app sends the tags through the existing TTD `inputs[].text` field and continues streaming committed phrases with `flush`.

References: [v3/v4 audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-and-v4), [v4 prompting guidance](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4), and [realtime TTD](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd).

## Hands-free turn detection

The separate `bin/yap-live-continuous` helper emits stable segment IDs, draft/final revisions with audio-time ranges, and 100 ms RMS activity windows. It uses one microphone stream. The old `bin/yap-live` and local-only server can remain running independently; stop their microphone session before starting Codex capture.

A turn ends after about 950 ms of quiet with finalized stable words, or about 1.6 seconds of quiet with a stable provisional draft. Audio timestamps prevent an old final transcript from closing a new utterance. Draft commits may contain recognition errors; later revisions are not silently resent to the model. If a segment spans two turns, bounded word alignment extracts the new suffix while avoiding duplicate committed words. Major rewrites and unusual pauses remain heuristic cases; **Send turn** and **Interrupt & talk** are available as fallbacks.

Keep the page visible and use headphones. The red microphone-session indicator stays visible while thinking and speaking. The transcript shows the current turn, and the response shows the latest reply; conversational history stays in memory. No conversation is saved by this app.

Live acceptance still needed for this change: Start once, ask two related questions, interrupt during thinking and during playback, confirm follow-up context, then Stop and Start again. This update was checked with synthetic audio and mocked providers; it did not record or transmit user speech.

## Optional OpenRouter replies (disabled until approved)

The reply-provider selector in Codex conversation mode also supports **OpenRouter → Google AI Studio → `google/gemini-3.5-flash-lite`**. It reuses the same continuous local ASR, context, barge-in, clean display, expressive v4 parsing, and Eleven playback. Codex remains a manually selectable fallback; the app never silently switches providers after an error. The request pins Google AI Studio, excludes its Flex/Priority variants, disables provider fallback, requests low reasoning, and supplies no tools or plugins.

This integration has only mock/protocol/browser validation. **No paid OpenRouter call or latency benchmark has been run.** The current local voice launcher explicitly keeps OpenRouter off. Existing OpenRouter credits, an approved test budget, and private key entry are still required before activation. No account, API key, or purchase is created by this project.

After those decisions, run these commands yourself on the Mac from this project:

```sh
npm run setup:openrouter
```

Type `SETUP`, then enter an existing authorized OpenRouter key at the hidden terminal prompt. Never paste it into chat or the page. This writes a separate ignored `.env.openrouter` with mode 0600, refuses to overwrite it, leaves `.env.voice` untouched, and saves `OPENROUTER_ENABLED=0`. It makes no network request and does not activate billing.

Only after explicit paid-usage/budget approval, deliberately stop the current server when its microphone session is idle, then launch:

```sh
OPENROUTER_ENABLED=1 npm run openrouter:background
```

The normal process environment explicitly overrides the disabled value in the private file. This launcher loads the existing voice setup and separate OpenRouter setup, keeps Codex available, uses canonical port 4319, and refuses to replace a running server. Reload **http://localhost:4319/?mode=codex&voice=1&provider=openrouter**, choose the reply provider, and review the new consent before Start. Changing providers resets consent. `npm run voice:background` returns to Codex with OpenRouter disabled after the existing server has been stopped deliberately.

Transcript **and conversation history** go to OpenRouter and its pinned Google AI Studio endpoint. Generated speech text goes separately to ElevenLabs. Microphone audio stays on the Mac. Local cancellation closes the stream and clears audio, but OpenRouter currently lists Google/Google AI Studio as **not supporting upstream generation/billing cancellation**; a cancelled reply may still be billed in full. Limits include six attempted replies per Start, 512 generated tokens per request, bounded history/input/output bytes, and a 45-second request deadline. These are not a guaranteed monetary spending cap; agree on a budget and provider-side limits separately.

The official model page lists $0.30/M input tokens and $2.50/M output tokens at the time checked. These prices and provider availability can change, and published latency is not a guarantee of this app’s performance. Sources: [model and pricing](https://openrouter.ai/google/gemini-3.5-flash-lite), [streaming and cancellation](https://openrouter.ai/docs/api_reference/streaming), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), and [reasoning configuration](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

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

After setup, launch with `npm run dev` or `npm run build && npm start`. These commands read `.env`; the detached demo/local launchers deliberately do not. The browser requires disclosure/consent before Live voice starts. Use headphones. Conversation mode uses unmodified YAP final segments and an explicit **Send turn**, then **Talk** for another turn. **Interrupt & talk** aborts generation and clears queued playback. In this separate legacy direct-API path, automatic spoken barge-in is not implemented; capture pauses during generation/playback to avoid feedback. The Codex path above supports hands-free turns.

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

UI tests use installed Google Chrome via Playwright on separate localhost port 4318. Real microphone capture is blocked/mocked; paid keys are blank. Tests cover repeated start/stop, cancellation, missing setup, audio queue clearing, draft replacement without duplicates, responsive layout, and localhost restrictions. Native adapter tests use synthetic subprocess fixtures. Hands-free tests cover repeated turns, context after cancellation, short replies, delayed/revised transcripts, silence/noise, stale packets, matching playback acknowledgements, and Stop/disconnect cleanup.

`npm run test:continuous` exercises the new continuous helper with locally synthesized file input, asserting multiple segments, revisions, speech/silence activity, and one process. `npm run test:native` generates synthetic speech using macOS `say` and feeds it to the native engine at real-time pace. It uses no microphone or speaker playback. Generated audio and evidence remain ignored locally. Prior synthetic testing observed provisional output before the audio finished, followed by successful finalization. The user has also accepted the local live transcription behavior. Neither is a comprehensive accuracy benchmark.

## Implementation references

- [YAP 1.2.1 native capture](https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift) and [CC0 license](https://github.com/finnvoor/yap/blob/1.2.1/LICENSE).
- [Apple SpeechAnalyzer and volatile results](https://developer.apple.com/videos/play/wwdc2025/277/).
- [OpenAI response streaming](https://developers.openai.com/api/docs/guides/streaming-responses).
- [ElevenLabs realtime Text-to-Dialogue](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) and [TTS versus TTD protocols](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets).
