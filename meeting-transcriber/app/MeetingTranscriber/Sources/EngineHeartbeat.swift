import Foundation

/// Liveness state the engine advertises to Electron via `engine_heartbeat.json`.
/// The raw values are the EXACT strings the TypeScript `EngineHeartbeat.state`
/// union expects — keep them in lockstep with `el/shared/types.ts`.
enum EngineLivenessState: String, Codable, Equatable {
    case watching
    case recording
    case processing
    case idle
}

/// Wire shape of `engine_heartbeat.json`, mirrored on the Electron side by the
/// `EngineHeartbeat` interface in `el/shared/types.ts`.
///
/// Two consumers on the Electron side:
///  - the reuse probe (`evaluateEngineReuse`) trusts a fresh, version-matched
///    heartbeat to skip a needless kill+relaunch of the engine on every launch;
///  - the supervisor (`engineSupervisor.ts`) treats a stale `updatedAt` — or a
///    stale `lastIOCallbackAt` while `updatedAt` is fresh — on a `recording`
///    engine as a wedge and drives a graceful restart.
///
/// TIMESTAMP UNITS: `startedAt`, `updatedAt`, `lastIOCallbackAt`, and
/// `lastSCKFrameAt` are epoch **milliseconds** (`Date().timeIntervalSince1970 *
/// 1000`), matching `active_meeting.json` / `engine_config.json` — NOT Swift's
/// default `Double` seconds. Get this wrong and reuse silently never fires.
///
/// Optional fields are OMITTED (not null) when absent — Swift's synthesized
/// encoder uses `encodeIfPresent`, matching the `?`-optional TS fields.
struct EngineHeartbeat: Codable, Equatable {
    let pid: Int
    /// `Bundle.main.appVersion` — MUST equal Electron's `app.getVersion()`
    /// (monorepo lockstep) or the reuse probe declines every time. The release
    /// build stamps the shared `VERSION` into the engine bundle's
    /// `CFBundleShortVersionString`; a dev `swift build` keeps the `0.1.0`
    /// placeholder, so reuse simply no-ops in dev (safe kill+relaunch instead).
    let version: String
    let state: EngineLivenessState
    let startedAt: Int64
    let lastIOCallbackAt: Int64?
    let lastSCKFrameAt: Int64?
    let tapPIDCount: Int?
    let updatedAt: Int64

    /// Precedence: an active recording wins; otherwise a busy pipeline reads as
    /// `processing`; otherwise the watch phase (watching / idle). A transient
    /// `.error` watch phase reads as `idle` — the watch loop self-recovers to
    /// watching, so advertising `error` would only flap the supervisor.
    static func livenessState(
        watchPhase: WatchLoop.State,
        pipelineProcessing: Bool,
    ) -> EngineLivenessState {
        switch watchPhase {
        case .recording:
            .recording

        case .watching:
            pipelineProcessing ? .processing : .watching

        case .idle, .error:
            pipelineProcessing ? .processing : .idle
        }
    }

    /// Epoch-milliseconds for a wall-clock `Date` — the bridge's timestamp unit.
    static func epochMillis(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
}

/// Serialises `EngineHeartbeat`s to `AppPaths.engineHeartbeatFile` off the main
/// thread. Writes are ordered on a private serial queue; `stopAndDelete()` runs
/// on that same queue so the file removal can never be reordered behind a
/// still-pending write — the cross-process signal the Electron reuse probe relies on at
/// shutdown (no reuse of a dying engine). `@unchecked Sendable`: the only
/// mutable state (`stopped`) is touched exclusively on `queue`.
final class EngineHeartbeatWriter: @unchecked Sendable {
    /// Cadence the engine refreshes the heartbeat at. The reuse probe trusts a
    /// heartbeat younger than 6 s and the supervisor flags a `recording` engine
    /// whose `updatedAt` is older than 15 s — 2 s keeps both comfortably fed.
    static let intervalSeconds: TimeInterval = 2

    private let url: URL
    private let queue = DispatchQueue(label: "engine.heartbeat.writer", qos: .utility)
    private var stopped = false
    private let encoder = JSONEncoder()

    init(url: URL = AppPaths.engineHeartbeatFile) {
        self.url = url
    }

    /// Atomically write the heartbeat (temp file + rename via `.atomic`) so an
    /// Electron reader never observes a torn file. Best-effort — a failed write
    /// must never disturb the engine.
    func write(_ heartbeat: EngineHeartbeat) {
        queue.async { [weak self] in
            guard let self, !stopped else { return }
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true,
                )
                let data = try encoder.encode(heartbeat)
                try data.write(to: url, options: .atomic)
            } catch {
                // Best-effort — the heartbeat is advisory; never surface a failure.
            }
        }
    }

    /// Stop refreshing and delete the file, ordered after any pending write.
    /// Called at the very start of graceful shutdown so a concurrent Electron
    /// start cannot reuse a dying engine.
    func stopAndDelete() {
        queue.sync {
            stopped = true
            try? FileManager.default.removeItem(at: url)
        }
    }
}
