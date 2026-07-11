import Foundation

/// Pure verdict machine for CATap health. Fed once per health tick with the time
/// since the last IOProc callback, the peak |sample| seen since the previous tick,
/// and whether the mic channel is currently carrying audio. The impure shell
/// (`AppAudioCapture+Lifecycle`) turns a sick verdict into a `healthCheckFailed`
/// rebuild trigger. All timing is injected so the machine is deterministic and
/// unit-testable without sleeping.
///
/// Two fault signatures, mirroring the field-observed wedged-tap states:
///  - **no callbacks** — the device claims running but the IOProc has not fired
///    for `noCallbackTimeout`: the tap is dead.
///  - **all zero** — callbacks are arriving but every sample has been 0 for
///    `allZeroTimeout` *while the mic channel is non-silent*. That mic-asymmetry
///    guard (same idea as `ChannelHealthMonitor`) keeps genuine meeting silence
///    from tripping a rebuild: without a live reference channel an all-zero tap is
///    indistinguishable from "nobody is talking right now".
struct TapHealthMonitor {
    enum Verdict: Equatable {
        case healthy
        case noCallbacks(secondsStale: TimeInterval)
        case allZero(secondsStale: TimeInterval)
    }

    let noCallbackTimeout: TimeInterval
    let allZeroTimeout: TimeInterval

    /// When the current all-zero episode began (nil = not currently all-zero).
    private var zeroSince: Date?

    init(
        noCallbackTimeout: TimeInterval = CaptureTuning.tapNoCallbackTimeout,
        allZeroTimeout: TimeInterval = CaptureTuning.tapAllZeroTimeout,
    ) {
        self.noCallbackTimeout = noCallbackTimeout
        self.allZeroTimeout = allZeroTimeout
    }

    /// - Parameters:
    ///   - now: evaluation time.
    ///   - secondsSinceLastCallback: wall time since the IOProc last fired.
    ///   - recentPeakAbs: max |sample| observed since the previous evaluation.
    ///   - micNonSilent: true when the mic channel is carrying audio (the guard).
    mutating func evaluate(
        now: Date,
        secondsSinceLastCallback: TimeInterval,
        recentPeakAbs: Float,
        micNonSilent: Bool,
    ) -> Verdict {
        // 1. No-callback is the most severe — the IOProc is not running at all.
        //    The zero-window is meaningless without data, so clear it.
        if secondsSinceLastCallback >= noCallbackTimeout {
            zeroSince = nil
            return .noCallbacks(secondsStale: secondsSinceLastCallback)
        }
        // 2. Callbacks are arriving — judge signal content. Any non-zero sample
        //    clears the episode.
        if recentPeakAbs > 0 {
            zeroSince = nil
            return .healthy
        }
        // 3. All-zero, but only a fault if the mic proves the room isn't silent.
        guard micNonSilent else {
            zeroSince = nil
            return .healthy
        }
        let since = zeroSince ?? now
        zeroSince = since
        let window = now.timeIntervalSince(since)
        return window >= allZeroTimeout ? .allZero(secondsStale: window) : .healthy
    }

    /// Clear the zero-window accounting after a rebuild is triggered so the fault
    /// window restarts fresh instead of immediately re-firing on the next tick.
    mutating func reset() {
        zeroSince = nil
    }
}
