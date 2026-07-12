import Foundation

/// A non-overlapping diarization interval: one speaker holding the floor over
/// `[start, end)`. The shared word-attribution input, decoupled from either
/// consumer's richer diarization-result type (the app's `DiarizationResult`
/// carries CoreML embeddings; mt-batch's `DiarizationOutput` carries speaking
/// times). Both map their segments onto this at the boundary.
public struct SpeakerSegment: Equatable, Sendable {
    public let start: TimeInterval
    public let end: TimeInterval
    public let speaker: String

    public init(start: TimeInterval, end: TimeInterval, speaker: String) {
        self.start = start
        self.end = end
        self.speaker = speaker
    }
}

/// Pure, model-free word-level speaker attribution.
///
/// The batch pipeline historically assigned a speaker to each *ASR segment*
/// by maximum temporal overlap with the diarization output. That loses every
/// turn boundary that falls *inside* one ASR segment: a 10 s Whisper segment
/// that starts with speaker A and ends with speaker B is attributed wholesale
/// to whichever speaker overlaps it most, absorbing the other speaker's words.
///
/// `WordTimeline` fixes this by attributing at *word* granularity against an
/// **exclusive** (non-overlapping) turn timeline, then re-segmenting the
/// attributed words into display utterances. Three pure stages:
///
///   1. `exclusiveTurns(from:)` — collapse possibly-overlapping diarization
///      segments into a non-overlapping turn timeline (pyannote-4 "exclusive"
///      insight: during an overlap the later-starting speaker wins), then
///      absorb sub-`minTurn` slivers into a neighbour (DiariZen min-duration).
///   2. `assign(words:turns:)` — give each word the speaker of the turn that
///      contains its midpoint, falling back to the nearest turn otherwise.
///   3. `utterances(from:maxPause:)` — re-chunk consecutive same-speaker words
///      into `TimestampedSegment`s, breaking on speaker change or a pause
///      longer than `maxPause`.
///
/// All three are static + side-effect-free so they unit-test without CoreML.
public enum WordTimeline {
    /// Turns shorter than this (seconds) are absorbed into a neighbouring turn.
    /// A 0.3 s backchannel ("yeah", "mm-hm") should not fragment the dominant
    /// speaker's utterance. Matches the plan's 0.4 s min-turn.
    public static let minTurnSeconds: TimeInterval = 0.4

    /// Words whose decoder confidence is below this never *start* a new
    /// utterance or trigger a speaker-change break — they inherit the
    /// surrounding utterance's speaker instead of fragmenting it on a
    /// low-confidence mis-attribution. `nil` probability (engine emits none)
    /// counts as confident. Mirrors the plan's `probability < 0.2` guard.
    public static let lowProbabilityThreshold: Float = 0.2

    /// Default maximum intra-utterance pause (seconds) before a same-speaker
    /// run is split into a new utterance for readability.
    public static let defaultMaxPause: TimeInterval = 0.8

    /// Which capture track a word came from. In the dual-source pipeline the
    /// mic track is the known local speaker and the app track carries the
    /// remote speakers; downstream stages exploit that prior.
    public enum Track: String, Codable, Sendable {
        case mic
        case app
    }

    /// A single transcribed word with timing and optional decoder confidence.
    public struct Word: Equatable, Sendable {
        public let start: TimeInterval
        public let end: TimeInterval
        public let text: String
        /// Per-word decoder confidence in 0…1, or `nil` when the engine does
        /// not emit it (treated as confident).
        public let probability: Float?
        public let source: Track

        public init(
            start: TimeInterval,
            end: TimeInterval,
            text: String,
            probability: Float? = nil,
            source: Track = .app,
        ) {
            self.start = start
            self.end = end
            self.text = text
            self.probability = probability
            self.source = source
        }

        /// Midpoint of the word, used as its attribution anchor. A word is
        /// assigned to the turn that contains its midpoint — more robust than
        /// the start or end when a word straddles a boundary.
        public var midpoint: TimeInterval { (start + end) / 2 }

        /// Return a copy shifted by `delta` seconds (used to align mic-track
        /// words onto the global timeline via `micDelay`).
        public func shifted(by delta: TimeInterval) -> Word {
            Word(start: start + delta, end: end + delta, text: text, probability: probability, source: source)
        }
    }

    /// A non-overlapping speaker turn on one track's exclusive timeline.
    public struct Turn: Equatable, Sendable {
        public let start: TimeInterval
        public let end: TimeInterval
        public let speaker: String

        public init(start: TimeInterval, end: TimeInterval, speaker: String) {
            self.start = start
            self.end = end
            self.speaker = speaker
        }

        public var duration: TimeInterval { end - start }
    }

    /// A word after speaker attribution.
    public struct AttributedWord: Equatable, Sendable {
        public let word: Word
        public var speaker: String

        public init(word: Word, speaker: String) {
            self.word = word
            self.speaker = speaker
        }
    }

