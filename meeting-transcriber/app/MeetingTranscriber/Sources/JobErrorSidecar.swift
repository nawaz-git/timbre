import Foundation

/// Sidecar written to `<outputDir>/protocols/<prefix>.error.json` when a
/// pipeline job terminates in `.error`. Without it a transcribe/diarize
/// failure is invisible: no transcript lands, the raw audio never leaves
/// Application Support, and the mix is marked "processed" so orphan recovery
/// never retries it. The sidecar gives the failed job its own engine-prefix
/// identity so the product UI can surface a failed row — and records the
/// absolute source paths (the Application Support originals) so a retry can
/// reach them. Mirrors `RecordingSidecar`'s atomic-write pattern.
struct JobErrorSidecar: Codable {
    /// Extension handed to `ProtocolGenerator.filename(title:ext:)` to mint the
    /// sidecar filename `YYYYMMDD_HHmm_<slug>.error.json`.
    static let filenameExtension = "error.json"

    /// Schema version stamped into every sidecar. Bump when fields change so
    /// downstream readers can branch on it.
    static let currentVersion = 1

    let version: Int
    let title: String
    let error: String
    let failedAt: Date
    let jobShortID: String
    /// Absolute paths to the recorded source audio (nil when a job had none,
    /// e.g. a paired import without a persistent mix). A retry re-imports
    /// `mixPath`.
    let mixPath: String?
    let appPath: String?
    let micPath: String?
    let micDelay: TimeInterval
    let warnings: [String]

    init(
        title: String,
        error: String,
        failedAt: Date = Date(),
        jobShortID: String,
        mixPath: URL?,
        appPath: URL?,
        micPath: URL?,
        micDelay: TimeInterval,
        warnings: [String],
    ) {
        self.version = Self.currentVersion
        self.title = title
        self.error = error
        self.failedAt = failedAt
        self.jobShortID = jobShortID
        self.mixPath = mixPath?.path
        self.appPath = appPath?.path
        self.micPath = micPath?.path
        self.micDelay = micDelay
        self.warnings = warnings
    }

    /// Atomically write this sidecar as `<protocolsDir>/<filename>`, creating
    /// the directory if needed. Returns the resulting URL.
    @discardableResult
    func write(toDirectory protocolsDir: URL, filename: String) throws -> URL {
        try FileManager.default.createDirectory(at: protocolsDir, withIntermediateDirectories: true)
        let url = protocolsDir.appendingPathComponent(filename)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// Watch-level error snapshot written to `AppPaths.ipcDir/engine_last_error.json`
/// when the engine's top-level state machine enters `.error` — e.g. a recording
/// that never started because Screen/Mic TCC was revoked, which produces no job
/// (and therefore no `JobErrorSidecar`). Deliberately its own file, separate
/// from any heartbeat/supervisor artifact, so it carries zero cross-file merge
/// coupling; a richer liveness file can subsume it later.
struct EngineLastError: Codable {
    static let filename = "engine_last_error.json"

    let error: String
    let at: Date

    init(error: String, at: Date = Date()) {
        self.error = error
        self.at = at
    }

    /// Atomically write to `<directory>/engine_last_error.json`
    /// (default `AppPaths.ipcDir`). Returns the resulting URL.
    @discardableResult
    func write(toDirectory directory: URL = AppPaths.ipcDir) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(Self.filename)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        try data.write(to: url, options: .atomic)
        return url
    }
}
