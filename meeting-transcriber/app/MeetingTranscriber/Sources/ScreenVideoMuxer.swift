import AVFoundation
import Foundation
import OSLog

/// Muxes the separately-recorded audio mix into the video-only screen recording
/// so the saved `.mp4` plays WITH sound.
///
/// `ScreenRecorder` writes video-only HEVC (audio stays on the CATap so we never
/// contend with `DualSourceRecorder`). The full app+mic mix lands in `_mix.wav`.
/// This step combines them after the recording finishes:
///
///   1. Encode the LPCM `_mix.wav` → AAC `.m4a` (mp4 can't carry raw LPCM well,
///      and AAC is what every player + Electron `<video>` expects).
///   2. Build an `AVMutableComposition` with the original HEVC video track
///      (passthrough — NOT re-encoded, so it's fast and lossless) + the AAC audio.
///   3. Export passthrough to a temp `.mp4`, then atomically replace the
///      video-only file.
///
/// Strictly best-effort: on ANY failure the original video-only `.mp4` is left
/// untouched and `false` is returned. A mux problem must never lose a recording
/// (the audio also survives independently as `_mix.wav`).
@available(macOS 14.0, *)
enum ScreenVideoMuxer {
    private static let logger = Logger(
        subsystem: AppPaths.logSubsystem, category: "ScreenVideoMuxer",
    )

    @discardableResult
    static func muxAudioIntoVideo(videoURL: URL, audioURL: URL) async -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: videoURL.path) else { return false }
        guard fm.fileExists(atPath: audioURL.path) else {
            PermissionHealthCheck.debugLog("[Mux] skip — no audio at \(audioURL.lastPathComponent)")
            return false
        }

        let base = videoURL.deletingPathExtension()
        let aacURL = base.appendingPathExtension("muxaudio.m4a")
        let tmpURL = base.appendingPathExtension("muxing.mp4")
        defer { try? fm.removeItem(at: aacURL) }

        do {
            // 1. Encode the WAV mix → AAC (.m4a).
            try? fm.removeItem(at: aacURL)
            guard await export(
                asset: AVURLAsset(url: audioURL), to: aacURL,
                fileType: .m4a, preset: AVAssetExportPresetAppleM4A,
            ) else {
                PermissionHealthCheck.debugLog("[Mux] FAILED — audio AAC encode")
                return false
            }

            // 2. Compose video (passthrough) + AAC audio.
            let videoAsset = AVURLAsset(url: videoURL)
            let aacAsset = AVURLAsset(url: aacURL)
            guard let vTrack = try await videoAsset.loadTracks(withMediaType: .video).first,
                  let aTrack = try await aacAsset.loadTracks(withMediaType: .audio).first else {
                PermissionHealthCheck.debugLog("[Mux] FAILED — missing track")
                return false
            }
            let vDur = try await videoAsset.load(.duration)
            let aDur = try await aacAsset.load(.duration)

            let comp = AVMutableComposition()
            guard let vComp = comp.addMutableTrack(
                withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                let aComp = comp.addMutableTrack(
                    withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            else { return false }
            try vComp.insertTimeRange(
                CMTimeRange(start: .zero, duration: vDur), of: vTrack, at: .zero)
            // Clamp audio to the video length — a longer audio tail must not
            // stretch the clip past its visual end.
            try aComp.insertTimeRange(
                CMTimeRange(start: .zero, duration: min(aDur, vDur)), of: aTrack, at: .zero)
            vComp.preferredTransform = try await vTrack.load(.preferredTransform)

            // 3. Passthrough export (no video re-encode) → temp, then replace.
            try? fm.removeItem(at: tmpURL)
            guard await export(
                asset: comp, to: tmpURL,
                fileType: .mp4, preset: AVAssetExportPresetPassthrough,
            ), fm.fileExists(atPath: tmpURL.path) else {
                PermissionHealthCheck.debugLog("[Mux] FAILED — passthrough export")
                try? fm.removeItem(at: tmpURL)
                return false
            }
            try? fm.removeItem(at: videoURL)
            try fm.moveItem(at: tmpURL, to: videoURL)
            PermissionHealthCheck.debugLog("[Mux] OK — audio muxed into \(videoURL.lastPathComponent)")
            return true
        } catch {
            PermissionHealthCheck.debugLog("[Mux] FAILED — \(error.localizedDescription)")
            try? fm.removeItem(at: tmpURL)
            return false
        }
    }

    /// macOS 14-compatible async wrapper around the (pre-15) completion-handler
    /// export API. Returns true only on `.completed`.
    private static func export(
        asset: AVAsset, to url: URL, fileType: AVFileType, preset: String,
    ) async -> Bool {
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            return false
        }
        session.outputURL = url
        session.outputFileType = fileType
        session.shouldOptimizeForNetworkUse = true
        // `export()` (no-arg async) is macOS 15+; use the completion-handler
        // form so we stay buildable on the macOS 14 deployment target.
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { cont.resume() }
        }
        if session.status != .completed {
            logger.error("export(\(preset)) status=\(session.status.rawValue) err=\(String(describing: session.error))")
        }
        return session.status == .completed
    }
}
