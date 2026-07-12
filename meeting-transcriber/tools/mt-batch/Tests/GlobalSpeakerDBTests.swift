@testable import mt_batch
import XCTest

/// Covers `GlobalSpeakerDB.match` — in particular the fallback that lets a
/// legacy / short-utterance entry (no persisted centroid) still match via its
/// FIFO-sample mean, mirroring the live app matcher.
final class GlobalSpeakerDBTests: XCTestCase {
    func testCentroidBackedEntryMatches() {
        let enrolled = [StoredSpeakerEntry(name: "Alice", embeddings: [[1, 0, 0]], centroid: [1, 0, 0])]
        let result = GlobalSpeakerDB.match(detectedCentroids: ["S0": [0.99, 0.01, 0]], enrolled: enrolled)
        XCTAssertEqual(result.first?.enrolledName, "Alice")
    }

    func testCentroidLessEntryMatchesViaSampleMean() {
        // No persisted centroid — only FIFO samples. The detected voice is
        // near their mean, so it must still match (was rejected before the fix).
        let enrolled = [StoredSpeakerEntry(name: "Alice", embeddings: [[1, 0, 0], [0.98, 0.02, 0]], centroid: nil)]
        let result = GlobalSpeakerDB.match(detectedCentroids: ["S0": [0.99, 0.01, 0]], enrolled: enrolled)
        XCTAssertEqual(result.first?.enrolledName, "Alice", "a centroid-less entry matches via its sample mean")
    }

    func testCentroidLessAndSampleLessEntryDoesNotMatch() {
        // No centroid AND no samples → nothing to compare → no match.
        let enrolled = [StoredSpeakerEntry(name: "Ghost", embeddings: [], centroid: nil)]
        let result = GlobalSpeakerDB.match(detectedCentroids: ["S0": [1, 0, 0]], enrolled: enrolled)
        XCTAssertNil(result.first?.enrolledName)
    }

    func testDistantVoiceDoesNotMatchCentroidLessEntry() {
        let enrolled = [StoredSpeakerEntry(name: "Alice", embeddings: [[1, 0, 0]], centroid: nil)]
        // Orthogonal voice → similarity 0 < floor → no match.
        let result = GlobalSpeakerDB.match(detectedCentroids: ["S0": [0, 1, 0]], enrolled: enrolled)
        XCTAssertNil(result.first?.enrolledName)
    }
}
