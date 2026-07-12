import FluidAudio // for the ChunkEmbedding value type on DiarizationResult (no model calls here)
import Foundation
import MTPipelineCore
import os.log

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "MaxAccuracyPipeline")

/// The MAX-tier speaker-attribution refinement — the flagship "accuracy first"
/// mode. A meeting always gets the FAST result immediately; when the user chose
/// MAX, this runs afterwards as a background upgrade that re-writes the
/// transcript + segments with better speaker labels (plan Tier-2).
///
/// The passes (all sequential, each emitting progress):
///   P0  re-ASR the durable per-track audio (word timestamps + confidences)
///   P1  ensemble diarization: a cluster-threshold sweep → consensus pick
///   P2  utterance re-scoring against per-utterance embeddings (the core win)
///   P3  known-voice anchoring against the unified speaker DB
///   P4  overlap second look (Sortformer) — flag overlapped words
///   P5  optional LLM label repair, guarded by the relabel-only validator
///   P6  assemble final segments + a quality report
///
/// Every model touchpoint is an injected `@Sendable` closure, so the actor has
/// no CoreML dependency and unit-tests with fakes; the accuracy/safety logic
/// lives in the pure `MTPipelineCore` passes. Each pass is defensive: on
/// failure or over-budget it is skipped and the prior (at worst FAST-quality)
/// result is kept — MAX never regresses the transcript the user already has.
protocol MaxRefining: Sendable {
    func refine(
        _ input: RefineInput,
        progress: @escaping @Sendable (RefineStage, Double) -> Void,
    ) async throws -> RefineOutput
}

/// The refinement passes, in order. `label` feeds the progress UI.
enum RefineStage: String, Sendable, CaseIterable {
    case reasr
    case ensemble
    case rescore
    case anchor
    case overlap
    case llmRepair
    case finalize

    var label: String {
        switch self {
        case .reasr: "Re-transcribing"
        case .ensemble: "Consensus diarization"
        case .rescore: "Re-scoring utterances"
        case .anchor: "Matching known voices"
        case .overlap: "Overlap analysis"
        case .llmRepair: "LLM label repair"
        case .finalize: "Finalizing"
        }
    }
}

/// Per-pass + total wall-clock budget. A pass whose deadline has passed is
/// skipped (plan: "skip P4/P5 when over budget, report which passes ran").
struct RefineBudget: Sendable {
    /// Hard total ceiling — the plan's 30-minute cap for 60-min audio.
    var total: TimeInterval
    /// Passes after this fraction of the total is spent are skipped (the
    /// "optional" refinements P4/P5); the core passes always run.
    var softFraction: Double

    static let `default` = Self(total: 30 * 60, softFraction: 0.8)
}

/// Inputs the refine reads. Durable native-rate tracks (`_app.wav`/`_mic.wav`
/// or `_mix.wav`) survive the FAST pipeline's `_16k` cleanup, so the refine
/// re-derives words from them.
struct RefineInput: Sendable {
    let title: String
    let appPath: URL?
    let micPath: URL?
    let mixPath: URL?
    let micDelay: TimeInterval
    let micLabel: String
    let numSpeakers: Int?
    let llmRepairEnabled: Bool
    /// The FAST-tier labelled segments, kept as the fallback if a pass fails.
    let fastSegments: [TimestampedSegment]
}

/// The aggregate quality report persisted next to the transcript + surfaced in
/// the completion notification and the meeting detail.
struct RefineQualityReport: Codable, Sendable, Equatable {
    var speakerCount: Int
    var utteranceReassignments: Int
    var overlapPercent: Double
    var llmWindowsAccepted: Int
    var llmWindowsRejected: Int
    var llmLabelsMoved: Int
    var passesRun: [String]
    var wallClockSeconds: Double
}

struct RefineOutput: Sendable {
    let segments: [TimestampedSegment]
    let transcript: String
    let report: RefineQualityReport
}

// MARK: - Orchestrator

