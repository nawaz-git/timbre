import Foundation
import MTPipelineCore

/// Lightweight transcript segment with timestamps and an optional speaker label.
///
/// This is mt-batch's stable on-disk shape (the `transcript.json` schema and
/// the `[HH:MM:SS] Speaker: text` line format). It bridges to the shared
/// `TimestampedSegment` in `MTPipelineCore` — the type the word-attribution
/// core reads and writes — via `timestamped` / `init(_:)`, so the shared
/// pipeline logic runs on one segment type while mt-batch keeps its own I/O
/// type and helpers.
struct TimedSegment: Codable {
    var start: TimeInterval
    var end: TimeInterval
    var text: String
    var speaker: String = ""
}

extension TimedSegment {
    /// This segment as the shared `TimestampedSegment`.
    var timestamped: TimestampedSegment {
        TimestampedSegment(start: start, end: end, text: text, speaker: speaker)
    }

    /// Adopt a shared `TimestampedSegment` produced by the attribution core.
    init(_ segment: TimestampedSegment) {
        self.init(start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker)
    }
}

extension TimedSegment {
    /// `[HH:MM:SS]` for the segment start. Used by the human-readable
    /// `transcript.txt` line format the deliverable specifies.
    var hmsTimestamp: String {
        let total = max(0, Int(start.rounded(.down)))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        return String(format: "[%02d:%02d:%02d]", h, m, s)
    }

    /// `[HH:MM:SS] Speaker N: text` (or omit the speaker when blank).
    var transcriptLine: String {
        if speaker.isEmpty {
            return "\(hmsTimestamp) \(text)"
        }
        return "\(hmsTimestamp) \(speaker): \(text)"
    }
}
