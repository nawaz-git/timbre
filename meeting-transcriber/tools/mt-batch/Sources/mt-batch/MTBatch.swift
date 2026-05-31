import ArgumentParser
import Foundation

/// Headless batch transcription + speaker diarization CLI.
///
/// Reads an audio file off disk, runs the chosen ASR engine (default
/// WhisperKit Large-v3 Turbo) plus FluidAudio's offline (clustering)
/// diarizer, merges the timelines into per-segment `{speaker, start, end,
/// text}` records, and writes everything to a caller-named output dir.
///
/// Designed as a pure subprocess — no AppKit / NSApplication, no menu bar,
/// no TCC interaction. Stdout carries one JSON object per line so an
/// Electron parent can stream progress; stderr carries human-readable
/// diagnostics. Exit code is 0 on success, non-zero on any failure.
///
/// The CLI exposes two subcommands behind one binary:
///   * `transcribe` (the default) — the full pipeline above.
///   * `list-speakers` — quickly dump enrolled names from a global DB
///     without loading any models.
///
/// `defaultSubcommand: Transcribe.self` preserves the original flat CLI:
/// `mt-batch --input … --output-dir …` is still parsed as a transcribe run
/// for backward compatibility with the Electron driver and earlier scripts.
@main
struct MTBatch: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mt-batch",
        abstract: "Headless batch transcription + speaker diarization.",
        version: "0.1.0",
        subcommands: [Transcribe.self, ListSpeakers.self],
        defaultSubcommand: Transcribe.self,
    )
}

