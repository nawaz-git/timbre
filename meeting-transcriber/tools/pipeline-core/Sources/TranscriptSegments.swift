import Foundation

/// Display-level grouping of an attributed transcript.
///
/// `mergeConsecutiveSpeakers` was duplicated verbatim in the app's
/// `DiarizationProcess` and mt-batch's `Merger` (same 2.0 s paragraph gap).
/// Both now delegate here so the readability rule has one definition.
public enum TranscriptSegments {
    /// Maximum silence gap (seconds) before breaking a same-speaker block.
    /// Pauses longer than this start a new paragraph even for the same speaker.
    public static let mergeGapThreshold: TimeInterval = 2.0

    /// Merge consecutive segments from the same speaker into single blocks,
    /// joining their text with a single space. Preserves the first segment's
    /// start and the last segment's end. A silence gap > `gap` forces a break
    /// even for the same speaker. The MAX-tier `confidence`/`overlap` metadata
    /// is carried across the merge (any overlapped member makes the block
    /// overlapped; confidence is duration-weighted) so the annotation survives.
    public static func mergeConsecutiveSpeakers(
        _ segments: [TimestampedSegment],
        gap: TimeInterval = mergeGapThreshold,
    ) -> [TimestampedSegment] {
        guard var current = segments.first else { return [] }

        var merged: [TimestampedSegment] = []
        for seg in segments.dropFirst() {
            let silenceGap = seg.start - current.end
            if seg.speaker == current.speaker, silenceGap <= gap {
                current = TimestampedSegment(
                    start: current.start,
                    end: seg.end,
                    text: "\(current.text) \(seg.text)",
                    speaker: current.speaker,
                    confidence: combinedConfidence(current, seg),
                    overlap: current.overlap == true || seg.overlap == true ? true : nil,
                )
            } else {
                merged.append(current)
                current = seg
            }
        }
        merged.append(current)
        return merged
    }

    /// Duration-weighted mean of two segments' confidences — the closest
    /// reconstruction of the word-weighted mean without the per-word counts at
    /// the merge boundary. A `nil` on either side falls back to the other;
    /// both `nil` → `nil` (so FAST segments stay unannotated).
    private static func combinedConfidence(
        _ a: TimestampedSegment,
        _ b: TimestampedSegment,
    ) -> Double? {
        switch (a.confidence, b.confidence) {
        case let (x?, y?):
            let wa = max(0, a.end - a.start)
            let wb = max(0, b.end - b.start)
            let total = wa + wb
            return total > 0 ? (x * wa + y * wb) / total : (x + y) / 2
        case let (x?, nil): return x
        case let (nil, y?): return y
        case (nil, nil): return nil
        }
    }
}
