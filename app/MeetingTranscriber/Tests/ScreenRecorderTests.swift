@testable import MeetingTranscriber
import XCTest

/// The live SCStream/ScreenCaptureKit delegate path is not headless-unit-testable
/// (it needs real window-server frames and a TCC grant), so these tests pin the
/// extracted PURE decision logic `ScreenRecorder.shouldRestart(...)` plus the
/// pure geometry helpers. They are the deterministic regression for the
/// silent-stop fix: restart while recording vs teardown vs attempt-cap vs
/// sub-threshold gap.
@available(macOS 14.0, *)
final class ScreenRecorderTests: XCTestCase {
    // MARK: - shouldRestart decision boundary

    /// Frames went stale (>= threshold) while still recording, under the
    /// attempt cap → restart.
    func testRestartsOnStallWhileRecording() {
        XCTAssertTrue(
            ScreenRecorder.shouldRestart(
                isRecording: true,
                secondsSinceLastFrame: 4.0,
                attemptsSoFar: 0,
                maxAttempts: 5,
                stallThreshold: 3.0,
            ),
        )
    }

    /// stop() flipped isRecording=false → never restart, even with a huge gap
    /// (otherwise a restart would race teardown).
    func testNoRestartDuringTeardown() {
        XCTAssertFalse(
            ScreenRecorder.shouldRestart(
                isRecording: false,
                secondsSinceLastFrame: 999.0,
                attemptsSoFar: 0,
                maxAttempts: 5,
                stallThreshold: 3.0,
            ),
        )
    }

    /// Attempt cap reached → stop retrying and finalize whatever was captured.
    func testNoRestartPastAttemptCap() {
        XCTAssertFalse(
            ScreenRecorder.shouldRestart(
                isRecording: true,
                secondsSinceLastFrame: 999.0,
                attemptsSoFar: 5,
                maxAttempts: 5,
                stallThreshold: 3.0,
            ),
        )
    }

    /// Gap below the stall threshold → no restart (transient single dropped
    /// frame is normal at 5 fps).
    func testNoRestartBelowStallThreshold() {
        XCTAssertFalse(
            ScreenRecorder.shouldRestart(
                isRecording: true,
                secondsSinceLastFrame: 1.0,
                attemptsSoFar: 0,
                maxAttempts: 5,
                stallThreshold: 3.0,
            ),
        )
    }

    /// A didStopWithError uses stallThreshold 0 — any non-negative gap restarts
    /// while recording and under cap. Guards that the immediate-restart path
    /// (handleStreamStopped) stays distinct from the watchdog path.
    func testRestartsImmediatelyOnDelegateStop() {
        XCTAssertTrue(
            ScreenRecorder.shouldRestart(
                isRecording: true,
                secondsSinceLastFrame: .greatestFiniteMagnitude,
                attemptsSoFar: 0,
                maxAttempts: 5,
                stallThreshold: 0,
            ),
        )
    }

    // MARK: - Pure geometry helpers

    func testFitCapsLongEdgePreservingAspect() {
        let (w, h) = ScreenRecorder.fit(width: 3840, height: 2160, maxLongEdge: 1080)
        XCTAssertEqual(w, 1080)
        XCTAssertEqual(h, 606) // 2160 * (1080/3840) = 607.5 → Int truncates to 607 → even-floored to 606
    }

    func testFitNoCapWhenUnderLimit() {
        let (w, h) = ScreenRecorder.fit(width: 800, height: 600, maxLongEdge: 1080)
        XCTAssertEqual(w, 800)
        XCTAssertEqual(h, 600)
    }

    func testFitZeroMaxLongEdgeDisablesCap() {
        let (w, h) = ScreenRecorder.fit(width: 3841, height: 2161, maxLongEdge: 0)
        XCTAssertEqual(w, 3840) // even-rounded
        XCTAssertEqual(h, 2160)
    }

    func testEvenRoundsDownAndFloorsAtTwo() {
        XCTAssertEqual(ScreenRecorder.even(5), 4)
        XCTAssertEqual(ScreenRecorder.even(4), 4)
        XCTAssertEqual(ScreenRecorder.even(1), 2)
        XCTAssertEqual(ScreenRecorder.even(0), 2)
    }

    // MARK: - pickWindow selection (pure, no live SCStream)

    private func win(
        id: CGWindowID,
        pid: pid_t,
        title: String? = nil,
        bundleId: String? = "com.google.Chrome",
        area: CGFloat = 1000,
    ) -> ScreenRecorder.WindowInfo {
        ScreenRecorder.WindowInfo(
            id: id, pid: pid, title: title, bundleId: bundleId, frameArea: area,
        )
    }

    /// (a) A window owned by the requested PID is returned.
    func testPickWindowPidMatch() {
        let chosen = ScreenRecorder.pickWindow(
            candidates: [
                win(id: 1, pid: 100, area: 500),
                win(id: 2, pid: 200, area: 9000),
            ],
            pid: 100, titleHint: nil, bundleId: "com.google.Chrome",
        )
        XCTAssertEqual(chosen?.id, 1)
    }

    /// (b) Multiple windows share the PID → the title-containment tiebreak wins
    /// over the larger-but-untitled sibling.
    func testPickWindowTitleContainmentTiebreak() {
        let chosen = ScreenRecorder.pickWindow(
            candidates: [
                win(id: 1, pid: 100, title: "Docs - Google Chrome", area: 9000),
                win(id: 2, pid: 100, title: "ntu-vwcf-onr - Google Meet", area: 500),
            ],
            pid: 100, titleHint: "Google Meet", bundleId: "com.google.Chrome",
        )
        XCTAssertEqual(chosen?.id, 2)
    }

    /// (c) PID matches but no title contains the hint → fall through to the
    /// largest PID-matched window.
    func testPickWindowFallsBackToLargestAreaOnTitleMiss() {
        let chosen = ScreenRecorder.pickWindow(
            candidates: [
                win(id: 1, pid: 100, title: "Inbox", area: 500),
                win(id: 2, pid: 100, title: "Docs", area: 9000),
            ],
            pid: 100, titleHint: "Google Meet", bundleId: "com.google.Chrome",
        )
        XCTAssertEqual(chosen?.id, 2)
    }

    /// (d) No PID supplied → bundleId-only match (largest area within bundle).
    func testPickWindowBundleIdOnlyMatch() {
        let chosen = ScreenRecorder.pickWindow(
            candidates: [
                win(id: 1, pid: 100, bundleId: "com.apple.finder", area: 9000),
                win(id: 2, pid: 200, bundleId: "com.google.Chrome", area: 500),
                win(id: 3, pid: 300, bundleId: "com.google.Chrome", area: 4000),
            ],
            pid: nil, titleHint: nil, bundleId: "com.google.Chrome",
        )
        XCTAssertEqual(chosen?.id, 3)
    }

    /// (e) No PID match and no bundleId match → nil (caller falls back to
    /// whole-display capture).
    func testPickWindowReturnsNilWhenNoMatch() {
        XCTAssertNil(
            ScreenRecorder.pickWindow(
                candidates: [
                    win(id: 1, pid: 999, bundleId: "com.apple.finder"),
                ],
                pid: 100, titleHint: nil, bundleId: "com.google.Chrome",
            ),
        )
        XCTAssertNil(
            ScreenRecorder.pickWindow(
                candidates: [],
                pid: 100, titleHint: "x", bundleId: "com.google.Chrome",
            ),
        )
    }
}
