@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

/// Pure-logic tests for the shared dual-track assembly both batch pipelines
/// route through (the app's live path and mt-batch's import path). Covers the
/// mic-identity prior, micDelay alignment, echo/bleed dedup, shared-room
/// diarized-mic mode, and raw-label renaming.
final class DualTrackAttributionTests: XCTestCase {
    private func word(
        _ start: TimeInterval,
        _ end: TimeInterval,
        _ text: String,
        source: WordTimeline.Track = .app,
    ) -> WordTimeline.Word {
        WordTimeline.Word(start: start, end: end, text: text, source: source)
    }

    private func turn(_ start: TimeInterval, _ end: TimeInterval, _ speaker: String) -> SpeakerSegment {
        SpeakerSegment(start: start, end: end, speaker: speaker)
    }

    // MARK: - basic dual assembly

    func testMicKeepsKnownIdentityWhenNotDiarized() {
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello"), word(1, 2, "everyone")],
            micWords: [word(3, 4, "hi", source: .mic)],
            appTurns: [turn(0, 2, "SPEAKER_0")],
            micTurns: nil,
            micLabel: "Me",
        )
        XCTAssertEqual(result.kept.count, 2)
        XCTAssertEqual(result.kept[0].speaker, "SPEAKER_0")
        XCTAssertEqual(result.kept[0].text, "hello everyone")
        XCTAssertEqual(result.kept[1].speaker, "Me")
        XCTAssertEqual(result.kept[1].text, "hi")
    }

    func testEmptyInputsProduceEmptyResult() {
        let result = DualTrackAttribution.attribute(
            appWords: [], micWords: nil, appTurns: [], micTurns: nil,
        )
        XCTAssertTrue(result.kept.isEmpty)
        XCTAssertEqual(result.micCount, 0)
    }

    // MARK: - micDelay alignment

    func testMicDelayShiftsMicOntoAppTimeline() {
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello")],
            micWords: [word(0, 1, "hi", source: .mic)],
            appTurns: [turn(0, 1, "SPEAKER_0")],
            micTurns: nil,
            micLabel: "Me",
            micDelay: 5,
        )
        let micSeg = result.kept.first { $0.speaker == "Me" }
        XCTAssertNotNil(micSeg)
        XCTAssertEqual(micSeg?.start ?? -1, 5, accuracy: 0.001, "the mic word is shifted by micDelay")
    }

    // MARK: - echo/bleed dedup

    func testEchoedMicUtteranceDropped() {
        // No headphones: the mic re-records the app's own "hello world" through
        // the speakers, so the mic copy is measurably quieter than the app copy
        // (the echo-attenuation signature). That loudness evidence — never a
        // bare text+time match — is what lets the dedup drop it.
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello"), word(1, 2, "world")],
            micWords: [word(0, 1, "hello", source: .mic), word(1, 2, "world", source: .mic)],
            appTurns: [turn(0, 2, "SPEAKER_0")],
            micTurns: nil,
            micLabel: "Me",
            micRMS: { _ in -25 },
            appRMS: { _ in -10 },
        )
        XCTAssertEqual(result.droppedCount, 1)
        XCTAssertEqual(result.kept.count, 1)
        XCTAssertEqual(result.kept[0].speaker, "SPEAKER_0")
    }

    func testLouderMicCopyRescuedFromDedup() {
        // Same words + time, but the mic copy is clearly louder → genuine local
        // speech, keep it.
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello"), word(1, 2, "world")],
            micWords: [word(0, 1, "hello", source: .mic), word(1, 2, "world", source: .mic)],
            appTurns: [turn(0, 2, "SPEAKER_0")],
            micTurns: nil,
            micLabel: "Me",
            micRMS: { _ in -5 },
            appRMS: { _ in -20 },
        )
        XCTAssertEqual(result.droppedCount, 0)
        XCTAssertEqual(result.kept.count, 2)
    }

    // MARK: - shared-room (diarized mic)

    func testDiarizedMicUsesMicTurnsNotLocalLabel() {
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "remote")],
            micWords: [word(2, 3, "alice", source: .mic), word(4, 5, "bob", source: .mic)],
            appTurns: [turn(0, 1, "SPEAKER_0")],
            micTurns: [turn(2, 3, "M0"), turn(4, 5, "M1")],
            micLabel: "Me",
        )
        let micSpeakers = Set(result.kept.map(\.speaker)).intersection(["M0", "M1"])
        XCTAssertEqual(micSpeakers, ["M0", "M1"])
        XCTAssertFalse(result.kept.contains { $0.speaker == "Me" }, "diarized mic never uses the fixed local label")
    }

    // MARK: - raw-label renaming

    func testAppNamesRenameRawLabels() {
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello")],
            micWords: nil,
            appTurns: [turn(0, 1, "SPEAKER_0")],
            micTurns: nil,
            appNames: ["SPEAKER_0": "Alice"],
        )
        XCTAssertEqual(result.kept.first?.speaker, "Alice")
    }

    // MARK: - per-segment hybrid (no word-path data loss)

    private func tseg(_ start: TimeInterval, _ end: TimeInterval, _ text: String) -> TimestampedSegment {
        TimestampedSegment(start: start, end: end, text: text, speaker: "")
    }

    func testWordlessAppSegmentRecoveredViaWholeSegment() {
        // App track has words for [0,1] but the engine failed DTW on [1,2] —
        // its text must survive through the whole-segment fallback.
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "hello")],
            micWords: [word(3, 4, "hi", source: .mic)],
            appTurns: [turn(0, 2, "SPEAKER_0")],
            micTurns: nil,
            appSegments: [tseg(0, 1, "hello"), tseg(1, 2, "dtw failed")],
            micSegments: [tseg(3, 4, "hi")],
            micLabel: "Me",
        )
        let text = result.kept.map(\.text).joined(separator: " ")
        XCTAssertTrue(text.contains("dtw failed"), "word-less app segment text preserved")
        XCTAssertTrue(text.contains("hello"))
        XCTAssertTrue(text.contains("hi"))
    }

    func testWordlessMicSegmentRecoveredUnderLocalLabel() {
        let result = DualTrackAttribution.attribute(
            appWords: [word(0, 1, "remote")],
            micWords: [], // engine emitted no mic words this run
            appTurns: [turn(0, 1, "SPEAKER_0")],
            micTurns: nil,
            appSegments: [tseg(0, 1, "remote")],
            micSegments: [tseg(2, 3, "local line")],
            micLabel: "Me",
        )
        let mine = result.kept.filter { $0.speaker == "Me" }
        XCTAssertEqual(mine.map(\.text).joined(separator: " "), "local line")
    }
}
