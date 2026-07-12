import Foundation

/// Pure, model-free utterance re-scoring — the accuracy core of MAX-tier
/// diarization refinement (plan Tier-2 pass P2).
///
/// FAST attribution assigns each word a speaker from the clusterer's turn
/// timeline. That is right most of the time but wrong for a whole utterance
/// whenever the clusterer put a boundary a second early/late or merged two
/// short turns. This pass re-scores at *utterance* granularity: each utterance
/// carries one speaker embedding (a WeSpeaker vector extracted over the
/// utterance's own, overlap-excluded frames — the caller owns that CoreML
/// step), and we iteratively move an utterance to the cluster centroid it
/// actually sounds most like. It is VBx-style resegmentation, but at the
/// granularity a reader perceives ("this one sentence is the wrong speaker").
///
/// The loop is deterministic and side-effect-free so it unit-tests without any
/// model: feed synthetic embeddings, assert planted mis-assignments get fixed
/// and correct ones stay put.
///
///   1. seed centroids from the initial assignment (or take caller-supplied
///      ones),
///   2. for every utterance with an embedding, cosine-compare to each centroid
///      and reassign to the best one **only when it beats the runner-up by
///      `reassignMargin`** (an ambiguous utterance keeps its label rather than
///      flip-flopping),
///   3. recompute centroids from the new assignment,
///   4. repeat until fewer than `minMoveFraction` of utterances move or
///      `maxIterations` is hit.
///
/// Each utterance's final confidence is the margin between its best and
/// second-best centroid — surfaced in the MAX quality report.
public enum UtteranceRescorer {
    /// Minimum best-vs-second-best cosine margin for a reassignment to fire.
    /// Below it the utterance is ambiguous and keeps its current label.
    public static let defaultReassignMargin: Float = 0.10

    /// Hard cap on refinement iterations (plan: "iterate ≤3").
    public static let defaultMaxIterations = 3

    /// Stop early once fewer than this fraction of utterances move in an
    /// iteration (plan: "until <1 % utterances move").
    public static let defaultMinMoveFraction = 0.01

    /// One utterance to re-score. `embedding` is the L2-normalised speaker
    /// vector over the utterance's own frames, or empty when the utterance was
    /// too short / too overlapped to embed (those keep their seed speaker and
    /// never vote a centroid).
    public struct Utterance: Equatable, Sendable {
        public let id: Int
        public let embedding: [Float]
        public var speaker: String

        public init(id: Int, embedding: [Float], speaker: String) {
            self.id = id
            self.embedding = embedding
            self.speaker = speaker
        }

        var hasEmbedding: Bool { !embedding.isEmpty }
    }

    /// A speaker move the loop made, for the quality report / diagnostics.
    public struct Reassignment: Equatable, Sendable {
        public let utteranceID: Int
        public let from: String
        public let to: String
        public let confidence: Float

        public init(utteranceID: Int, from: String, to: String, confidence: Float) {
            self.utteranceID = utteranceID
            self.from = from
            self.to = to
            self.confidence = confidence
        }
    }

    public struct Result: Equatable, Sendable {
        /// Utterances with their final speaker labels (input order preserved).
        public let utterances: [Utterance]
        /// Per-utterance confidence = best-vs-second-best centroid margin. No
        /// entry for embedding-less utterances (they were not re-scored).
        public let confidence: [Int: Float]
        /// Net moves relative to the seed assignment.
        public let reassignments: [Reassignment]
        /// Iterations actually run (≤ `maxIterations`).
        public let iterations: Int

        public init(
            utterances: [Utterance],
            confidence: [Int: Float],
            reassignments: [Reassignment],
            iterations: Int,
        ) {
            self.utterances = utterances
            self.confidence = confidence
            self.reassignments = reassignments
            self.iterations = iterations
        }
    }

