import Foundation

/// The pure dual-track word-attribution assembly, shared by both batch
/// pipelines so the app's live-recording path and mt-batch's file-import path
/// produce identical output from the same inputs.
///
/// Exploits the dual-track prior (plan D1/D3): the app track carries the remote
/// speakers, the mic track carries the known local speaker. It:
///   1. attributes app words against the app diarization turns,
///   2. attributes mic words — against the mic diarization turns when the mic
///      is diarized (shared-room mode), else straight to the known local
///      speaker `micLabel`,
///   3. shifts the mic track (words *and* turns) by `micDelay` so both tracks
///      live on one timeline,
///   4. drops mic utterances that are app-audio bleed (`CrossTrackDedup`),
///   5. merges consecutive same-speaker utterances for display.
///
/// Impure inputs are injected: `micRMS`/`appRMS` measure loudness over an
/// utterance's own-track span (the caller reads the audio files), and the
/// caller does the logging/warning off the returned `dropped`/`dropRatio`.
public enum DualTrackAttribution {
    public struct Result: Sendable {
        /// Final merged, speaker-labelled display segments.
        public let kept: [TimestampedSegment]
        /// Mic utterances removed as app-audio bleed (for diagnostics logging).
        public let dropped: [TimestampedSegment]
        /// Total mic utterances considered (denominator for `dropRatio`).
        public let micCount: Int

        public init(kept: [TimestampedSegment], dropped: [TimestampedSegment], micCount: Int) {
            self.kept = kept
            self.dropped = dropped
            self.micCount = micCount
        }

        public var droppedCount: Int { dropped.count }
        /// Fraction of mic utterances dropped — a high ratio suggests a
        /// no-headphones setup worth warning the user about.
        public var dropRatio: Double { micCount == 0 ? 0 : Double(dropped.count) / Double(micCount) }
    }

    /// - Parameters:
    ///   - appTurns: app-track diarization segments (remote speakers).
    ///   - micTurns: mic-track diarization segments, or `nil` when the mic is a
    ///     single known speaker (attribute all mic words to `micLabel`).
    ///   - appNames/micNames: raw-label → display/enrolled-name overrides,
    ///     applied per track before attribution.
    ///   - micDelay: seconds to shift the mic track onto the app timeline.
    public static func attribute(
        appWords: [WordTimeline.Word],
        micWords: [WordTimeline.Word]?,
        appTurns: [SpeakerSegment],
        micTurns: [SpeakerSegment]?,
        appNames: [String: String] = [:],
        micNames: [String: String] = [:],
        micLabel: String = "Me",
        micDelay: TimeInterval = 0,
        maxPause: TimeInterval = WordTimeline.defaultMaxPause,
        micRMS: CrossTrackDedup.RMSProvider = { _ in nil },
        appRMS: CrossTrackDedup.RMSProvider = { _ in nil },
    ) -> Result {
        let appUtterances = WordTimeline.attribute(
            words: appWords, diarization: appTurns, turnSpeakerMap: appNames, maxPause: maxPause,
        )

        var micUtterances: [TimestampedSegment] = []
        if let micWords {
            let shiftedWords = micDelay == 0 ? micWords : micWords.map { $0.shifted(by: micDelay) }
            if let micTurns {
                let shiftedTurns = micDelay == 0 ? micTurns : micTurns.map {
                    SpeakerSegment(start: $0.start + micDelay, end: $0.end + micDelay, speaker: $0.speaker)
                }
                micUtterances = WordTimeline.attribute(
                    words: shiftedWords, diarization: shiftedTurns, turnSpeakerMap: micNames, maxPause: maxPause,
                )
            } else {
                // Mic diarization unavailable / not wanted → the known local speaker.
                micUtterances = WordTimeline.utterances(
                    from: shiftedWords.map { WordTimeline.AttributedWord(word: $0, speaker: micLabel) },
                    maxPause: maxPause,
                )
            }
        }

        let deduped = CrossTrackDedup.dedup(
            mic: micUtterances, app: appUtterances, micRMS: micRMS, appRMS: appRMS,
        )
        return Result(
            kept: TranscriptSegments.mergeConsecutiveSpeakers(deduped.kept),
            dropped: deduped.dropped,
            micCount: deduped.micCount,
        )
    }
}