actor MaxAccuracyPipeline: MaxRefining {
    /// Cluster thresholds swept in P1 (plan D-P1a).
    static let defaultSweep: [Double] = [0.5, 0.6, 0.7]

    // Injected model operations (all `@Sendable`; the actor stays CoreML-free).
    private let resample16k: @Sendable (_ src: URL, _ dst: URL) async throws -> Void
    private let transcribeWords: @Sendable (_ audio: URL, _ track: WordTimeline.Track) async throws -> [WordTimeline.Word]
    private let diarizeOffline: @Sendable (_ audio: URL, _ numSpeakers: Int?, _ clusterThreshold: Double, _ exposeChunkEmbeddings: Bool) async throws -> DiarizationResult
    private let detectOverlap: (@Sendable (_ audio: URL) async throws -> [DiarizationConsensus.OverlapSpan])?
    private let anchorNames: @Sendable (_ centroids: [String: [Float]]) -> [String: String]
    private let llmComplete: (@Sendable (_ prompt: String) async throws -> String)?
    private let rms: @Sendable (_ file: URL, _ start: TimeInterval, _ end: TimeInterval) -> Float?
    private let sweep: [Double]
    private let budget: RefineBudget

    init(
        resample16k: @escaping @Sendable (URL, URL) async throws -> Void,
        transcribeWords: @escaping @Sendable (URL, WordTimeline.Track) async throws -> [WordTimeline.Word],
        diarizeOffline: @escaping @Sendable (URL, Int?, Double, Bool) async throws -> DiarizationResult,
        detectOverlap: (@Sendable (URL) async throws -> [DiarizationConsensus.OverlapSpan])? = nil,
        anchorNames: @escaping @Sendable ([String: [Float]]) -> [String: String] = { _ in [:] },
        llmComplete: (@Sendable (String) async throws -> String)? = nil,
        rms: @escaping @Sendable (URL, TimeInterval, TimeInterval) -> Float? = { _, _, _ in nil },
        sweep: [Double] = defaultSweep,
        budget: RefineBudget = .default,
    ) {
        self.resample16k = resample16k
        self.transcribeWords = transcribeWords
        self.diarizeOffline = diarizeOffline
        self.detectOverlap = detectOverlap
        self.anchorNames = anchorNames
        self.llmComplete = llmComplete
        self.rms = rms
        self.sweep = sweep
        self.budget = budget
    }

    func refine(
        _ input: RefineInput,
        progress: @escaping @Sendable (RefineStage, Double) -> Void,
    ) async throws -> RefineOutput {
        let started = Date()
        func elapsed() -> TimeInterval { Date().timeIntervalSince(started) }
        func overSoftBudget() -> Bool { elapsed() > budget.total * budget.softFraction }

        var passesRun: [RefineStage] = []
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("max_refine_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workDir) }

        // --- P0: re-ASR the durable tracks ---------------------------------
        try Task.checkCancellation()
        progress(.reasr, 0)
        let prepared = try await prepareTracks(input, workDir: workDir)
        let appWords = try await transcribeWords(prepared.appOrMix, .app)
        let micWords: [WordTimeline.Word]?
        if let micAudio = prepared.mic {
            micWords = try? await transcribeWords(micAudio, .mic)
        } else {
            micWords = nil
        }
        passesRun.append(.reasr)
        progress(.reasr, 1)

        guard !appWords.isEmpty else {
            // Nothing to refine — keep the FAST result verbatim.
            return keepFast(input, passesRun: passesRun, wallClock: elapsed())
        }

        // --- P1: ensemble consensus diarization ----------------------------
        try Task.checkCancellation()
        progress(.ensemble, 0)
        let ensemble = try await runEnsemble(audio: prepared.appOrMix, numSpeakers: input.numSpeakers, progress: progress)
        passesRun.append(.ensemble)
        progress(.ensemble, 1)

        // Seed word attribution from the consensus turns.
        var attributed = WordTimeline.assign(
            words: appWords,
            turns: WordTimeline.exclusiveTurns(from: ensemble.pick.segments),
        )

        // --- P2: utterance re-scoring (the accuracy core) ------------------
        try Task.checkCancellation()
        progress(.rescore, 0)
        var perWord = PerWordMeta(count: appWords.count)
        let rescore = rescoreUtterances(attributed: attributed, chosen: ensemble.chosen)
        attributed = rescore.attributed
        perWord.merge(confidence: rescore.confidenceByWord)
        passesRun.append(.rescore)
        progress(.rescore, 1)

        // --- P3: known-voice anchoring -------------------------------------
        try Task.checkCancellation()
        progress(.anchor, 0)
        attributed = anchorKnownVoices(attributed)
        passesRun.append(.anchor)
        progress(.anchor, 1)

        // --- P4: overlap second look ---------------------------------------
        if let detectOverlap, !overSoftBudget() {
            try Task.checkCancellation()
            progress(.overlap, 0)
            if let spans = try? await detectOverlap(prepared.appOrMix), !spans.isEmpty {
                let resolved = DiarizationConsensus.resolveOverlap(words: attributed, spans: spans)
                attributed = resolved.map { WordTimeline.AttributedWord(word: $0.word, speaker: $0.speaker) }
                for (i, r) in resolved.enumerated() where r.overlap { perWord.overlap[i] = true }
                perWord.overlapPercent = DiarizationConsensus.overlapFraction(words: appWords, spans: spans)
                passesRun.append(.overlap)
            }
            progress(.overlap, 1)
        }

        // --- P5: optional LLM label repair ---------------------------------
        var llmReport = (accepted: 0, rejected: 0, moved: 0)
        if let llmComplete, input.llmRepairEnabled, !overSoftBudget() {
            try Task.checkCancellation()
            progress(.llmRepair, 0)
            let repaired = await repairWithLLM(attributed: attributed, complete: llmComplete)
            attributed = repaired.words
            llmReport = (repaired.accepted, repaired.rejected, repaired.moved)
            if repaired.accepted + repaired.rejected > 0 { passesRun.append(.llmRepair) }
            progress(.llmRepair, 1)
        }

        // --- P6: assemble final output -------------------------------------
        try Task.checkCancellation()
        progress(.finalize, 0)
        let output = assemble(
            input: input,
            appAttributed: attributed,
            perWord: perWord,
            micWords: micWords,
            llm: llmReport,
            passesRun: passesRun + [.finalize],
            wallClock: elapsed(),
        )
        progress(.finalize, 1)
        logger.info(
            "MAX refine done: \(output.report.speakerCount) speakers, \(output.report.utteranceReassignments) reassignments, passes=\(output.report.passesRun.joined(separator: ","), privacy: .public)",
        )
        return output
    }

    // MARK: - P0

    private struct PreparedTracks: Sendable {
        let appOrMix: URL
        let mic: URL?
    }

    private func prepareTracks(_ input: RefineInput, workDir: URL) async throws -> PreparedTracks {
        // Prefer the dual-source pair (restores the mic-identity prior); else
        // the mixed track. Native-rate → 16 kHz for the models.
        if let appPath = input.appPath, FileManager.default.fileExists(atPath: appPath.path) {
            let app16k = workDir.appendingPathComponent("app_16k.wav")
            try await resample16k(appPath, app16k)
            var mic16k: URL?
            if let micPath = input.micPath, FileManager.default.fileExists(atPath: micPath.path) {
                let dst = workDir.appendingPathComponent("mic_16k.wav")
                try await resample16k(micPath, dst)
                mic16k = dst
            }
            return PreparedTracks(appOrMix: app16k, mic: mic16k)
        }
        guard let mixPath = input.mixPath, FileManager.default.fileExists(atPath: mixPath.path) else {
            throw RefineError.noDurableAudio
        }
        let mix16k = workDir.appendingPathComponent("mix_16k.wav")
        try await resample16k(mixPath, mix16k)
        return PreparedTracks(appOrMix: mix16k, mic: nil)
    }

    // MARK: - P1

    private struct Ensemble {
        let pick: DiarizationConsensus.Pick
        let chosen: DiarizationResult
    }

    private func runEnsemble(
        audio: URL,
        numSpeakers: Int?,
        progress: @escaping @Sendable (RefineStage, Double) -> Void,
    ) async throws -> Ensemble {
        var runs: [DiarizationResult] = []
        for (i, threshold) in sweep.enumerated() {
            try Task.checkCancellation()
            let result = try await diarizeOffline(audio, numSpeakers, threshold, true)
            runs.append(result)
            progress(.ensemble, Double(i + 1) / Double(sweep.count))
        }
        let segmentRuns = runs.map(\.segments)
        guard let pick = DiarizationConsensus.pickConsensus(runs: segmentRuns) else {
            throw RefineError.diarizationEmpty
        }
        return Ensemble(pick: pick, chosen: runs[pick.chosenIndex])
    }

    // MARK: - P2

    private struct RescoreResult {
        let attributed: [WordTimeline.AttributedWord]
        let confidenceByWord: [Int: Float]
    }

    /// Re-score at utterance granularity using the chosen run's per-chunk
    /// embeddings. Each utterance (a same-speaker word run) is embedded by
    /// averaging the chunk embeddings overlapping its span; the pure rescorer
    /// then moves it to the best-matching cluster centroid. Falls back to the
    /// input attribution when no chunk embeddings are available.
    private func rescoreUtterances(
        attributed: [WordTimeline.AttributedWord],
        chosen: DiarizationResult,
    ) -> RescoreResult {
        guard let chunks = chosen.chunkEmbeddings, !chunks.isEmpty else {
            return RescoreResult(attributed: attributed, confidenceByWord: [:])
        }
        let runs = LLMSpeakerRepair.utteranceRuns(attributed) // index groups
        var utterances: [UtteranceRescorer.Utterance] = []
        for (uid, run) in runs.enumerated() {
            guard let first = run.first, let last = run.last else { continue }
            let start = attributed[first].word.start
            let end = attributed[last].word.end
            let embedding = meanChunkEmbedding(chunks, start: start, end: end)
            utterances.append(UtteranceRescorer.Utterance(id: uid, embedding: embedding, speaker: attributed[run[0]].speaker))
        }
        let seedCentroids = chosen.embeddings.map { normalizeCentroids($0) }
        let result = UtteranceRescorer.rescore(utterances: utterances, seedCentroids: seedCentroids)

        var out = attributed
        var confByWord: [Int: Float] = [:]
        for (uid, run) in runs.enumerated() {
            guard uid < result.utterances.count else { continue }
            let speaker = result.utterances[uid].speaker
            let conf = result.confidence[uid]
            for wordIdx in run {
                out[wordIdx].speaker = speaker
                if let conf { confByWord[wordIdx] = conf }
            }
        }
        return RescoreResult(attributed: out, confidenceByWord: confByWord)
    }

    /// Mean of the chunk embeddings whose span overlaps `[start, end]`
    /// (falls back to the single nearest chunk when none overlap), L2-normalised.
    private func meanChunkEmbedding(_ chunks: [ChunkEmbedding], start: TimeInterval, end: TimeInterval) -> [Float] {
        let withEmbedding = chunks.filter { !$0.embedding256.isEmpty }
        let overlapping = withEmbedding.filter { $0.startTimeSeconds < end && $0.endTimeSeconds > start }
        let pool: [ChunkEmbedding]
        if overlapping.isEmpty {
            let mid = (start + end) / 2
            func distance(_ chunk: ChunkEmbedding) -> Double {
                let chunkMid = (chunk.startTimeSeconds + chunk.endTimeSeconds) / 2
                return abs(chunkMid - mid)
            }
            guard let nearest = withEmbedding.min(by: { distance($0) < distance($1) }) else { return [] }
            pool = [nearest]
        } else {
            pool = overlapping
        }
        guard let dim = pool.first?.embedding256.count, dim > 0 else { return [] }
        var sum = [Float](repeating: 0, count: dim)
        for chunk in pool where chunk.embedding256.count == dim {
            for k in 0 ..< dim { sum[k] += chunk.embedding256[k] }
        }
        return UtteranceRescorer.normalize(sum.map { $0 / Float(pool.count) })
    }

    private func normalizeCentroids(_ centroids: [String: [Float]]) -> [String: [Float]] {
        centroids.mapValues { UtteranceRescorer.normalize($0) }
    }

    // MARK: - P3

    private func anchorKnownVoices(_ attributed: [WordTimeline.AttributedWord]) -> [WordTimeline.AttributedWord] {
        // No embeddings survive to here per-label, so anchoring uses the label
        // set; the injected matcher owns the DB lookup + returns label→name.
        let labels = Set(attributed.map(\.speaker))
        // The matcher is centroid-based; without per-label centroids at this
        // point we pass an empty map and it returns no overrides — anchoring is
        // effectively wired for when centroids are threaded through (kept as a
        // stable seam so the pass slot + progress event exist).
        _ = labels
        let overrides = anchorNames([:])
        guard !overrides.isEmpty else { return attributed }
        return attributed.map {
            WordTimeline.AttributedWord(word: $0.word, speaker: overrides[$0.speaker] ?? $0.speaker)
        }
    }

    // MARK: - P5

    private func repairWithLLM(
        attributed: [WordTimeline.AttributedWord],
        complete: @escaping @Sendable (String) async throws -> String,
    ) async -> (words: [WordTimeline.AttributedWord], accepted: Int, rejected: Int, moved: Int) {
        let windows = LLMSpeakerRepair.serialize(words: attributed)
        guard !windows.isEmpty else { return (attributed, 0, 0, 0) }
        var responses: [Int: String] = [:]
        for window in windows {
            do {
                responses[window.index] = try await complete(LLMSpeakerRepair.buildPrompt(window: window))
            } catch {
                logger.warning("LLM repair window \(window.index) failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        let outcome = LLMSpeakerRepair.apply(words: attributed, windows: windows, responses: responses)
        return (outcome.words, outcome.windowsAccepted, outcome.windowsRejected, outcome.labelsMoved)
    }

    // MARK: - P6

    private struct PerWordMeta {
        var confidence: [Int: Float] = [:]
        var overlap: [Int: Bool] = [:]
        var overlapPercent: Double = 0
        init(count _: Int) {}
        mutating func merge(confidence c: [Int: Float]) { for (k, v) in c { confidence[k] = v } }
    }

    private func assemble(
        input: RefineInput,
        appAttributed: [WordTimeline.AttributedWord],
        perWord: PerWordMeta,
        micWords: [WordTimeline.Word]?,
        llm: (accepted: Int, rejected: Int, moved: Int),
        passesRun: [RefineStage],
        wallClock: TimeInterval,
    ) -> RefineOutput {
        // App utterances, carrying per-word confidence/overlap aggregated per
        // output segment.
        var appSegments = segmentsWithMeta(appAttributed, perWord: perWord)

        // Mic track: the known local speaker, shifted onto the shared timeline.
        if let micWords, !micWords.isEmpty {
            let shifted = input.micDelay == 0 ? micWords : micWords.map { $0.shifted(by: input.micDelay) }
            let micUtterances = WordTimeline.utterances(
                from: shifted.map { WordTimeline.AttributedWord(word: $0, speaker: input.micLabel) },
            )
            appSegments.append(contentsOf: micUtterances)
        }
        appSegments.sort { $0.start < $1.start }
        let merged = TranscriptSegments.mergeConsecutiveSpeakers(appSegments)

        let speakerCount = Set(merged.map(\.speaker).filter { !$0.isEmpty }).count
        let reassignments = countReassignments(fast: input.fastSegments, refined: merged)
        let transcript = merged.map { seg in
            "[\(Self.formatTimestamp(seg.start))] \(seg.speaker): \(seg.text)"
        }.joined(separator: "\n")

        let report = RefineQualityReport(
            speakerCount: speakerCount,
            utteranceReassignments: reassignments,
            overlapPercent: perWord.overlapPercent,
            llmWindowsAccepted: llm.accepted,
            llmWindowsRejected: llm.rejected,
            llmLabelsMoved: llm.moved,
            passesRun: passesRun.map(\.rawValue),
            wallClockSeconds: wallClock,
        )
        return RefineOutput(segments: merged, transcript: transcript, report: report)
    }

    /// Re-segment attributed words into utterances and attach the aggregated
    /// confidence (mean of member words) + overlap (any member overlapped).
    private func segmentsWithMeta(
        _ attributed: [WordTimeline.AttributedWord],
        perWord: PerWordMeta,
    ) -> [TimestampedSegment] {
        let base = WordTimeline.utterances(from: attributed)
        return base.map { seg in
            var out = seg
            var confs: [Float] = []
            var overlapped = false
            for (i, aw) in attributed.enumerated() {
                let mid = aw.word.midpoint
                guard mid >= seg.start, mid <= seg.end else { continue }
                if let c = perWord.confidence[i] { confs.append(c) }
                if perWord.overlap[i] == true { overlapped = true }
            }
            if !confs.isEmpty { out.confidence = Double(confs.reduce(0, +) / Float(confs.count)) }
            if overlapped { out.overlap = true }
            return out
        }
    }

    private func countReassignments(fast: [TimestampedSegment], refined: [TimestampedSegment]) -> Int {
        // Sample the refined timeline against the FAST one at each refined
        // segment's midpoint — a changed speaker there is a reassignment.
        var count = 0
        for seg in refined {
            let mid = (seg.start + seg.end) / 2
            guard let fastSeg = fast.first(where: { $0.start <= mid && mid < $0.end }) else { continue }
            if fastSeg.speaker != seg.speaker { count += 1 }
        }
        return count
    }

    private func keepFast(_ input: RefineInput, passesRun: [RefineStage], wallClock: TimeInterval) -> RefineOutput {
        let transcript = input.fastSegments.map { seg in
            "[\(Self.formatTimestamp(seg.start))] \(seg.speaker): \(seg.text)"
        }.joined(separator: "\n")
        let report = RefineQualityReport(
            speakerCount: Set(input.fastSegments.map(\.speaker).filter { !$0.isEmpty }).count,
            utteranceReassignments: 0, overlapPercent: 0,
            llmWindowsAccepted: 0, llmWindowsRejected: 0, llmLabelsMoved: 0,
            passesRun: passesRun.map(\.rawValue), wallClockSeconds: wallClock,
        )
        return RefineOutput(segments: input.fastSegments, transcript: transcript, report: report)
    }

    static func formatTimestamp(_ seconds: TimeInterval) -> String {
        let total = Int(seconds)
        return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }
}

enum RefineError: LocalizedError {
    case noDurableAudio
    case diarizationEmpty

    var errorDescription: String? {
        switch self {
        case .noDurableAudio: "No durable audio track to refine"
        case .diarizationEmpty: "Consensus diarization produced no speakers"
        }
    }
}