    /// Re-score `utterances`. `seedCentroids` overrides the centroids computed
    /// from the initial assignment (MAX passes the P1 cluster centroids so a
    /// cluster with zero confidently-assigned utterances still has an anchor);
    /// pass `nil` to derive them from the input labels.
    public static func rescore(
        utterances: [Utterance],
        seedCentroids: [String: [Float]]? = nil,
        reassignMargin: Float = defaultReassignMargin,
        maxIterations: Int = defaultMaxIterations,
        minMoveFraction: Double = defaultMinMoveFraction,
    ) -> Result {
        var current = utterances
        let seedSpeakers = utterances.map(\.speaker)

        var centroids = seedCentroids ?? computeCentroids(from: current)
        // Keep every seed cluster label alive even if it currently has no
        // embedding-bearing utterance, so utterances can still move *back* to it.
        for label in Set(seedSpeakers) where centroids[label] == nil {
            centroids[label] = seedCentroids?[label]
        }

        var confidence: [Int: Float] = [:]
        var iterations = 0

        for _ in 0 ..< max(1, maxIterations) {
            iterations += 1
            var moved = 0
            var scorable = 0

            for i in current.indices where current[i].hasEmbedding {
                guard let ranked = rank(embedding: current[i].embedding, against: centroids) else { continue }
                scorable += 1
                confidence[current[i].id] = ranked.margin
                if ranked.best != current[i].speaker, ranked.margin >= reassignMargin {
                    current[i].speaker = ranked.best
                    moved += 1
                }
            }

            centroids = computeCentroids(from: current, keepingLabelsFrom: centroids)
            if scorable == 0 { break }
            if Double(moved) / Double(scorable) < minMoveFraction { break }
        }

        var reassignments: [Reassignment] = []
        for (i, utt) in current.enumerated() where utt.speaker != seedSpeakers[i] {
            reassignments.append(Reassignment(
                utteranceID: utt.id,
                from: seedSpeakers[i],
                to: utt.speaker,
                confidence: confidence[utt.id] ?? 0,
            ))
        }

        return Result(
            utterances: current,
            confidence: confidence,
            reassignments: reassignments,
            iterations: iterations,
        )
    }

    // MARK: - Centroids

    /// L2-normalised mean of the embeddings assigned to each speaker. Only
    /// embedding-bearing utterances contribute. `keepingLabelsFrom` preserves
    /// centroids for labels that momentarily lost all their utterances so a
    /// cluster can't silently disappear mid-loop.
    static func computeCentroids(
        from utterances: [Utterance],
        keepingLabelsFrom prior: [String: [Float]] = [:],
    ) -> [String: [Float]] {
        var sums: [String: [Float]] = [:]
        var counts: [String: Int] = [:]
        for utt in utterances where utt.hasEmbedding {
            counts[utt.speaker, default: 0] += 1
            if var running = sums[utt.speaker] {
                for k in running.indices where k < utt.embedding.count { running[k] += utt.embedding[k] }
                sums[utt.speaker] = running
            } else {
                sums[utt.speaker] = utt.embedding
            }
        }
        var result: [String: [Float]] = [:]
        for (label, sum) in sums {
            result[label] = normalize(sum.map { $0 / Float(counts[label] ?? 1) })
        }
        for (label, vector) in prior where result[label] == nil {
            result[label] = vector
        }
        return result
    }

    /// Best + second-best centroid for one embedding, with the confidence
    /// margin between them. `nil` when there is no centroid to compare against.
    private static func rank(
        embedding: [Float],
        against centroids: [String: [Float]],
    ) -> (best: String, margin: Float)? {
        var bestLabel: String?
        var bestSim: Float = -.greatestFiniteMagnitude
        var secondSim: Float = -.greatestFiniteMagnitude
        for (label, centroid) in centroids {
            let sim = cosine(embedding, centroid)
            if sim > bestSim {
                secondSim = bestSim
                bestSim = sim
                bestLabel = label
            } else if sim > secondSim {
                secondSim = sim
            }
        }
        guard let bestLabel else { return nil }
        // With a single centroid there is no runner-up — treat the margin as
        // the raw similarity so a lone cluster never blocks (or forces) a move.
        let margin = secondSim == -.greatestFiniteMagnitude ? bestSim : bestSim - secondSim
        return (bestLabel, margin)
    }

    // MARK: - Vector math

    /// Cosine similarity of two vectors. Zero when either is empty or a
    /// zero-vector; tolerates a length mismatch by comparing the shared prefix.
    public static func cosine(_ a: [Float], _ b: [Float]) -> Float {
        let n = min(a.count, b.count)
        guard n > 0 else { return 0 }
        var dot: Float = 0
        var na: Float = 0
        var nb: Float = 0
        for i in 0 ..< n {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        let denom = (na.squareRoot() * nb.squareRoot())
        return denom > 1e-9 ? dot / denom : 0
    }

    /// L2-normalise, returning the input unchanged when its norm is ~0.
    public static func normalize(_ v: [Float]) -> [Float] {
        let norm = v.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        return norm > 1e-9 ? v.map { $0 / norm } : v
    }
}
