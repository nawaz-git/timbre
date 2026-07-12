import ArgumentParser
import Foundation
import MTPipelineCore

/// Processing tier requested on the CLI. `max` is accepted now so the flag and
/// its plumbing exist; the accuracy-refinement passes it will drive land later.
enum ProcessingMode: String {
    case fast
    case max
}

/// Dual-source import: reconstruct the per-track prior a live recording has
/// (app track = remote speakers, mic track = the known local speaker) from two
/// separate audio files, then run the same word-level attribution the live
/// pipeline uses via the shared `MTPipelineCore`.
extension Transcribe {
    /// ArgumentParser validation — enforce the `--input` XOR `--input-app`/
    /// `--input-mic` contract and a known `--mode` before any model loads.
    func validate() throws {
        let hasSingle = input != nil
        let hasApp = inputApp != nil
        let hasMic = inputMic != nil
        if hasApp != hasMic {
            throw ValidationError("--input-app and --input-mic must be provided together.")
        }
        let hasPair = hasApp // == hasMic here
        if hasSingle == hasPair {
            throw ValidationError("Provide either --input or the --input-app/--input-mic pair (exactly one).")
        }
        if ProcessingMode(rawValue: mode.lowercased()) == nil {
            throw ValidationError("Unknown --mode '\(mode)'. Use 'fast' or 'max'.")
        }
    }

    /// Prepared per-track audio: the 16 kHz WAV written for the models plus the
    /// in-memory samples kept for cross-track RMS comparison.
    private struct PreparedTrack {
        let audioURL: URL
        let samples: [Float]
        let duration: TimeInterval
    }

    /// ASR + diarization output for the pair. `appDiar` is always produced;
    /// `micDiar` only in shared-room mode (empty `--mic-name`).
    private struct DualTrackEngineOutput {
        let appSegments: [TimedSegment]
        let appWords: [WordTimeline.Word]
        let micSegments: [TimedSegment]
        let micWords: [WordTimeline.Word]
        let appDiar: DiarizationOutput
        let micDiar: DiarizationOutput? // swiftlint:disable:this discouraged_optional_collection
    }

    /// Full dual-source pipeline: prepare both tracks, transcribe + diarize,
    /// attribute per word across the two tracks, dedup app-audio bleed, and
    /// write the same `transcript.txt` / `transcript.json` / `speakers.json`
    /// outputs the single-source path produces.
    func runDualTrackPipeline(appURL: URL, micURL: URL, outputURL: URL) async throws {
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            throw CLIError.inputNotFound(appURL.path)
        }
        guard FileManager.default.fileExists(atPath: micURL.path) else {
            throw CLIError.inputNotFound(micURL.path)
        }
        guard let engineChoice = Engine(rawValue: engine.lowercased()) else {
            throw CLIError.invalidEngine(engine)
        }
        try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
        let runStart = Date()

        if ProcessingMode(rawValue: mode.lowercased()) == .max {
            Log.warn(
                "mode=max requested — MAX accuracy-refinement passes are not available yet; " +
                    "producing the fast dual-track result.",
            )
        }

        let enrolled = loadEnrolledSpeakers()
        let appTrack = try await prepareTrack(url: appURL, outputURL: outputURL, basename: "app_16k")
        let micTrack = try await prepareTrack(url: micURL, outputURL: outputURL, basename: "mic_16k")
        let (transcriber, diarizer) = try await loadModels(engineChoice: engineChoice)

        let engines = try await runDualTrackEngines(
            transcriber: transcriber,
            diarizer: diarizer,
            appAudio: appTrack.audioURL,
            micAudio: micTrack.audioURL,
            diarizeMic: micName.isEmpty,
        )

        // Only the app (remote) track is matched against the enrolled DB — the
        // local speaker's identity is known (`--mic-name`).
        Events.merging()
        let (nameOverrides, matchResults) = matchEnrolledSpeakers(diarization: engines.appDiar, enrolled: enrolled)
        if let matchResults {
            Events.matchedSpeakers(matchResults)
            logMatchSummary(matchResults)
        }