/// Default subcommand — runs the full ASR + diarization pipeline.
/// Arguments are unchanged from the pre-subcommand CLI; new flags below
/// (`--global-db`, `--match-threshold`, `--match-margin`) are additive.
struct Transcribe: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "transcribe",
        abstract: "Run transcription + diarization on an audio file.",
    )

    @Option(name: .long, help: "Path to the input audio (or video) file.")
    var input: String

    @Option(name: .long, help: "Path to a folder where outputs will be written. Created if missing.")
    var outputDir: String

    @Option(
        name: .long,
        help: "ASR engine: whisperkit (default, 99+ langs, ~1 GB model) or parakeet (25 EU langs, ~50 MB model).",
    )
    var engine: String = Engine.whisperkit.rawValue

    @Option(
        name: .long,
        help: "Optional language hint (ISO 639-1, e.g. en, de, es). Omit to auto-detect.",
    )
    var language: String?

    @Option(
        name: .long,
        help: "Optional WhisperKit model variant override (e.g. openai_whisper-small). Defaults to large-v3 turbo.",
    )
    var whisperModel: String?

    @Option(
        name: .long,
        help: "Diarization cluster threshold (lower = more speakers, default 0.6). Tighten to 0.5 if distinct voices keep merging.",
    )
    var clusterThreshold: Double = 0.6

    @Option(
        name: .long,
        help: "Optional fixed speaker count (1-10). Omit to let the clusterer auto-detect.",
    )
    var numSpeakers: Int?

    @Option(
        name: .long,
        // swiftlint:disable:next line_length
        help: "Optional path to a global speakers.json. Diarized clusters are matched against enrolled centroids; matches above --match-threshold (with --match-margin gap) auto-name 'Speaker N' to the enrolled name. Read-only — mt-batch never writes back. Missing file = empty DB.",
    )
    var globalDb: String?

    @Option(
        name: .long,
        help: "Cosine-similarity threshold for auto-naming (default 0.70). Same voice + model typically scores 0.95+.",
    )
    var matchThreshold: Float = GlobalSpeakerDB.defaultMatchThreshold

    @Option(
        name: .long,
        // swiftlint:disable:next line_length
        help: "Required gap between top-1 and top-2 enrolled similarity scores (default 0.05). Prevents flip-flopping when two enrolled voices are both borderline.",
    )
    var matchMargin: Float = GlobalSpeakerDB.defaultMatchMargin

    func run() async throws {
        let inputURL = URL(fileURLWithPath: PathHelpers.expandTilde(input))
        let outputURL = URL(fileURLWithPath: PathHelpers.expandTilde(outputDir))

        do {
            try await runPipeline(inputURL: inputURL, outputURL: outputURL)
        } catch {
            Events.error(error.localizedDescription)
            Log.err(error.localizedDescription)
            throw ExitCode.failure
        }
    }

    // MARK: - Pipeline

    private func runPipeline(inputURL: URL, outputURL: URL) async throws {
        guard FileManager.default.fileExists(atPath: inputURL.path) else {
            throw CLIError.inputNotFound(inputURL.path)
        }
        guard let engineChoice = Engine(rawValue: engine.lowercased()) else {
            throw CLIError.invalidEngine(engine)
        }
        try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
        let runStart = Date()

        // Load the global DB up-front so a malformed file fails fast instead
        // of after a 5-min transcription. The loader logs + returns [] on
        // parse failure, so the pipeline still produces a transcript.
        let enrolled = loadEnrolledSpeakers()
        let prepared = try await prepareAudio(inputURL: inputURL, outputURL: outputURL)
        let (transcriber, diarizer) = try await loadModels(engineChoice: engineChoice)
        let (transcript, diarization) = try await runEngines(
            transcriber: transcriber,
            diarizer: diarizer,
            audioURL: prepared.audioURL,
        )
        try persistResults(
            transcript: transcript,
            diarization: diarization,
            duration: prepared.duration,
            outputURL: outputURL,
            enrolled: enrolled,
        )

        let total = Date().timeIntervalSince(runStart)
        Log.info("Done in \(PathHelpers.formatDuration(total)) — output: \(outputURL.path)")
        Events.done(outputDir: outputURL.path)
    }

    /// Load the global DB if `--global-db` was passed. nil return means
    /// the user opted out; an empty array means the file was missing or
    /// malformed (matcher still runs, finds no candidates, emits an empty
    /// `matched_speakers` event so the UI knows matching was attempted).
    private func loadEnrolledSpeakers() -> [StoredSpeakerEntry]? { // swiftlint:disable:this discouraged_optional_collection
        guard let globalDbPath = globalDb else { return nil }
        let url = URL(fileURLWithPath: PathHelpers.expandTilde(globalDbPath))
        let entries = GlobalSpeakerDB.load(from: url)
        Log.info("Loaded global speakers DB: \(entries.count) enrolled speaker(s) at \(url.path)")
        return entries
    }

    /// Stage 1: load the input file, resample to 16 kHz mono, write `audio.wav`.
    private struct PreparedAudio {
        let audioURL: URL
        let duration: TimeInterval
    }

    private func prepareAudio(inputURL: URL, outputURL: URL) async throws -> PreparedAudio {
        Events.loadingAudio()
        Log.info("Loading audio: \(inputURL.lastPathComponent)")
        let (rawSamples, sourceRate) = try await AudioLoader.loadAsFloat32(url: inputURL)
        let samples16k: [Float] = if sourceRate == AudioLoader.targetSampleRate {
            rawSamples
        } else {
            AudioLoader.resample(rawSamples, from: sourceRate, to: AudioLoader.targetSampleRate)
        }
        let duration = Double(samples16k.count) / Double(AudioLoader.targetSampleRate)
        Log.info("Loaded \(samples16k.count) samples (\(PathHelpers.formatDuration(duration)) @ 16 kHz mono)")
        let audioWAVURL = outputURL.appendingPathComponent("audio.wav")
        try AudioLoader.saveWAV(
            samples: samples16k, sampleRate: AudioLoader.targetSampleRate, url: audioWAVURL,
        )
        Log.info("Wrote 16 kHz mono WAV: \(audioWAVURL.lastPathComponent)")
        return PreparedAudio(audioURL: audioWAVURL, duration: duration)
    }

    /// Stage 2: load ASR + diarizer models. Sequential because both can hit
    /// HuggingFace on first run; parallel would double peak memory during
    /// CoreML compilation on smaller hardware.
    private func loadModels(engineChoice: Engine) async throws -> (any Transcribing, DiarizerWrapper) {
        Events.loadingModels()
        let transcriber: any Transcribing
        switch engineChoice {
        case .whisperkit:
            let variant = whisperModel ?? "openai_whisper-large-v3-v20240930_turbo"
            Log.info("Loading WhisperKit model: \(variant) (language=\(language ?? "auto"))")
            transcriber = WhisperKitTranscriber(modelVariant: variant, language: language)

        case .parakeet:
            Log.info("Loading Parakeet TDT v3 model (language=\(language ?? "auto"))")
            transcriber = ParakeetTranscriber(language: language)
        }
        try await transcriber.loadModel()
        Log.info("Transcription model ready")
        let diarizer = DiarizerWrapper(
            clusterThreshold: clusterThreshold,
            numSpeakers: numSpeakers,
        )
        try await diarizer.loadModel()
        Log.info(
            "Diarizer model ready (clusterThreshold=\(clusterThreshold), " +
                "numSpeakers=\(numSpeakers.map(String.init) ?? "auto"))",
        )
        return (transcriber, diarizer)
    }

    /// Stage 3: run ASR + diarization concurrently. FluidAudio's CoreML
    /// inference is documented thread-safe and WhisperKit holds its own
    /// actor, so the two stages overlap by roughly the shorter stage's
    /// duration on M-series.
    private func runEngines(
        transcriber: any Transcribing,
        diarizer: DiarizerWrapper,
        audioURL: URL,
    ) async throws -> (transcript: [TimedSegment], diarization: DiarizationOutput) {
        let transcribeStart = Date()
        // Coalesce progress callbacks to one event per 1 %-point change so
        // the JSONL stream isn't dominated by identical-progress lines.
        // WhisperKit fires its callback once per chunk *attempt*; on
        // Large-v3 Turbo most files complete in a single 30 s window and
        // the callback returns the same fraction many times.
        let progressBox = ProgressBox()
        async let transcriptTask: [TimedSegment] = transcriber.transcribeSegments(
            audioPath: audioURL,
        ) { fraction in
            if progressBox.shouldEmit(fraction) {
                Events.transcribing(progress: fraction)
            }
        }
        Events.diarizing()
        async let diarizationTask = diarizer.diarize(audioPath: audioURL)
        let transcript = try await transcriptTask
        Log.info(
            "Transcription complete: \(transcript.count) segments in " +
                "\(PathHelpers.formatDuration(Date().timeIntervalSince(transcribeStart)))",
        )
        let diarization = try await diarizationTask
        Log.info(
            "Diarization complete: \(diarization.segments.count) segments, " +
                "\(diarization.speakingTimes.count) speakers",
        )
        return (transcript, diarization)
    }

    /// Stage 4: merge transcript + diarization timelines, optionally apply
    /// global-DB name overrides, and write all outputs (`transcript.txt`,
    /// `transcript.json`, `speakers.json`).
    private func persistResults(
        transcript: [TimedSegment],
        diarization: DiarizationOutput,
        duration: TimeInterval,
        outputURL: URL,
        enrolled: [StoredSpeakerEntry]?, // swiftlint:disable:this discouraged_optional_collection
    ) throws {
        Events.merging()

        // Global-DB matching happens *before* we rewrite the transcript so
        // the entire JSON + text pipeline downstream operates on the final
        // human-readable speaker names. nameOverrides is empty when no
        // enrolled DB was provided OR when nothing matched — both paths
        // safely no-op through the merger.
        let (nameOverrides, matchResults) = matchEnrolledSpeakers(
            diarization: diarization,
            enrolled: enrolled,
        )

        if let matchResults {
            Events.matchedSpeakers(matchResults)
            logMatchSummary(matchResults)
        }

        let labeled = Merger.mergeTranscriptWithDiarization(
            transcript: transcript,
            diarization: diarization.segments,
            nameOverrides: nameOverrides,
        )
        try writeTranscriptText(labeled, to: outputURL.appendingPathComponent("transcript.txt"))
        let speakerCount = Set(labeled.map(\.speaker).filter { !$0.isEmpty }).count
        try writeTranscriptJSON(
            labeled,
            speakerCount: speakerCount,
            duration: duration,
            generatedAt: Date(),
            to: outputURL.appendingPathComponent("transcript.json"),
        )
        try persistSpeakerDB(
            embeddings: diarization.embeddings,
            speakingTimes: diarization.speakingTimes,
            nameOverrides: nameOverrides,
            outputDir: outputURL,
        )
    }

    /// Run the cluster-vs-enrolled match if an enrolled DB was provided.
    /// Returns `(nameOverrides, matchResults)`:
    ///   * `nameOverrides` maps `"Speaker N"` → `"Alice"` for confirmed
    ///     matches. The merger applies it directly to segment labels and we
    ///     reuse it when rewriting the per-meeting `speakers.json`.
    ///   * `matchResults` is the structured per-label outcome used by the
    ///     `matched_speakers` event. nil when matching wasn't requested at
    ///     all (so we don't emit a misleading empty event).
    private func matchEnrolledSpeakers(
        diarization: DiarizationOutput,
        enrolled: [StoredSpeakerEntry]?, // swiftlint:disable:this discouraged_optional_collection
    ) -> (
        overrides: [String: String],
        // swiftlint:disable:next discouraged_optional_collection
        results: [GlobalSpeakerDB.MatchResult]?,
    ) {
        guard let enrolled else { return ([:], nil) }
        let results = GlobalSpeakerDB.match(
            detectedCentroids: diarization.embeddings,
            enrolled: enrolled,
            threshold: matchThreshold,
            margin: matchMargin,
        )
        var overrides: [String: String] = [:]
        for result in results {
            if let name = result.enrolledName {
                overrides[result.detectedLabel] = name
            }
        }
        return (overrides, results)
    }

    /// One-line summary on stderr so a human watching the run sees the
    /// match outcome alongside the JSONL stream. Skipped when no enrolled
    /// DB was supplied (no decisions to report).
    private func logMatchSummary(_ results: [GlobalSpeakerDB.MatchResult]) {
        if results.isEmpty {
            Log.info("Global DB matching: no detected speakers to match")
            return
        }
        let lines = results.map { r -> String in
            let simStr = r.bestSimilarity.map { String(format: "%.3f", $0) } ?? "-"
            let assigned = r.enrolledName ?? "(no match)"
            return "  \(r.detectedLabel) → \(assigned) (similarity=\(simStr))"
        }
        Log.info("Global DB matching:\n\(lines.joined(separator: "\n"))")
    }

    // MARK: - Output writers

    private func writeTranscriptText(_ segments: [TimedSegment], to url: URL) throws {
        let body = segments.map(\.transcriptLine).joined(separator: "\n") + "\n"
        try body.write(to: url, atomically: true, encoding: .utf8)
    }

    private func writeTranscriptJSON(
        _ segments: [TimedSegment],
        speakerCount: Int,
        duration: TimeInterval,
        generatedAt: Date,
        to url: URL,
    ) throws {
        struct Payload: Codable {
            let segments: [TimedSegment]
            let speakerCount: Int
            let duration: TimeInterval
            let generatedAt: Date
        }
        let payload = Payload(
            segments: segments,
            speakerCount: speakerCount,
            duration: duration,
            generatedAt: generatedAt,
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(payload)
        try data.write(to: url, options: .atomic)
    }

    /// Persist the per-meeting `speakers.json` with the *final* names — when
    /// matching renamed "Speaker 1" → "Alice", the local entry is keyed by
    /// "Alice" too, so a follow-up consumer (e.g. the Electron app folding
    /// this run's data back into the global DB) doesn't need a separate
    /// rename step.
    ///
    /// The centroid still comes from THIS meeting's diarization, not the
    /// merged global centroid — global-DB writes happen exclusively from
    /// the Electron parent, so we never mix the two anchors implicitly.
    private func persistSpeakerDB(
        embeddings: [String: [Float]],
        speakingTimes: [String: TimeInterval],
        nameOverrides: [String: String],
        outputDir: URL,
    ) throws {
        let dbURL = outputDir.appendingPathComponent("speakers.json")
        let existing = SpeakerDB.load(from: dbURL)
        let renamedEmbeddings = renameKeys(embeddings, with: nameOverrides)
        let renamedSpeakingTimes = renameKeys(speakingTimes, with: nameOverrides)
        let next = SpeakerDB.apply(
            existing: existing,
            embeddings: renamedEmbeddings,
            speakingTimes: renamedSpeakingTimes,
        )
        try SpeakerDB.save(next, to: dbURL)
    }

    /// Rebuild a `[label: V]` dictionary with override-applied keys. Falls
    /// back to the original label when no override exists, so unmatched
    /// clusters keep their "Speaker N" identity.
    private func renameKeys<V>(_ dict: [String: V], with overrides: [String: String]) -> [String: V] {
        var renamed: [String: V] = [:]
        for (key, value) in dict {
            renamed[overrides[key] ?? key] = value
        }
        return renamed
    }
}

