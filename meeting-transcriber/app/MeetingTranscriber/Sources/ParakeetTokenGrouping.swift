import FluidAudio
import Foundation

/// Pure token-grouping logic for Parakeet ASR output.
///
/// Extracted from `ParakeetEngine` so the segmentation rules (sentence-end
/// punctuation, 20-token cap) can be unit-tested without loading a model.
enum ParakeetTokenGrouping {
    /// Maximum tokens per segment before forcing a split — keeps segments
    /// short enough that they remain useful for the protocol generator
    /// even when the model emits long runs without terminal punctuation.
    static let maxTokensPerSegment = 20

    /// Group token-level timings into sentence-level `TimestampedSegment`s.
    ///
    /// Ends a segment at sentence-terminating punctuation (`. ! ?`) or
    /// after `maxTokensPerSegment` tokens, whichever comes first. Tokens
    /// that are blank after whitespace-trimming are skipped entirely.
    static func groupIntoSegments(_ timings: [TokenTiming]) -> [TimestampedSegment] {
        var segments: [TimestampedSegment] = []
        var group: [TokenTiming] = []

        for timing in timings {
            let token = timing.token
            guard !token.trimmingCharacters(in: CharacterSet.whitespaces).isEmpty else { continue }
            group.append(timing)

            let endsWithPunct = token.hasSuffix(".") || token.hasSuffix("!") || token.hasSuffix("?")
            if endsWithPunct || group.count >= maxTokensPerSegment {
                if let seg = makeSegment(from: group) { segments.append(seg) }
                group = []
            }
        }
        if let seg = makeSegment(from: group) { segments.append(seg) }

        return segments
    }

    /// Build a `TimestampedSegment` from a contiguous group of token timings.
    /// Returns nil if `timings` is empty or yields an all-whitespace text.
    static func makeSegment(from timings: [TokenTiming]) -> TimestampedSegment? {
        guard !timings.isEmpty else { return nil }
        let text = timings.map(\.token).joined().trimmingCharacters(in: CharacterSet.whitespaces)
        guard !text.isEmpty else { return nil }
        // swiftlint:disable:next force_unwrapping
        return TimestampedSegment(start: timings.first!.startTime, end: timings.last!.endTime, text: text)
    }

    /// Detokenize SentencePiece token timings into word-level
    /// `WordTimeline.Word`s for word-level speaker attribution.
    ///
    /// FluidAudio's Parakeet tokenizer marks a word boundary with a leading
    /// space or `▁` (U+2581) on the first sub-token of the word; continuation
    /// sub-tokens carry neither. Each word spans from the start time of its
    /// first sub-token to the end time of its last, and takes the mean of the
    /// sub-token confidences as its probability. Pure so it unit-tests without
    /// a model.
    static func groupIntoWords(_ timings: [TokenTiming], source: WordTimeline.Track) -> [WordTimeline.Word] {
        var words: [WordTimeline.Word] = []
        var tokens: [String] = []
        var start: TimeInterval = 0
        var end: TimeInterval = 0
        var confidences: [Float] = []

        func flush() {
            defer { tokens = []; confidences = [] }
            let text = tokens.joined()
                .replacingOccurrences(of: "\u{2581}", with: " ")
                .trimmingCharacters(in: CharacterSet.whitespaces)
            guard !text.isEmpty else { return }
            let probability = confidences.isEmpty ? nil : confidences.reduce(0, +) / Float(confidences.count)
            words.append(WordTimeline.Word(start: start, end: end, text: text, probability: probability, source: source))
        }

        for timing in timings {
            let startsWord = timing.token.hasPrefix(" ") || timing.token.hasPrefix("\u{2581}")
            if startsWord, !tokens.isEmpty { flush() }
            if tokens.isEmpty { start = timing.startTime }
            tokens.append(timing.token)
            end = timing.endTime
            confidences.append(timing.confidence)
        }
        flush()
        return words
    }
}
