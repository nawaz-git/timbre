@testable import MeetingTranscriber
import XCTest

/// Round-trip + default/coercion tests for the cross-process engine config
/// reader. Proves the in-code defaults and scope coercion match the bridge
/// schema (`engine_config.json` written by the Electron app).
final class EngineConfigTests: XCTestCase {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-config-\(UUID()).json")
    }

    private func write(_ json: String, to url: URL) throws {
        try Data(json.utf8).write(to: url)
    }

    /// A full payload round-trips both fields verbatim.
    func testReadsFullPayload() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"recordMicrophone":false,"screenCaptureScope":"entireScreen"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertFalse(cfg.recordMicrophone)
        XCTAssertEqual(cfg.screenCaptureScope, .entireScreen)
    }

    /// Missing file → in-code defaults (mic ON, Chrome window).
    func testMissingFileReturnsDefault() {
        let cfg = EngineConfig.read(from: tempURL())
        XCTAssertEqual(cfg.recordMicrophone, EngineConfig.default.recordMicrophone)
        XCTAssertEqual(cfg.screenCaptureScope, EngineConfig.default.screenCaptureScope)
        XCTAssertTrue(cfg.recordMicrophone)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// Malformed JSON → defaults.
    func testMalformedJsonReturnsDefault() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write("{ not valid json ", to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertTrue(cfg.recordMicrophone)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// An unknown scope string coerces to the Chrome-window default.
    func testUnknownScopeCoercesToChromeWindow() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"recordMicrophone":true,"screenCaptureScope":"someFutureMode"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// A partial payload (only recordMicrophone) keeps that value and defaults
    /// the scope to Chrome window.
    func testPartialPayloadDefaultsMissingScope() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"recordMicrophone":false}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertFalse(cfg.recordMicrophone)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }
}
