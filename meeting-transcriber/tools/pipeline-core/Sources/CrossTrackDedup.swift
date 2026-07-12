import Foundation

/// Pure cross-track echo/bleed de-duplication.
///
/// Without headphones the microphone picks up the app's own audio (the remote
/// speakers coming out of the laptop speakers), so the *same* speech is
/// transcribed on **both** the mic and app tracks. Naively merging the two
/// tracks then prints every remote sentence twice — once attributed to the
/// remote speaker (app) and once to the local speaker (mic).
///
/// A mic utterance is bleed only with **positive loudness evidence**: RMS must
/// be available on BOTH tracks (a text+time match alone never drops it — we
/// never delete speech without evidence). Given RMS:
///   * a normal-length utterance is bleed unless the mic copy is clearly LOUDER
///     than the app copy (mic RMS > app RMS + `rmsGuardDecibels`), i.e. genuine
///     local speech;
///   * a SHORT utterance (a backchannel — ≤ `shortUtteranceMaxTokens` words or
///     < `shortUtteranceMaxDurationSeconds`) is only dropped with the
///     echo-attenuation signature — the mic copy measurably QUIETER than the
///     app copy (mic RMS < app RMS − `shortUtteranceBleedMarginDecibels`) —
///     because a genuine short "yeah"/"mm-hm" from the local speaker is loud at
///     the mic, and dropping it on a mere text match would erase real speech.
///
/// Genuine double-talk (two people, different words) is always kept.
///
/// Pure: RMS is supplied via injected providers so this unit-tests without any
/// audio file.
public enum CrossTrackDedup {
    /// Minimum `overlap / min(duration)` for two utterances to be considered
    /// the same span. 0.6 tolerates the small time skew (0–400 ms) between a
    /// sound and its speaker-bleed echo.
    public static let minTimeOverlapRatio = 0.6

    /// Minimum normalized token-Jaccard similarity for two utterances to count
    /// as the same words. 0.8 catches near-identical echoes while rejecting
    /// genuinely different double-talk.
    public static let minTextSimilarity = 0.8

    /// A normal-length mic copy is kept (genuine local speech, not bleed) when
    /// its RMS exceeds the app copy's by more than this many dB.
    public static let rmsGuardDecibels: Float = 6.0

    /// An utterance with at most this many words counts as SHORT (a
    /// backchannel) and needs positive echo-attenuation evidence to drop.
    public static let shortUtteranceMaxTokens = 2

    /// An utterance shorter than this (seconds) counts as SHORT.
    public static let shortUtteranceMaxDurationSeconds: TimeInterval = 1.0

    /// A SHORT mic copy is bleed only when its RMS is at least this many dB
    /// BELOW the app copy's (the echo picked up through the speakers is
    /// attenuated). Provisional — the benchmark harness re-fits it.
    public static let shortUtteranceBleedMarginDecibels: Float = 3.0

    /// dBFS over an utterance's time span on its own track, or `nil` when
    /// unavailable. A `nil` on either track means no loudness evidence, so the
    /// mic utterance is KEPT (never dropped without evidence).
    public typealias RMSProvider = (TimestampedSegment) -> Float?

    public struct Result: Sendable {
        /// App utterances plus the surviving mic utterances, sorted by start.
        public let kept: [TimestampedSegment]
        /// Mic utterances judged to be app-audio bleed and removed.
        public let dropped: [TimestampedSegment]
        /// Total mic utterances considered (denominator for `dropRatio`).
        public let micCount: Int

        public init(kept: [TimestampedSegment], dropped: [TimestampedSegment], micCount: Int) {
            self.kept = kept
            self.dropped = dropped
            self.micCount = micCount
        }

        public var droppedCount: Int { dropped.count }
        /// Fraction of mic utterances dropped. A high ratio suggests a
        /// no-headphones setup worth warning the user about.
        public var dropRatio: Double { micCount == 0 ? 0 : Double(dropped.count) / Double(micCount) }
    }

    public static func dedup(
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
    public static func isBleed(
        _ micSeg: TimestampedSegment,
        of app: [TimestampedSegment],
        micRMS: RMSProvider,
        appRMS: RMSProvider,
    ) -> Bool {
        var micLevel: Float?
        var micLevelComputed = false
        let short = isShort(micSeg)
        for appSeg in app {
            guard timeOverlapRatio(micSeg, appSeg) >= minTimeOverlapRatio else { continue }
            guard tokenSimilarity(micSeg.text, appSeg.text) >= minTextSimilarity else { continue }
            // Text + time match → bleed candidate. Compute mic loudness once.
            if !micLevelComputed {
                micLevel = micRMS(micSeg)
                micLevelComputed = true
            }
            // No loudness evidence on either track → never drop.
            guard let mic = micLevel, let appLevel = appRMS(appSeg) else { continue }
            if short {
                // Backchannel: drop ONLY with the echo-attenuation signature —
                // the mic copy measurably quieter than the app copy.
                if mic < appLevel - shortUtteranceBleedMarginDecibels { return true }
            } else {
                // Normal-length: bleed unless the mic copy is clearly louder.
                if mic <= appLevel + rmsGuardDecibels { return true }
            }
            // Otherwise this app seg isn't decisive — try the next one.
        }
        return false
    }

    /// A short utterance (backchannel) — few words or brief. Dropped only with
    /// positive echo-attenuation evidence, never on a bare text+time match.
    public static func isShort(_ seg: TimestampedSegment) -> Bool {
        let duration = seg.end - seg.start
        let wordCount = seg.text
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .lazy.filter { !$0.isEmpty }.count
        return wordCount <= shortUtteranceMaxTokens || duration < shortUtteranceMaxDurationSeconds
    }

    /// Temporal overlap of two utterances as a fraction of the shorter one.
    public static func timeOverlapRatio(_ a: TimestampedSegment, _ b: TimestampedSegment) -> Double {
        let overlap = max(0, min(a.end, b.end) - max(a.start, b.start))
        let minDuration = max(1e-9, min(a.end - a.start, b.end - b.start))
        return overlap / minDuration
    }

    /// Lowercased alphanumeric word set — punctuation and casing stripped.
    public static func normalizedTokens(_ text: String) -> Set<String> {
        Set(
            text.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { !$0.isEmpty },
        )
    }

    /// Jaccard similarity of the two utterances' normalized token sets.
    /// Two empty strings are treated as identical (1.0).
    public static func tokenSimilarity(_ a: String, _ b: String) -> Double {
        let setA = normalizedTokens(a)
        let setB = normalizedTokens(b)
        if setA.isEmpty, setB.isEmpty { return 1.0 }
        let union = setA.union(setB).count
        guard union > 0 else { return 0 }
        return Double(setA.intersection(setB).count) / Double(union)
    }
}
