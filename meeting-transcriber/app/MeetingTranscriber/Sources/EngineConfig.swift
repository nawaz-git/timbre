import Foundation

/// Which slice of the screen the video recorder captures.
enum ScreenCaptureScope: String {
    /// Capture ONLY the meeting browser window (default). Falls back to the
    /// whole display if no matching window can be resolved.
    case chromeWindow
    /// Capture the entire main display (legacy behaviour).
    case entireScreen
}

/// Post-processing effort the engine applies AFTER a meeting finishes.
/// `fast` is the default same-latency pipeline; `max` requests the slower,
/// high-accuracy speaker-attribution refinement. The refinement passes are
/// consumed downstream — this bridge only carries the user's choice so a
/// headless engine driven by Timbre honours the tier the user picked.
enum ProcessingMode: String {
    case fast
    case max
}

/// Cross-process configuration the Electron app writes into
/// `AppPaths.engineConfigFile` and the engine reads FRESH at the start of each
/// meeting (see `WatchLoop.handleMeeting`). Reading it per-meeting — rather than
/// at process launch — sidesteps the UserDefaults cross-process caching trap and
/// lets a mid-session settings change take effect on the next meeting.
///
/// Carries the screen-capture scope (window vs full display) and the
/// `disableAppAudioTap` kill switch, plus the diarization-quality knobs Timbre
/// owns: the processing tier, the ASR language (the engine no longer forces
/// German), an optional engine override, a speaker-count hint, the path to the
/// unified global speakers DB, and the MAX-mode LLM-repair gate. The mic is
/// always recorded alongside the meeting audio, and the engine's existing
/// `AppSettings.recordScreenVideo` UserDefaults gate stays authoritative for
/// video on/off — neither is in this bridge. Every field is OPTIONAL on the
/// wire and falls back to `.default`, so a missing / partial / malformed
/// payload never breaks a recording.
struct EngineConfig {
    var screenCaptureScope: ScreenCaptureScope
    /// When true, the recorder creates NO CoreAudio process tap or aggregate
    /// device — it records the microphone (and screen video) only. A field
    /// mitigation for meetings destabilised by app-audio capture. Defaults to
    /// false (normal dual-source capture); a missing key decodes as false.
    var disableAppAudioTap: Bool
    /// Requested post-processing tier. Default `.fast`.
    var processingMode: ProcessingMode
    /// ASR language hint (ISO 639-1, e.g. "en", "de"). Empty string = auto-detect.
    /// This is the R5 fix: Timbre owns the language, so a headless engine no
    /// longer forces German on non-German meetings.
    var asrLanguage: String
    /// Engine override supplied by Timbre. `nil` = no override — the engine keeps
    /// its own `AppSettings.transcriptionEngine` choice. A legacy `"qwen3"` value
    /// migrates to WhisperKit (Qwen3 was dropped upstream).
    var transcriptionEngine: TranscriptionEngineSetting?
    /// Fixed remote-speaker-count hint. 0 = auto-detect.
    var numSpeakersHint: Int
    /// Absolute path to the unified global speakers DB (Timbre's
    /// `global-speakers.json`, in Electron userData). `nil` = fall back to the
    /// engine's local `AppPaths.speakersDB`.
    var globalSpeakersDBPath: String?
    /// MAX-mode LLM speaker-repair gate. Default false. Consumed by the refine
    /// pipeline; the LLM provider itself comes from the engine's own settings.
    var llmRepairEnabled: Bool

    /// In-code fallback used for a missing / malformed / partial config file —
    /// the sole source of truth for these fields (they have no UserDefaults
    /// backing). The microphone is always recorded alongside the meeting audio,
    /// so there is no mic field here.
    static let `default` = Self(
        screenCaptureScope: .chromeWindow,
        disableAppAudioTap: false,
        processingMode: .fast,
        asrLanguage: "",
        transcriptionEngine: nil,
        numSpeakersHint: 0,
        globalSpeakersDBPath: nil,
        llmRepairEnabled: false,
    )

    /// Decodable mirror of the JSON the Electron writer emits. Every field is
    /// optional so a missing/partial payload still decodes and falls back to
    /// the matching `.default` value.
    private struct Wire: Decodable {
        let screenCaptureScope: String?
        let disableAppAudioTap: Bool?
        let processingMode: String?
        let asrLanguage: String?
        let transcriptionEngine: String?
        let numSpeakersHint: Int?
        let globalSpeakersDBPath: String?
        let llmRepair: LLMRepairWire?

        struct LLMRepairWire: Decodable {
            let enabled: Bool?
        }
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
            processingMode: wire.processingMode.flatMap(ProcessingMode.init(rawValue:)) ?? .fast,
            asrLanguage: wire.asrLanguage ?? "",
            transcriptionEngine: Self.parseEngine(wire.transcriptionEngine),
            numSpeakersHint: wire.numSpeakersHint ?? 0,
            globalSpeakersDBPath: Self.normalizedPath(wire.globalSpeakersDBPath),
            llmRepairEnabled: wire.llmRepair?.enabled ?? false,
        )
    }

    /// Map the bridge engine string to the app enum. The bridge contract uses
    /// lowercase (`"whisperkit"`, `"parakeet"`) so it stays independent of the
    /// Swift enum's camelCased raw values; the comparison lowercases the input
    /// to tolerate either. The legacy `"qwen3"` value migrates to WhisperKit —
    /// Qwen3-ASR was removed upstream. Unknown / missing → `nil` (no override).
    private static func parseEngine(_ raw: String?) -> TranscriptionEngineSetting? {
        switch raw?.lowercased() {
        case "whisperkit": .whisperKit
        case "parakeet": .parakeet
        case "qwen3": .whisperKit
        default: nil
        }
    }

    /// Treat an empty path string the same as an absent one (Timbre serialises
    /// `""` when nothing is configured).
    private static func normalizedPath(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return raw
    }
}
