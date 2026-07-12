import Foundation
import MTPipelineCore

/// `--emit-metrics` support: score the produced transcript against a word-level
/// ground truth and report WDER / DER / speaker-count. A debug aid for the
/// local cluster-threshold sweep — it never changes the transcript and never
/// fails the run (a missing or malformed truth file logs a warning and is
/// skipped), so it is safe to leave the flag on while iterating.
extension Transcribe {
    /// Durable per-run metrics, written next to the transcript so a sweep loop
    /// can collect one file per threshold.
    struct MetricsReport: Codable {
        let fixture: String
        let clusterThreshold: Double
        let wder: Double
        let der: Double
        let speakerCountError: Int
        let refSpeakers: Int
        let hypSpeakers: Int
        let wrongWords: Int
        let totalWords: Int
    }

    /// Compute and report metrics when `--emit-metrics` was passed. Emits a
    /// machine-readable `metrics` JSONL line (parsed by the sweep driver), a
    /// human summary on stderr, and a durable `metrics.json` in the output dir.
    func emitMetricsIfRequested(labeled: [TimedSegment], outputURL: URL) {
        guard let emitMetrics else { return }
        let truthURL = URL(fileURLWithPath: PathHelpers.expandTilde(emitMetrics))
        let truth: AttributionTruth
        do {
            let data = try Data(contentsOf: truthURL)
            truth = try JSONDecoder().decode(AttributionTruth.self, from: data)
        } catch {
            Log.warn("--emit-metrics: could not read ground truth at \(truthURL.path): \(error.localizedDescription)")
            return
        }

        let hypTurns = labeled.map { SpeakerSegment(start: $0.start, end: $0.end, speaker: $0.speaker) }
        let wder = DiarizationMetrics.wder(referenceWords: truth.words, hypothesisTurns: hypTurns)
        let der = DiarizationMetrics.der(referenceTurns: truth.referenceTurns, hypothesisTurns: hypTurns)
        let refSpeakers = truth.speakerCount
        let hypSpeakers = Set(hypTurns.map(\.speaker).filter { !$0.isEmpty }).count
        let speakerCountError = DiarizationMetrics.speakerCountError(
            referenceTurns: truth.referenceTurns,
            hypothesisTurns: hypTurns,
        )

        Events.metrics(
            fixture: truth.fixture,
            wder: wder.errorRate,
            der: der.der,
            speakerCountError: speakerCountError,
            refSpeakers: refSpeakers,
            hypSpeakers: hypSpeakers,
            clusterThreshold: clusterThreshold,
        )
        Log.info(String(
            format: "Metrics for %@ (clusterThreshold=%.2f): WDER=%.1f%% DER=%.1f%% speakers hyp=%d ref=%d",
            truth.fixture, clusterThreshold, wder.errorRate * 100, der.der * 100, hypSpeakers, refSpeakers,
        ))

        let report = MetricsReport(
            fixture: truth.fixture,
            clusterThreshold: clusterThreshold,
            wder: wder.errorRate,
            der: der.der,
            speakerCountError: speakerCountError,
            refSpeakers: refSpeakers,
            hypSpeakers: hypSpeakers,
            wrongWords: wder.wrongWords,
            totalWords: wder.totalWords,
        )
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(report)
            try data.write(to: outputURL.appendingPathComponent("metrics.json"), options: .atomic)
        } catch {
            Log.warn("--emit-metrics: could not write metrics.json: \(error.localizedDescription)")
        }
    }
}
