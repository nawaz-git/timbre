import Foundation

/// Outcome of racing an async operation against a wall-clock deadline.
enum ShutdownRaceOutcome: Equatable, Sendable {
    case completed
    case timedOut
}

/// One-shot result cell that reports whichever of two racing tasks finishes
/// first, WITHOUT structurally awaiting the loser. The first `resolve` wins;
/// later ones are ignored. A single `wait()` awaiter resumes the moment the
/// cell is resolved. Being an actor makes the check-then-store in `wait()`
/// atomic against `resolve()`, so there is no lost-wakeup window.
private actor RaceCell {
    private var outcome: ShutdownRaceOutcome?
    private var waiter: CheckedContinuation<ShutdownRaceOutcome, Never>?

    func resolve(_ value: ShutdownRaceOutcome) {
        guard outcome == nil else { return }
        outcome = value
        waiter?.resume(returning: value)
        waiter = nil
    }

    func wait() async -> ShutdownRaceOutcome {
        if let outcome { return outcome }
        return await withCheckedContinuation { continuation in
            waiter = continuation
        }
    }
}

/// Runs `operation`, racing it against a `seconds` deadline. Returns
/// `.completed` if the operation finished first, `.timedOut` if the deadline
/// fired first.
///
/// The deadline is authoritative even when `operation` is wedged in an
/// un-cancellable `await`: the operation runs in an unstructured child task and
/// this function returns as soon as the FIRST side resolves the race cell — it
/// never structurally awaits the operation past the deadline (which is what a
/// `withTaskGroup`-based race would do, hanging on a stuck child). On timeout
/// the possibly-stuck operation task is left orphaned; the sole production
/// caller force-exits immediately afterwards, so nothing leaks.
///
/// `onTimeout`, when supplied, runs on the deadline task itself — i.e. OFF the
/// (possibly wedged) caller actor — the instant the deadline fires, BEFORE this
/// function returns. That makes the deadline able to terminate the process even
/// when the caller's continuation can never be scheduled (e.g. a @MainActor
/// caller whose main thread is blocked): pass `{ exit(0) }` for a real,
/// preemptive self-deadline. Omit it (the default) to keep the pure
/// caller-owns-the-decision behaviour used by the bounded SCK-teardown races.
func raceAgainstDeadline(
    seconds: Double,
    onTimeout: (@Sendable () -> Void)? = nil,
    operation: @Sendable @escaping () async -> Void,
) async -> ShutdownRaceOutcome {
    let cell = RaceCell()
    let operationTask = Task {
        await operation()
        await cell.resolve(.completed)
    }
    let deadlineTask = Task {
        try? await Task.sleep(for: .seconds(seconds))
        // Fire the escape hatch off-main before resolving, so a wedged caller
        // actor cannot swallow the termination.
        onTimeout?()
        await cell.resolve(.timedOut)
    }
    let outcome = await cell.wait()
    // Best-effort: unblock a cancellation-aware operation and stop the timer.
    // A cancellation-ignoring operation is simply left to finish on its own.
    operationTask.cancel()
    deadlineTask.cancel()
    return outcome
}
