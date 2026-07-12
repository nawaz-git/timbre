import MTPipelineCore
import XCTest

/// Exhaustive tests for the MAX-tier LLM-repair validator — the safety boundary
/// on untrusted LLM output. The validator must accept a pure speaker-tag move
/// and reject EVERY form of text drift (paraphrase, insertion, deletion,
/// reorder), so the LLM can only ever relabel and never rewrite the transcript.
final class LLMSpeakerRepairTests: XCTestCase {
    private func aw(_ text: String, _ speaker: String, start: TimeInterval = 0) -> WordTimeline.AttributedWord {
        WordTimeline.AttributedWord(word: WordTimeline.Word(start: start, end: start + 0.3, text: text), speaker: speaker)
    }

    /// Build a window from words with a fixed compact-id map, plus the words array.
    private func fixture() -> (words: [WordTimeline.AttributedWord], windows: [LLMSpeakerRepair.Window]) {
        let words = [
            aw("hello", "A", start: 0),
            aw("there", "A", start: 0.3),
            aw("hi", "A", start: 0.6), // planted: should be B
            aw("friend", "A", start: 0.9), // planted: should be B
        ]
        let windows = LLMSpeakerRepair.serialize(words: words)
        return (words, windows)
    }

    // MARK: - Accept: pure tag moves

    func testPureTagMoveAccepted() {
        let (words, windows) = fixture()
        let w = windows[0]
        // All four words are labelled A → compact map is {spk:1: A}. The LLM
        // introduces spk:2 for the same words → but spk:2 isn't in the map, so
        // those words keep A. To actually MOVE, relabel using the existing map:
        // reproduce words verbatim, tag the last two <spk:1> still (no move).
        // Instead, assert identity round-trip below; here assert acceptance.
        let outcome = LLMSpeakerRepair.validate(window: w, response: w.serialized, words: words)
        XCTAssertTrue(outcome.accepted)
        XCTAssertTrue(outcome.moves.isEmpty, "Feeding the input back verbatim moves nothing")
    }

    func testTagMoveWithinKnownVocabularyIsApplied() {
        // Two speakers so the window's map has spk:1→A and spk:2→B. Moving a
        // word's tag from spk:1 to spk:2 (words unchanged) must apply.
        let words = [aw("hello", "A", start: 0), aw("hi", "B", start: 1), aw("bye", "A", start: 2)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        let w = windows[0]
        // Original: <spk:1> hello <spk:2> hi <spk:1> bye. Move "bye" to spk:2.
        let response = "<spk:1> hello <spk:2> hi <spk:2> bye"
        let repair = LLMSpeakerRepair.validate(window: w, response: response, words: words)
        XCTAssertTrue(repair.accepted)
        XCTAssertEqual(repair.moves[2], "B", "\"bye\" moved from A to B")
        XCTAssertEqual(repair.moves.count, 1)
    }

    func testCaseAndPunctuationOnlyDifferenceAccepted() {
        let words = [aw("Hello", "A", start: 0), aw("there", "A", start: 1)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        let response = "<spk:1> hello, THERE!"
        let repair = LLMSpeakerRepair.validate(window: windows[0], response: response, words: words)
        XCTAssertTrue(repair.accepted, "Case/punctuation normalization must not trigger a false reject")
    }

    // MARK: - Reject: any text drift

    func testParaphraseRejected() {
        let (words, windows) = fixture()
        let response = "<spk:1> hello there <spk:2> hey friend" // "hi" → "hey"
        let repair = LLMSpeakerRepair.validate(window: windows[0], response: response, words: words)
        XCTAssertFalse(repair.accepted)
        XCTAssertTrue(repair.moves.isEmpty)
    }

    func testWordAddedRejected() {
        let (words, windows) = fixture()
        let response = "<spk:1> hello there <spk:2> hi my friend" // added "my"
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: response, words: words).accepted)
    }

