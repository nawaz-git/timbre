import MTPipelineCore
import XCTest

/// Unit tests for the pure word-diarization metrics that back the attribution
/// quality lane and the mt-batch `--emit-metrics` sweep. No models, no audio —
/// the metric math is deterministic value-in/value-out, so these run in the
/// normal (non-quality) test lane and gate every change to the calculator.
final class DiarizationMetricsTests: XCTestCase {
    // MARK: - Helpers

    private func word(_ w: String, _ s: Double, _ e: Double, _ spk: String) -> AttributionTruth.Word {
        AttributionTruth.Word(w: w, start: s, end: e, speaker: spk)
    }

    private func seg(_ s: Double, _ e: Double, _ spk: String) -> SpeakerSegment {
        SpeakerSegment(start: s, end: e, speaker: spk)
    }

    /// Ref A speaks [0,2), B speaks [2,4), one word per second.
    private var twoSpeakerWords: [AttributionTruth.Word] {
        [word("a1", 0, 1, "A"), word("a2", 1, 2, "A"), word("b1", 2, 3, "B"), word("b2", 3, 4, "B")]
    }

    // MARK: - Aligned WDER

    func test_alignedWDER_zeroUnderOptimalRelabel() {
        let result = DiarizationMetrics.wder(
            referenceLabels: ["A", "A", "B", "B"],
            hypothesisLabels: ["S1", "S1", "S2", "S2"],
        )
        XCTAssertEqual(result.errorRate, 0.0, accuracy: 1e-9)
        XCTAssertEqual(result.wrongWords, 0)
        XCTAssertEqual(result.totalWords, 4)
    }

    func test_alignedWDER_oneCrossedWord() {
        let result = DiarizationMetrics.wder(
            referenceLabels: ["A", "A", "B", "B"],
            hypothesisLabels: ["S1", "S2", "S2", "S2"],
        )
        XCTAssertEqual(result.errorRate, 0.25, accuracy: 1e-9)
        XCTAssertEqual(result.wrongWords, 1)
    }

    func test_alignedWDER_nilHypothesisWordIsError() {
        let result = DiarizationMetrics.wder(
            referenceLabels: ["A", "A", "B", "B"],
            hypothesisLabels: ["S1", nil, "S2", "S2"],
        )
        XCTAssertEqual(result.errorRate, 0.25, accuracy: 1e-9)
        XCTAssertEqual(result.wrongWords, 1)
    }

    func test_alignedWDER_singleSpeakerCollapse() {
        let result = DiarizationMetrics.wder(
            referenceLabels: ["A", "A", "B", "B"],
            hypothesisLabels: ["S1", "S1", "S1", "S1"],
        )
        XCTAssertEqual(result.errorRate, 0.5, accuracy: 1e-9)
    }

    // MARK: - Time-projected WDER

    func test_byTimeWDER_honoursMidSegmentBoundary() {
        // A single ASR span could straddle the 2.0 s turn boundary; scoring by
        // word midpoint against exclusive turns must still attribute correctly.
        let hyp = [seg(0, 2, "x"), seg(2, 4, "y")]
        let result = DiarizationMetrics.wder(referenceWords: twoSpeakerWords, hypothesisTurns: hyp)
        XCTAssertEqual(result.errorRate, 0.0, accuracy: 1e-9)
    }

    func test_byTimeWDER_penalisesCollapse() {
        let hyp = [seg(0, 4, "only")]
        let result = DiarizationMetrics.wder(referenceWords: twoSpeakerWords, hypothesisTurns: hyp)
        XCTAssertEqual(result.errorRate, 0.5, accuracy: 1e-9)
    }

    func test_byTimeWDER_nearestFallbackAcrossGap() {
        // A word landing in a hypothesis gap is attributed to the nearest turn.
        let hyp = [seg(0, 1.9, "x"), seg(2.1, 4, "y")]
        let result = DiarizationMetrics.wder(referenceWords: twoSpeakerWords, hypothesisTurns: hyp)
        XCTAssertEqual(result.errorRate, 0.0, accuracy: 1e-9)
    }

