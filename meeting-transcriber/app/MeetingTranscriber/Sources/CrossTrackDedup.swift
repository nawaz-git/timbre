import Foundation

/// Pure cross-track echo/bleed de-duplication.
///
/// Without headphones the microphone picks up the app's own audio (the remote
/// speakers coming out of the laptop speakers), so the *same* speech is
/// transcribed on **both** the mic and app tracks. Naively merging the two
/// tracks then prints every remote sentence twice — once attributed to the
/// remote speaker (app) and once to the local speaker (mic).
///
/// For each mic utterance this drops it when an app utterance both overlaps it
/// in time (≥ `minTimeOverlapRatio`) and matches its text (token-Jaccard ≥
/// `minTextSimilarity`) — that's bleed — **unless** the mic copy is clearly
/// louder than the app copy (mic RMS exceeds app RMS by more than
/// `rmsGuardDecibels`), which means the local speaker genuinely said the same
/// words and should be kept. All three conditions are required to drop, so
/// genuine double-talk (two people, different words) is always kept.
///
/// Pure: RMS is supplied via injected providers so this unit-tests without any
/// audio file.
enum CrossTrackDedup {
    /// Minimum `overlap / min(duration)` for two utterances to be considered
    /// the same span. 0.6 tolerates the small time skew (0–400 ms) between a
    /// sound and its speaker-bleed echo.
    static let minTimeOverlapRatio = 0.6

    /// Minimum normalized token-Jaccard similarity for two utterances to count
    /// as the same words. 0.8 catches near-identical echoes while rejecting
    /// genuinely different double-talk.
    static let minTextSimilarity = 0.8

    /// The mic copy is kept (treated as genuine local speech, not bleed) when
    /// its RMS exceeds the app copy's by more than this many dB.
    static let rmsGuardDecibels: Float = 6.0

    /// dBFS over an utterance's time span on its own track, or `nil` when
    /// unavailable (then the RMS rescue can't fire → the utterance is dropped
    /// on a text+time match, per the plan's default).
    typealias RMSProvider = (TimestampedSegment) -> Float?

    struct Result {
        /// App utterances plus the surviving mic utterances, sorted by start.
        let kept: [TimestampedSegment]
        /// Mic utterances judged to be app-audio bleed and removed.
        let dropped: [TimestampedSegment]
        /// Total mic utterances considered (denominator for `dropRatio`).
        let micCount: Int

        var droppedCount: Int { dropped.count }
        /// Fraction of mic utterances dropped. A high ratio suggests a
        /// no-headphones setup worth warning the user about.
        var dropRatio: Double { micCount == 0 ? 0 : Double(dropped.count) / Double(micCount) }
    }

    static func dedup(
        mic: [TimestampedSegment],
        app: [TimestampedSegment],
        micRMS: RMSProvider = { _ in nil },
        appRMS: RMSProvider = { _ in nil },
    ) -> Result {
        var survivingMic: [TimestampedSegment] = []
        var dropped: [TimestampedSegment] = []
        for micSeg in mic {
            if isBleed(micSeg, of: app, micRMS: micRMS, appRMS: appRMS) {
                dropped.append(micSeg)
            } else {
                survivingMic.append(micSeg)
            }
        }
        let kept = (app + survivingMic).sorted { $0.start < $1.start }
        return Result(kept: kept, dropped: dropped, micCount: mic.count)
    }

    /// Whether `micSeg` is app-audio bleed of some app utterance.
    static func isBleed(
        _ micSeg: TimestampedSegment,
        of app: [TimestampedSegment],
        micRMS: RMSProvider,
        appRMS: RMSProvider,
    ) -> Bool {
        var micLevel: Float?
        var micLevelComputed = false
        for appSeg in app {
            guard timeOverlapRatio(micSeg, appSeg) >= minTimeOverlapRatio else { continue }
            guard tokenSimilarity(micSeg.text, appSeg.text) >= minTextSimilarity else { continue }
            // Text + time match → bleed candidate. Compute mic loudness once.
            if !micLevelComputed {
                micLevel = micRMS(micSeg)
                micLevelComputed = true
            }
            if let mic = micLevel, let appLevel = appRMS(appSeg), mic > appLevel + rmsGuardDecibels {
                continue // genuinely louder local speech — keep, try other app segs
            }
            return true
        }
        return false
    }

    /// Temporal overlap of two utterances as a fraction of the shorter one.
    static func timeOverlapRatio(_ a: TimestampedSegment, _ b: TimestampedSegment) -> Double {
        let overlap = max(0, min(a.end, b.end) - max(a.start, b.start))
        let minDuration = max(1e-9, min(a.end - a.start, b.end - b.start))
        return overlap / minDuration
    }

    /// Lowercased alphanumeric word set — punctuation and casing stripped.
    static func normalizedTokens(_ text: String) -> Set<String> {
        Set(
            text.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { !$0.isEmpty },
        )
    }

    /// Jaccard similarity of the two utterances' normalized token sets.
    /// Two empty strings are treated as identical (1.0).
    static func tokenSimilarity(_ a: String, _ b: String) -> Double {
        let setA = normalizedTokens(a)
        let setB = normalizedTokens(b)
        if setA.isEmpty, setB.isEmpty { return 1.0 }
        let union = setA.union(setB).count
        guard union > 0 else { return 0 }
        return Double(setA.intersection(setB).count) / Double(union)
    }
}
