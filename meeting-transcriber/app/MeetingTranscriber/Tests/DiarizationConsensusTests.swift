import MTPipelineCore
import XCTest

/// Pure-logic tests for the MAX ensemble pick (P1) and overlap second look
/// (P4). No CoreML: the caller's model outputs are fabricated so we can pin the
/// decision logic — most importantly that a collapsed 1-speaker run never wins
/// a near-tie against a 2-speaker run (the R3 under-clustering complaint).
final class DiarizationConsensusTests: XCTestCase {
    private func seg(_ start: TimeInterval, _ end: TimeInterval, _ speaker: String) -> SpeakerSegment {
        SpeakerSegment(start: start, end: end, speaker: speaker)
    }

    private func word(_ start: TimeInterval, _ end: TimeInterval, _ text: String) -> WordTimeline.Word {
        WordTimeline.Word(start: start, end: end, text: text)
    }

    // MARK: - P1 ensemble pick

    func testConsensusPrefersTwoSpeakersOverCollapse() {
        // run0 collapses everything to one speaker; run1 + run2 both find two.
        let collapsed = [seg(0, 10, "S0")]
        let twoSpeaker = [seg(0, 5, "S0"), seg(5, 10, "S1")]
        let pick = DiarizationConsensus.pickConsensus(runs: [collapsed, twoSpeaker, twoSpeaker], duration: 10)
        let unwrapped = try? XCTUnwrap(pick)
        XCTAssertEqual(unwrapped?.speakerCount, 2)
    }

    func testTwoRunTieBreaksTowardMoreSpeakers() {
        // Exactly two runs → their mutual Rand agreement is identical, a perfect
        // stability tie. Tie-break must choose the 2-speaker run, not collapse.
        let collapsed = [seg(0, 10, "S0")]
        let twoSpeaker = [seg(0, 5, "A"), seg(5, 10, "B")]
        let pick = DiarizationConsensus.pickConsensus(runs: [collapsed, twoSpeaker], duration: 10)
        XCTAssertEqual(pick?.chosenIndex, 1)
        XCTAssertEqual(pick?.speakerCount, 2)
    }

    func testSingleRunReturnedAsIs() {
        let only = [seg(0, 5, "A"), seg(5, 10, "B")]
        let pick = DiarizationConsensus.pickConsensus(runs: [only])
        XCTAssertEqual(pick?.chosenIndex, 0)
        XCTAssertEqual(pick?.stability, 1.0)
        XCTAssertEqual(pick?.speakerCount, 2)
    }

    func testEmptyRunsReturnNil() {
        XCTAssertNil(DiarizationConsensus.pickConsensus(runs: []))
    }

    // MARK: - Rand index

    func testRandIndexIdenticalPartitions() {
        let a = ["A", "A", "B", "B"]
        XCTAssertEqual(DiarizationConsensus.randIndex(a, a), 1.0, accuracy: 1e-9)
    }

    func testRandIndexRelabelInvariant() {
        // Same partition, different label names → Rand still 1.0.
        let a = ["A", "A", "B", "B"]
        let b = ["X", "X", "Y", "Y"]
        XCTAssertEqual(DiarizationConsensus.randIndex(a, b), 1.0, accuracy: 1e-9)
    }

    func testRandIndexDisagreementBelowOne() {
        let a = ["A", "A", "B", "B"]
        let b = ["A", "B", "A", "B"]
        XCTAssertLessThan(DiarizationConsensus.randIndex(a, b), 1.0)
        XCTAssertGreaterThanOrEqual(DiarizationConsensus.randIndex(a, b), 0.0)
    }

    // MARK: - P4 overlap

    func testOverlapWordReassignedToDominant() {
        let words = [
            WordTimeline.AttributedWord(word: word(0, 1, "hi"), speaker: "A"),
            WordTimeline.AttributedWord(word: word(4, 5, "yes"), speaker: "A"), // inside overlap, dominant B
            WordTimeline.AttributedWord(word: word(9, 10, "bye"), speaker: "A"),
        ]
        let spans = [DiarizationConsensus.OverlapSpan(start: 3.5, end: 6, dominantSpeaker: "B")]
        let resolved = DiarizationConsensus.resolveOverlap(words: words, spans: spans)
        XCTAssertEqual(resolved[0].overlap, false)
        XCTAssertEqual(resolved[0].speaker, "A")
        XCTAssertEqual(resolved[1].overlap, true)
        XCTAssertEqual(resolved[1].speaker, "B", "word inside overlap moves to the dominant stream")
        XCTAssertEqual(resolved[2].overlap, false)
    }

    func testOverlapWithoutDominantIsAnnotateOnly() {
        let words = [WordTimeline.AttributedWord(word: word(4, 5, "yes"), speaker: "A")]
        let spans = [DiarizationConsensus.OverlapSpan(start: 3, end: 6, dominantSpeaker: nil)]
        let resolved = DiarizationConsensus.resolveOverlap(words: words, spans: spans)
        XCTAssertEqual(resolved[0].overlap, true)
        XCTAssertEqual(resolved[0].speaker, "A", "keeps primary speaker when no dominant stream is known")
    }

    func testOverlapFraction() {
        let words = [word(0, 1, "a"), word(4, 5, "b"), word(9, 10, "c")]
        let spans = [DiarizationConsensus.OverlapSpan(start: 3.5, end: 6, dominantSpeaker: "B")]
        XCTAssertEqual(DiarizationConsensus.overlapFraction(words: words, spans: spans), 1.0 / 3.0, accuracy: 1e-9)
    }
}
