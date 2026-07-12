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

    // MARK: - disableAppAudioTap kill switch

    /// `disableAppAudioTap: true` round-trips (and scope still decodes).
    func testReadsDisableAppAudioTap() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"screenCaptureScope":"chromeWindow","disableAppAudioTap":true}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertTrue(cfg.disableAppAudioTap)
        XCTAssertEqual(cfg.screenCaptureScope, .chromeWindow)
    }

    /// `disableAppAudioTap: false` round-trips as false.
    func testReadsDisableAppAudioTapFalse() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"disableAppAudioTap":false}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertFalse(cfg.disableAppAudioTap)
    }

    /// A payload without the key (older Electron writer) defaults the switch off
    /// — the safe default is normal dual-source capture.
    func testMissingDisableAppAudioTapDefaultsFalse() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"screenCaptureScope":"entireScreen"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertFalse(cfg.disableAppAudioTap)
        XCTAssertEqual(cfg.screenCaptureScope, .entireScreen)
    }

    /// Missing file → in-code default has the switch off.
    func testDefaultHasKillSwitchOff() {
        XCTAssertFalse(EngineConfig.default.disableAppAudioTap)
        XCTAssertFalse(EngineConfig.read(from: tempURL()).disableAppAudioTap)
    }

    // MARK: - Diarization-quality bridge fields

    /// A full payload round-trips every field the diarization bridge carries.
    func testReadsFullDiarizationPayload() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"""
        {
          "screenCaptureScope": "entireScreen",
          "processingMode": "max",
          "asrLanguage": "en",
          "transcriptionEngine": "parakeet",
          "numSpeakersHint": 3,
          "globalSpeakersDBPath": "/Users/x/global-speakers.json",
          "llmRepair": { "enabled": true }
        }
        """#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.screenCaptureScope, .entireScreen)
        XCTAssertEqual(cfg.processingMode, .max)
        XCTAssertEqual(cfg.asrLanguage, "en")
        XCTAssertEqual(cfg.transcriptionEngine, .parakeet)
        XCTAssertEqual(cfg.numSpeakersHint, 3)
        XCTAssertEqual(cfg.globalSpeakersDBPath, "/Users/x/global-speakers.json")
        XCTAssertTrue(cfg.llmRepairEnabled)
    }

    /// Every new field falls back to its default when the payload only carries
    /// the (pre-existing) scope key — the additive-bridge contract.
    func testPartialPayloadDefaultsNewFields() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"screenCaptureScope":"chromeWindow"}"#, to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.processingMode, .fast)
        XCTAssertEqual(cfg.asrLanguage, "")
        XCTAssertNil(cfg.transcriptionEngine)
        XCTAssertEqual(cfg.numSpeakersHint, 0)
        XCTAssertNil(cfg.globalSpeakersDBPath)
        XCTAssertFalse(cfg.llmRepairEnabled)
    }

    /// The whole default matches the documented fallback shape.
    func testDefaultCarriesFastAutoNoOverride() {
        let cfg = EngineConfig.default
        XCTAssertEqual(cfg.processingMode, .fast)
        XCTAssertEqual(cfg.asrLanguage, "")
        XCTAssertNil(cfg.transcriptionEngine)
        XCTAssertEqual(cfg.numSpeakersHint, 0)
        XCTAssertNil(cfg.globalSpeakersDBPath)
        XCTAssertFalse(cfg.llmRepairEnabled)
    }

    /// Legacy `"qwen3"` engine values migrate to WhisperKit (Qwen3 was dropped
    /// upstream) rather than leaving the engine unset.
    func testLegacyQwen3EngineMigratesToWhisperKit() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"transcriptionEngine":"qwen3"}"#, to: url)

        XCTAssertEqual(EngineConfig.read(from: url).transcriptionEngine, .whisperKit)
    }

    /// The engine string is case-insensitive so the lowercase bridge contract
    /// and the app enum's camelCase raw value both resolve.
    func testEngineStringIsCaseInsensitive() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"transcriptionEngine":"WhisperKit"}"#, to: url)

        XCTAssertEqual(EngineConfig.read(from: url).transcriptionEngine, .whisperKit)
    }

    /// An unknown engine string is treated as "no override" (nil), not a crash.
    func testUnknownEngineIsNoOverride() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"transcriptionEngine":"someFutureEngine"}"#, to: url)

        XCTAssertNil(EngineConfig.read(from: url).transcriptionEngine)
    }

    /// An unknown processing mode coerces to the safe `.fast` default.
    func testUnknownProcessingModeDefaultsFast() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"processingMode":"turbo"}"#, to: url)

        XCTAssertEqual(EngineConfig.read(from: url).processingMode, .fast)
    }

    /// An empty `globalSpeakersDBPath` (what Timbre serialises when nothing is
    /// configured) is normalised to nil so the engine falls back to its local DB.
    func testEmptyGlobalDBPathNormalisesToNil() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write(#"{"globalSpeakersDBPath":""}"#, to: url)

        XCTAssertNil(EngineConfig.read(from: url).globalSpeakersDBPath)
    }

    /// A malformed payload still yields the full default (every new field
    /// included), never a partially-initialised config.
    func testMalformedJsonReturnsFullDefault() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try write("{ not json", to: url)

        let cfg = EngineConfig.read(from: url)
        XCTAssertEqual(cfg.processingMode, .fast)
        XCTAssertEqual(cfg.asrLanguage, "")
        XCTAssertNil(cfg.transcriptionEngine)
    }
}