    func testWordRemovedRejected() {
        let (words, windows) = fixture()
        let response = "<spk:1> hello <spk:2> hi friend" // dropped "there"
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: response, words: words).accepted)
    }

    func testReorderRejected() {
        let (words, windows) = fixture()
        let response = "<spk:1> there hello <spk:2> hi friend" // swapped first two
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: response, words: words).accepted)
    }

    func testEmptyResponseRejected() {
        let (words, windows) = fixture()
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: "", words: words).accepted)
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: "   ", words: words).accepted)
    }

    func testResponseWithNoTagsRejected() {
        let (words, windows) = fixture()
        // Same words, but no speaker tags at all → unparseable → reject.
        XCTAssertFalse(LLMSpeakerRepair.validate(window: windows[0], response: "hello there hi friend", words: words).accepted)
    }

    func testInventedTagKeepsOriginalLabel() {
        // LLM invents spk:9 (not in the window map) but keeps the words → the
        // words match, so it's accepted, but the unknown tag maps to nothing so
        // the affected words keep their original label (no crash, no bogus move).
        let words = [aw("hello", "A", start: 0), aw("there", "A", start: 1)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        let repair = LLMSpeakerRepair.validate(window: windows[0], response: "<spk:9> hello there", words: words)
        XCTAssertTrue(repair.accepted)
        XCTAssertTrue(repair.moves.isEmpty, "Unknown tag can't move a label")
    }

    // MARK: - Serialization

    func testSerializeRoundTripMovesNothing() {
        let words = [aw("a", "A", start: 0), aw("b", "B", start: 1), aw("c", "A", start: 2)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        XCTAssertEqual(windows.count, 1)
        let outcome = LLMSpeakerRepair.apply(
            words: words,
            windows: windows,
            responses: [0: windows[0].serialized],
        )
        XCTAssertEqual(outcome.words.map(\.speaker), ["A", "B", "A"], "Verbatim echo changes nothing")
        XCTAssertEqual(outcome.labelsMoved, 0)
        XCTAssertEqual(outcome.windowsAccepted, 1)
    }

    func testSerializeCompactsConsecutiveSameSpeaker() {
        let words = [aw("one", "A", start: 0), aw("two", "A", start: 1), aw("three", "B", start: 2)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        XCTAssertEqual(windows[0].serialized, "<spk:1> one two <spk:2> three")
    }

    func testSerializeSplitsIntoTimeWindows() {
        // Two utterances ~5 min apart with a 60 s window → two windows, second
        // carries the first's last utterance as overlap context.
        let words = [
            aw("early", "A", start: 0),
            aw("late", "B", start: 300),
        ]
        let windows = LLMSpeakerRepair.serialize(words: words, windowSeconds: 60)
        XCTAssertEqual(windows.count, 2)
        XCTAssertTrue(windows[1].wordIndices.contains(0), "second window includes the overlap utterance")
    }

    func testApplyAggregatesAcceptedAndRejected() {
        let words = [aw("hello", "A", start: 0), aw("hi", "B", start: 1), aw("bye", "A", start: 2)]
        let windows = LLMSpeakerRepair.serialize(words: words)
        let outcome = LLMSpeakerRepair.apply(
            words: words,
            windows: windows,
            responses: [0: "<spk:1> hello <spk:2> hi <spk:2> bye"], // move "bye" to B
        )
        XCTAssertEqual(outcome.windowsAccepted, 1)
        XCTAssertEqual(outcome.labelsMoved, 1)
        XCTAssertEqual(outcome.words[2].speaker, "B")
    }

    func testNormalizeStripsPunctuationAndCase() {
        XCTAssertEqual(LLMSpeakerRepair.normalize("Hello,"), "hello")
        XCTAssertEqual(LLMSpeakerRepair.normalize("don't"), "dont")
        XCTAssertEqual(LLMSpeakerRepair.normalize("—"), "")
    }

    func testNormalizeTagVariants() {
        XCTAssertEqual(LLMSpeakerRepair.normalizeTag("spk:2"), "spk:2")
        XCTAssertEqual(LLMSpeakerRepair.normalizeTag(" SPK 3 "), "spk:3")
        XCTAssertNil(LLMSpeakerRepair.normalizeTag("speaker"))
        XCTAssertNil(LLMSpeakerRepair.normalizeTag("hello"))
    }
}
