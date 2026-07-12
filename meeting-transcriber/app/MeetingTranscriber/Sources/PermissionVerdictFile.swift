import Foundation

/// Writes the engine's permission verdict as JSON under the Application Support
/// ipc dir, where Electron reads it (JSON-first, staleness-gated) instead of the
/// old fixed, world-writable `/tmp/mt-permission.log`. Kept free of app state so
/// the wire shape, atomicity, and 0600 mode are unit-testable in isolation.
enum PermissionVerdictFile {
    /// Map a `PermissionStatus` to the wire vocabulary Electron parses. `broken`
    /// is preserved here (Electron collapses it to `denied` on read) so the raw
    /// verdict stays diagnosable in the file.
    static func verdictString(_ status: PermissionStatus) -> String {
        switch status {
        case .healthy: "healthy"
        case .denied: "denied"
        case .broken: "broken"
        case .notDetermined: "notDetermined"
        }
    }

    /// Serialize the verdict payload to JSON with sorted keys → deterministic
    /// bytes (so the writer is straightforward to assert on).
    static func makeJSON(
        screen: String,
        mic: String,
        ax: String,
        notifications: String,
        updatedAt: Int,
    ) -> Data {
        let payload: [String: Any] = [
            "screen": screen,
            "mic": mic,
            "ax": ax,
            "notifications": notifications,
            "updatedAt": updatedAt,
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            ?? Data("{}".utf8)
    }

    /// Atomically write the verdict JSON to `url`, owner-only (0600). Ensures the
    /// parent dir exists. Throws on write failure.
    static func write(
        screen: String,
        mic: String,
        ax: String,
        notifications: String,
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        to url: URL = AppPaths.permissionVerdictFile,
    ) throws {
        let data = makeJSON(
            screen: screen,
            mic: mic,
            ax: ax,
            notifications: notifications,
            updatedAt: updatedAt,
        )
        let fm = FileManager.default
        try fm.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
        )
        try data.write(to: url, options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
