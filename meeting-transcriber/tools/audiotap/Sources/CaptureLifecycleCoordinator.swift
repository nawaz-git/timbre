import Foundation

/// Pure, single-flight state machine that owns the tap/aggregate lifecycle
/// transitions for `AppAudioCapture`. The impure shell runs the actual CoreAudio
/// teardown/rebuild and schedules the timers this machine asks for; this struct
/// decides *when* and *what*, with all timing driven by injected `Date`s so it
/// stays deterministic and unit-testable. It replaces `OutputDeviceChangeCoordinator`,
/// folding its restart flow into a debounced, rate-limited, degrade-not-hot-loop
/// policy.
///
/// Policy (constants live in `CaptureTuning`):
///  - a `deviceChanged` never triggers a rebuild until the device identity has
///    been quiet for `debounce` — coalesces an HFP↔A2DP burst into one rebuild;
///  - successive rebuild cycles are at least `minRebuildInterval` apart;
///  - a `healthCheckFailed` is an urgent trigger (rebuild as soon as the min
///    interval allows), distinct from the debounced device-change path;
///  - after `maxRebuilds` consecutive failed cycles the machine goes `degraded`
///    (tap off, level publisher reports -120) and only re-attempts on the next
///    quiet window at `degradedBackoff` — never a hot loop;
///  - a successful rebuild resets the failure counter.
struct CaptureLifecycleCoordinator: Equatable {
    enum State: Equatable {
        /// Healthy; no rebuild has run yet (initial).
        case idle
        /// Healthy; at least one rebuild cycle has completed.
        case running
        /// A trigger was seen — waiting until `until` (quiet window / min
        /// interval) before rebuilding. Coalesces bursts.
        case coolingDown(until: Date)
        /// A full teardown+rebuild is in progress.
        case rebuilding
        /// Too many consecutive failures — tap off, awaiting a backoff retry.
        case degraded
    }

    enum Event: Equatable {
        case deviceChanged(at: Date)
        case healthCheckFailed(at: Date)
        case quietWindowElapsed(at: Date)
        case rebuildFinished(success: Bool)
    }

    enum Action: Equatable {
        /// Shell does nothing this event.
        case ignore
        /// Schedule a `quietWindowElapsed(at:)` callback to fire at `at`.
        case scheduleQuietWindow(at: Date)
        /// Run the full ordered teardown+rebuild, then feed back `rebuildFinished`.
        case rebuild
        /// Stop the tap, publish -120, and schedule a re-attempt at `reattemptAt`.
        case enterDegraded(reattemptAt: Date)
    }

    private(set) var state: State = .idle
    private var failureCount = 0
    private var lastRebuildStartedAt: Date?

    let debounce: TimeInterval
    let minRebuildInterval: TimeInterval
    let maxRebuilds: Int
    let degradedBackoff: TimeInterval

    init(
        debounce: TimeInterval = CaptureTuning.deviceChangeDebounce,
        minRebuildInterval: TimeInterval = CaptureTuning.minRebuildInterval,
        maxRebuilds: Int = CaptureTuning.maxRebuilds,
        degradedBackoff: TimeInterval = CaptureTuning.degradedBackoff,
    ) {
        self.debounce = debounce
        self.minRebuildInterval = minRebuildInterval
        self.maxRebuilds = maxRebuilds
        self.degradedBackoff = degradedBackoff
    }

    mutating func handle(_ event: Event) -> Action {
        switch event {
        case let .deviceChanged(at): return onDeviceChanged(at: at)
        case let .healthCheckFailed(at): return onHealthCheckFailed(at: at)
        case let .quietWindowElapsed(at): return onQuietWindow(at: at)
        case let .rebuildFinished(success): return onRebuildFinished(success: success)
        }
    }

    // MARK: - Per-event handlers

    /// Device-change triggers are always debounced by the full `debounce`
    /// window, coalescing a burst into a single eventual rebuild.
    private mutating func onDeviceChanged(at now: Date) -> Action {
        switch state {
        case .idle, .running, .coolingDown:
            let deadline = now.addingTimeInterval(debounce)
            state = .coolingDown(until: deadline)
            return .scheduleQuietWindow(at: deadline)
        case .rebuilding, .degraded:
            return .ignore
        }
    }

    /// Health failures are urgent — rebuild as soon as the min-rebuild interval
    /// allows (immediately if none has run yet), no debounce.
    private mutating func onHealthCheckFailed(at now: Date) -> Action {
        switch state {
        case .idle, .running, .coolingDown:
            let deadline = earliestRebuild(after: now)
            state = .coolingDown(until: deadline)
            return .scheduleQuietWindow(at: deadline)
        case .rebuilding, .degraded:
            return .ignore
        }
    }

    private mutating func onQuietWindow(at now: Date) -> Action {
        switch state {
        case let .coolingDown(until):
            // A newer trigger pushed the deadline out — this is a stale timer.
            if now < until { return .ignore }
            // Respect the min interval between rebuild cycles.
            let earliest = earliestRebuild(after: now)
            if now < earliest {
                state = .coolingDown(until: earliest)
                return .scheduleQuietWindow(at: earliest)
            }
            return startRebuild(at: now)
        case .degraded:
            return startRebuild(at: now)
        case .idle, .running, .rebuilding:
            return .ignore
        }
    }

    private mutating func onRebuildFinished(success: Bool) -> Action {
        guard state == .rebuilding else { return .ignore }
        if success {
            failureCount = 0
            state = .running
            return .ignore
        }
        failureCount += 1
        // `lastRebuildStartedAt` is always set here (we only reach `.rebuilding`
        // via `startRebuild`); the fallback is unreachable defensive code.
        let anchor = lastRebuildStartedAt ?? Date()
        if failureCount >= maxRebuilds {
            state = .degraded
            return .enterDegraded(reattemptAt: anchor.addingTimeInterval(degradedBackoff))
        }
        let deadline = anchor.addingTimeInterval(minRebuildInterval)
        state = .coolingDown(until: deadline)
        return .scheduleQuietWindow(at: deadline)
    }

    // MARK: - Helpers

    private mutating func startRebuild(at now: Date) -> Action {
        state = .rebuilding
        lastRebuildStartedAt = now
        return .rebuild
    }

    /// Earliest a rebuild may START given the last rebuild's start time and the
    /// min-interval floor. Returns `now` when no rebuild has run yet.
    private func earliestRebuild(after now: Date) -> Date {
        guard let last = lastRebuildStartedAt else { return now }
        return max(now, last.addingTimeInterval(minRebuildInterval))
    }
}
