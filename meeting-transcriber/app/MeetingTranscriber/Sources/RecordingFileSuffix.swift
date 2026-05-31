import Foundation

/// Filename suffixes for the three audio files produced by a dual-source recording.
enum RecordingFileSuffix {
    static let mix = "_mix.wav"
    static let app = "_app.wav"
    static let mic = "_mic.wav"
    /// Whole-screen video sidecar. Deliberately NOT part of `all`: `all` drives
    /// `stripSuffix` (WatchLoop record-only basename recovery) and the orphan-
    /// recovery grouping, both of which key off `_mix.wav` audio — adding the
    /// `.mp4` here would mis-route the video as an audio file.
    static let screen = "_screen.mp4"

    static let all: [String] = [mix, app, mic]

    static func stripSuffix(from filename: String) -> (stem: String, suffix: String)? {
        for suffix in all where filename.hasSuffix(suffix) {
            return (String(filename.dropLast(suffix.count)), suffix)
        }
        return nil
    }
}
