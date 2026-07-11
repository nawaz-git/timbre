import Atomics
import CoreAudio
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "HALLivenessSentinel")

/// Pure verdict machine for the HAL-liveness sentinel. Fed one probe result per
/// tick; latches `.unresponsive` after `timeoutsBeforeUnresponsive` CONSECUTIVE
/// timeouts (emitted once), and emits `.recovered` the first time the HAL
/// answers again afterwards. Deterministic + unit-testable with injected results
/// — the dedicated thread and the real bounded probe live in `HALLivenessMonitor`.
public struct HALLivenessSentinel: Equatable, Sendable {
    public enum ProbeResult: Equatable, Sendable {
        case responded
        case timedOut
    }

    public enum Verdict: Equatable, Sendable {
        /// Nothing to report — healthy, or still within the timeout tolerance.
        case healthy
        /// Just crossed the consecutive-timeout threshold (emitted once, latched).
        case unresponsive
        /// The HAL answered again after having been declared unresponsive.
        case recovered
    }

    public let timeoutsBeforeUnresponsive: Int
    private(set) var consecutiveTimeouts = 0
    private(set) var firedUnresponsive = false

    /// `timeoutsBeforeUnresponsive` defaults (via nil) to
    /// `CaptureTuning.halSentinelTimeoutsBeforeUnresponsive` — resolved in-body so
    /// this public init doesn't inline an internal symbol into cross-module call
    /// sites.
    public init(timeoutsBeforeUnresponsive: Int? = nil) {
        self.timeoutsBeforeUnresponsive =
            timeoutsBeforeUnresponsive ?? CaptureTuning.halSentinelTimeoutsBeforeUnresponsive
    }

    public mutating func record(_ result: ProbeResult) -> Verdict {
        switch result {
        case .responded:
            consecutiveTimeouts = 0
            if firedUnresponsive {
                firedUnresponsive = false
                return .recovered
            }
            return .healthy

        case .timedOut:
            consecutiveTimeouts += 1
            if consecutiveTimeouts >= timeoutsBeforeUnresponsive, !firedUnresponsive {
                firedUnresponsive = true
                return .unresponsive
            }
            return .healthy
        }
    }
}

/// The real HAL liveness probe. Queries the default output device on a HELPER
/// thread with a bounded deadline so a wedged coreaudiod times out instead of
/// blocking the sentinel loop.
public enum HALProbe {
    /// Returns `.timedOut` when `AudioObjectGetPropertyData` for the default
    /// output device doesn't answer within `deadline`. The helper thread that
    /// ran the (possibly-blocking) call is left to unblock on its own once the
    /// HAL recovers — the same bounded-wait shape `CaptureFileWriter.flushAndClose`
    /// uses for a stalled disk.
    public static func probeDefaultOutputDevice(
        deadline: TimeInterval,
    ) -> HALLivenessSentinel.ProbeResult {
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            )
            var deviceID = AudioObjectID(kAudioObjectUnknown)
            var size = UInt32(MemoryLayout<AudioObjectID>.size)
            _ = AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID,
            )
            semaphore.signal()
        }
        return semaphore.wait(timeout: .now() + deadline) == .timedOut ? .timedOut : .responded
    }
}

/// Thin thread shell that drives the sentinel: every `interval` it takes a
/// bounded probe (off its own loop) and feeds the pure `HALLivenessSentinel`,
/// invoking `onVerdict` for `.unresponsive` / `.recovered`. AppState starts it
/// while watching/recording and stops it on idle. `@unchecked Sendable`: the
/// mutable `sentinel` is confined to the run-loop thread; `running` is atomic.
public final class HALLivenessMonitor: @unchecked Sendable {
    private let interval: TimeInterval
    private let probe: @Sendable () -> HALLivenessSentinel.ProbeResult
    private let onVerdict: @Sendable (HALLivenessSentinel.Verdict) -> Void
    private var sentinel: HALLivenessSentinel
    private let running = ManagedAtomic<Bool>(false)
    private var thread: Thread?

    /// nil-valued numeric params fall back to the `CaptureTuning` defaults
    /// (resolved in-body so this public init doesn't inline internal symbols).
    /// - Parameter probe: injected for tests / a debug hook; defaults to the real
    ///   bounded `HALProbe.probeDefaultOutputDevice`.
    public init(
        interval: TimeInterval? = nil,
        probeDeadline: TimeInterval? = nil,
        timeoutsBeforeUnresponsive: Int? = nil,
        probe: (@Sendable () -> HALLivenessSentinel.ProbeResult)? = nil,
        onVerdict: @escaping @Sendable (HALLivenessSentinel.Verdict) -> Void,
    ) {
        let resolvedDeadline = probeDeadline ?? CaptureTuning.halSentinelProbeDeadline
        self.interval = interval ?? CaptureTuning.halSentinelInterval
        self.probe = probe ?? { HALProbe.probeDefaultOutputDevice(deadline: resolvedDeadline) }
        self.onVerdict = onVerdict
        sentinel = HALLivenessSentinel(timeoutsBeforeUnresponsive: timeoutsBeforeUnresponsive)
    }

    /// Start the sentinel thread. Idempotent.
    public func start() {
        guard thread == nil else { return }
        running.store(true, ordering: .relaxed)
        let sentinelThread = Thread { [weak self] in self?.runLoop() }
        sentinelThread.name = "audiotap.hal-sentinel"
        sentinelThread.qualityOfService = .utility
        thread = sentinelThread
        sentinelThread.start()
        logger.info("HAL liveness sentinel started (interval \(self.interval, privacy: .public)s)")
    }

    /// Signal the loop to stop. The thread exits after its current sleep slice; a
    /// probe helper thread left blocked on a wedged HAL unblocks on its own.
    public func stop() {
        running.store(false, ordering: .relaxed)
        thread = nil
    }

    private func runLoop() {
        while running.load(ordering: .relaxed) {
            let verdict = sentinel.record(probe())
            switch verdict {
            case .unresponsive:
                logger.error("HAL liveness: default-output probe unresponsive — coreaudiod may be wedged")
                onVerdict(.unresponsive)

            case .recovered:
                logger.info("HAL liveness: recovered")
                onVerdict(.recovered)

            case .healthy:
                break
            }
            sleepInSlices(interval)
        }
    }

    /// Sleep `total` in short slices so `stop()` is observed promptly rather than
    /// after a full interval.
    private func sleepInSlices(_ total: TimeInterval) {
        let slice: TimeInterval = 0.25
        var remaining = total
        while remaining > 0, running.load(ordering: .relaxed) {
            let step = min(slice, remaining)
            Thread.sleep(forTimeInterval: step)
            remaining -= step
        }
    }
}
