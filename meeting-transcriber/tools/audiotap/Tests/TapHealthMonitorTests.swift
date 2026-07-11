@testable import AudioTapLib
import XCTest

/// Verdict-table coverage for the pure `TapHealthMonitor`. Timeouts are injected
/// (no-callback 5 s, all-zero 60 s) and all timing is driven by explicit `Date`s.
final class TapHealthMonitorTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 2_000_000)
    private func date(_ offset: TimeInterval) -> Date { base.addingTimeInterval(offset) }

    private func makeMonitor() -> TapHealthMonitor {
        TapHealthMonitor(noCallbackTimeout: 5, allZeroTimeout: 60)
    }

    // MARK: - Healthy

    func testHealthyWhenCallbacksFreshAndSignalPresent() {
        var monitor = makeMonitor()
        XCTAssertEqual(
            monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0.3, micNonSilent: true),
            .healthy,
        )
    }

    // MARK: - No callbacks

    func testNoCallbacksWhenIOProcSilentPastTimeout() {
        var monitor = makeMonitor()
        XCTAssertEqual(
            monitor.evaluate(now: date(0), secondsSinceLastCallback: 5.0, recentPeakAbs: 0, micNonSilent: true),
            .noCallbacks(secondsStale: 5.0),
        )
    }

    func testNoCallbacksTakesPrecedenceOverAllZero() {
        var monitor = makeMonitor()
        _ = monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        // At t60 the zero window has elapsed AND the callbacks have stopped — the
        // dead IOProc is the more severe signature and wins.
        XCTAssertEqual(
            monitor.evaluate(now: date(60), secondsSinceLastCallback: 6.0, recentPeakAbs: 0, micNonSilent: true),
            .noCallbacks(secondsStale: 6.0),
        )
    }

    // MARK: - All zero (with the mic-asymmetry guard)

    func testAllZeroFiresOnlyAfterTimeoutWithMicNonSilent() {
        var monitor = makeMonitor()
        XCTAssertEqual(
            monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .healthy,
        )
        XCTAssertEqual(
            monitor.evaluate(now: date(59), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .healthy,
        )
        XCTAssertEqual(
            monitor.evaluate(now: date(60), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .allZero(secondsStale: 60),
        )
    }

    func testAllZeroSuppressedWhenMicAlsoSilent() {
        var monitor = makeMonitor()
        _ = monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: false)
        // Both channels silent → genuine quiet, never a fault however long it lasts.
        XCTAssertEqual(
            monitor.evaluate(now: date(120), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: false),
            .healthy,
        )
    }

    func testNonZeroSampleClearsTheZeroWindow() {
        var monitor = makeMonitor()
        _ = monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        // A non-zero peak at t40 clears the accumulation.
        XCTAssertEqual(
            monitor.evaluate(now: date(40), secondsSinceLastCallback: 0.1, recentPeakAbs: 0.2, micNonSilent: true),
            .healthy,
        )
        // Zero resumes at t50, so the deadline is now t110 — t109 is not yet a fault.
        _ = monitor.evaluate(now: date(50), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        XCTAssertEqual(
            monitor.evaluate(now: date(109), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .healthy,
        )
        XCTAssertEqual(
            monitor.evaluate(now: date(110), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .allZero(secondsStale: 60),
        )
    }

    func testMicGoingSilentMidZeroWindowResetsIt() {
        var monitor = makeMonitor()
        _ = monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        // Mic falls silent at t30 → the room may just be quiet, drop the episode.
        XCTAssertEqual(
            monitor.evaluate(now: date(30), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: false),
            .healthy,
        )
        // Mic returns at t60; a fresh window starts, so t60 is not itself a fault.
        XCTAssertEqual(
            monitor.evaluate(now: date(60), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .healthy,
        )
    }

    // MARK: - Reset

    func testResetClearsTheZeroWindow() {
        var monitor = makeMonitor()
        _ = monitor.evaluate(now: date(0), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        monitor.reset()
        // The window restarts from the next zero (t10), so the deadline is t70.
        _ = monitor.evaluate(now: date(10), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true)
        XCTAssertEqual(
            monitor.evaluate(now: date(69), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .healthy,
        )
        XCTAssertEqual(
            monitor.evaluate(now: date(70), secondsSinceLastCallback: 0.1, recentPeakAbs: 0, micNonSilent: true),
            .allZero(secondsStale: 60),
        )
    }
}