    /// Minimal per-sub-token timing, decoupling word grouping from any specific
    /// ASR engine's token type (FluidAudio's `TokenTiming`, WhisperKit's word
    /// timings, …). Consumers map their engine's token onto this so the
    /// SentencePiece detokenization rule lives here once.
    public struct SubwordToken: Equatable, Sendable {
        public let token: String
        public let start: TimeInterval
        public let end: TimeInterval
        public let confidence: Float

        public init(token: String, start: TimeInterval, end: TimeInterval, confidence: Float) {
            self.token = token
            self.start = start
            self.end = end
            self.confidence = confidence
        }
    }

    // MARK: - Stage 1: exclusive turn timeline

    /// Collapse possibly-overlapping diarization segments into a
    /// non-overlapping turn timeline.
    ///
    /// Overlap resolution: at every instant covered by ≥2 segments the
    /// **later-starting** segment wins (an interrupter takes the floor). The
    /// timeline is then coalesced across equal-speaker runs and any turn
    /// shorter than `minTurn` is absorbed into its longer neighbour.
    public static func exclusiveTurns(
        from segments: [SpeakerSegment],
        minTurn: TimeInterval = minTurnSeconds,
    ) -> [Turn] {
        let valid = segments.filter { $0.end > $0.start }
        guard !valid.isEmpty else { return [] }

        // Sub-divide the timeline at every segment boundary, then pick the
        // winning speaker per atomic interval by "latest start wins".
        let breakpoints = Set(valid.flatMap { [$0.start, $0.end] }).sorted()
        var raw: [Turn] = []
        for i in 0 ..< (breakpoints.count - 1) {
            let lo = breakpoints[i]
            let hi = breakpoints[i + 1]
            guard hi > lo else { continue }
            let mid = (lo + hi) / 2
            let covering = valid.filter { $0.start <= mid && mid < $0.end }
            guard let winner = covering.max(by: { $0.start < $1.start }) else { continue }
            raw.append(Turn(start: lo, end: hi, speaker: winner.speaker))
        }

        return absorbShortTurns(coalesce(raw), minTurn: minTurn)
    }

    /// Merge adjacent turns that share a speaker (and touch) into one.
    public static func coalesce(_ turns: [Turn]) -> [Turn] {
        guard var current = turns.first else { return [] }
        var out: [Turn] = []
        for turn in turns.dropFirst() {
            if turn.speaker == current.speaker, turn.start <= current.end + 1e-6 {
                current = Turn(start: current.start, end: max(current.end, turn.end), speaker: current.speaker)
            } else {
                out.append(current)
                current = turn
            }
        }
        out.append(current)
        return out
    }

    /// Reassign every turn shorter than `minTurn` to its longer neighbour,
    /// re-coalescing after each move. Iterates until no sub-`minTurn` turn
    /// remains or a single turn is left. Each iteration strictly reduces the
    /// turn count, so it always terminates.
    private static func absorbShortTurns(_ input: [Turn], minTurn: TimeInterval) -> [Turn] {
        var turns = input
        while turns.count > 1 {
            guard let idx = turns.firstIndex(where: { $0.duration < minTurn }) else { break }
            let prev = idx > 0 ? turns[idx - 1] : nil
            let next = idx < turns.count - 1 ? turns[idx + 1] : nil
            let targetSpeaker: String
            switch (prev, next) {
            case let (p?, n?): targetSpeaker = p.duration >= n.duration ? p.speaker : n.speaker
            case let (p?, nil): targetSpeaker = p.speaker
            case let (nil, n?): targetSpeaker = n.speaker
            case (nil, nil): return turns
            }
            turns[idx] = Turn(start: turns[idx].start, end: turns[idx].end, speaker: targetSpeaker)
            let coalesced = coalesce(turns)
            // Guard against a pathological no-progress case (shouldn't happen:
            // reassigning to a neighbour's speaker always creates an adjacency).
            if coalesced.count == turns.count { break }
            turns = coalesced
        }
        return turns
    }

    // MARK: - Stage 2: per-word assignment

    /// Attribute each word to a speaker: the turn containing the word's
    /// midpoint, or — when no turn contains it — the nearest turn by time gap.
    /// Words beyond `~1.5 s` of any turn still fall back to the nearest turn
    /// (best-effort) rather than going unlabelled.
    public static func assign(words: [Word], turns: [Turn]) -> [AttributedWord] {
        guard !turns.isEmpty else {
            return words.map { AttributedWord(word: $0, speaker: "") }
        }
        return words.map { word in
            let mid = word.midpoint
            if let containing = turns.first(where: { mid >= $0.start && mid < $0.end }) {
                return AttributedWord(word: word, speaker: containing.speaker)
            }
            var best = turns[0]
            var bestGap = gap(mid, to: best)
            for turn in turns.dropFirst() {
                let g = gap(mid, to: turn)
                if g < bestGap {
                    bestGap = g
                    best = turn
                }
            }
            return AttributedWord(word: word, speaker: best.speaker)
        }
    }

