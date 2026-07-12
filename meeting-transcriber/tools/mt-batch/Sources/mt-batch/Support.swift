import Foundation

enum CLIError: Swift.Error, LocalizedError {
    case inputNotFound(String)
    case invalidEngine(String)
    case noInput

    var errorDescription: String? {
        switch self {
        case let .inputNotFound(path):
            "Input file not found: \(path)"

        case let .invalidEngine(value):
            "Unknown engine '\(value)'. Use 'whisperkit' or 'parakeet'."

        case .noInput:
            "No input provided. Pass --input <file> or the --input-app/--input-mic pair."
        }
    }
}

/// Coalesces progress callbacks so identical-fraction calls don't spam
/// stdout. Reference type so the `@Sendable` progress closure can mutate
/// shared state across the WhisperKit task pool. NSLock keeps the
/// read-modify-write tight; the closure is hot (called many times per
/// transcription) but lock contention is trivial vs. CoreML inference.
final class ProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var lastEmitted: Double = -1

    /// Emit when the value moved by >= 1 percentage point, or when we
    /// reach the terminal 1.0 (so the JSONL consumer always sees a final
    /// 100 % event).
    func shouldEmit(_ value: Double) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if value >= 1.0, lastEmitted < 1.0 {
            lastEmitted = value
            return true
        }
        if value - lastEmitted >= 0.01 {
            lastEmitted = value
            return true
        }
        return false
    }
}

/// Small helpers shared between subcommands. Extracted here because both
/// `Transcribe` and `ListSpeakers` need path expansion, and `Transcribe`
/// also needs the duration formatter that used to live as a private method
/// on the original flat command.
enum PathHelpers {
    /// Expand a leading `~/` to the current user's home directory. Swift's
    /// `URL(fileURLWithPath:)` doesn't expand tildes; doing it here keeps
    /// the CLI usable from shells that don't expand quoted paths.
    static func expandTilde(_ path: String) -> String {
        guard path.hasPrefix("~") else { return path }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == "~" { return home }
        if path.hasPrefix("~/") {
            return home + String(path.dropFirst(1))
        }
        return path
    }

    static func formatDuration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded()))
        if s >= 60 {
            return String(format: "%dm %02ds", s / 60, s % 60)
        }
        return String(format: "%ds", s)
    }
}
