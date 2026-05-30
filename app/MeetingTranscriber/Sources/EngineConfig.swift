import Foundation

/// Which slice of the screen the video recorder captures.
enum ScreenCaptureScope: String {
    /// Capture ONLY the meeting browser window (default). Falls back to the
    /// whole display if no matching window can be resolved.
    case chromeWindow
    /// Capture the entire main display (legacy behaviour).
    case entireScreen
}

/// Cross-process configuration the Electron app writes into
/// `AppPaths.engineConfigFile` and the engine reads FRESH at the start of each
/// meeting (see `WatchLoop.handleMeeting`). Reading it per-meeting — rather than
/// at process launch — sidesteps the UserDefaults cross-process caching trap and
/// lets a mid-session settings change take effect on the next meeting.
///
/// Carries ONLY the two genuinely-new cross-process concepts (mic on/off, screen
/// scope). The engine's existing `AppSettings.recordScreenVideo` UserDefaults
/// gate stays authoritative for video on/off and is deliberately NOT in this
/// bridge.
struct EngineConfig {
    /// When false, the meeting is recorded app-audio-only (maps to
    /// `DualSourceRecorder.start(noMic: true)`).
    var recordMicrophone: Bool
    var screenCaptureScope: ScreenCaptureScope

    /// In-code fallback used for a missing / malformed / partial config file —
    /// the sole source of truth for `screenCaptureScope` (it has no UserDefaults
    /// backing) and the safe default for `recordMicrophone` (mic ON, so the
    /// user's voice is never silently dropped — diarization needs the mic track).
    static let `default` = Self(recordMicrophone: true, screenCaptureScope: .chromeWindow)

    /// Decodable mirror of the JSON the Electron writer emits. Both fields are
    /// optional so a partial payload still decodes; missing fields fall back to
    /// `.default` values.
    private struct Wire: Decodable {
        // Optional so a partial payload decodes; nil → `.default` (mic ON).
        // swiftlint:disable:next discouraged_optional_boolean
        let recordMicrophone: Bool?
        let screenCaptureScope: String?
    }

    /// Read the config FRESH. Returns `.default` on any failure (missing file,
    /// malformed JSON, partial payload, unknown scope string). No staleness
    /// gating — the file is last-known-good and must survive Electron quitting.
    static func read(from url: URL = AppPaths.engineConfigFile) -> Self {
        guard let data = try? Data(contentsOf: url),
              let wire = try? JSONDecoder().decode(Wire.self, from: data)
        else {
            return .default
        }
        let scope: ScreenCaptureScope = wire.screenCaptureScope == ScreenCaptureScope.entireScreen.rawValue
            ? .entireScreen
            : .chromeWindow
        return Self(
            recordMicrophone: wire.recordMicrophone ?? Self.default.recordMicrophone,
            screenCaptureScope: scope,
        )
    }
}