/// `list-speakers` subcommand — prints one JSON line per enrolled speaker in
/// the global DB. Used by the Electron UI to render the "known voices" picker
/// without spinning up the full ASR + diarization pipeline. Quiet success on
/// an empty / missing DB: prints nothing and exits 0. Schema is intentionally
/// minimal (name, useCount, centroidSampleCount, lastUsed) — we deliberately
/// don't expose centroids on stdout so a misconfigured shell redirection
/// can't dump 256-float vectors per speaker into a log file.
struct ListSpeakers: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list-speakers",
        abstract: "List enrolled speakers from a global speakers.json. One JSON object per line.",
    )

    @Option(name: .long, help: "Path to the global speakers.json file.")
    var globalDb: String

    func run() {
        let url = URL(fileURLWithPath: PathHelpers.expandTilde(globalDb))
        let entries = GlobalSpeakerDB.load(from: url)
        for entry in entries {
            var json: [String: Any] = [
                "name": entry.name,
                "useCount": entry.useCount,
                "centroidSampleCount": entry.centroidSampleCount,
            ]
            if let lastUsed = entry.lastUsed {
                json["lastUsed"] = lastUsed.timeIntervalSince1970
            } else {
                json["lastUsed"] = NSNull()
            }
            guard let data = try? JSONSerialization.data(
                withJSONObject: json,
                options: [.sortedKeys],
            ) else {
                continue
            }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
    }
}

