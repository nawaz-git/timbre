import Foundation
import os.log

/// Centralized path constants and logger subsystem for the app.
enum AppPaths {
    /// Logger subsystem for all os.log loggers.
    static let logSubsystem = "com.meetingtranscriber"

    /// App data directory: `~/Library/Application Support/MeetingTranscriber/`
    /// In sandbox, this automatically resolves to the container path.
    /// Falls back to `~/.MeetingTranscriber/` if Application Support is unavailable.
    static let dataDir: URL = {
        if let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport.appendingPathComponent("MeetingTranscriber")
        }
        Logger(subsystem: logSubsystem, category: "AppPaths")
            .error("Application Support directory unavailable — falling back to home directory")
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".MeetingTranscriber")
    }()

    /// IPC directory: under `dataDir` for sandbox compatibility.
    static let ipcDir = dataDir.appendingPathComponent("ipc")

    /// Cross-process engine config written by Electron and read FRESH by the
    /// engine at the start of each meeting. Carries the screen-capture scope +
    /// mic toggle (see `EngineConfig`). Lives in the same dir as
    /// `active_meeting.json`. NOT staleness-gated — last-known-good survives
    /// Electron quitting.
    static let engineConfigFile = ipcDir.appendingPathComponent("engine_config.json")

    /// Cross-process engine liveness heartbeat written by the engine every ~2 s
    /// (see `EngineHeartbeatWriter`) and read by Electron's reuse probe +
    /// supervisor. Lives in the same dir as `active_meeting.json`; DELETED at
    /// the start of graceful shutdown so a concurrent Electron start can't reuse
    /// a dying engine.
    static let engineHeartbeatFile = ipcDir.appendingPathComponent("engine_heartbeat.json")

    /// Recordings directory.
    static let recordingsDir = dataDir.appendingPathComponent("recordings")

    /// Protocols output directory (legacy, inside Application Support).
    static let protocolsDir = dataDir.appendingPathComponent("protocols")

    /// Default protocols output in Downloads: `~/Downloads/MeetingTranscriber/`
    /// In sandbox, `FileManager.urls(for: .downloadsDirectory)` resolves to the container-granted path.
    static let downloadsProtocolsDir: URL = {
        guard let downloads = FileManager.default
            .urls(for: .downloadsDirectory, in: .userDomainMask).first
        else {
            return protocolsDir
        }
        return downloads.appendingPathComponent("MeetingTranscriber")
    }()

    /// Speaker voice profiles DB (engine-local, legacy). For the unified DB the
    /// batch pipeline reads/writes, resolve through `resolvedSpeakersDB(...)`.
    static let speakersDB = dataDir.appendingPathComponent("speakers.json")

    /// The speaker DB the batch pipeline should read/write. Honours the Electron
    /// bridge override (`EngineConfig.globalSpeakersDBPath` → Timbre's unified
    /// `global-speakers.json` in Electron userData) so enrollment pays off
    /// across the live + import paths; falls back to the engine-local
    /// `speakersDB` when Timbre hasn't supplied a path (e.g. the standalone
    /// Homebrew build).
    static func resolvedSpeakersDB(bridgeOverride: String?) -> URL {
        guard let path = bridgeOverride, !path.isEmpty else { return speakersDB }
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }

    /// Custom protocol prompt file.
    static let customPromptFile = dataDir.appendingPathComponent("protocol_prompt.md")

    /// Legacy IPC directory (`~/.meeting-transcriber/`) used before sandbox migration.
    private static let legacyIpcDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".meeting-transcriber")

    private static let logger = Logger(subsystem: logSubsystem, category: "AppPaths")

    /// Migrate IPC files from `~/.meeting-transcriber/` to `dataDir/ipc/`.
    /// Safe to call multiple times — copyItem fails gracefully if destination exists.
    static func migrateIfNeeded() {
        let fm = FileManager.default
        guard fm.fileExists(atPath: legacyIpcDir.path) else { return }

        let filesToMigrate = [
            "processed_recordings.json",
            "pipeline_queue.json",
            "pipeline_log.jsonl",
        ]

        try? fm.createDirectory(at: ipcDir, withIntermediateDirectories: true)

        for name in filesToMigrate {
            let src = legacyIpcDir.appendingPathComponent(name)
            let dst = ipcDir.appendingPathComponent(name)
            do {
                try fm.copyItem(at: src, to: dst)
                logger.info("Migrated \(name) from legacy IPC directory")
            } catch CocoaError.fileWriteFileExists {
                // Already migrated — expected on subsequent launches
            } catch CocoaError.fileReadNoSuchFile {
                // Source doesn't exist — skip
            } catch {
                logger.error("Failed to migrate \(name): \(error.localizedDescription)")
            }
        }
    }
}
