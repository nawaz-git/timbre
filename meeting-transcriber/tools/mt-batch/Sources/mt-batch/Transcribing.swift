@preconcurrency import AVFoundation
import FluidAudio
import Foundation
import MTPipelineCore
import WhisperKit

/// Engine choice surfaced on the CLI.
enum Engine: String, CaseIterable {
    case whisperkit
    case parakeet
}

/// Common transcription interface. Both engines below conform.
///
/// `Sendable` so a single instance can be handed to an `async let` running
/// concurrently with the diarizer. Conforming classes are init-once + read-
/// after-`loadModel()`, so the underlying CoreML inference is safe to share
/// — same pattern the main app uses for `DiarizationProvider`.
protocol Transcribing: Sendable {
    /// Load (and download on first run) the underlying model.
    func loadModel() async throws

    /// Transcribe a 16 kHz mono WAV file, emitting progress in 0…1 via
    /// `progressCallback` whenever a new chunk completes, and returning both
    /// the display segments and the per-word timeline (each word stamped with
    /// `source` so the dual-track pipeline can tell mic from app). `words` is
    /// empty when the engine can't emit reliable word timings, in which case
    /// the caller falls back to per-segment assignment. The callback is
    /// `@Sendable` because WhisperKit fires it from its internal task queue.
    func transcribeWords(
        audioPath: URL,
        source: WordTimeline.Track,
        progressCallback: @escaping @Sendable (Double) -> Void,
    ) async throws -> (segments: [TimedSegment], words: [WordTimeline.Word])
}

/// WhisperKit (Large-v3 Turbo by default) — CoreML/ANE, 99+ languages.
///
/// `@unchecked Sendable` because the internal `pipe` is set exactly once by
/// `loadModel()` and read by every subsequent `transcribeSegments` call.
/// WhisperKit's `transcribe` is its own actor, so post-load reads on the
/// same instance are safe across tasks. Matches the pattern the main app
/// uses for `FluidDiarizer`.
final class WhisperKitTranscriber: Transcribing, @unchecked Sendable {
    private let modelVariant: String
    private let language: String?
    private var pipe: WhisperKit?

    init(modelVariant: String = "openai_whisper-large-v3-v20240930_turbo", language: String? = nil) {
        self.modelVariant = modelVariant
        self.language = language
    }

    func loadModel() async throws {
        // Two-step load: explicit `download()` first so we can resolve the
        // model folder once and avoid WhisperKit re-resolving the
        // HuggingFace path inside the init. Matches the production
        // WhisperKitEngine pattern.
        let modelFolder = try await WhisperKit.download(variant: modelVariant)
        let config = WhisperKitConfig(model: modelVariant, modelFolder: modelFolder.path())
        pipe = try await WhisperKit(config)
    }

    func transcribeWords(
        audioPath: URL,
        source: WordTimeline.Track,
        progressCallback: @escaping @Sendable (Double) -> Void,
    ) async throws -> (segments: [TimedSegment], words: [WordTimeline.Word]) {
        guard let pipe else {
            throw TranscriberError.modelNotLoaded("WhisperKit not loaded")
        }

        // Estimate total 30 s windows so progress is monotonic.
        let totalWindows = max(1, Self.estimateWindowCount(audioPath: audioPath))

        // wordTimestamps: DTW over cross-attention → per-word spans for the
        // attribution core. The batch pipeline always wants them; the live
        // path (which this CLI doesn't have) is the only place they'd be off.
        let options = DecodingOptions(language: language, wordTimestamps: true)
        let results = await pipe.transcribe(
            audioPaths: [audioPath.path],
            decodeOptions: options,
        ) { progress in
            let frac = min(Double(progress.windowId + 1) / Double(totalWindows), 1.0)
            progressCallback(frac)
            return nil // continue
        }

        guard let firstResult = results.first, let transcriptionResults = firstResult else {
            return ([], [])
        }

        var segments: [TimedSegment] = []
        var words: [WordTimeline.Word] = []
        var lastText = ""
        for segment in transcriptionResults.flatMap(\.segments) {
            let cleaned = Self.stripWhisperTokens(segment.text).trimmingCharacters(in: .whitespaces)
            if cleaned.isEmpty || cleaned == lastText { continue } // hallucination filter
            lastText = cleaned
            segments.append(TimedSegment(
                start: TimeInterval(segment.start),
                end: TimeInterval(segment.end),
                text: cleaned,
            ))
            for wordTiming in segment.words ?? [] {
                let token = Self.stripWhisperTokens(wordTiming.word).trimmingCharacters(in: .whitespaces)
                guard !token.isEmpty else { continue }
                words.append(WordTimeline.Word(
                    start: TimeInterval(wordTiming.start),
                    end: TimeInterval(wordTiming.end),
                    text: token,
                    probability: wordTiming.probability,
                    source: source,
                ))
            }
        }
        progressCallback(1.0)
        return (segments, words)
    }

