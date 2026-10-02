// Project-local live-caption adapter, derived from finnvoor/yap 1.2.1 Dictate.swift.
// YAP is CC0-1.0. Original: https://github.com/finnvoor/yap/blob/1.2.1/Sources/yap/Dictate.swift
// Changes: no package dependencies; volatile results; NDJSON protocol; readiness/check mode.
import Foundation
@preconcurrency import AVFoundation
import Speech
import Darwin

private nonisolated(unsafe) var stopWriteFD: Int32 = -1
private let outputLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data + Data([10]))
}

enum LocalError: Error { case unavailable, unsupportedLocale, missingAssets, audioFormat, microphone }

@main
struct YapLive {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.contains("--help") {
            print("Voice Lab YAP-derived live captions: --locale en-US [--continuous] [--check | --input /path/to/synthetic.wav [--realtime]]. Default opens microphone only when invoked.")
            return
        }
        let localeID = args.firstIndex(of: "--locale").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "en-US"
        let continuous = args.contains("--continuous")
        do {
            guard SpeechTranscriber.isAvailable else { throw LocalError.unavailable }
            let locale = Locale(identifier: localeID)
            let supported = await SpeechTranscriber.supportedLocales
            guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else { throw LocalError.unsupportedLocale }
            let installed = await SpeechTranscriber.installedLocales
            guard installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else { throw LocalError.missingAssets }
            if args.contains("--check") {
                var available: [String: Any] = ["type": "available", "locale": localeID, "partials": true]
                if continuous { available["continuous"] = true }
                emit(available); return
            }
            let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            var capture: MicrophoneCapture?
            var signalReadFD: Int32 = -1
            var readyEmitted = false
            if let inputIndex = args.firstIndex(of: "--input"), inputIndex + 1 < args.count {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[inputIndex + 1]))
                guard file.length > 0 else { throw LocalError.audioFormat }
                if args.contains("--realtime") || continuous {
                    let (sequence, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
                          let converter = AVAudioConverter(from: file.processingFormat, to: format) else { throw LocalError.audioFormat }
                    try await analyzer.start(inputSequence: sequence)
                    if continuous { emit(["type": "ready", "continuous": true]); readyEmitted = true }
                    Task { @MainActor in
                        let activity = continuous ? AudioActivityMeter() : nil
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
                                activity?.consume(converted)
                                continuation.yield(AnalyzerInput(buffer: converted))
                                if args.contains("--realtime") { try await Task.sleep(for: .seconds(Double(buffer.frameLength) / file.processingFormat.sampleRate)) }
                            }
                            activity?.finish()
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
                capture = try MicrophoneCapture(targetFormat: format, inputContinuation: continuation, continuous: continuous)
                var pipeFDs: [Int32] = [0, 0]
                guard pipe(&pipeFDs) == 0 else { throw LocalError.audioFormat }
                signalReadFD = pipeFDs[0]
                stopWriteFD = pipeFDs[1]
                signal(SIGINT) { _ in _ = write(stopWriteFD, "x", 1) }
                // Install the shutdown handler before activating the microphone.
                try await analyzer.start(inputSequence: sequence)
                if continuous { emit(["type": "ready", "continuous": true]); readyEmitted = true }
                try capture?.start()
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
            if !readyEmitted { emit(["type": "ready"]) }
            var finalized = ""
            var draft = ""
            var segmentId = 1
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if continuous {
                    let startMs = result.range.start.seconds * 1000
                    let endMs = CMTimeRangeGetEnd(result.range).seconds * 1000
                    guard startMs.isFinite, endMs.isFinite, startMs >= 0, endMs >= startMs else { throw LocalError.audioFormat }
                    emit(["type": "transcript.segment", "id": segmentId, "text": text, "final": result.isFinal, "startMs": startMs, "endMs": endMs])
                    if result.isFinal { segmentId += 1 }
                } else {
                    if result.isFinal { finalized += text; draft = "" } else { draft = text }
                    // Snapshot replacement, never append successive volatile hypotheses.
                    emit(["type": "snapshot", "finalized": finalized, "draft": draft])
                }
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
    let activity: AudioActivityMeter?
    init(targetFormat: AVAudioFormat, inputContinuation: AsyncStream<AnalyzerInput>.Continuation, continuous: Bool = false) throws {
        self.targetFormat = targetFormat
        self.inputContinuation = inputContinuation
        activity = continuous ? AudioActivityMeter() : nil
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
        if error == nil, converted.frameLength > 0 {
            activity?.consume(converted)
            inputContinuation.yield(AnalyzerInput(buffer: converted))
        }
    }
}

// Bounded energy-only metadata on the same converted audio timeline as Speech.
// A window's timeMs is its end, and durationMs is its length. No samples leave the process.
final class AudioActivityMeter {
    private var frames: Int64 = 0
    private var windowFrames = 0
    private var squares = 0.0
    private var sampleRate = 0.0
    func consume(_ buffer: AVAudioPCMBuffer) {
        sampleRate = buffer.format.sampleRate
        let channels = Int(buffer.format.channelCount)
        guard sampleRate > 0, channels > 0 else { return }
        let windowSize = max(1, Int((sampleRate * 0.1).rounded()))
        let interleaved = buffer.format.isInterleaved
        for frame in 0..<Int(buffer.frameLength) {
            var energy = 0.0
            for channel in 0..<channels {
                let plane = interleaved ? 0 : channel
                let index = interleaved ? frame * channels + channel : frame
                let sample: Double
                if let data = buffer.floatChannelData { sample = Double(data[plane][index]) }
                else if let data = buffer.int16ChannelData { sample = Double(data[plane][index]) / 32768 }
                else if let data = buffer.int32ChannelData { sample = Double(data[plane][index]) / 2147483648 }
                else { return }
                if sample.isFinite { energy += min(1, sample * sample) }
            }
            squares += energy / Double(channels)
            frames += 1
            windowFrames += 1
            if windowFrames == windowSize { finish() }
        }
    }
    func finish() {
        guard windowFrames > 0 else { return }
        emit(["type": "audio.activity", "rms": sqrt(squares / Double(windowFrames)), "timeMs": Double(frames) / sampleRate * 1000, "durationMs": Double(windowFrames) / sampleRate * 1000])
        windowFrames = 0
        squares = 0
    }
}
