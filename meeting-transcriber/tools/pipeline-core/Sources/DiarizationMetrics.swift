import Foundation

/// Pure, model-free diarization-quality metrics: word diarization error rate
/// (WDER), diarization error rate (DER), speaker-count error, and a per-pass
/// ablation helper.
///
/// Lives in `MTPipelineCore` so the one implementation backs both consumers:
/// the app's env-gated quality lane (`AttributionQualityTests`) and the
/// mt-batch `--emit-metrics` sweep driver. Everything here is deterministic
/// value-in/value-out with no CoreML, so it unit-tests without downloading a
/// model.
///
/// **Why WDER is the headline metric.** DER scores turn-level speech overlap;
/// it is blind to the product's actual complaint — a word attributed to the
/// wrong speaker because a turn boundary fell inside one ASR segment. WDER is
/// the fraction of *reference words* whose speaker (under the optimal
/// hyp→ref speaker mapping) is wrong. It moves exactly when attribution moves.
///
/// **Optimal speaker mapping.** Reference and hypothesis label the same people
/// with arbitrary names ("Speaker 1" vs "A"). Before counting errors we find
/// the 1:1 hyp→ref mapping that maximises agreement, brute-forced over all
/// assignments — fine for the ≤10 speakers real meetings hit. Shared by WDER
/// and DER so both agree on who-is-who.
public enum DiarizationMetrics {
    // MARK: - Result types

    public struct WDERResult: Equatable, Sendable {
        /// Wrong-speaker reference words / total reference words, 0…1.
        public let errorRate: Double
        public let totalWords: Int
        public let wrongWords: Int
        /// Optimal hypothesis-label → reference-label mapping used to score.
        public let mapping: [String: String]

        public init(errorRate: Double, totalWords: Int, wrongWords: Int, mapping: [String: String]) {
            self.errorRate = errorRate
            self.totalWords = totalWords
            self.wrongWords = wrongWords
            self.mapping = mapping
        }
    }

    public struct DERResult: Equatable, Sendable {
        public let der: Double
        public let missedSpeech: TimeInterval
        public let falseAlarm: TimeInterval
        public let speakerConfusion: TimeInterval
        public let totalReference: TimeInterval

        public init(
            der: Double,
            missedSpeech: TimeInterval,
            falseAlarm: TimeInterval,
            speakerConfusion: TimeInterval,
            totalReference: TimeInterval,
        ) {
            self.der = der
            self.missedSpeech = missedSpeech
            self.falseAlarm = falseAlarm
            self.speakerConfusion = speakerConfusion
            self.totalReference = totalReference
        }
    }

    // MARK: - WDER

    /// WDER over two **aligned** per-word speaker-label streams (same words in
    /// the same order — e.g. a synthetic fixture where the hypothesis is scored
    /// on the reference transcript, or a unit test). `hypothesisLabels[i] == nil`
    /// means the hypothesis left word *i* unattributed and it always counts as
    /// an error.
    ///
    /// Precondition: `referenceLabels.count == hypothesisLabels.count`.
    public static func wder(
        referenceLabels: [String],
        hypothesisLabels: [String?],
    ) -> WDERResult {
        precondition(
            referenceLabels.count == hypothesisLabels.count,
            "aligned WDER needs equal-length label streams",
        )
        let pairs = zip(referenceLabels, hypothesisLabels).map { (ref: $0.0, hyp: $0.1) }
        return wder(pairs: pairs)
    }

    /// WDER for the real pipeline, where the hypothesis is a diarized *turn*
    /// timeline and its word list need not match the reference. Each reference
    /// word is projected onto the hypothesis by the turn covering its midpoint
    /// (nearest turn as a fallback), then scored under the optimal mapping.
    ///
    /// This is the form the quality lane and mt-batch `--emit-metrics` use: the
    /// hypothesis comes straight from the pipeline's `_segments.json`.
    public static func wder(
        referenceWords: [AttributionTruth.Word],
        hypothesisTurns: [SpeakerSegment],
    ) -> WDERResult {
        let pairs = referenceWords.map { word in
            (ref: word.speaker, hyp: hypothesisSpeaker(at: word.midpoint, in: hypothesisTurns))
        }
        return wder(pairs: pairs)
    }