    /// Strip Whisper special tokens like `<|startoftranscript|>`, `<|en|>`,
    /// `<|0.00|>`. Mirrors `WhisperKitEngine.stripWhisperTokens`.
    static func stripWhisperTokens(_ text: String) -> String {
        text.replacingOccurrences(of: #"<\|[^|]*\|>"#, with: "", options: .regularExpression)
    }

    private static func estimateWindowCount(audioPath: URL) -> Int {
        guard let audioFile = try? AVAudioFile(forReading: audioPath) else { return 1 }
        let duration = Double(audioFile.length) / audioFile.fileFormat.sampleRate
        return Int(ceil(duration / 30.0))
    }
}

/// NVIDIA Parakeet TDT v3 via FluidAudio — CoreML/ANE, ~25 EU languages,
/// significantly faster than WhisperKit but with a smaller language set.
///
/// `@unchecked Sendable` for the same reason as `WhisperKitTranscriber`:
/// `asrManager` is init-once via `loadModel()`, and FluidAudio's CoreML
/// inference is thread-safe.
final class ParakeetTranscriber: Transcribing, @unchecked Sendable {
    private let languageHint: String?
    private var asrManager: AsrManager?

    init(language: String? = nil) {
        languageHint = language
    }

    func loadModel() async throws {
        let models = try await AsrModels.downloadAndLoad()
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        asrManager = manager
    }

    func transcribeWords(
        audioPath: URL,
        source: WordTimeline.Track,
        progressCallback: @escaping @Sendable (Double) -> Void,
    ) async throws -> (segments: [TimedSegment], words: [WordTimeline.Word]) {
        guard let asrManager else {
            throw TranscriberError.modelNotLoaded("Parakeet not loaded")
        }

        // Parakeet doesn't expose a streaming progress callback for the
        // batch transcribe entrypoint. Emit a single "starting" tick and
        // a final 1.0 so the parent UI still sees movement.
        progressCallback(0.05)
        var decoderState = await TdtDecoderState.make(decoderLayers: asrManager.decoderLayerCount)
        let resolvedLanguage = languageHint.flatMap { Language(rawValue: $0) }
        let result = try await asrManager.transcribe(
            audioPath,
            decoderState: &decoderState,
            language: resolvedLanguage,
        )
        progressCallback(1.0)

        // Without token timings, emit a single segment spanning the whole
        // file and no words (caller falls back to per-segment assignment).
        guard let timings = result.tokenTimings, !timings.isEmpty else {
            let text = result.text.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { return ([], []) }
            return ([TimedSegment(start: 0, end: result.duration, text: text)], [])
        }
        let segments = Self.groupTokenTimings(timings, fallbackEnd: result.duration)
        let words = Self.wordsFromTimings(timings, source: source)
        return (segments, words)
    }

    /// Detokenize FluidAudio Parakeet `TokenTiming`s into word-level
    /// `WordTimeline.Word`s. Maps FluidAudio's token type onto the shared
    /// `SubwordToken` and delegates the SentencePiece detokenization to
    /// `WordTimeline.words` — the same code path the app's Parakeet engine
    /// uses, so both pipelines detokenize identically.
    static func wordsFromTimings(_ timings: [TokenTiming], source: WordTimeline.Track) -> [WordTimeline.Word] {
        let tokens = timings.map {
            WordTimeline.SubwordToken(token: $0.token, start: $0.startTime, end: $0.endTime, confidence: $0.confidence)
        }
        return WordTimeline.words(fromTokens: tokens, source: source)
    }

    /// Group per-token timings into sentence-ish segments by pause length.
    /// Mirrors the spirit of `ParakeetTokenGrouping.groupIntoSegments` in
    /// the main app — a pause > 0.6 s starts a new segment.
    static func groupTokenTimings(_ timings: [TokenTiming], fallbackEnd: TimeInterval) -> [TimedSegment] {
        guard !timings.isEmpty else { return [] }
        let pauseThreshold: TimeInterval = 0.6

        var segments: [TimedSegment] = []
        var currentStart = TimeInterval(timings[0].startTime)
        var currentEnd = TimeInterval(timings[0].endTime)
        var currentTokens: [String] = [timings[0].token]

        for i in 1 ..< timings.count {
            let prevEnd = TimeInterval(timings[i - 1].endTime)
            let thisStart = TimeInterval(timings[i].startTime)
            let gap = thisStart - prevEnd
            if gap > pauseThreshold {
                segments.append(TimedSegment(
                    start: currentStart,
                    end: currentEnd,
                    text: joinTokens(currentTokens),
                ))
                currentStart = thisStart
                currentTokens = []
            }
            currentTokens.append(timings[i].token)
            currentEnd = TimeInterval(timings[i].endTime)
        }
        if !currentTokens.isEmpty {
            segments.append(TimedSegment(
                start: currentStart,
                end: max(currentEnd, fallbackEnd > 0 ? min(fallbackEnd, currentEnd + 0.5) : currentEnd),
                text: joinTokens(currentTokens),
            ))
        }
        return segments
    }

    /// Concatenate Parakeet tokens preserving leading-space convention.
    /// FluidAudio's Parakeet tokenizer emits SentencePiece-style tokens
    /// with leading spaces on word boundaries; a naive join would lose
    /// whitespace.
    private static func joinTokens(_ tokens: [String]) -> String {
        tokens.joined()
            .replacingOccurrences(of: " +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}

enum TranscriberError: Swift.Error, LocalizedError {
    case modelNotLoaded(String)

    var errorDescription: String? {
        switch self {
        case let .modelNotLoaded(detail): "Transcription model not loaded: \(detail)"
        }
    }
}
