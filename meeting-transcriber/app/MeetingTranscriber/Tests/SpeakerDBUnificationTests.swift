@testable import MeetingTranscriber
import XCTest

/// Covers the unified speaker-DB work: the shared match decision rule, the
/// cross-writer `lastUsed` encoding (Unix seconds, byte-compatible with the
/// Electron/Timbre writer), and the one-time local → global migration.
final class SpeakerDBUnificationTests: XCTestCase {
    // swiftlint:disable implicitly_unwrapped_optional
    private var tmpDir: URL!
    // swiftlint:enable implicitly_unwrapped_optional

    override func setUpWithError() throws {
        tmpDir = try makeTempDirectory(prefix: "SpeakerDBUnification")
    }

    // MARK: - Decision rule constants

    /// The distance ceiling is the similarity floor mirrored into distance space.
    /// The floor/margin are the mainline-equivalent defaults (0.60 / 0.10) so
    /// already-enrolled voices keep matching; the quality lane re-fits them.
    func testDistanceCeilingMirrorsSimilarityFloor() {
        XCTAssertEqual(SpeakerMatcher.matchSimilarityFloor, 0.60, accuracy: 0.0001)
        XCTAssertEqual(SpeakerMatcher.matchSimilarityMargin, 0.10, accuracy: 0.0001)
        XCTAssertEqual(
            SpeakerMatcher.matchDistanceCeiling,
            1 - SpeakerMatcher.matchSimilarityFloor,
            accuracy: 0.0001,
        )
    }

    /// A default-constructed matcher enforces the unified rule: a voice at
    /// similarity 0.62 matches under the 0.60 floor (the mainline behaviour —
    /// tightening the floor to 0.65 would have regressed such enrolments), and a
    /// near-identical voice still matches.
    func testDefaultMatcherEnforcesUnifiedFloor() throws {
        let dbPath = tmpDir.appendingPathComponent("speakers.json")
        let matcher = SpeakerMatcher(dbPath: dbPath)
        matcher.saveDB([StoredSpeaker(name: "Alice", embeddings: [[1, 0, 0]])])

        // cos([1,0,0], [0.62, 0.7846, 0]) = 0.62 → similarity 0.62 > floor 0.60.
        let borderline = matcher.match(embeddings: ["S0": [0.62, 0.7846, 0]])
        XCTAssertEqual(borderline["S0"], "Alice", "similarity 0.62 is above the 0.60 floor → matches")

        let clear = matcher.match(embeddings: ["S0": [0.99, 0.01, 0]])
        XCTAssertEqual(clear["S0"], "Alice", "a near-identical voice still matches")
    }

    // MARK: - Cross-writer lastUsed encoding

