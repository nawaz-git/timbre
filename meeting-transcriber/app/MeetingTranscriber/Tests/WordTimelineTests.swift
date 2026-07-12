@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

/// Pure-logic tests for `WordTimeline` — the word-level speaker-attribution
/// core. No model or CoreML involved. The four headline cases from the spec
/// are called out explicitly; the rest pin the exclusive-timeline, assignment,
/// and re-segmentation helpers individually.
final class WordTimelineTests: XCTestCase {
    private typealias Seg = DiarizationResult.Segment

    private func word(
        _ start: TimeInterval,
        _ end: TimeInterval,
        _ text: String = "w",
        prob: Float? = nil,
        source: WordTimeline.Track = .app,
    ) -> WordTimeline.Word {
        WordTimeline.Word(start: start, end: end, text: text, probability: prob, source: source)
    }

    // MARK: - (a) a long ASR segment spanning A→B splits at the boundary

    func testLongSegmentSpanningTwoSpeakersSplitsAtBoundary() {
        // Diarization: A owns [0,5), B owns [5,10). One "ASR segment" worth of
        // words at 1 s cadence straddles the boundary.
        let turns = WordTimeline.exclusiveTurns(from: [Seg(start: 0, end: 5, speaker: "A"), Seg(start: 5, end: 10, speaker: "B")])
        let words = (0 ..< 10).map { i in word(Double(i), Double(i) + 1, "w\(i)") }

        let utterances = WordTimeline.utterances(from: WordTimeline.assign(words: words, turns: turns))

        XCTAssertEqual(utterances.count, 2, "words must split into one A utterance and one B utterance")
        XCTAssertEqual(utterances[0].speaker, "A")
        XCTAssertEqual(utterances[1].speaker, "B")
        XCTAssertEqual(utterances[0].end, 5, accuracy: 0.001, "A utterance ends at the turn boundary")
        XCTAssertEqual(utterances[1].start, 5, accuracy: 0.001, "B utterance starts at the turn boundary")
    }

    // MARK: - (b) a 0.3 s backchannel inside A's turn does not fragment it

    func testShortBackchannelInsideTurnDoesNotFragment() {
        // Diarization produced a 0.3 s "B" sliver inside A's long turn.
        let segments = [Seg(start: 0, end: 10, speaker: "A"), Seg(start: 4.0, end: 4.3, speaker: "B")]
        let turns = WordTimeline.exclusiveTurns(from: segments)

        XCTAssertEqual(turns, [WordTimeline.Turn(start: 0, end: 10, speaker: "A")],
                       "the sub-0.4 s B sliver is absorbed into A")

        // The backchannel word ("yeah") sits inside the sliver's time span.
        // Words are contiguous (sub-0.8 s gaps) so only the speaker rule, not
        // the pause rule, decides fragmentation.
        let words = [word(3.5, 4.0, "hello"), word(4.05, 4.25, "yeah"), word(4.3, 4.8, "world")]
        let utterances = WordTimeline.utterances(from: WordTimeline.assign(words: words, turns: turns))

        XCTAssertEqual(utterances.count, 1)
        XCTAssertEqual(utterances[0].speaker, "A")
        XCTAssertEqual(utterances[0].text, "hello yeah world")
    }

    // MARK: - (c) a word beyond 1.5 s of any turn falls back to the nearest

    func testWordFarFromAnyTurnFallsBackToNearest() {
        let turns = [WordTimeline.Turn(start: 0, end: 2, speaker: "A"), WordTimeline.Turn(start: 10, end: 12, speaker: "B")]
        // Midpoint 5.1: 3.1 s past A, 4.9 s before B → nearest is A.
        let attributed = WordTimeline.assign(words: [word(5, 5.2)], turns: turns)

        XCTAssertEqual(attributed.first?.speaker, "A")
    }

    // MARK: - (d) exclusive-turn tie-breaking: later start wins the overlap

    func testExclusiveTurnsLaterStartWinsOverlap() {
        // A [0,5] and B [3,8] overlap on [3,5]; B started later → B owns it.
        let turns = WordTimeline.exclusiveTurns(from: [Seg(start: 0, end: 5, speaker: "A"), Seg(start: 3, end: 8, speaker: "B")])

        XCTAssertEqual(turns, [
            WordTimeline.Turn(start: 0, end: 3, speaker: "A"),
            WordTimeline.Turn(start: 3, end: 8, speaker: "B"),
        ])
    }

    // MARK: - exclusiveTurns edge cases

    func testExclusiveTurnsEmptyInput() {
        XCTAssertEqual(WordTimeline.exclusiveTurns(from: []), [])
    }

    func testExclusiveTurnsDropsZeroLengthSegments() {
        let turns = WordTimeline.exclusiveTurns(from: [Seg(start: 2, end: 2, speaker: "A"), Seg(start: 0, end: 3, speaker: "B")])
        XCTAssertEqual(turns, [WordTimeline.Turn(start: 0, end: 3, speaker: "B")])
    }