    /// Core WDER over `(referenceSpeaker, hypothesisSpeaker?)` pairs, one per
    /// reference word. Finds the optimal hyp→ref mapping maximising agreement,
    /// then counts words whose mapped hypothesis speaker disagrees.
    static func wder(pairs: [(ref: String, hyp: String?)]) -> WDERResult {
        let total = pairs.count
        guard total > 0 else {
            return WDERResult(errorRate: 0, totalWords: 0, wrongWords: 0, mapping: [:])
        }

        let refLabels = Array(Set(pairs.map(\.ref))).sorted()
        let hypLabels = Array(Set(pairs.compactMap(\.hyp))).sorted()

        // agreement[h][r] = # words where hyp = hypLabels[h] and ref = refLabels[r].
        var agreement = Array(
            repeating: Array(repeating: 0.0, count: refLabels.count),
            count: hypLabels.count,
        )
        for pair in pairs {
            guard let hyp = pair.hyp,
                  let hi = hypLabels.firstIndex(of: hyp),
                  let ri = refLabels.firstIndex(of: pair.ref)
            else { continue }
            agreement[hi][ri] += 1
        }

        let mapping = bestAssignment(hypLabels: hypLabels, refLabels: refLabels, weight: agreement)

        var wrong = 0
        for pair in pairs {
            if let hyp = pair.hyp, mapping[hyp] == pair.ref {
                continue // correctly attributed under the optimal mapping
            }
            wrong += 1
        }

        return WDERResult(
            errorRate: Double(wrong) / Double(total),
            totalWords: total,
            wrongWords: wrong,
            mapping: mapping,
        )
    }

    // MARK: - DER

    /// Diarization Error Rate (pyannote-style, no collar, overlap not modelled):
    /// `(missed + false-alarm + confusion) / total_reference_speech`, with the
    /// same optimal speaker mapping as WDER. Reference and hypothesis are turn
    /// timelines; at most one speaker is active per instant (later turns win any
    /// overlap). This mirrors the app's existing turn-level `DERCalculator`; it
    /// is duplicated here rather than shared because that one lives in the app's
    /// test target (unreachable from mt-batch) — kept independently tested.
    public static func der(
        referenceTurns: [SpeakerSegment],
        hypothesisTurns: [SpeakerSegment],
    ) -> DERResult {
        let intervals = sliceTimeline(reference: referenceTurns, hypothesis: hypothesisTurns)
        let totalRef = intervals
            .filter { $0.refSpeaker != nil }
            .reduce(0.0) { $0 + $1.duration }

        if totalRef == 0 {
            let falseAlarm = intervals.reduce(0.0) { $0 + ($1.hypSpeaker == nil ? 0 : $1.duration) }
            return DERResult(
                der: hypothesisTurns.isEmpty ? 0 : 1,
                missedSpeech: 0,
                falseAlarm: falseAlarm,
                speakerConfusion: 0,
                totalReference: 0,
            )
        }

        let refLabels = Array(Set(referenceTurns.map(\.speaker))).sorted()
        let hypLabels = Array(Set(hypothesisTurns.map(\.speaker))).sorted()

        var overlap = Array(
            repeating: Array(repeating: 0.0, count: refLabels.count),
            count: hypLabels.count,
        )
        for interval in intervals {
            guard let r = interval.refSpeaker, let h = interval.hypSpeaker,
                  let ri = refLabels.firstIndex(of: r),
                  let hi = hypLabels.firstIndex(of: h)
            else { continue }
            overlap[hi][ri] += interval.duration
        }
        let mapping = bestAssignment(hypLabels: hypLabels, refLabels: refLabels, weight: overlap)

        var missed = 0.0
        var falseAlarm = 0.0
        var confusion = 0.0
        for interval in intervals {
            switch (interval.refSpeaker, interval.hypSpeaker) {
            case (nil, nil):
                continue
            case (.some, nil):
                missed += interval.duration
            case (nil, .some):
                falseAlarm += interval.duration
            case let (ref?, hyp?):
                if mapping[hyp] != ref { confusion += interval.duration }
            }
        }
        return DERResult(
            der: (missed + falseAlarm + confusion) / totalRef,
            missedSpeech: missed,
            falseAlarm: falseAlarm,
            speakerConfusion: confusion,
            totalReference: totalRef,
        )
    }

    // MARK: - Speaker count

    /// Absolute speaker-count error — `abs(|hyp speakers| − |ref speakers|)`.
    /// Aggregated across a fixture set this is the speaker-count MAE (R3
    /// under/over-clustering). Empty-label turns are ignored on both sides.
    public static func speakerCountError(
        referenceTurns: [SpeakerSegment],
        hypothesisTurns: [SpeakerSegment],
    ) -> Int {
        let ref = Set(referenceTurns.map(\.speaker).filter { !$0.isEmpty })
        let hyp = Set(hypothesisTurns.map(\.speaker).filter { !$0.isEmpty })
        return abs(hyp.count - ref.count)
    }

    // MARK: - Per-pass ablation

    /// One row of a per-pass ablation table: the WDER after a pass ran, and how
    /// much it moved versus the previous pass.
    public struct AblationRow: Equatable, Sendable {
        public let stage: String
        public let wder: Double
        /// `wder(previous) − wder(this)`. Positive = this pass reduced WDER.
        public let deltaVsPrevious: Double
        /// Relative reduction versus the previous pass, `delta / wder(previous)`.
        /// `nil` for the first row (no previous) or when the previous WDER was 0.
        public let relativeImprovement: Double?

