The native microphone capture/conversion and lifecycle structure in YapLive.swift are adapted from finnvoor/yap 1.2.1, licensed CC0-1.0:
https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift
https://github.com/finnvoor/yap/blob/1.2.1/LICENSE

This project-local executable is a modified adapter, not an official YAP release. It uses the same Apple on-device SpeechTranscriber engine, enabling volatile results and emitting draft/final snapshots. It does not replace the Homebrew YAP installation. Apple's Speech framework and models are proprietary.
