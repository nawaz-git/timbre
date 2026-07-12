import Foundation

/// Pure, model-free diarization-consensus logic — MAX-tier passes P1 (ensemble
/// pick) and P4 (overlap second look). The caller runs the actual model work
/// (a VBx cluster-threshold sweep, one Sortformer pass) and hands the outputs
/// here; this file holds only the deterministic decision logic so it unit-tests
/// without CoreML.
///
/// **P1 — ensemble pick.** Under-clustering (every remote voice collapsed to
/// one speaker) is a top user complaint. Running the offline clusterer at
/// several thresholds and picking the *most representative* partition is more
/// robust than trusting one threshold. "Most representative" = the run whose
/// speaker partition best agrees (Rand index) with the rest of the ensemble;
/// near-ties break toward MORE speakers so a lone collapsed run can't win by
/// agreeing with itself.
///
/// **P4 — overlap second look.** Sortformer is overlap-aware; VBx is not. Where
/// Sortformer marks ≥2 active speakers, the words there are flagged `overlap`
/// and — when Sortformer's dominant stream maps (by embedding cosine, computed
/// by the caller) to a *different* VBx cluster than the word currently has —
/// reassigned to it.
public enum DiarizationConsensus {
    /// Grid resolution (seconds) for the co-clustering Rand-index comparison.
    public static let defaultGridStep: TimeInterval = 0.5

    // MARK: - P1: ensemble pick

    public struct Pick: Equatable, Sendable {
        /// The chosen run's segments (unchanged from the input run).
        public let segments: [SpeakerSegment]
        /// Index of the chosen run within `runs`.
        public let chosenIndex: Int
        /// Distinct non-empty speaker labels in the chosen run.
        public let speakerCount: Int
        /// Mean pairwise Rand agreement of the chosen run with the others
        /// (1.0 when a single run was supplied).
        public let stability: Double

        public init(segments: [SpeakerSegment], chosenIndex: Int, speakerCount: Int, stability: Double) {
            self.segments = segments
            self.chosenIndex = chosenIndex
            self.speakerCount = speakerCount
            self.stability = stability
        }
    }

    /// Pick the consensus run from a cluster-threshold sweep.
    ///
    /// - Parameters:
    ///   - runs: one `[SpeakerSegment]` per swept threshold (e.g. 0.5/0.6/0.7).
    ///   - duration: timeline length; defaults to the max segment end.
    ///   - gridStep: sampling step for the Rand comparison.
    ///   - stabilityEpsilon: runs within this of the best stability are treated
    ///     as tied and broken by speaker count (prefer more speakers).
    public static func pickConsensus(
        runs: [[SpeakerSegment]],
        duration: TimeInterval? = nil,
        gridStep: TimeInterval = defaultGridStep,
        stabilityEpsilon: Double = 0.02,
    ) -> Pick? {
        guard !runs.isEmpty else { return nil }
        if runs.count == 1 {
            return Pick(
                segments: runs[0],
                chosenIndex: 0,
                speakerCount: distinctSpeakers(runs[0]),
                stability: 1.0,
            )
        }

        let total = duration ?? runs.flatMap { $0 }.map(\.end).max() ?? 0
        let grids = runs.map { labelGrid($0, duration: total, step: gridStep) }

        // Mean pairwise Rand agreement of each run with all the others.
        var stability = [Double](repeating: 0, count: runs.count)
        for i in runs.indices {
            var sum = 0.0
            for j in runs.indices where j != i {
                sum += randIndex(grids[i], grids[j])
            }
            stability[i] = sum / Double(runs.count - 1)
        }

        let bestStability = stability.max() ?? 0
        // Among near-ties, prefer the run with more distinct speakers (fights
        // the 1-speaker collapse); final tie → lowest index (stable/reproducible).
        let winner = runs.indices
            .filter { stability[$0] >= bestStability - stabilityEpsilon }
            .max { a, b in
                let sa = distinctSpeakers(runs[a])
                let sb = distinctSpeakers(runs[b])
                if sa != sb { return sa < sb }
                return a > b
            } ?? 0

        return Pick(
            segments: runs[winner],
            chosenIndex: winner,
            speakerCount: distinctSpeakers(runs[winner]),
            stability: stability[winner],
        )
    }

    /// Distinct non-empty speaker labels in a run.
    static func distinctSpeakers(_ segments: [SpeakerSegment]) -> Int {
        Set(segments.map(\.speaker).filter { !$0.isEmpty }).count
    }

