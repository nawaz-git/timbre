import Foundation
import MTPipelineCore

/// Pure functions that combine ASR transcript segments with diarization
/// segments into a single speaker-labelled timeline.
///
/// Algorithm mirrors `DiarizationProcess` in the main app:
///  1. For each transcript segment, assign the speaker label of the
///     diarization segment with the largest temporal overlap.
///  2. If no overlap exists, fall back to the nearest diarization segment
///     by gap distance.
///  3. Optionally merge consecutive same-speaker segments separated by a
///     short pause into single utterance blocks for readability.
enum Merger {
    /// Maximum pause (seconds) the merge step tolerates between two
    /// same-speaker segments before starting a new block. Sourced from the
    /// shared `TranscriptSegments` rule so both pipelines paragraph identically.
    static let mergeGapThreshold: TimeInterval = TranscriptSegments.mergeGapThreshold

    /// Assign a speaker label to each transcript segment.
    static func assignSpeakers(
        transcript: [TimedSegment],
        diarization: [DiarizationOutput.Segment],
        nameOverrides: [String: String] = [:],
    ) -> [TimedSegment] {
        transcript.map { seg in
            assignSpeaker(to: seg, diarization: diarization, nameOverrides: nameOverrides)
        }
    }

    /// Single-segment assignment: maximum-overlap, with nearest-gap fallback.
    private static func assignSpeaker(
        to seg: TimedSegment,
        diarization: [DiarizationOutput.Segment],
        nameOverrides: [String: String],
    ) -> TimedSegment {
        var best = seg
        var bestOverlap: TimeInterval = 0
        for dSeg in diarization {
            let overlapStart = max(seg.start, dSeg.start)
            let overlapEnd = min(seg.end, dSeg.end)
            let overlap = max(0, overlapEnd - overlapStart)
            if overlap > bestOverlap {
                bestOverlap = overlap
                best.speaker = nameOverrides[dSeg.speaker] ?? dSeg.speaker
            }
        }
        if bestOverlap == 0 {
            best.speaker = nearestSpeaker(for: seg, diarization: diarization, nameOverrides: nameOverrides)
        }
        if best.speaker.isEmpty {
            best.speaker = "UNKNOWN"
        }
        return best
    }

    /// Find the speaker label of the diarization segment closest in time to
    /// `seg` when no temporal overlap exists. Used as a fallback so very
    /// short transcript segments at a speaker boundary always get *some*
    /// label rather than the catch-all "UNKNOWN".
    private static func nearestSpeaker(
        for seg: TimedSegment,
        diarization: [DiarizationOutput.Segment],
        nameOverrides: [String: String],
    ) -> String {
        var nearestGap: TimeInterval = .infinity
        var label = ""
        for dSeg in diarization {
            let gap: TimeInterval = if seg.end <= dSeg.start {
                dSeg.start - seg.end
            } else if seg.start >= dSeg.end {
                seg.start - dSeg.end
            } else {
                0
            }
            if gap < nearestGap {
                nearestGap = gap
                label = nameOverrides[dSeg.speaker] ?? dSeg.speaker
            }
        }
        return label
    }

    /// Merge consecutive segments from the same speaker into single blocks,
    /// joining their text with a single space. A silence gap >
    /// `mergeGapThreshold` forces a break even for the same speaker. Delegates
    /// to the shared `TranscriptSegments` rule via the segment bridge.
    static func mergeConsecutiveSpeakers(_ segments: [TimedSegment]) -> [TimedSegment] {
        TranscriptSegments.mergeConsecutiveSpeakers(segments.map(\.timestamped)).map(TimedSegment.init)
    }

    /// Convenience: assign + merge in one call.
    static func mergeTranscriptWithDiarization(
        transcript: [TimedSegment],
        diarization: [DiarizationOutput.Segment],
        nameOverrides: [String: String] = [:],
    ) -> [TimedSegment] {
        let labeled = assignSpeakers(
            transcript: transcript,
            diarization: diarization,
            nameOverrides: nameOverrides,
        )
        return mergeConsecutiveSpeakers(labeled)
    }
}
