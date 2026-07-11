@testable import MeetingTranscriber
import XCTest

/// Unit coverage for the pure `raceAgainstDeadline` helper that bounds the
/// engine's graceful SIGTERM teardown. The load-bearing property is that the
/// deadline is authoritative even when the operation is wedged — a hung
/// teardown must never prevent the process from exiting.
final class GracefulShutdownTests: XCTestCase {
    /// An operation that finishes before the deadline reports `.completed`.
    func testOperationCompletingBeforeDeadlineReportsCompleted() async {
        let outcome = await raceAgainstDeadline(seconds: 10) {
            // returns immediately
        }
        XCTAssertEqual(outcome, .completed)
    }

    /// A short operation still under the deadline reports `.completed`.
    func testShortOperationUnderDeadlineReportsCompleted() async {
        let outcome = await raceAgainstDeadline(seconds: 10) {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(outcome, .completed)
    }

    /// An operation that exceeds the deadline reports `.timedOut` — and the
    /// call returns at the deadline, NOT after the (much longer) operation.
    func testOperationExceedingDeadlineReportsTimedOut() async {
        let start = ContinuousClock.now
        let outcome = await raceAgainstDeadline(seconds: 0.05) {
            try? await Task.sleep(for: .seconds(60))
        }
        let elapsed = ContinuousClock.now - start

        XCTAssertEqual(outcome, .timedOut)
        XCTAssertLessThan(
            elapsed, .seconds(5),
            "race must resolve at the 0.05 s deadline, not wait for the 60 s operation",
        )
    }

    /// Even a teardown that IGNORES cancellation must not block the race past
    /// the deadline — this is the property that guarantees SIGTERM can always
    /// force the process to exit.
    func testDeadlineWinsAgainstCancellationIgnoringOperation() async {
        let start = ContinuousClock.now
        let outcome = await raceAgainstDeadline(seconds: 0.05) {
            // Busy-yield well past the deadline without ever checking for
            // cancellation (no `try` / no throwing sleep).
            let until = ContinuousClock.now + .milliseconds(400)
            while ContinuousClock.now < until {
                await Task.yield()
            }
        }
        let elapsed = ContinuousClock.now - start

        XCTAssertEqual(outcome, .timedOut)
        XCTAssertLessThan(
            elapsed, .seconds(2),
            "a cancellation-ignoring operation must not stall the deadline",
        )
    }
}
