import MTPipelineCore
import XCTest

/// Pure-logic tests for the MAX-tier utterance re-scoring loop. Synthetic
/// embeddings (near-orthogonal unit vectors stand in for distinct voices) let
/// us pin the behaviour that matters: a planted mis-assignment gets fixed, a
/// correct assignment stays put, an ambiguous one doesn't flip-flop, and
/// embedding-less utterances are left alone.
final class UtteranceRescorerTests: XCTestCase {
    private func utt(_ id: Int, _ embedding: [Float], _ speaker: String) -> UtteranceRescorer.Utterance {
        UtteranceRescorer.Utterance(id: id, embedding: embedding, speaker: speaker)
    }

    // Two near-orthogonal "voices".
    private let voiceA: [Float] = [1, 0, 0]
    private let voiceB: [Float] = [0, 1, 0]

    func testPlantedMisassignmentIsFixed() {
        // Utterance 2 sounds like B but was labelled A → must move to B.
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceA, "A"),
            utt(2, voiceB, "A"), // planted error
            utt(3, voiceB, "B"),
        ]
        let result = UtteranceRescorer.rescore(utterances: input)
        XCTAssertEqual(result.utterances.first { $0.id == 2 }?.speaker, "B")
        XCTAssertTrue(result.reassignments.contains { $0.utteranceID == 2 && $0.from == "A" && $0.to == "B" })
    }

    func testCorrectAssignmentsAreStable() {
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceA, "A"),
            utt(2, voiceB, "B"),
            utt(3, voiceB, "B"),
        ]
        let result = UtteranceRescorer.rescore(utterances: input)
        XCTAssertTrue(result.reassignments.isEmpty, "No utterance should move when all are already correct")
        XCTAssertEqual(result.utterances.map(\.speaker), ["A", "A", "B", "B"])
    }

    func testAmbiguousUtteranceKeepsLabel() {
        // An utterance equidistant from both centroids (margin ~0) must not move.
        let ambiguous: [Float] = UtteranceRescorer.normalize([1, 1, 0])
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceB, "B"),
            utt(2, ambiguous, "A"),
        ]
        let result = UtteranceRescorer.rescore(utterances: input, reassignMargin: 0.10)
        XCTAssertEqual(result.utterances.first { $0.id == 2 }?.speaker, "A", "Below-margin utterance keeps its seed label")
    }

    func testEmbeddinglessUtteranceIsUntouched() {
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceB, "B"),
            utt(2, [], "A"), // no embedding — too short to score
        ]
        let result = UtteranceRescorer.rescore(utterances: input)
        XCTAssertEqual(result.utterances.first { $0.id == 2 }?.speaker, "A")
        XCTAssertNil(result.confidence[2], "Embedding-less utterance gets no confidence")
    }

    func testConfidenceIsBestMinusSecondMargin() {
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceB, "B"),
        ]
        let result = UtteranceRescorer.rescore(utterances: input)
        // Utterance 0 == centroid A (cos 1.0), cos to B ~0 → margin ≈ 1.0.
        let c0 = try? XCTUnwrap(result.confidence[0])
        XCTAssertNotNil(c0)
        if let c0 { XCTAssertGreaterThan(c0, 0.8) }
    }

    func testSeedCentroidsKeepEmptyClusterAnchored() {
        // Cluster B has no utterances initially; a seed centroid for B lets an
        // A-labelled B-voice utterance still find its way home.
        let input = [
            utt(0, voiceA, "A"),
            utt(1, voiceB, "A"), // sounds like B, no B utterance yet
        ]
        let result = UtteranceRescorer.rescore(
            utterances: input,
            seedCentroids: ["A": voiceA, "B": voiceB],
        )
        XCTAssertEqual(result.utterances.first { $0.id == 1 }?.speaker, "B")
    }

    func testIterationsAreBounded() {
        let input = (0 ..< 6).map { utt($0, $0 % 2 == 0 ? voiceA : voiceB, "A") }
        let result = UtteranceRescorer.rescore(utterances: input, maxIterations: 3)
        XCTAssertLessThanOrEqual(result.iterations, 3)
        XCTAssertGreaterThanOrEqual(result.iterations, 1)
    }

    func testCosineHelper() {
        XCTAssertEqual(UtteranceRescorer.cosine([1, 0], [1, 0]), 1.0, accuracy: 1e-6)
        XCTAssertEqual(UtteranceRescorer.cosine([1, 0], [0, 1]), 0.0, accuracy: 1e-6)
        XCTAssertEqual(UtteranceRescorer.cosine([1, 0], []), 0.0, accuracy: 1e-6)
        XCTAssertEqual(UtteranceRescorer.cosine([], []), 0.0, accuracy: 1e-6)
    }

    func testNormalizeUnitLength() {
        let n = UtteranceRescorer.normalize([3, 4])
        XCTAssertEqual((n[0] * n[0] + n[1] * n[1]).squareRoot(), 1.0, accuracy: 1e-6)
        // Zero-vector is returned unchanged (no divide-by-zero).
        XCTAssertEqual(UtteranceRescorer.normalize([0, 0]), [0, 0])
    }
}