enum CLIError: Swift.Error, LocalizedError {
    case inputNotFound(String)
    case invalidEngine(String)

    var errorDescription: String? {
        switch self {
        case let .inputNotFound(path):
            "Input file not found: \(path)"

        case let .invalidEngine(value):
            "Unknown engine '\(value)'. Use 'whisperkit' or 'parakeet'."
        }
    }
}

/// Coalesces progress callbacks so identical-fraction calls don't spam
/// stdout. Reference type so the `@Sendable` progress closure can mutate
/// shared state across the WhisperKit task pool. NSLock keeps the
/// read-modify-write tight; the closure is hot (called many times per
/// transcription) but lock contention is trivial vs. CoreML inference.
final class ProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var lastEmitted: Double = -1

    /// Emit when the value moved by >= 1 percentage point, or when we
    /// reach the terminal 1.0 (so the JSONL consumer always sees a final
    /// 100 % event).
    func shouldEmit(_ value: Double) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if value >= 1.0, lastEmitted < 1.0 {
            lastEmitted = value
            return true
        }
        if value - lastEmitted >= 0.01 {
            lastEmitted = value
            return true
        }
        return false
    }
}

/// Small helpers shared between subcommands. Extracted here because both
/// `Transcribe` and `ListSpeakers` need path expansion, and `Transcribe`
/// also needs the duration formatter that used to live as a private method
/// on the original flat command.
enum PathHelpers {
    /// Expand a leading `~/` to the current user's home directory. Swift's
    /// `URL(fileURLWithPath:)` doesn't expand tildes; doing it here keeps
    /// the CLI usable from shells that don't expand quoted paths.
    static func expandTilde(_ path: String) -> String {
        guard path.hasPrefix("~") else { return path }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == "~" { return home }
        if path.hasPrefix("~/") {
            return home + String(path.dropFirst(1))
        }
        return path
    }

    static func formatDuration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded()))
        if s >= 60 {
            return String(format: "%dm %02ds", s / 60, s % 60)
        }
        return String(format: "%ds", s)
    }
}
