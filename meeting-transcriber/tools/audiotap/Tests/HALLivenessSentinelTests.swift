@testable import AudioTapLib
import XCTest

/// Verdict-table coverage for the pure `HALLivenessSentinel`. Probe results are
/// injected; the machine must latch `.unresponsive` after two CONSECUTIVE
/// timeouts, stay quiet afterwards, and emit `.recovered` exactly once when the
/// HAL answers again.
final class HALLivenessSentinelTests: XCTestCase {
    private func makeSentinel() -> HALLivenessSentinel {
        HALLivenessSentinel(timeoutsBeforeUnresponsive: 2)
    }

    func testHealthyWhileResponding() {
        var sentinel = makeSentinel()
        XCTAssertEqual(sentinel.record(.responded), .healthy)
        XCTAssertEqual(sentinel.record(.responded), .healthy)
    }

    func testSingleTimeoutIsStillHealthy() {
        var sentinel = makeSentinel()
        // One timeout is within tolerance — a transient blip must not fire.
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
    }

    func testTwoConsecutiveTimeoutsFireUnresponsiveOnce() {
        var sentinel = makeSentinel()
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
        XCTAssertEqual(sentinel.record(.timedOut), .unresponsive)
        // Latched — further timeouts stay quiet (no notification spam).
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
    }

    func testResponseResetsTheConsecutiveCounter() {
        var sentinel = makeSentinel()
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
        // A response between timeouts clears the streak, so the next single
        // timeout is not enough to fire.
        XCTAssertEqual(sentinel.record(.responded), .healthy)
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
        XCTAssertEqual(sentinel.record(.timedOut), .unresponsive)
    }

    func testRecoveryFiresOnceAfterUnresponsive() {
        var sentinel = makeSentinel()
        _ = sentinel.record(.timedOut)
        XCTAssertEqual(sentinel.record(.timedOut), .unresponsive)
        // First response after the wedge reports recovery…
        XCTAssertEqual(sentinel.record(.responded), .recovered)
        // …and only once — subsequent responses are plain healthy.
        XCTAssertEqual(sentinel.record(.responded), .healthy)
    }

    func testReWedgeFiresUnresponsiveAgainAfterRecovery() {
        var sentinel = makeSentinel()
        _ = sentinel.record(.timedOut)
        XCTAssertEqual(sentinel.record(.timedOut), .unresponsive)
        XCTAssertEqual(sentinel.record(.responded), .recovered)
        // A fresh wedge after recovery must fire again (not stay latched).
        XCTAssertEqual(sentinel.record(.timedOut), .healthy)
        XCTAssertEqual(sentinel.record(.timedOut), .unresponsive)
    }
}