    func testExclusiveTurnsCoalescesAdjacentSameSpeaker() {
        // Two touching A segments with a B in between that is long enough to survive.
        let turns = WordTimeline.exclusiveTurns(from: [
            Seg(start: 0, end: 3, speaker: "A"),
            Seg(start: 3, end: 5, speaker: "B"),
            Seg(start: 5, end: 8, speaker: "A"),
        ])
        XCTAssertEqual(turns, [
            WordTimeline.Turn(start: 0, end: 3, speaker: "A"),
            WordTimeline.Turn(start: 3, end: 5, speaker: "B"),
            WordTimeline.Turn(start: 5, end: 8, speaker: "A"),
        ])
    }

    func testShortTurnAtStartAbsorbedIntoOnlyNeighbour() {
        // Leading 0.2 s A sliver with no left neighbour → absorbed into B.
        let turns = WordTimeline.exclusiveTurns(from: [
            Seg(start: 0, end: 0.2, speaker: "A"),
            Seg(start: 0.2, end: 5, speaker: "B"),
        ])
        XCTAssertEqual(turns, [WordTimeline.Turn(start: 0, end: 5, speaker: "B")])
    }

    // MARK: - assignment

    func testAssignMidpointInsideTurnWins() {
        let turns = [WordTimeline.Turn(start: 0, end: 5, speaker: "A"), WordTimeline.Turn(start: 5, end: 10, speaker: "B")]
        // Word [4.5,5.5] straddles the boundary; midpoint 5.0 lands in B.
        XCTAssertEqual(WordTimeline.assign(words: [word(4.5, 5.5)], turns: turns).first?.speaker, "B")
    }

    func testAssignWithNoTurnsYieldsEmptySpeaker() {
        XCTAssertEqual(WordTimeline.assign(words: [word(0, 1)], turns: []).first?.speaker, "")
    }

    // MARK: - utterances re-segmentation

    func testUtterancesBreakOnConfidentSpeakerChange() {
        let attributed = [
            WordTimeline.AttributedWord(word: word(0, 1, "hello", prob: 0.9), speaker: "A"),
            WordTimeline.AttributedWord(word: word(1, 2, "there", prob: 0.9), speaker: "B"),
        ]
        let utterances = WordTimeline.utterances(from: attributed)
        XCTAssertEqual(utterances.map(\.speaker), ["A", "B"])
    }

    func testUtterancesBreakOnLongPauseSameSpeaker() {
        // 1.0 s gap > 0.8 s default → same speaker, but two utterances.
        let attributed = [
            WordTimeline.AttributedWord(word: word(0, 1, "one"), speaker: "A"),
            WordTimeline.AttributedWord(word: word(2, 3, "two"), speaker: "A"),
        ]
        XCTAssertEqual(WordTimeline.utterances(from: attributed).count, 2)
    }

    func testLowProbabilityWordInheritsUtteranceSpeaker() {
        // The middle word is assigned "B" but its confidence is below the
        // threshold, so it must not fragment A's utterance.
        let attributed = [
            WordTimeline.AttributedWord(word: word(0, 1, "hello", prob: 0.9), speaker: "A"),
            WordTimeline.AttributedWord(word: word(1, 2, "uhh", prob: 0.1), speaker: "B"),
            WordTimeline.AttributedWord(word: word(2, 3, "world", prob: 0.9), speaker: "A"),
        ]
        let utterances = WordTimeline.utterances(from: attributed)
        XCTAssertEqual(utterances.count, 1)
        XCTAssertEqual(utterances[0].speaker, "A")
        XCTAssertEqual(utterances[0].text, "hello uhh world")
    }

    func testUtterancesEmptyInput() {
        XCTAssertEqual(WordTimeline.utterances(from: []).count, 0)
    }

    func testJoinWordsCollapsesSpacingAndPunctuation() {
        XCTAssertEqual(WordTimeline.joinWords(["hello", "world", ","]), "hello world,")
        XCTAssertEqual(WordTimeline.joinWords(["  a ", " b"]), "a b")
    }

    // MARK: - Word.shifted (micDelay alignment)

    func testWordShiftedByDelta() {
        let shifted = word(1, 2, "x", prob: 0.5, source: .mic).shifted(by: 0.25)
        XCTAssertEqual(shifted.start, 1.25, accuracy: 0.0001)
        XCTAssertEqual(shifted.end, 2.25, accuracy: 0.0001)
        XCTAssertEqual(shifted.source, .mic)
        XCTAssertEqual(shifted.probability, 0.5)
    }

    // MARK: - attribute() convenience + name mapping

    func testAttributeAppliesTurnSpeakerMap() {
        let words = [word(0.5, 1.0, "hi"), word(6, 7, "bye")]
        let segments = [Seg(start: 0, end: 5, speaker: "SPEAKER_0"), Seg(start: 5, end: 10, speaker: "SPEAKER_1")]
        let out = WordTimeline.attribute(
            words: words,
            diarization: segments,
            turnSpeakerMap: ["SPEAKER_0": "Alice", "SPEAKER_1": "Bob"],
        )
        XCTAssertEqual(out.map(\.speaker), ["Alice", "Bob"])
    }

