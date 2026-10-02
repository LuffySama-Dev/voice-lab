The native microphone capture/conversion and lifecycle structure in YapLive.swift are adapted from finnvoor/yap 1.2.1, licensed CC0-1.0:
https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift
https://github.com/finnvoor/yap/blob/1.2.1/LICENSE

The unmodified upstream license is included in LICENSE-YAP-CC0.txt. The root MIT license applies to original project contributions and does not replace the upstream CC0 dedication.

This project-local executable is a modified adapter, not an official YAP release. It uses the same Apple on-device SpeechTranscriber engine, enabling volatile results and emitting draft/final snapshots. It does not replace the Homebrew YAP installation. Apple's Speech framework and models are proprietary.
