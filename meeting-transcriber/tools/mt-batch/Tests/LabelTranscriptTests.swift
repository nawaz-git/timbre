@testable import mt_batch
import MTPipelineCore
import XCTest

/// mt-batch's speaker-labelling glue: prefer word-level attribution when the
/// engine emitted words, fall back to per-segment assignment otherwise, and
/// the `TimedSegment` <-> `TimestampedSegment` bridge the shared core rides on.
final class LabelTranscriptTests: XCTestCase {
    private func diar(_ segs: [(Double, Double, String)]) -> DiarizationOutput {
        DiarizationOutput(
            segments: segs.map { DiarizationOutput.Segment(start: $0.0, end: $0.1, speaker: $0.2) },
            speakingTimes: [:],
            embeddings: [:],
        )
    }

    func testPrefersWordLevelWhenWordsPresent() {
        let words = [
            WordTimeline.Word(start: 0, end: 1, text: "hello", source: .app),
            WordTimeline.Word(start: 1, end: 2, text: "there", source: .app),
        ]
        let result = Transcribe.labelTranscript(
            transcript: [], words: words, diarization: diar([(0, 2, "Speaker 1")]), nameOverrides: [:],
        )
        XCTAssertEqual(result.first?.speaker, "Speaker 1")
        XCTAssertEqual(result.first?.text, "hello there")
    }

    func testFallsBackToSegmentsWhenNoWords() {
        let segs = [TimedSegment(start: 0, end: 1, text: "hello")]
        let result = Transcribe.labelTranscript(
            transcript: segs, words: [], diarization: diar([(0, 1, "Speaker 1")]), nameOverrides: [:],
        )
        XCTAssertEqual(result.first?.speaker, "Speaker 1")
        XCTAssertEqual(result.first?.text, "hello")
    }

    func testPartialWordCoverageKeepsWordlessSegmentText() {
        // The engine emitted words for the first segment but not the second
        // (partial DTW coverage). The word-only rebuild would drop the second
        // segment's text entirely; the hybrid must keep it.
        let segs = [
            TimedSegment(start: 0, end: 1, text: "hello there"),
            TimedSegment(start: 2, end: 3, text: "silent segment"),
        ]
        let words = [
            WordTimeline.Word(start: 0, end: 0.5, text: "hello", source: .app),
            WordTimeline.Word(start: 0.5, end: 1, text: "there", source: .app),
        ]
        let result = Transcribe.labelTranscript(
            transcript: segs, words: words, diarization: diar([(0, 3, "Speaker 1")]), nameOverrides: [:],
        )
        let joined = result.map(\.text).joined(separator: " ")
        XCTAssertTrue(joined.contains("hello there"), "word-covered segment attributed")
        XCTAssertTrue(joined.contains("silent segment"), "word-less segment text preserved, not dropped")
    }

    func testNameOverridesAppliedInWordPath() {
        let words = [WordTimeline.Word(start: 0, end: 1, text: "hi", source: .app)]
        let result = Transcribe.labelTranscript(
            transcript: [], words: words, diarization: diar([(0, 1, "Speaker 1")]), nameOverrides: ["Speaker 1": "Alice"],
        )
        XCTAssertEqual(result.first?.speaker, "Alice")
    }

    func testTimedSegmentBridgeRoundTrips() {
        let shared = TimestampedSegment(start: 1, end: 2, text: "x", speaker: "Bob")
        let timed = TimedSegment(shared)
        XCTAssertEqual(timed.start, 1)
        XCTAssertEqual(timed.end, 2)
        XCTAssertEqual(timed.speaker, "Bob")
        XCTAssertEqual(timed.timestamped, shared)
    }
}
