import FluidAudio
import Foundation

/// Wraps FluidAudio's offline (clustering-based) diarizer.
///
/// The offline pipeline is what the main app uses by default
/// (`AppSettings.diarizerMode == .offline`). It clusters per-window speaker
/// embeddings and produces (start, end, speakerId) segments plus a per-
/// speaker centroid embedding that lets `SpeakerDB` recognise the same
/// voices across future runs.
///
/// `@unchecked Sendable` because `manager` is init-once via `loadModel()`
/// and FluidAudio's CoreML inference is documented thread-safe. Same
/// pattern the main app's `FluidDiarizer` uses.
final class DiarizerWrapper: @unchecked Sendable {
    /// Cluster threshold for the offline pipeline. 0.6 is FluidAudio's
    /// `Clustering.community` default; lower values produce more clusters
    /// (i.e. more speakers). The main app exposes the same knob under
    /// Settings → Speakers → Experimental Diarization Tuning.
    private let clusterThreshold: Double
    /// Optional fixed speaker count. `nil` = auto-detect. When set, the
    /// clusterer's K-Means stage uses it as a hard cap (see
    /// `OfflineDiarizerConfig.withSpeakers`).
    private let numSpeakers: Int?
    private var manager: OfflineDiarizerManager?

    init(clusterThreshold: Double = 0.6, numSpeakers: Int? = nil) {
        self.clusterThreshold = clusterThreshold
        self.numSpeakers = numSpeakers
    }

    func loadModel() async throws {
        var config = OfflineDiarizerConfig.default
        config.clustering.threshold = clusterThreshold
        if let n = numSpeakers, n > 0 {
            config = config.withSpeakers(min: 1, max: n)
        }
        let manager = OfflineDiarizerManager(config: config)
        try await manager.prepareModels()
        self.manager = manager
    }

    /// Run diarization on a 16 kHz mono WAV.
    ///
    /// Returns the segments and the per-speaker centroid embeddings the
    /// FluidAudio pipeline produces. Embeddings keys use FluidAudio's
    /// `"Speaker 0"` format; we normalise to `"SPEAKER_0"` to match the
    /// rest of the app's pipeline and persisted DB.
    func diarize(audioPath: URL) async throws -> DiarizationOutput {
        guard let manager else {
            throw DiarizationError.notLoaded
        }
        let result = try await manager.process(audioPath)
        let segments = result.segments.map { seg in
            DiarizationOutput.Segment(
                start: TimeInterval(seg.startTimeSeconds),
                end: TimeInterval(seg.endTimeSeconds),
                speaker: Self.normalize(seg.speakerId),
            )
        }
        // FluidAudio returns the per-speaker centroid via `speakerDatabase`.
        var embeddings: [String: [Float]] = [:]
        for (id, vec) in result.speakerDatabase ?? [:] {
            embeddings[Self.normalize(id)] = vec
        }
        var speakingTimes: [String: TimeInterval] = [:]
        for seg in segments {
            speakingTimes[seg.speaker, default: 0] += max(0, seg.end - seg.start)
        }
        return DiarizationOutput(
            segments: segments.sorted { $0.start < $1.start },
            speakingTimes: speakingTimes,
            embeddings: embeddings,
        )
    }

    /// Normalize FluidAudio's speaker-id strings to a human-friendly
    /// `"Speaker N"` form (1-indexed). FluidAudio 0.13+ emits `"S1"`,
    /// `"S2"`, etc. from the offline clusterer; legacy paths emit
    /// `"Speaker 0"`. Both shapes get folded into `"Speaker 1"`,
    /// `"Speaker 2"`, … so transcript lines read naturally
    /// (`[00:00:00] Speaker 1: …`) without a downstream rewrite step.
    static func normalize(_ id: String) -> String {
        // FluidAudio 0.13+ offline: "S1", "S2"
        if id.hasPrefix("S"), let n = Int(id.dropFirst()) {
            return "Speaker \(n)"
        }
        // Legacy FluidAudio: "Speaker 0", "Speaker 1" — bump to 1-indexed.
        if id.hasPrefix("Speaker "), let n = Int(id.dropFirst("Speaker ".count)) {
            return "Speaker \(n + 1)"
        }
        return id
    }
}

/// Result of running diarization on a single audio file.
struct DiarizationOutput {
    struct Segment {
        let start: TimeInterval
        let end: TimeInterval
        let speaker: String
    }

    let segments: [Segment]
    let speakingTimes: [String: TimeInterval]
    /// Centroid embeddings keyed by normalised speaker id. Empty when the
    /// model didn't produce centroids (e.g. very short audio with no
    /// confirmed speakers).
    let embeddings: [String: [Float]]
}

enum DiarizationError: Swift.Error, LocalizedError {
    case notLoaded

    var errorDescription: String? {
        switch self {
        case .notLoaded: "Diarizer model not loaded"
        }
    }
}
