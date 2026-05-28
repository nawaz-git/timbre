import Foundation

/// JSON-line progress events the parent (e.g. an Electron driver) can parse.
///
/// One JSON object per line, written to stdout and immediately flushed.
/// `stderr` is reserved for human-readable logs / errors so the JSONL stream
/// stays machine-clean.
///
/// All numeric fields are non-NaN; progress values are clamped 0…1.
enum Events {
    /// Atomic line writer. Newline-terminates and flushes so a buffered
    /// reader on the other side never sees a partial line.
    private static func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func loadingAudio() {
        emit(["event": "loading_audio"])
    }

    static func loadingModels() {
        emit(["event": "loading_models"])
    }

    static func transcribing(progress: Double) {
        let clamped = min(max(progress, 0), 1)
        emit(["event": "transcribing", "progress": clamped])
    }

    static func diarizing() {
        emit(["event": "diarizing"])
    }

    static func diarizing(progress: Double) {
        let clamped = min(max(progress, 0), 1)
        emit(["event": "diarizing", "progress": clamped])
    }

    static func merging() {
        emit(["event": "merging"])
    }

    /// Per-detected-speaker match outcome against the global speakers DB.
    /// Emitted once per run when `--global-db` was passed, even when no
    /// enrollments matched — gives the Electron UI a single deterministic
    /// signal that matching ran and which detected speakers were recognised.
    static func matchedSpeakers(_ matches: [GlobalSpeakerDB.MatchResult]) {
        let arr: [[String: Any]] = matches.map { result in
            var entry: [String: Any] = ["detected": result.detectedLabel]
            // Use NSNull so the JSON emitter writes a literal `null` for
            // unmatched speakers. This mirrors the schema the prompt
            // specifies — `enrolled: null` is the explicit "no match" signal.
            if let name = result.enrolledName {
                entry["enrolled"] = name
            } else {
                entry["enrolled"] = NSNull()
            }
            // Round to 4 decimal places — keeps the line short without
            // hiding the signal vs. the 0.05 margin threshold.
            if let sim = result.bestSimilarity {
                entry["similarity"] = (Double(sim) * 10000).rounded() / 10000
            } else {
                entry["similarity"] = NSNull()
            }
            return entry
        }
        emit(["event": "matched_speakers", "matches": arr])
    }

    static func done(outputDir: String) {
        emit(["event": "done", "outputDir": outputDir])
    }

    static func error(_ message: String) {
        emit(["event": "error", "message": message])
    }
}

/// Tiny stderr logger. Anything written here is human-readable diagnostics
/// for the operator; the parent process should treat stderr as opaque text
/// (or pipe it to a log file).
enum Log {
    static func info(_ message: String) {
        let line = "[mt-batch] \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    static func warn(_ message: String) {
        let line = "[mt-batch] WARN: \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    static func err(_ message: String) {
        let line = "[mt-batch] ERROR: \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
