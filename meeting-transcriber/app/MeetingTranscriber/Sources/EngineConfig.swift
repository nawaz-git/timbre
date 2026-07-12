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
/// Carries the screen-capture scope (window vs full display) plus the
/// `disableAppAudioTap` kill switch. The mic is always recorded alongside the
/// meeting audio, and the engine's existing `AppSettings.recordScreenVideo`
/// UserDefaults gate stays authoritative for video on/off — neither is in this
/// bridge.
struct EngineConfig {
    var screenCaptureScope: ScreenCaptureScope
    /// When true, the recorder creates NO CoreAudio process tap or aggregate
    /// device — it records the microphone (and screen video) only. A field
    /// mitigation for meetings destabilised by app-audio capture. Defaults to
    /// false (normal dual-source capture); a missing key decodes as false.
    var disableAppAudioTap: Bool

    /// In-code fallback used for a missing / malformed / partial config file —
    /// the sole source of truth for these fields (they have no UserDefaults
    /// backing). The microphone is always recorded alongside the meeting audio,
    /// so there is no mic field here.
    static let `default` = Self(screenCaptureScope: .chromeWindow, disableAppAudioTap: false)

    /// Decodable mirror of the JSON the Electron writer emits. Both fields are
    /// optional so a missing/partial payload still decodes and falls back to
    /// the `.default` values.
    private struct Wire: Decodable {
        let screenCaptureScope: String?
        let disableAppAudioTap: Bool?
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
            screenCaptureScope: scope,
            disableAppAudioTap: wire.disableAppAudioTap ?? false,
        )
    }
}
