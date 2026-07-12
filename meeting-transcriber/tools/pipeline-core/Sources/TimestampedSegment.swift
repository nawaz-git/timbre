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
public struct TimestampedSegment: Codable, Equatable, Sendable {
    public let start: TimeInterval // seconds
    public let end: TimeInterval // seconds
    public let text: String
    public var speaker: String

    public init(start: TimeInterval, end: TimeInterval, text: String, speaker: String = "") {
        self.start = start
        self.end = end
        self.text = text
        self.speaker = speaker
    }
}
