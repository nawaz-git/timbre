import Foundation

/// Pure debounce/coalescing decision for mic engine restarts — the mic-side
/// mirror of `CaptureLifecycleCoordinator`'s device-change debounce, scaled down
/// to the mic's simpler needs. A Bluetooth HFP↔A2DP flip fires several input
/// notifications (default-input change + `AVAudioEngineConfigurationChange`);
/// this collapses a burst into a single restart once the input identity has been
/// quiet for `debounce`, so the mic engine and the tap stop churning the HAL
/// concurrently. All timing is injected so it is deterministic and testable.
struct MicRestartCoalescer: Equatable {
    enum Event: Equatable {
        case deviceChanged(at: Date)
        case debounceElapsed(at: Date)
    }

    enum Action: Equatable {
        /// Do nothing.
        case ignore
        /// Schedule a `debounceElapsed(at:)` callback to fire at `at`.
        case scheduleDebounce(at: Date)
        /// The window elapsed with no newer change — perform one restart.
        case restart
    }

    private var pendingUntil: Date?
    let debounce: TimeInterval

    init(debounce: TimeInterval = CaptureTuning.deviceChangeDebounce) {
        self.debounce = debounce
    }

    mutating func handle(_ event: Event) -> Action {
        switch event {
        case let .deviceChanged(at):
            let deadline = at.addingTimeInterval(debounce)
            pendingUntil = deadline
            return .scheduleDebounce(at: deadline)
        case let .debounceElapsed(at):
            guard let until = pendingUntil else { return .ignore }
            // A newer change pushed the deadline out — this timer is stale.
            if at < until { return .ignore }
            pendingUntil = nil
            return .restart
        }
    }
}
