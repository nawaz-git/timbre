@testable import MeetingTranscriber
import XCTest

/// Pure-logic tests for cross-track echo/bleed de-duplication. Duplicates
/// (same words, overlapping time) must drop; genuine double-talk (different
/// words) must survive; a clearly-louder mic copy is rescued.
final class CrossTrackDedupTests: XCTestCase {
    private func seg(_ start: TimeInterval, _ end: TimeInterval, _ text: String, speaker: String = "Me") -> TimestampedSegment {
        TimestampedSegment(start: start, end: end, text: text, speaker: speaker)
    }

    // MARK: - duplicates dropped

    func testExactDuplicateMicUtteranceDropped() {
        let mic = [seg(0, 2, "hello world")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app)
        XCTAssertEqual(result.droppedCount, 1)
        XCTAssertEqual(result.kept.count, 1)
        XCTAssertEqual(result.kept.first?.speaker, "Remote", "the app copy is the one kept")
    }

    func testDuplicateShiftedWithinToleranceDropped() {
        // 400 ms skew between the app sound and its mic bleed.
        let mic = [seg(0.4, 2.4, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app)
        XCTAssertEqual(result.droppedCount, 1)
    }

    func testCaseAndPunctuationInsensitiveMatchDropped() {
        let mic = [seg(0, 2, "Hello, world!")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app).droppedCount, 1)
    }

    // MARK: - double-talk and non-overlap kept

    func testDoubleTalkDifferentWordsKept() {
        let mic = [seg(0, 2, "yes I totally agree")]
        let app = [seg(0, 2, "no I strongly disagree", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app)
        XCTAssertEqual(result.droppedCount, 0)
        XCTAssertEqual(result.kept.count, 2)
    }

    func testSameWordsButNoTimeOverlapKept() {
        let mic = [seg(10, 12, "hello world")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app).droppedCount, 0)
    }

    // MARK: - RMS guard

    func testLouderMicCopyRescuedAsGenuineLocalSpeech() {
        let mic = [seg(0, 2, "hello world")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        // Mic is 10 dB louder than app → local speaker genuinely said it.
        let result = CrossTrackDedup.dedup(
            mic: mic, app: app,
            micRMS: { _ in -10 },
            appRMS: { _ in -20 },
        )
        XCTAssertEqual(result.droppedCount, 0, "a >6 dB louder mic copy is kept")
    }

    func testMicNotSufficientlyLouderStillDropped() {
        let mic = [seg(0, 2, "hello world")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        // Only 3 dB louder — below the 6 dB guard → still bleed.
        let result = CrossTrackDedup.dedup(
            mic: mic, app: app,
            micRMS: { _ in -17 },
            appRMS: { _ in -20 },
        )
        XCTAssertEqual(result.droppedCount, 1)
    }

    // MARK: - aggregate stats

    func testDropRatioReported() {
        let mic = [seg(0, 2, "hello world"), seg(3, 5, "unique local line")]
        let app = [seg(0, 2, "hello world", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app)
        XCTAssertEqual(result.droppedCount, 1)
        XCTAssertEqual(result.dropRatio, 0.5, accuracy: 0.0001)
        XCTAssertEqual(result.kept.count, 2, "app copy + the unique local line")
    }

    func testEmptyInputsProduceNoDrops() {
        XCTAssertEqual(CrossTrackDedup.dedup(mic: [], app: []).droppedCount, 0)
        XCTAssertEqual(CrossTrackDedup.dedup(mic: [seg(0, 1, "hi")], app: []).kept.count, 1)
    }

    // MARK: - similarity + overlap helpers

    func testTokenSimilarityIdenticalIsOne() {
        XCTAssertEqual(CrossTrackDedup.tokenSimilarity("Hello, World", "hello world"), 1.0, accuracy: 0.0001)
    }

    func testTokenSimilarityDisjointIsZero() {
        XCTAssertEqual(CrossTrackDedup.tokenSimilarity("cat dog", "fish bird"), 0.0, accuracy: 0.0001)
    }

    func testTimeOverlapRatioFullContainment() {
        XCTAssertEqual(
            CrossTrackDedup.timeOverlapRatio(seg(0, 4, "x"), seg(1, 2, "y")),
            1.0, accuracy: 0.0001, "shorter segment fully inside the longer → 1.0",
        )
    }
}
