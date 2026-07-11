import CoreAudio
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "AppAudioCapture")

/// Translates PIDs to CoreAudio process `AudioObjectID`s for `CATapDescription`.
@available(macOS 14.2, *)
extension AppAudioCapture {
    /// Translate every stored PID and return (pid, audioObjectID) pairs.
    /// PIDs that fail translation (helper has no audio-object entry, process
    /// exited between enumeration and tap creation) are dropped — that's
    /// expected for Electron helper trees where only the audio-emitting
    /// renderer owns an audio object. Throws when no PID at all could be
    /// translated, since the resulting tap would have nothing to listen to.
    ///
    /// Returns pairs (not parallel arrays) so callers can log per-PID
    /// without re-zipping against `pids` — `compactMap` would otherwise
    /// silently mis-align the two sequences.
    func translatePIDs() throws -> [(pid: pid_t, audioObjectID: AudioObjectID)] {
        let translated: [(pid: pid_t, audioObjectID: AudioObjectID)] = pids.compactMap { pid in
            guard let objectID = Self.translatePID(pid) else { return nil }
            return (pid: pid, audioObjectID: objectID)
        }
        guard !translated.isEmpty else {
            throw NSError(
                domain: "audiotap", code: -1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Failed to translate any of \(pids.count) PIDs to audio objects",
                ],
            )
        }
        // Keep only the processes actually emitting audio (capped). Re-resolved
        // fresh on every tap creation — including health rebuilds — so a renderer
        // that starts audio later is picked up on the next re-tap. This "N → M"
        // line is also the forensic lifecycle counter.
        let filtered = AudioActiveProcessFilter.filter(
            candidates: translated,
            isRunningOutput: AudioActiveProcessFilter.liveIsRunningOutput,
            rootPID: pids.first ?? translated[0].pid,
        )
        logger.info(
            "Tap PID filter: \(translated.count, privacy: .public) → \(filtered.count, privacy: .public) audio-active",
        )
        return filtered.isEmpty ? translated : filtered
    }

    static func translatePID(_ pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        var objectID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var mutablePid = pid
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &mutablePid, &size, &objectID,
        )
        guard status == noErr, objectID != kAudioObjectUnknown else { return nil }
        return objectID
    }
}
