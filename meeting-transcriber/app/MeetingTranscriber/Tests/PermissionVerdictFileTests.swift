@testable import MeetingTranscriber
import XCTest

final class PermissionVerdictFileTests: XCTestCase {
    private func parse(_ data: Data) throws -> [String: Any] {
        let obj = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(obj as? [String: Any])
    }

    func test_verdictString_mapsEveryStatus() {
        XCTAssertEqual(PermissionVerdictFile.verdictString(.healthy), "healthy")
        XCTAssertEqual(PermissionVerdictFile.verdictString(.denied), "denied")
        XCTAssertEqual(PermissionVerdictFile.verdictString(.broken), "broken")
        XCTAssertEqual(PermissionVerdictFile.verdictString(.notDetermined), "notDetermined")
    }

    func test_makeJSON_includesAllFields() throws {
        let data = PermissionVerdictFile.makeJSON(
            screen: "healthy",
            mic: "denied",
            ax: "broken",
            notifications: "provisional",
            updatedAt: 1_777_000_000_000,
        )
        let dict = try parse(data)
        XCTAssertEqual(dict["screen"] as? String, "healthy")
        XCTAssertEqual(dict["mic"] as? String, "denied")
        XCTAssertEqual(dict["ax"] as? String, "broken")
        XCTAssertEqual(dict["notifications"] as? String, "provisional")
        XCTAssertEqual(dict["updatedAt"] as? Int, 1_777_000_000_000)
    }

    func test_write_isAtomicParseableAndOwnerOnly() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("verdict-test-\(UUID().uuidString)")
        let url = dir.appendingPathComponent("permission_verdict.json")
        defer { try? FileManager.default.removeItem(at: dir) }

        try PermissionVerdictFile.write(
            screen: "healthy",
            mic: "healthy",
            ax: "denied",
            notifications: "authorized",
            updatedAt: 42,
            to: url,
        )

        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        let dict = try parse(Data(contentsOf: url))
        XCTAssertEqual(dict["ax"] as? String, "denied")
        XCTAssertEqual(dict["notifications"] as? String, "authorized")
        XCTAssertEqual(dict["updatedAt"] as? Int, 42)

        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let perms = try XCTUnwrap(attrs[.posixPermissions] as? NSNumber)
        XCTAssertEqual(perms.int16Value, 0o600)
    }

    func test_write_overwritesExistingVerdict() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("verdict-test-\(UUID().uuidString)")
        let url = dir.appendingPathComponent("permission_verdict.json")
        defer { try? FileManager.default.removeItem(at: dir) }

        try PermissionVerdictFile.write(
            screen: "denied", mic: "denied", ax: "denied",
            notifications: "denied", updatedAt: 1, to: url,
        )
        try PermissionVerdictFile.write(
            screen: "healthy", mic: "healthy", ax: "healthy",
            notifications: "authorized", updatedAt: 2, to: url,
        )
        let dict = try parse(Data(contentsOf: url))
        XCTAssertEqual(dict["screen"] as? String, "healthy")
        XCTAssertEqual(dict["updatedAt"] as? Int, 2)
    }
}
