// Project-local live-caption adapter, derived from finnvoor/yap 1.2.1 Dictate.swift.
// YAP is CC0-1.0. Original: https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift
// Changes: no package dependencies; volatile results; NDJSON protocol; readiness/check mode.
import Foundation
@preconcurrency import AVFoundation
import Speech
import Darwin

private nonisolated(unsafe) var stopWriteFD: Int32 = -1

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

enum LocalError: Error { case unavailable, unsupportedLocale, missingAssets, audioFormat, microphone }

@main
struct YapLive {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.contains("--help") {
            print("Voice Lab YAP-derived live captions: --locale en-US [--check | --input /path/to/synthetic.wav]. Default opens microphone only when invoked.")
            return
        }
        let localeID = args.firstIndex(of: "--locale").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "en-US"
        do {
            guard SpeechTranscriber.isAvailable else { throw LocalError.unavailable }
            let locale = Locale(identifier: localeID)
            let supported = await SpeechTranscriber.supportedLocales
            guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else { throw LocalError.unsupportedLocale }
            let installed = await SpeechTranscriber.installedLocales
            guard installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else { throw LocalError.missingAssets }
            if args.contains("--check") { emit(["type": "available", "locale": localeID, "partials": true]); return }
            let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            var capture: MicrophoneCapture?
            var signalReadFD: Int32 = -1
            if let inputIndex = args.firstIndex(of: "--input"), inputIndex + 1 < args.count {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[inputIndex + 1]))
                guard file.length > 0 else { throw LocalError.audioFormat }
                if args.contains("--realtime") {
                    let (sequence, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
                          let converter = AVAudioConverter(from: file.processingFormat, to: format) else { throw LocalError.audioFormat }
                    try await analyzer.start(inputSequence: sequence)
                    Task { @MainActor in
                        do {
                            while file.framePosition < file.length {
                                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { throw LocalError.audioFormat }
                                try file.read(into: buffer)
                                let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / file.processingFormat.sampleRate))
                                guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw LocalError.audioFormat }
                                var conversionError: NSError?
                                nonisolated(unsafe) var consumed = false
                                nonisolated(unsafe) let source = buffer
                                converter.convert(to: converted, error: &conversionError) { _, status in
                                    if consumed { status.pointee = .noDataNow; return nil }
                                    consumed = true; status.pointee = .haveData; return source
                                }
                                if let conversionError { throw conversionError }
                                continuation.yield(AnalyzerInput(buffer: converted))
                                try await Task.sleep(for: .seconds(Double(buffer.frameLength) / file.processingFormat.sampleRate))
                            }
                            emit(["type": "input_complete"])
                            continuation.finish()
                            try await analyzer.finalizeAndFinishThroughEndOfInput()
                        } catch {
                            continuation.finish()
                            await analyzer.cancelAndFinishNow()
                        }
                    }
                } else {
                    try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
                }
            } else {
                let (sequence, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw LocalError.audioFormat }
                capture = try MicrophoneCapture(targetFormat: format, inputContinuation: continuation)
                var pipeFDs: [Int32] = [0, 0]
                guard pipe(&pipeFDs) == 0 else { throw LocalError.audioFormat }
                signalReadFD = pipeFDs[0]
                stopWriteFD = pipeFDs[1]
                signal(SIGINT) { _ in _ = write(stopWriteFD, "x", 1) }
                // Install the shutdown handler before activating the microphone.
                try capture?.start()
                try await analyzer.start(inputSequence: sequence)
                let readFD = signalReadFD
                let runningCapture = capture
                Task.detached {
                    var byte: UInt8 = 0
                    _ = read(readFD, &byte, 1)
                    close(readFD)
                    close(stopWriteFD)
                    runningCapture?.stop()
                    try? await analyzer.finalizeAndFinishThroughEndOfInput()
                }
            }
            emit(["type": "ready"])
            var finalized = ""
            var draft = ""
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal { finalized += text; draft = "" } else { draft = text }
                // Snapshot replacement, never append successive volatile hypotheses.
                emit(["type": "snapshot", "finalized": finalized, "draft": draft])
            }
            capture?.stop()
            emit(["type": "done", "text": finalized.trimmingCharacters(in: .whitespacesAndNewlines)])
        } catch {
            let code: String
            switch error {
            case LocalError.unavailable: code = "unavailable"
            case LocalError.unsupportedLocale: code = "unsupported_locale"
            case LocalError.missingAssets: code = "missing_assets"
            case LocalError.microphone: code = "microphone_permission"
            default: code = "recognition_failed"
            }
            emit(["type": "error", "code": code])
            exit(1)
        }
    }
}

// This capture/conversion path follows YAP's MicrophoneCapture (CC0-1.0).
final class MicrophoneCapture: @unchecked Sendable {
    let audioEngine: AVAudioEngine
    let converter: AVAudioConverter
    let inputContinuation: AsyncStream<AnalyzerInput>.Continuation
    let targetFormat: AVAudioFormat
    init(targetFormat: AVAudioFormat, inputContinuation: AsyncStream<AnalyzerInput>.Continuation) throws {
        self.targetFormat = targetFormat
        self.inputContinuation = inputContinuation
        audioEngine = AVAudioEngine()
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw LocalError.microphone }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else { throw LocalError.audioFormat }
        self.converter = converter
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { [self] buffer, _ in handleBuffer(buffer) }
    }
    func stop() { audioEngine.stop(); inputContinuation.finish() }
    func start() throws { do { try audioEngine.start() } catch { throw LocalError.microphone } }
    private func handleBuffer(_ buffer: AVAudioPCMBuffer) {
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * targetFormat.sampleRate / converter.inputFormat.sampleRate))
        guard capacity > 0, let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        nonisolated(unsafe) var consumed = false
        nonisolated(unsafe) let source = buffer
        converter.convert(to: converted, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true; status.pointee = .haveData; return source
        }
        if error == nil, converted.frameLength > 0 { inputContinuation.yield(AnalyzerInput(buffer: converted)) }
    }
}