        public init(stage: String, wder: Double, deltaVsPrevious: Double, relativeImprovement: Double?) {
            self.stage = stage
            self.wder = wder
            self.deltaVsPrevious = deltaVsPrevious
            self.relativeImprovement = relativeImprovement
        }
    }

    /// Build a per-pass ablation table from the hypothesis captured after each
    /// stage of the pipeline (FAST baseline, then +consensus, +rescore, +LLM …).
    /// Each stage's hypothesis is scored against the same reference; adjacent
    /// rows show the marginal WDER contribution of that pass, which is what the
    /// benchmark plan needs to fit the provisional MAX knobs (a pass that does
    /// not move WDER on the fixtures is not earning its runtime budget).
    public static func ablation(
        referenceWords: [AttributionTruth.Word],
        stages: [(name: String, hypothesisTurns: [SpeakerSegment])],
    ) -> [AblationRow] {
        var rows: [AblationRow] = []
        var previous: Double?
        for stage in stages {
            let value = wder(referenceWords: referenceWords, hypothesisTurns: stage.hypothesisTurns).errorRate
            let delta = previous.map { $0 - value } ?? 0
            let relative: Double? = {
                guard let prev = previous, prev > 0 else { return nil }
                return delta / prev
            }()
            rows.append(AblationRow(
                stage: stage.name,
                wder: value,
                deltaVsPrevious: delta,
                relativeImprovement: relative,
            ))
            previous = value
        }
        return rows
    }

    // MARK: - Internals

    /// Hypothesis speaker active at `time`: the covering turn, else the nearest
    /// turn by midpoint distance (unbounded), else `nil` when the hypothesis is
    /// empty. Nearest-fallback means every reference word is attributed to some
    /// hypothesis speaker whenever the hypothesis has any speech, matching how
    /// the pipeline itself would attribute a word that lands in a gap.
    static func hypothesisSpeaker(at time: TimeInterval, in turns: [SpeakerSegment]) -> String? {
        for turn in turns where turn.start <= time && time < turn.end {
            return turn.speaker
        }
        var best: String?
        var bestGap = Double.greatestFiniteMagnitude
        for turn in turns {
            let gap = time < turn.start ? turn.start - time : time - turn.end
            if gap < bestGap {
                bestGap = gap
                best = turn.speaker
            }
        }
        return best
    }

    private struct Interval {
        let start: TimeInterval
        let end: TimeInterval
        let refSpeaker: String?
        let hypSpeaker: String?
        var duration: TimeInterval { end - start }
    }

    /// Slice both timelines into micro-intervals at every turn boundary; within
    /// each, the ref and hyp speakers are constant.
    private static func sliceTimeline(
        reference: [SpeakerSegment],
        hypothesis: [SpeakerSegment],
    ) -> [Interval] {
        var boundaries = Set<TimeInterval>()
        for t in reference { boundaries.insert(t.start); boundaries.insert(t.end) }
        for t in hypothesis { boundaries.insert(t.start); boundaries.insert(t.end) }
        let sorted = boundaries.sorted()
        guard sorted.count >= 2 else { return [] }

        var result: [Interval] = []
        for i in 0 ..< (sorted.count - 1) {
            let start = sorted[i]
            let end = sorted[i + 1]
            guard end > start else { continue }
            let mid = (start + end) / 2
            result.append(Interval(
                start: start,
                end: end,
                refSpeaker: speaker(at: mid, in: reference),
                hypSpeaker: speaker(at: mid, in: hypothesis),
            ))
        }
        return result
    }

    private static func speaker(at time: TimeInterval, in turns: [SpeakerSegment]) -> String? {
        for turn in turns where turn.start <= time && time < turn.end {
            return turn.speaker
        }
        return nil
    }

    /// Pick the hyp→ref 1:1 assignment maximising total `weight[h][r]`.
    /// Brute-force recursion over all valid mappings (a hyp label may stay
    /// unmapped when hyp speakers outnumber ref, or have zero weight anywhere);
    /// bounded by speaker count. Same shape as the app's `DERCalculator`.
    static func bestAssignment(
        hypLabels: [String],
        refLabels: [String],
        weight: [[Double]],
    ) -> [String: String] {
        var best: [String: String] = [:]
        var bestScore = -1.0

        func recurse(_ hypIdx: Int, _ used: Set<Int>, _ current: [String: String], _ score: Double) {
            if hypIdx == hypLabels.count {
                if score > bestScore {
                    bestScore = score
                    best = current
                }
                return
            }
            // Leave this hyp label unmapped.
            recurse(hypIdx + 1, used, current, score)
            for r in refLabels.indices where !used.contains(r) {
                var next = current
                next[hypLabels[hypIdx]] = refLabels[r]
                recurse(hypIdx + 1, used.union([r]), next, score + weight[hypIdx][r])
            }
        }
        recurse(0, [], [:], 0)
        return best
    }
}