    // MARK: - Whole-segment fallback + per-segment hybrid (no word-path data loss)

    private func seg(_ start: TimeInterval, _ end: TimeInterval, _ text: String, _ speaker: String = "") -> TimestampedSegment {
        TimestampedSegment(start: start, end: end, text: text, speaker: speaker)
    }

    func testAssignWholeSegmentsMaxOverlapAndNearestFallback() {
        let segs = [seg(0, 2, "a"), seg(2, 4, "b"), seg(10, 11, "c")]
        let diar = [SpeakerSegment(start: 0, end: 3, speaker: "SPEAKER_0"),
                    SpeakerSegment(start: 3, end: 5, speaker: "SPEAKER_1")]
        let out = WordTimeline.assignWholeSegments(
            segments: segs, diarization: diar,
            turnSpeakerMap: ["SPEAKER_0": "Alice", "SPEAKER_1": "Bob"],
        )
        // a overlaps SPEAKER_0 fully; b overlaps SPEAKER_0 more than SPEAKER_1;
        // c overlaps nothing → nearest turn (SPEAKER_1 ends at 5, gap 5) wins.
        XCTAssertEqual(out.map(\.speaker), ["Alice", "Alice", "Bob"])
        XCTAssertEqual(out.map(\.text), ["a", "b", "c"])
    }

    func testSegmentsWithoutWordCoverageDetectsGaps() {
        let segs = [seg(0, 2, "covered"), seg(2, 4, "gap"), seg(4, 6, "covered2")]
        let words = [word(0.5, 1.0), word(4.5, 5.0)] // midpoints land in seg 0 and seg 2
        let uncovered = WordTimeline.segmentsWithoutWordCoverage(segs, words: words)
        XCTAssertEqual(uncovered.map(\.text), ["gap"])
    }

    func testAttributeHybridRecoversWordlessSegmentText() {
        // The engine emitted words for the first and third segment but failed
        // DTW on the middle one — its text must survive via whole-segment
        // assignment instead of vanishing from the word-only rebuild.
        let segs = [seg(0, 2, "hello"), seg(2, 4, "dropped middle"), seg(4, 6, "world")]
        let words = [word(0.5, 1.5, "hello"), word(4.5, 5.5, "world")]
        let diar = [SpeakerSegment(start: 0, end: 6, speaker: "SPEAKER_0")]
        let out = WordTimeline.attributeHybrid(segments: segs, words: words, diarization: diar)
        let joined = out.map(\.text).joined(separator: " ")
        XCTAssertTrue(joined.contains("dropped middle"), "word-less segment text preserved")
        XCTAssertTrue(joined.contains("hello"))
        XCTAssertTrue(joined.contains("world"))
    }

    func testAttributeHybridEmptyWordsEqualsWholeSegmentPath() {
        // An empty (non-nil) word list must degenerate to the whole-segment
        // path, NOT produce an empty transcript (the data-loss regression).
        let segs = [seg(0, 2, "one"), seg(2, 4, "two")]
        let diar = [SpeakerSegment(start: 0, end: 2, speaker: "SPEAKER_0"),
                    SpeakerSegment(start: 2, end: 4, speaker: "SPEAKER_1")]
        let hybrid = WordTimeline.attributeHybrid(segments: segs, words: [], diarization: diar)
        let whole = WordTimeline.assignWholeSegments(segments: segs, diarization: diar)
        XCTAssertEqual(hybrid.map(\.text), whole.map(\.text))
        XCTAssertEqual(hybrid.map(\.text), ["one", "two"])
        XCTAssertEqual(hybrid.map(\.speaker), ["SPEAKER_0", "SPEAKER_1"])
    }

    func testAttributeHybridFullCoverageMatchesWordPath() {
        // With full word coverage the hybrid must equal the pure word path.
        let segs = [seg(0, 5, "hi there"), seg(5, 10, "bye now")]
        let words = [word(0.5, 1.0, "hi"), word(1.0, 1.5, "there"), word(6, 6.5, "bye"), word(6.5, 7, "now")]
        let diar = [SpeakerSegment(start: 0, end: 5, speaker: "A"), SpeakerSegment(start: 5, end: 10, speaker: "B")]
        let hybrid = WordTimeline.attributeHybrid(segments: segs, words: words, diarization: diar)
        let pure = WordTimeline.attribute(words: words, diarization: diar)
        XCTAssertEqual(hybrid, pure)
    }

    func testAttributeToSpeakerRecoversWordlessMicSegment() {
        let segs = [seg(0, 2, "spoken"), seg(2, 4, "silent DTW fail")]
        let words = [word(0.5, 1.5, "spoken", source: .mic)]
        let out = WordTimeline.attributeToSpeaker(segments: segs, words: words, speaker: "Me")
        XCTAssertTrue(out.allSatisfy { $0.speaker == "Me" })
        let joined = out.map(\.text).joined(separator: " ")
        XCTAssertTrue(joined.contains("spoken"))
        XCTAssertTrue(joined.contains("silent DTW fail"), "word-less mic segment text preserved")
    }
}
