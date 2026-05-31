@testable import MeetingTranscriber
import XCTest

/// Round-trip + default/coercion tests for the cross-process engine config
/// reader. Proves the in-code default and scope coercion match the bridge
/// schema (`engine_config.json` written by the Electron app).
final class EngineConfigTests: XCTestCase {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-config-\(UUID()).json")
    }

    private func write(_ json: String, to url: URL) throws {
        try Data(json.utf8).write(to: url)
    }

    /// A payload's scope round-trips verbatim.
    func testReadsScope() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"screenCaptureScope":"entireScreen"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .entireScreen)
    }

    /// Missing file → in-code default (Chrome window).
    func testMissingFileReturnsDefault() {
        let cfg = EngineConfig.read(from: tempURL())
        XCTAssertEqual(cfg.screenCaptureScope, EngineConfig.default.screenCaptureScope)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// Malformed JSON → default.
    func testMalformedJsonReturnsDefault() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write("{ not valid json ", to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// An unknown scope string coerces to the Chrome-window default.
    func testUnknownScopeCoercesToChromeWindow() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"screenCaptureScope":"someFutureMode"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// An empty payload (no scope key) defaults to Chrome window.
    func testEmptyPayloadDefaultsScope() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write("{}", to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }
}
