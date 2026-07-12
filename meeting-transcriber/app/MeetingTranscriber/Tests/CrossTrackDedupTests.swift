@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

/// Pure-logic tests for cross-track echo/bleed de-duplication. A mic copy is
/// dropped only with positive loudness evidence: bleed is quieter than the
/// direct app audio. Without RMS evidence nothing is dropped, and short
/// backchannels are protected unless the echo-attenuation signature is present.
final class CrossTrackDedupTests: XCTestCase {
    private func seg(_ start: TimeInterval, _ end: TimeInterval, _ text: String, speaker: String = "Me") -> TimestampedSegment {
        TimestampedSegment(start: start, end: end, text: text, speaker: speaker)
    }

    /// A quieter-mic (bleed) RMS pair: mic well below app.
    private func bleedRMS() -> (mic: CrossTrackDedup.RMSProvider, app: CrossTrackDedup.RMSProvider) {
        ({ _ in -28 }, { _ in -18 })
    }

    // MARK: - normal-length utterances (RMS present)

    func testLongDuplicateWithBleedEvidenceDropped() {
        // >2 words, ≥1 s, mic quieter than app → bleed.
        let mic = [seg(0, 2, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let (m, a) = bleedRMS()
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a)
        XCTAssertEqual(result.droppedCount, 1)
        XCTAssertEqual(result.kept.first?.speaker, "Remote", "the app copy is the one kept")
    }

    func testLongDuplicateShiftedWithinToleranceDropped() {
        // 400 ms skew between the app sound and its mic bleed.
        let mic = [seg(0.4, 2.4, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let (m, a) = bleedRMS()
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a).droppedCount, 1)
    }

    func testLongCaseAndPunctuationInsensitiveMatchDropped() {
        let mic = [seg(0, 2, "Hello, there, world!")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let (m, a) = bleedRMS()
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a).droppedCount, 1)
    }

    func testLongLouderMicCopyRescuedAsGenuineLocalSpeech() {
        let mic = [seg(0, 2, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        // Mic is 10 dB louder than app → local speaker genuinely said it.
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in -10 }, appRMS: { _ in -20 })
        XCTAssertEqual(result.droppedCount, 0, "a >6 dB louder mic copy is kept")
    }

    func testLongMicNotSufficientlyLouderStillDropped() {
        let mic = [seg(0, 2, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        // Only 3 dB louder — below the 6 dB guard → still bleed.
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in -17 }, appRMS: { _ in -20 })
        XCTAssertEqual(result.droppedCount, 1)
    }

    // MARK: - never drop without RMS evidence

    func testLongDuplicateWithoutRmsEvidenceKept() {
        // Same words + time, but no loudness evidence (default nil providers).
        let mic = [seg(0, 2, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app)
        XCTAssertEqual(result.droppedCount, 0, "never drop a mic utterance without loudness evidence")
    }

    func testNilOnOneTrackOnlyStillKept() {
        let mic = [seg(0, 2, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        // App RMS present, mic RMS nil → not enough evidence → keep.
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in nil }, appRMS: { _ in -18 })
        XCTAssertEqual(result.droppedCount, 0)
    }

    // MARK: - short backchannels

    func testShortBackchannelWithBleedEvidenceDropped() {
        // "yeah" (1 word) that is measurably quieter than the app copy → echo.
        let mic = [seg(0, 0.5, "yeah")]
        let app = [seg(0, 0.5, "yeah", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in -30 }, appRMS: { _ in -18 })
        XCTAssertEqual(result.droppedCount, 1, "a quiet short echo is bleed")
    }

    func testShortBackchannelNotQuieterKept() {
        // Same short word but the mic copy is NOT measurably below the app copy
        // (equal loudness) → a genuine local backchannel, must be kept.
        let mic = [seg(0, 0.5, "yeah")]
        let app = [seg(0, 0.5, "yeah", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in -18 }, appRMS: { _ in -18 })
        XCTAssertEqual(result.droppedCount, 0, "a short backchannel without echo attenuation is kept")
    }

    func testShortBackchannelWithoutRmsEvidenceKept() {
        let mic = [seg(0, 0.5, "yeah")]
        let app = [seg(0, 0.5, "yeah", speaker: "Remote")]
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app).droppedCount, 0)
    }

    func testShortByDurationEvenWithManyWordsNeedsEvidence() {
        // <1 s counts as short regardless of word count — a fast phrase; not
        // quieter than app → kept.
        let mic = [seg(0, 0.8, "hello there world")]
        let app = [seg(0, 0.8, "hello there world", speaker: "Remote")]
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: { _ in -18 }, appRMS: { _ in -18 })
        XCTAssertEqual(result.droppedCount, 0)
    }

    // MARK: - double-talk and non-overlap kept

    func testDoubleTalkDifferentWordsKept() {
        let mic = [seg(0, 2, "yes I totally agree")]
        let app = [seg(0, 2, "no I strongly disagree", speaker: "Remote")]
        let (m, a) = bleedRMS()
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a)
        XCTAssertEqual(result.droppedCount, 0)
        XCTAssertEqual(result.kept.count, 2)
    }

    func testSameWordsButNoTimeOverlapKept() {
        let mic = [seg(10, 12, "hello there world")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let (m, a) = bleedRMS()
        XCTAssertEqual(CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a).droppedCount, 0)
    }

    // MARK: - aggregate stats

    func testDropRatioReported() {
        let mic = [seg(0, 2, "hello there world"), seg(3, 5, "unique local line")]
        let app = [seg(0, 2, "hello there world", speaker: "Remote")]
        let (m, a) = bleedRMS()
        let result = CrossTrackDedup.dedup(mic: mic, app: app, micRMS: m, appRMS: a)
        XCTAssertEqual(result.droppedCount, 1)
        XCTAssertEqual(result.dropRatio, 0.5, accuracy: 0.0001)
        XCTAssertEqual(result.kept.count, 2, "app copy + the unique local line")
    }

    func testEmptyInputsProduceNoDrops() {
        XCTAssertEqual(CrossTrackDedup.dedup(mic: [], app: []).droppedCount, 0)
        XCTAssertEqual(CrossTrackDedup.dedup(mic: [seg(0, 1, "hi")], app: []).kept.count, 1)
    }

    // MARK: - classification + similarity + overlap helpers

    func testIsShortByWordCountAndDuration() {
        XCTAssertTrue(CrossTrackDedup.isShort(seg(0, 3, "yeah")), "≤2 words is short")
        XCTAssertTrue(CrossTrackDedup.isShort(seg(0, 0.5, "hello there world")), "<1 s is short")
        XCTAssertFalse(CrossTrackDedup.isShort(seg(0, 2, "hello there world")), ">2 words and ≥1 s is not short")
    }

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
