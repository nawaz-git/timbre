@testable import MeetingTranscriber
import XCTest

final class JobErrorSidecarTests: XCTestCase {
    private func encodeAsDict(_ sidecar: JobErrorSidecar) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(sidecar)
        let obj = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(obj as? [String: Any])
    }

    func test_encode_includesAllFieldsWithAbsolutePaths() throws {
        let sidecar = JobErrorSidecar(
            title: "Standup",
            error: "Empty transcript",
            failedAt: Date(timeIntervalSince1970: 1_777_000_000),
            jobShortID: "abcd1234",
            mixPath: URL(fileURLWithPath: "/tmp/recordings/20260503_083000_mix.wav"),
            appPath: URL(fileURLWithPath: "/tmp/recordings/20260503_083000_app.wav"),
            micPath: URL(fileURLWithPath: "/tmp/recordings/20260503_083000_mic.wav"),
            micDelay: 0.12,
            warnings: ["low mic level"],
        )
        let dict = try encodeAsDict(sidecar)

        XCTAssertEqual(dict["version"] as? Int, 1)
        XCTAssertEqual(dict["title"] as? String, "Standup")
        XCTAssertEqual(dict["error"] as? String, "Empty transcript")
        XCTAssertEqual(dict["jobShortID"] as? String, "abcd1234")
        XCTAssertEqual(dict["micDelay"] as? Double, 0.12)
        XCTAssertEqual(dict["warnings"] as? [String], ["low mic level"])
        XCTAssertNotNil(dict["failedAt"] as? String, "failedAt must serialize as an ISO8601 string")
        // Absolute source paths so a retry can reach the App Support originals.
        XCTAssertEqual(dict["mixPath"] as? String, "/tmp/recordings/20260503_083000_mix.wav")
        XCTAssertEqual(dict["appPath"] as? String, "/tmp/recordings/20260503_083000_app.wav")
        XCTAssertEqual(dict["micPath"] as? String, "/tmp/recordings/20260503_083000_mic.wav")
    }

    func test_encode_omitsSourcePathsWhenNil() throws {
        let sidecar = JobErrorSidecar(
            title: "Paired import",
            error: "boom",
            jobShortID: "0000ffff",
            mixPath: nil,
            appPath: nil,
            micPath: nil,
            micDelay: 0,
            warnings: [],
        )
        let dict = try encodeAsDict(sidecar)
        XCTAssertNil(dict["mixPath"])
        XCTAssertNil(dict["appPath"])
        XCTAssertNil(dict["micPath"])
    }

    func test_write_producesDecodableFileWithGivenName() throws {
        let dir = try makeTempDirectory(prefix: "job_error_sidecar")
        let sidecar = JobErrorSidecar(
            title: "Standup",
            error: "Empty transcript",
            jobShortID: "abcd1234",
            mixPath: URL(fileURLWithPath: "/tmp/mix.wav"),
            appPath: nil,
            micPath: nil,
            micDelay: 0,
            warnings: [],
        )
        let url = try sidecar.write(toDirectory: dir, filename: "20260503_0830_standup.error.json")

        XCTAssertEqual(url.lastPathComponent, "20260503_0830_standup.error.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(JobErrorSidecar.self, from: Data(contentsOf: url))
        XCTAssertEqual(decoded.version, 1)
        XCTAssertEqual(decoded.error, "Empty transcript")
        XCTAssertEqual(decoded.mixPath, "/tmp/mix.wav")
    }

    func test_engineLastError_writesDecodableFile() throws {
        let dir = try makeTempDirectory(prefix: "engine_last_error")
        let url = try EngineLastError(
            error: "Screen recording permission revoked",
            at: Date(timeIntervalSince1970: 1_777_000_000),
        ).write(toDirectory: dir)

        XCTAssertEqual(url.lastPathComponent, "engine_last_error.json")
        let dict = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
        )
        XCTAssertEqual(dict["error"] as? String, "Screen recording permission revoked")
        XCTAssertNotNil(dict["at"] as? String)
    }
}