    func test_byTimeWDER_emptyHypothesisIsAllWrong() {
        let result = DiarizationMetrics.wder(referenceWords: twoSpeakerWords, hypothesisTurns: [])
        XCTAssertEqual(result.errorRate, 1.0, accuracy: 1e-9)
        XCTAssertEqual(result.wrongWords, 4)
    }

    func test_wder_emptyReferenceIsZero() {
        let result = DiarizationMetrics.wder(referenceWords: [], hypothesisTurns: [seg(0, 1, "x")])
        XCTAssertEqual(result.errorRate, 0.0, accuracy: 1e-9)
        XCTAssertEqual(result.totalWords, 0)
    }

    // MARK: - DER

    func test_der_zeroOnPerfectTimeline() {
        let ref = [seg(0, 2, "A"), seg(2, 4, "B")]
        let hyp = [seg(0, 2, "x"), seg(2, 4, "y")]
        XCTAssertEqual(DiarizationMetrics.der(referenceTurns: ref, hypothesisTurns: hyp).der, 0.0, accuracy: 1e-9)
    }

    func test_der_confusionOnCollapse() {
        let ref = [seg(0, 2, "A"), seg(2, 4, "B")]
        let result = DiarizationMetrics.der(referenceTurns: ref, hypothesisTurns: [seg(0, 4, "x")])
        XCTAssertEqual(result.der, 0.5, accuracy: 1e-9)
        XCTAssertEqual(result.speakerConfusion, 2.0, accuracy: 1e-9)
    }

    func test_der_countsMissedSpeech() {
        let ref = [seg(0, 2, "A"), seg(2, 4, "B")]
        let result = DiarizationMetrics.der(referenceTurns: ref, hypothesisTurns: [seg(2, 4, "y")])
        XCTAssertEqual(result.der, 0.5, accuracy: 1e-9)
        XCTAssertEqual(result.missedSpeech, 2.0, accuracy: 1e-9)
    }

    // MARK: - Speaker count

    func test_speakerCountError() {
        let ref = [seg(0, 1, "A"), seg(1, 2, "B"), seg(2, 3, "C")]
        XCTAssertEqual(DiarizationMetrics.speakerCountError(referenceTurns: ref, hypothesisTurns: [seg(0, 3, "x")]), 2)
        XCTAssertEqual(DiarizationMetrics.speakerCountError(referenceTurns: ref, hypothesisTurns: ref), 0)
    }

    // MARK: - Ablation

    func test_ablation_reportsPerPassWDERDelta() {
        let rows = DiarizationMetrics.ablation(
            referenceWords: twoSpeakerWords,
            stages: [("fast", [seg(0, 4, "only")]), ("+consensus", [seg(0, 2, "x"), seg(2, 4, "y")])],
        )
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].wder, 0.5, accuracy: 1e-9)
        XCTAssertNil(rows[0].relativeImprovement)
        XCTAssertEqual(rows[1].wder, 0.0, accuracy: 1e-9)
        XCTAssertEqual(rows[1].deltaVsPrevious, 0.5, accuracy: 1e-9)
        XCTAssertEqual(rows[1].relativeImprovement ?? .nan, 1.0, accuracy: 1e-9)
    }

    // MARK: - AttributionTruth schema

    func test_attributionTruth_coalescesTurnsFromWords() {
        let turns = AttributionTruth.turns(fromWords: [
            word("x", 0, 1, "A"), word("y", 1, 2, "A"), word("z", 2, 3, "B"),
        ])
        XCTAssertEqual(turns, [seg(0, 2, "A"), seg(2, 3, "B")])
    }

    func test_attributionTruth_codableRoundTripAndDerivedTurns() throws {
        let truth = AttributionTruth(
            fixture: "t", kind: "dualtrack", appAudio: "t_app.wav", micAudio: "t_mic.wav",
            micDelay: 0, micSpeaker: "Me", sampleRate: 16000, duration: 4,
            words: twoSpeakerWords, turns: nil,
        )
        let data = try JSONEncoder().encode(truth)
        let decoded = try JSONDecoder().decode(AttributionTruth.self, from: data)
        XCTAssertEqual(decoded, truth)
        XCTAssertEqual(decoded.speakerCount, 2)
        XCTAssertEqual(decoded.referenceTurns.count, 2)
    }
}