        let labeled = attributeDualTrack(engines: engines, appTrack: appTrack, micTrack: micTrack, nameOverrides: nameOverrides)

        try writeTranscriptText(labeled, to: outputURL.appendingPathComponent("transcript.txt"))
        let speakerCount = Set(labeled.map(\.speaker).filter { !$0.isEmpty }).count
        try writeTranscriptJSON(
            labeled,
            speakerCount: speakerCount,
            duration: max(appTrack.duration, micTrack.duration),
            generatedAt: Date(),
            to: outputURL.appendingPathComponent("transcript.json"),
        )
        try persistSpeakerDB(
            embeddings: engines.appDiar.embeddings,
            speakingTimes: engines.appDiar.speakingTimes,
            nameOverrides: nameOverrides,
            outputDir: outputURL,
        )

        let total = Date().timeIntervalSince(runStart)
        Log.info("Done in \(PathHelpers.formatDuration(total)) — output: \(outputURL.path)")
        Events.done(outputDir: outputURL.path)
    }

    // MARK: - Stages

    private func prepareTrack(url: URL, outputURL: URL, basename: String) async throws -> PreparedTrack {
        Events.loadingAudio()
        Log.info("Loading audio: \(url.lastPathComponent)")
        let (raw, sourceRate) = try await AudioLoader.loadAsFloat32(url: url)
        let samples16k: [Float] = sourceRate == AudioLoader.targetSampleRate
            ? raw
            : AudioLoader.resample(raw, from: sourceRate, to: AudioLoader.targetSampleRate)
        let duration = Double(samples16k.count) / Double(AudioLoader.targetSampleRate)
        let wavURL = outputURL.appendingPathComponent("\(basename).wav")
        try AudioLoader.saveWAV(samples: samples16k, sampleRate: AudioLoader.targetSampleRate, url: wavURL)
        Log.info("Prepared \(basename): \(PathHelpers.formatDuration(duration)) @ 16 kHz mono")
        return PreparedTrack(audioURL: wavURL, samples: samples16k, duration: duration)
    }

    private func runDualTrackEngines(
        transcriber: any Transcribing,
        diarizer: DiarizerWrapper,
        appAudio: URL,
        micAudio: URL,
        diarizeMic: Bool,
    ) async throws -> DualTrackEngineOutput {
        // Diarize the app track concurrently with transcription (different
        // instances, FluidAudio is thread-safe). Transcription itself runs
        // sequentially per track — WhisperKit serializes on its own actor and
        // the live pipeline does the same to bound peak memory.
        async let appDiarTask = diarizer.diarize(audioPath: appAudio)
        Events.diarizing()

        let progressBox = ProgressBox()
        let (appSegments, appWords) = try await transcriber.transcribeWords(
            audioPath: appAudio, source: .app,
        ) { fraction in
            if progressBox.shouldEmit(fraction) { Events.transcribing(progress: fraction) }
        }
        let (micSegments, micWords) = try await transcriber.transcribeWords(
            audioPath: micAudio, source: .mic,
        ) { _ in }

        let appDiar = try await appDiarTask
        var micDiar: DiarizationOutput?
        if diarizeMic {
            micDiar = try await diarizer.diarize(audioPath: micAudio)
        }
        Log.info(
            "Dual-track engines done: app \(appWords.count) words / \(appDiar.segments.count) turns, " +
                "mic \(micWords.count) words" + (micDiar.map { " / \($0.segments.count) turns" } ?? ""),
        )
        return DualTrackEngineOutput(
            appSegments: appSegments, appWords: appWords,
            micSegments: micSegments, micWords: micWords,
            appDiar: appDiar, micDiar: micDiar,
        )
    }

    // MARK: - Attribution

    private func attributeDualTrack(
        engines: DualTrackEngineOutput,
        appTrack: PreparedTrack,
        micTrack: PreparedTrack,
        nameOverrides: [String: String],
    ) -> [TimedSegment] {
        let micLabel = micName.isEmpty ? "Me" : micName

        // No word timings on the app track (e.g. Parakeet returning only a
        // whole-file segment) — fall back to per-segment dual assignment so the
        // remote speech isn't dropped by the word-level path.
        guard !engines.appWords.isEmpty else {
            return labelDualSegmentsFallback(engines: engines, micLabel: micLabel, nameOverrides: nameOverrides)
        }

        let rate = AudioLoader.targetSampleRate
        let result = DualTrackAttribution.attribute(
            appWords: engines.appWords,
            micWords: engines.micWords,
            appTurns: engines.appDiar.segments.map(Self.speakerSegment),
            micTurns: engines.micDiar?.segments.map(Self.speakerSegment),
            appNames: nameOverrides,
            micNames: [:],
            micLabel: micLabel,
            micDelay: micDelay,
            // Mic utterances live on the micDelay-shifted timeline; un-shift to
            // measure loudness on the native mic samples.
            micRMS: Self.rmsProvider(samples: micTrack.samples, sampleRate: rate, shift: -micDelay),
            appRMS: Self.rmsProvider(samples: appTrack.samples, sampleRate: rate, shift: 0),
        )
        if result.droppedCount > 0 {
            Log.info(
                "Cross-track echo dedup: dropped \(result.droppedCount)/\(result.micCount) " +
                    "mic utterance(s) as app-audio bleed",
            )
        }
        return result.kept.map(TimedSegment.init)
    }

    /// Segment-level dual assignment used when the engine emitted no app-track
    /// word timings. Mirrors the live pipeline's pre-word behaviour.
    private func labelDualSegmentsFallback(
        engines: DualTrackEngineOutput,
        micLabel: String,
        nameOverrides: [String: String],
    ) -> [TimedSegment] {
        let appLabeled = Merger.assignSpeakers(
            transcript: engines.appSegments,
            diarization: engines.appDiar.segments,
            nameOverrides: nameOverrides,
        )
        let shiftedMic = micDelay == 0 ? engines.micSegments : engines.micSegments.map {
            TimedSegment(start: $0.start + micDelay, end: $0.end + micDelay, text: $0.text, speaker: $0.speaker)
        }
        let micLabeled: [TimedSegment]
        if let micDiar = engines.micDiar {
            micLabeled = Merger.assignSpeakers(transcript: shiftedMic, diarization: micDiar.segments)
        } else {
            micLabeled = shiftedMic.map { seg in
                var s = seg
                s.speaker = micLabel
                return s
            }
        }
        let combined = (appLabeled + micLabeled).sorted { $0.start < $1.start }
        return Merger.mergeConsecutiveSpeakers(combined)
    }

    // MARK: - Helpers

    private static func speakerSegment(_ seg: DiarizationOutput.Segment) -> SpeakerSegment {
        SpeakerSegment(start: seg.start, end: seg.end, speaker: seg.speaker)
    }

    /// RMS-over-window provider for `CrossTrackDedup`, reading the track's
    /// in-memory samples. `shift` maps an utterance's (possibly mic-delay
    /// shifted) timeline back onto the native samples.
    private static func rmsProvider(
        samples: [Float],
        sampleRate: Int,
        shift: TimeInterval,
    ) -> CrossTrackDedup.RMSProvider {
        { seg in
            let lo = max(0, Int((seg.start + shift) * Double(sampleRate)))
            let hi = min(samples.count, Int((seg.end + shift) * Double(sampleRate)))
            guard lo < hi else { return nil }
            return rmsDBFS(Array(samples[lo ..< hi]))
        }
    }

    /// RMS in dBFS for a Float32 PCM slice. Mirrors `AudioMixer.rmsDecibels`
    /// in the app so both pipelines' echo guards compare on the same scale.
    private static func rmsDBFS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return -.infinity }
        let sumSq = samples.reduce(Float(0)) { $0 + $1 * $1 }
        let rms = (sumSq / Float(samples.count)).squareRoot()
        return 20 * log10(max(rms, 1e-10))
    }
}