    /// Sample a run onto a fixed grid: each cell gets the label of the segment
    /// covering its midpoint, or `""` for silence. Both runs are gridded on the
    /// same `duration`/`step` so their cells line up for the Rand comparison.
    static func labelGrid(_ segments: [SpeakerSegment], duration: TimeInterval, step: TimeInterval) -> [String] {
        guard duration > 0, step > 0 else { return [] }
        let cells = Int((duration / step).rounded(.up))
        var grid = [String](repeating: "", count: max(0, cells))
        for i in 0 ..< grid.count {
            let mid = (Double(i) + 0.5) * step
            if let seg = segments.first(where: { $0.start <= mid && mid < $0.end }) {
                grid[i] = seg.speaker
            }
        }
        return grid
    }

    /// Rand index of two equal-length labelings: fraction of item PAIRS the two
    /// partitions agree on (both-together or both-apart). Computed in
    /// `O(n + k²)` via a contingency table, not `O(n²)`, so a 60-min grid is
    /// cheap. Returns 1.0 for empty/singleton inputs (nothing to disagree on).
    public static func randIndex(_ a: [String], _ b: [String]) -> Double {
        let n = min(a.count, b.count)
        guard n > 1 else { return 1.0 }

        var contingency: [String: [String: Int]] = [:]
        var aSizes: [String: Int] = [:]
        var bSizes: [String: Int] = [:]
        for i in 0 ..< n {
            contingency[a[i], default: [:]][b[i], default: 0] += 1
            aSizes[a[i], default: 0] += 1
            bSizes[b[i], default: 0] += 1
        }

        func choose2(_ x: Int) -> Double { x < 2 ? 0 : Double(x * (x - 1)) / 2 }

        let totalPairs = choose2(n)
        var bothTogether = 0.0
        for (_, row) in contingency {
            for (_, count) in row { bothTogether += choose2(count) }
        }
        let togetherInA = aSizes.values.reduce(0.0) { $0 + choose2($1) }
        let togetherInB = bSizes.values.reduce(0.0) { $0 + choose2($1) }
        // agreements = both-together + both-apart
        let agree = totalPairs + 2 * bothTogether - togetherInA - togetherInB
        return totalPairs > 0 ? agree / totalPairs : 1.0
    }

    // MARK: - P4: overlap second look

    /// A Sortformer-detected overlap span with the stream that dominates it
    /// (already mapped to the VBx cluster label by the caller, via embedding
    /// cosine — `nil` when no confident mapping exists → annotate-only).
    public struct OverlapSpan: Equatable, Sendable {
        public let start: TimeInterval
        public let end: TimeInterval
        public let dominantSpeaker: String?

        public init(start: TimeInterval, end: TimeInterval, dominantSpeaker: String?) {
            self.start = start
            self.end = end
            self.dominantSpeaker = dominantSpeaker
        }

        func contains(_ time: TimeInterval) -> Bool { time >= start && time < end }
    }

    /// A word after the overlap pass: its (possibly reassigned) speaker plus an
    /// `overlap` flag for the outputs contract.
    public struct ResolvedWord: Equatable, Sendable {
        public let word: WordTimeline.Word
        public var speaker: String
        public var overlap: Bool

        public init(word: WordTimeline.Word, speaker: String, overlap: Bool) {
            self.word = word
            self.speaker = speaker
            self.overlap = overlap
        }
    }

    /// Apply overlap spans to attributed words. A word whose midpoint lands in
    /// an overlap span is flagged `overlap`; if the span's dominant speaker is
    /// known and differs from the word's current speaker, the word is moved to
    /// it (Sortformer wins inside a genuine overlap). Words outside every span
    /// keep their speaker and `overlap == false`.
    public static func resolveOverlap(
        words: [WordTimeline.AttributedWord],
        spans: [OverlapSpan],
    ) -> [ResolvedWord] {
        words.map { attr in
            let mid = attr.word.midpoint
            guard let span = spans.first(where: { $0.contains(mid) }) else {
                return ResolvedWord(word: attr.word, speaker: attr.speaker, overlap: false)
            }
            let speaker = span.dominantSpeaker.map { $0.isEmpty ? attr.speaker : $0 } ?? attr.speaker
            return ResolvedWord(word: attr.word, speaker: speaker, overlap: true)
        }
    }

    /// Fraction of words that fall inside any overlap span (for the quality
    /// report's "overlap %").
    public static func overlapFraction(words: [WordTimeline.Word], spans: [OverlapSpan]) -> Double {
        guard !words.isEmpty else { return 0 }
        let inside = words.count { w in spans.contains { $0.contains(w.midpoint) } }
        return Double(inside) / Double(words.count)
    }
}