    private static func gap(_ time: TimeInterval, to turn: Turn) -> TimeInterval {
        if time < turn.start { return turn.start - time }
        if time > turn.end { return time - turn.end }
        return 0
    }

    // MARK: - Stage 3: re-segment into utterances

    /// Re-chunk attributed words into display utterances. A new utterance
    /// starts on a speaker change (from a *confident* word) or a pause longer
    /// than `maxPause`. Low-confidence words never start a speaker change —
    /// they inherit the current utterance's speaker.
    public static func utterances(
        from attributed: [AttributedWord],
        maxPause: TimeInterval = defaultMaxPause,
    ) -> [TimestampedSegment] {
        guard let first = attributed.first else { return [] }

        var result: [TimestampedSegment] = []
        var speaker = first.speaker
        var start = first.word.start
        var end = first.word.end
        var texts = [first.word.text]
        var lastEnd = first.word.end

        for attr in attributed.dropFirst() {
            let word = attr.word
            let isLowProb = (word.probability ?? 1) < lowProbabilityThreshold
            let pauseBreak = (word.start - lastEnd) > maxPause
            let speakerBreak = !isLowProb && attr.speaker != speaker

            if speakerBreak || pauseBreak {
                result.append(TimestampedSegment(start: start, end: end, text: joinWords(texts), speaker: speaker))
                // A low-prob word that only broke on a pause keeps the prior
                // speaker; a confident speaker change adopts the new speaker.
                speaker = isLowProb ? speaker : attr.speaker
                start = word.start
                end = word.end
                texts = [word.text]
            } else {
                end = word.end
                texts.append(word.text)
            }
            lastEnd = word.end
        }
        result.append(TimestampedSegment(start: start, end: end, text: joinWords(texts), speaker: speaker))
        return result
    }

    /// Join word tokens into utterance text: single-space separated, collapsed
    /// whitespace, no space before trailing punctuation. Engines are expected
    /// to hand over already-trimmed word tokens; this stays defensive anyway.
    public static func joinWords(_ texts: [String]) -> String {
        texts.joined(separator: " ")
            .replacingOccurrences(of: " +", with: " ", options: .regularExpression)
            .replacingOccurrences(of: #" ([,.!?;:])"#, with: "$1", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Sub-token → word grouping

    /// Detokenize SentencePiece sub-token timings into word-level `Word`s.
    ///
    /// A word boundary is marked by a leading space or `▁` (U+2581) on the
    /// first sub-token of the word; continuation sub-tokens carry neither. Each
    /// word spans from the start time of its first sub-token to the end time of
    /// its last, and takes the mean of the sub-token confidences as its
    /// probability. Pure so it unit-tests without a model; the FluidAudio
    /// `TokenTiming` → `SubwordToken` mapping lives in each consumer.
    public static func words(fromTokens tokens: [SubwordToken], source: Track) -> [Word] {
        var words: [Word] = []
        var group: [String] = []
        var start: TimeInterval = 0
        var end: TimeInterval = 0
        var confidences: [Float] = []

        func flush() {
            defer { group = []; confidences = [] }
            let text = group.joined()
                .replacingOccurrences(of: "\u{2581}", with: " ")
                .trimmingCharacters(in: CharacterSet.whitespaces)
            guard !text.isEmpty else { return }
            let probability = confidences.isEmpty ? nil : confidences.reduce(0, +) / Float(confidences.count)
            words.append(Word(start: start, end: end, text: text, probability: probability, source: source))
        }

        for timing in tokens {
            let startsWord = timing.token.hasPrefix(" ") || timing.token.hasPrefix("\u{2581}")
            if startsWord, !group.isEmpty { flush() }
            if group.isEmpty { start = timing.start }
            group.append(timing.token)
            end = timing.end
            confidences.append(timing.confidence)
        }
        flush()
        return words
    }

    // MARK: - Convenience

    /// One-shot: exclusive timeline → per-word assignment → utterances.
    /// `turnSpeakerMap` optionally renames raw diarization labels (e.g.
    /// `"SPEAKER_0"`) to display/auto-matched names before attribution.
    public static func attribute(
        words: [Word],
        diarization segments: [SpeakerSegment],
        turnSpeakerMap: [String: String] = [:],
        maxPause: TimeInterval = defaultMaxPause,
    ) -> [TimestampedSegment] {
        let named = turnSpeakerMap.isEmpty ? segments : segments.map {
            SpeakerSegment(start: $0.start, end: $0.end, speaker: turnSpeakerMap[$0.speaker] ?? $0.speaker)
        }
        let turns = exclusiveTurns(from: named)
        let attributed = assign(words: words, turns: turns)
        return utterances(from: attributed, maxPause: maxPause)
    }
}
