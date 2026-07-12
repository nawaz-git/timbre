import Foundation

/// A transcribed segment with timestamps and an optional speaker label.
///
/// The canonical transcript-segment type shared by both batch pipelines.
/// The menu-bar app used to define this privately in `WhisperKitEngine.swift`;
/// mt-batch has its own near-identical `TimedSegment`. This is the single
/// definition the shared attribution logic (`WordTimeline`, `CrossTrackDedup`,
/// `DualTrackAttribution`) reads and writes; each consumer maps its own I/O
/// types to it at the boundary.
///
/// The `Codable` field names + the `speaker` default are load-bearing: the app
/// persists `[TimestampedSegment]` as the `_segments.json` sidecar the renderer
/// reads, so the JSON shape (`start`/`end`/`text`/`speaker`, `speaker` absent →
/// `""`) must stay stable.
///
/// `confidence` and `overlap` are the MAX-tier outputs-contract additions
/// (plan §outputs contract). Both are optional with a `nil` default, so
/// Swift's synthesized `encodeIfPresent` **omits** them for every FAST segment
/// — the persisted JSON is byte-identical to before until a MAX refine sets
/// them. Renderers may ignore them.
public struct TimestampedSegment: Codable, Equatable, Sendable {
    public let start: TimeInterval // seconds
    public let end: TimeInterval // seconds
    public let text: String
    public var speaker: String
    /// MAX re-scoring confidence for this utterance's speaker (best-vs-second
    /// centroid cosine margin, 0…~1). `nil` on the FAST path.
    public var confidence: Double?
    /// `true` when MAX's overlap pass found ≥2 active speakers over this
    /// utterance's span. `nil`/absent on the FAST path.
    public var overlap: Bool?

    public init(
        start: TimeInterval,
        end: TimeInterval,
        text: String,
        speaker: String = "",
        confidence: Double? = nil,
        overlap: Bool? = nil,
    ) {
        self.start = start
        self.end = end
        self.text = text
        self.speaker = speaker
        self.confidence = confidence
        self.overlap = overlap
    }
}
