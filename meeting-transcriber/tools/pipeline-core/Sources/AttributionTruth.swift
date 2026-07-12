import Foundation

/// Decoded shape of a word-level attribution ground-truth file
/// (`<fixture>_truth.json`) produced by `scripts/generate_dualtrack_fixtures.sh`.
///
/// This is the reference side of the word-diarization metrics. It differs from
/// the older turn-only `GroundTruth` (used by the WER/DER engine tests) in two
/// ways that the speaker-attribution work needs:
///
///   1. **Per-word speaker labels** (`words`). Word diarization error rate
///      (WDER) is a per-word metric: it catches the exact failure the turn-level
///      DER misses — words absorbed across a speaker boundary that falls *inside*
///      one ASR segment. A turn list cannot express that.
///   2. **Dual-track shape** (`appAudio`/`micAudio`/`micDelay`/`micSpeaker`).
///      The product's live path records two tracks; a fixture that only ever
///      exposes a single mixed file cannot exercise the dual-source attribution
///      path or the mic-identity prior.
///
/// Kept dependency-free in `MTPipelineCore` so both consumers decode the same
/// schema: the app's env-gated quality lane and the mt-batch `--emit-metrics`
/// sweep driver.
public struct AttributionTruth: Codable, Sendable, Equatable {
    /// A single reference word with its span and the speaker who said it.
    public struct Word: Codable, Sendable, Equatable {
        public let w: String
        public let start: TimeInterval
        public let end: TimeInterval
        public let speaker: String

        public init(w: String, start: TimeInterval, end: TimeInterval, speaker: String) {
            self.w = w
            self.start = start
            self.end = end
            self.speaker = speaker
        }

        public var midpoint: TimeInterval { (start + end) / 2 }
    }

    /// A reference speaker turn. Optional in the JSON — when absent it is
    /// derived from consecutive same-speaker `words`.
    public struct Turn: Codable, Sendable, Equatable {
        public let speaker: String
        public let start: TimeInterval
        public let end: TimeInterval

        public init(speaker: String, start: TimeInterval, end: TimeInterval) {
            self.speaker = speaker
            self.start = start
            self.end = end
        }
    }

    /// Fixture identifier (matches the file basename without `_truth.json`).
    public let fixture: String
    /// `"mixed"` (one file) or `"dualtrack"` (app + mic files).
    public let kind: String
    /// Mixed-track audio basename, relative to the truth file's directory.
    public let audio: String?
    /// Dual-track app/remote audio basename.
    public let appAudio: String?
    /// Dual-track mic/local audio basename.
    public let micAudio: String?
    /// Seconds the mic track lags the app track (dual-track only).
    public let micDelay: TimeInterval?
    /// The known local speaker label carried on the mic track (dual-track prior).
    public let micSpeaker: String?
    public let sampleRate: Int
    public let duration: TimeInterval
    /// Every reference word, in spoken order.
    public let words: [Word]
    /// Optional explicit reference turns; derived from `words` when omitted.
    public let turns: [Turn]?

    public init(
        fixture: String,
        kind: String,
        audio: String? = nil,
        appAudio: String? = nil,
        micAudio: String? = nil,
        micDelay: TimeInterval? = nil,
        micSpeaker: String? = nil,
        sampleRate: Int,
        duration: TimeInterval,
        words: [Word],
        turns: [Turn]? = nil,
    ) {
        self.fixture = fixture
        self.kind = kind
        self.audio = audio
        self.appAudio = appAudio
        self.micAudio = micAudio
        self.micDelay = micDelay
        self.micSpeaker = micSpeaker
        self.sampleRate = sampleRate
        self.duration = duration
        self.words = words
        self.turns = turns
    }

    /// Distinct reference speakers.
    public var speakerCount: Int { Set(words.map(\.speaker)).count }

    /// Reference turns as `SpeakerSegment`s — explicit when the JSON carries
    /// them, otherwise coalesced from consecutive same-speaker words.
    public var referenceTurns: [SpeakerSegment] {
        if let turns {
            return turns.map { SpeakerSegment(start: $0.start, end: $0.end, speaker: $0.speaker) }
        }
        return Self.turns(fromWords: words)
    }

    /// Coalesce consecutive same-speaker words into contiguous turns.
    public static func turns(fromWords words: [Word]) -> [SpeakerSegment] {
        var result: [SpeakerSegment] = []
        for word in words {
            if var last = result.last, last.speaker == word.speaker {
                last = SpeakerSegment(start: last.start, end: max(last.end, word.end), speaker: last.speaker)
                result[result.count - 1] = last
            } else {
                result.append(SpeakerSegment(start: word.start, end: word.end, speaker: word.speaker))
            }
        }
        return result
    }
}
