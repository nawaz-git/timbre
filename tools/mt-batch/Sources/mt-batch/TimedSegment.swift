import Foundation

/// Lightweight transcript segment with timestamps and an optional speaker label.
///
/// Mirrors `TimestampedSegment` in the main app but is duplicated here
/// because the app's `Sources/` is an internal-visibility executableTarget
/// and cannot be linked into another target.
struct TimedSegment: Codable {
    var start: TimeInterval
    var end: TimeInterval
    var text: String
    var speaker: String = ""
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
