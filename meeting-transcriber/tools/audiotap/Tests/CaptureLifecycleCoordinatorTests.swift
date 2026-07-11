@testable import AudioTapLib
import XCTest

/// Unit tests for the pure tap-lifecycle state machine. All timing is driven by
/// injected `Date`s so every scenario is deterministic. Seeded from the old
/// `OutputDeviceChangeCoordinatorTests` (device-change → restart, re-entrancy
/// ignored, success returns to steady state) and extended for the new
/// debounce / rate-limit / degrade policy.
final class CaptureLifecycleCoordinatorTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_000_000)
    private func date(_ offset: TimeInterval) -> Date { base.addingTimeInterval(offset) }

    // Default tuning used across tests: debounce 2 s, min interval 5 s,
    // maxRebuilds 3, degraded backoff 30 s.
    private func makeCoordinator() -> CaptureLifecycleCoordinator {
        CaptureLifecycleCoordinator(
            debounce: 2.0, minRebuildInterval: 5.0, maxRebuilds: 3, degradedBackoff: 30.0,
        )
    }

    // MARK: - Device change → cooling window

    func testDeviceChangeEntersCoolingWithDebounceDeadline() {
        var coord = makeCoordinator()
        let action = coord.handle(.deviceChanged(at: date(0)))
        XCTAssertEqual(action, .scheduleQuietWindow(at: date(2)))
        XCTAssertEqual(coord.state, .coolingDown(until: date(2)))
    }

    func testBurstOfFiveDeviceChangesCoalescesToOneRebuild() {
        var coord = makeCoordinator()
        // Five changes within 1 s — each extends the quiet window.
        for offset in [0.0, 0.2, 0.4, 0.6, 0.8] {
            _ = coord.handle(.deviceChanged(at: date(offset)))
        }
        XCTAssertEqual(coord.state, .coolingDown(until: date(2.8)))

        // Quiet windows scheduled by the earlier changes are stale — ignored.
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2.0))), .ignore)
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2.6))), .ignore)

        // The final window fires → exactly one rebuild.
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2.8))), .rebuild)
        XCTAssertEqual(coord.state, .rebuilding)
    }

    func testStaleQuietWindowIgnoredWhenNewerChangeExtendedIt() {
        var coord = makeCoordinator()
        _ = coord.handle(.deviceChanged(at: date(0))) // cooling until 2
        _ = coord.handle(.deviceChanged(at: date(1))) // cooling until 3
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2))), .ignore)
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(3))), .rebuild)
    }

    // MARK: - Rebuild storm capped at the min interval

    func testConsecutiveRebuildsAreCappedAtMinInterval() {
        var coord = makeCoordinator()
        _ = coord.handle(.deviceChanged(at: date(0)))
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2))), .rebuild) // rebuild #1 at t2
        XCTAssertEqual(coord.handle(.rebuildFinished(success: true)), .ignore)
        XCTAssertEqual(coord.state, .running)

        // A change 1 s after the first rebuild — quiet window would elapse at t5,
        // but the min interval (5 s from t2 → t7) pushes the rebuild out.
        _ = coord.handle(.deviceChanged(at: date(3)))
        XCTAssertEqual(
            coord.handle(.quietWindowElapsed(at: date(5))),
            .scheduleQuietWindow(at: date(7)),
        )
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(7))), .rebuild) // rebuild #2 at t7
    }

    // MARK: - Degrade after repeated failures, then backoff re-attempt

    func testThreeFailuresEnterDegradedThenReattemptOnQuietWindow() {
        var coord = makeCoordinator()
        _ = coord.handle(.deviceChanged(at: date(0)))
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(2))), .rebuild) // #1 at t2
        XCTAssertEqual(
            coord.handle(.rebuildFinished(success: false)),
            .scheduleQuietWindow(at: date(7)),
        )
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(7))), .rebuild) // #2 at t7
        XCTAssertEqual(
            coord.handle(.rebuildFinished(success: false)),
            .scheduleQuietWindow(at: date(12)),
        )
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(12))), .rebuild) // #3 at t12

        // Third consecutive failure → degraded, re-attempt scheduled 30 s later.
        XCTAssertEqual(
            coord.handle(.rebuildFinished(success: false)),
            .enterDegraded(reattemptAt: date(42)),
        )
        XCTAssertEqual(coord.state, .degraded)

        // The backoff quiet window rebuilds again (no hot loop in between).
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(42))), .rebuild)
        XCTAssertEqual(coord.state, .rebuilding)
    }

    func testSuccessResetsFailureCounter() {
        var coord = makeCoordinator()
        // Two failures (counter → 2).
        _ = coord.handle(.deviceChanged(at: date(0)))
        _ = coord.handle(.quietWindowElapsed(at: date(2)))
        _ = coord.handle(.rebuildFinished(success: false)) // fc = 1
        _ = coord.handle(.quietWindowElapsed(at: date(7)))
        _ = coord.handle(.rebuildFinished(success: false)) // fc = 2

        // A success resets the counter.
        _ = coord.handle(.quietWindowElapsed(at: date(12)))
        XCTAssertEqual(coord.handle(.rebuildFinished(success: true)), .ignore)

        // One more failure must NOT degrade (would if the counter were still 2).
        _ = coord.handle(.deviceChanged(at: date(13)))
        _ = coord.handle(.quietWindowElapsed(at: date(15))) // min interval → reschedule
        _ = coord.handle(.quietWindowElapsed(at: date(17))) // rebuild #4 at t17
        let action = coord.handle(.rebuildFinished(success: false))
        XCTAssertEqual(action, .scheduleQuietWindow(at: date(22)))
        XCTAssertNotEqual(coord.state, .degraded)
    }

    // MARK: - Health-check failures (urgent path)

    func testHealthCheckFailedRebuildsImmediatelyWhenNoPriorRebuild() {
        var coord = makeCoordinator()
        // No debounce — deadline is "now" so the quiet window rebuilds at once.
        XCTAssertEqual(
            coord.handle(.healthCheckFailed(at: date(0))),
            .scheduleQuietWindow(at: date(0)),
        )
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(0))), .rebuild)
    }

    func testHealthCheckFailedRespectsMinIntervalAfterRebuild() {
        var coord = makeCoordinator()
        _ = coord.handle(.deviceChanged(at: date(0)))
        _ = coord.handle(.quietWindowElapsed(at: date(2))) // rebuild at t2
        _ = coord.handle(.rebuildFinished(success: true))
        // Health failure 1 s later must wait until t2 + 5 = t7.
        XCTAssertEqual(
            coord.handle(.healthCheckFailed(at: date(3))),
            .scheduleQuietWindow(at: date(7)),
        )
    }

    // MARK: - Re-entrancy / wrong-state events ignored (ported)

    func testDeviceChangeWhileRebuildingIsIgnored() {
        var coord = makeCoordinator()
        _ = coord.handle(.deviceChanged(at: date(0)))
        _ = coord.handle(.quietWindowElapsed(at: date(2))) // → rebuilding
        XCTAssertEqual(coord.handle(.deviceChanged(at: date(3))), .ignore)
        XCTAssertEqual(coord.state, .rebuilding)
    }

    func testStrayEventsInSteadyStateAreIgnored() {
        var coord = makeCoordinator()
        XCTAssertEqual(coord.handle(.quietWindowElapsed(at: date(0))), .ignore)
        XCTAssertEqual(coord.handle(.rebuildFinished(success: true)), .ignore)
        XCTAssertEqual(coord.state, .idle)
    }
}
