import CoreAudio
import Foundation

/// Narrows an enumerated process tree down to the processes actually emitting
/// audio, so the tap fans in a small, stable set (1-3 objects) instead of a
/// 40-100-object mixdown over constantly-dying Chrome renderers — the extreme,
/// unstable tap fan-in behind the coreaudiod stress. The pure core takes an
/// `isRunningOutput` probe so it is unit-testable without CoreAudio.
enum AudioActiveProcessFilter {
    typealias Candidate = (pid: pid_t, audioObjectID: AudioObjectID)

    /// - Parameters:
    ///   - candidates: (pid, HAL process object) pairs, in kernel order.
    ///   - isRunningOutput: `true` = emitting output, `false` = silent, `nil` =
    ///     the property was unreadable.
    ///   - rootPID: always kept (the meeting window owner), even if silent.
    ///   - cap: hard upper bound on the returned set (root counts toward it).
    /// - Returns: root first, then audio-active PIDs in kernel order, then any
    ///   unreadable ones to fill remaining slots up to `cap`. When NO candidate
    ///   is audio-active, returns just the root (not the whole silent tree) — the
    ///   zero-signal health re-tap catches the audio owner once it starts playing.
    static func filter(
        candidates: [Candidate],
        // swiftlint:disable:next discouraged_optional_boolean
        isRunningOutput: (AudioObjectID) -> Bool?,
        rootPID: pid_t,
        cap: Int = CaptureTuning.maxTapPIDs,
    ) -> [Candidate] {
        let root = candidates.first { $0.pid == rootPID }
        let classified = candidates.map { ($0, isRunningOutput($0.audioObjectID)) }
        let actives = classified.filter { $0.1 == true }.map(\.0)
        let unknowns = classified.filter { $0.1 == nil }.map(\.0)

        // Nothing is emitting audio yet (meeting hasn't started making sound):
        // tap only the root, NOT the whole silent tree. The zero-signal health
        // re-tap picks up the audio-owning helper once it starts playing.
        guard !actives.isEmpty else {
            if let root { return [root] }
            return Array(unknowns.prefix(cap))
        }

        var result: [Candidate] = []
        var seen = Set<AudioObjectID>()
        func append(_ candidate: Candidate) {
            guard result.count < cap, seen.insert(candidate.audioObjectID).inserted else { return }
            result.append(candidate)
        }
        if let root { append(root) } // root always kept, first
        for active in actives { append(active) } // then the audio-active set
        for unknown in unknowns { append(unknown) } // fill remaining slots
        return result
    }

    /// Live probe: reads `kAudioProcessPropertyIsRunningOutput` on a HAL process
    /// object. Returns `nil` when the property is unreadable (transient / older
    /// OS) so the pure filter keeps such a process only to fill the cap.
    // swiftlint:disable:next discouraged_optional_boolean
    static func liveIsRunningOutput(_ objectID: AudioObjectID) -> Bool? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningOutput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        guard AudioObjectHasProperty(objectID, &address) else { return nil }
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
        guard status == noErr else { return nil }
        return value != 0
    }
}