    /// `lastUsed` serialises as a Unix-epoch-seconds NUMBER — the exact shape
    /// Electron's `enrollOrUpdateSpeaker` writes (`Date.now() / 1000`).
    func testLastUsedEncodesAsUnixSeconds() throws {
        let speaker = StoredSpeaker(
            name: "Bob",
            embeddings: [[1, 0, 0]],
            lastUsed: Date(timeIntervalSince1970: 1_777_000_000),
            useCount: 2,
        )
        let data = try JSONEncoder().encode([speaker])
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [[String: Any]],
        )
        let lastUsed = try XCTUnwrap(json.first?["lastUsed"] as? Double)
        XCTAssertEqual(lastUsed, 1_777_000_000, accuracy: 0.5)
    }

    /// An Electron-written entry (bare Unix-seconds number) decodes to the right
    /// wall-clock time — the two writers agree on the shared global DB.
    func testDecodesElectronStyleUnixLastUsed() throws {
        let json = #"[{"name":"Bob","embeddings":[[1,0,0]],"lastUsed":1777000000,"useCount":2}]"#
        let decoded = try JSONDecoder().decode([StoredSpeaker].self, from: Data(json.utf8))
        XCTAssertEqual(decoded[0].lastUsed, Date(timeIntervalSince1970: 1_777_000_000))
    }

    /// Full round-trip through the matcher's own save/load preserves the instant.
    func testLastUsedRoundTripsThroughSaveLoad() throws {
        let dbPath = tmpDir.appendingPathComponent("speakers.json")
        let matcher = SpeakerMatcher(dbPath: dbPath)
        let when = Date(timeIntervalSince1970: 1_752_345_678)
        matcher.saveDB([StoredSpeaker(name: "Bob", embeddings: [[1, 0, 0]], lastUsed: when)])
        XCTAssertEqual(matcher.loadDB()[0].lastUsed, when)
    }

    // MARK: - Local → global migration

    private func write(_ speakers: [StoredSpeaker], to url: URL) throws {
        try JSONEncoder().encode(speakers).write(to: url)
    }

    func testMigrationMergesLocalIntoGlobalByName() throws {
        let localPath = tmpDir.appendingPathComponent("local/speakers.json")
        let globalPath = tmpDir.appendingPathComponent("global/global-speakers.json")
        try FileManager.default.createDirectory(
            at: localPath.deletingLastPathComponent(), withIntermediateDirectories: true,
        )
        try FileManager.default.createDirectory(
            at: globalPath.deletingLastPathComponent(), withIntermediateDirectories: true,
        )

        try write([
            StoredSpeaker(name: "Alice", embeddings: [[1, 0, 0]], useCount: 2),
            StoredSpeaker(name: "LocalOnly", embeddings: [[0, 1, 0]], useCount: 1),
        ], to: localPath)
        try write([
            StoredSpeaker(name: "Alice", embeddings: [[0.9, 0.1, 0]], useCount: 3),
            StoredSpeaker(name: "GlobalOnly", embeddings: [[0, 0, 1]], useCount: 5),
        ], to: globalPath)

        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(localPath: localPath, globalPath: globalPath)

        let merged = SpeakerMatcher(dbPath: globalPath).loadDB()
        let names = Set(merged.map(\.name))
        XCTAssertEqual(names, ["Alice", "LocalOnly", "GlobalOnly"], "no duplicates; local + global unioned")
        let alice = try XCTUnwrap(merged.first { $0.name == "Alice" })
        XCTAssertEqual(alice.useCount, 5, "colliding names fold useCount (3 + 2)")
    }

    func testMigrationIsOneTime() throws {
        let localPath = tmpDir.appendingPathComponent("local/speakers.json")
        let globalPath = tmpDir.appendingPathComponent("global/global-speakers.json")
        try FileManager.default.createDirectory(
            at: localPath.deletingLastPathComponent(), withIntermediateDirectories: true,
        )
        try FileManager.default.createDirectory(
            at: globalPath.deletingLastPathComponent(), withIntermediateDirectories: true,
        )
        try write([StoredSpeaker(name: "Alice", embeddings: [[1, 0, 0]])], to: localPath)
        try write([], to: globalPath)

        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(localPath: localPath, globalPath: globalPath)
        XCTAssertEqual(SpeakerMatcher(dbPath: globalPath).loadDB().count, 1)

        // A later local addition must NOT re-merge — the marker blocks it.
        try write([
            StoredSpeaker(name: "Alice", embeddings: [[1, 0, 0]]),
            StoredSpeaker(name: "Added", embeddings: [[0, 1, 0]]),
        ], to: localPath)
        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(localPath: localPath, globalPath: globalPath)
        XCTAssertEqual(
            SpeakerMatcher(dbPath: globalPath).loadDB().count, 1,
            "second call is a no-op — migration runs once",
        )
    }

    func testMigrationNoOpWhenGlobalEqualsLocal() throws {
        let path = tmpDir.appendingPathComponent("speakers.json")
        try write([StoredSpeaker(name: "Alice", embeddings: [[1, 0, 0]])], to: path)

        // Same path on both sides → nothing to unify, and no marker is dropped.
        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(localPath: path, globalPath: path)
        let marker = path.deletingLastPathComponent()
            .appendingPathComponent(".engine-local-speakers-merged")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertEqual(SpeakerMatcher(dbPath: path).loadDB().count, 1)
    }

    func testMigrationNoLocalFileDropsMarkerAndLeavesGlobal() throws {
        let localPath = tmpDir.appendingPathComponent("local/speakers.json") // does not exist
        let globalPath = tmpDir.appendingPathComponent("global/global-speakers.json")
        try FileManager.default.createDirectory(
            at: globalPath.deletingLastPathComponent(), withIntermediateDirectories: true,
        )
        try write([StoredSpeaker(name: "GlobalOnly", embeddings: [[1, 0, 0]])], to: globalPath)

        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(localPath: localPath, globalPath: globalPath)

        let marker = globalPath.deletingLastPathComponent()
            .appendingPathComponent(".engine-local-speakers-merged")
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "marker dropped so we don't rescan")
        XCTAssertEqual(SpeakerMatcher(dbPath: globalPath).loadDB().count, 1, "global untouched")
    }
}
