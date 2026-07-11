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

    // MARK: - watchdogVerdict (pause-aware decision table)

    private func verdict(
        gap: Double = 10,
        attempts: Int = 0,
        max: Int = 5,
        threshold: Double = 3,
        window: ScreenRecorder.WindowVisibility,
        recording: Bool = true,
    ) -> ScreenRecorder.WatchdogVerdict {
        ScreenRecorder.watchdogVerdict(
            isRecording: recording,
            secondsSinceLastFrame: gap,
            attemptsSoFar: attempts,
            maxAttempts: max,
            stallThreshold: threshold,
            windowState: window,
        )
    }

    /// Visible target + stale gap + under the cap → restart (the genuine stall).
    func testVerdictVisibleStaleRestarts() {
        XCTAssertEqual(verdict(window: .visible), .restart)
    }

    /// Fresh gap (below threshold) → wait, whatever the window state.
    func testVerdictFreshGapWaits() {
        XCTAssertEqual(verdict(gap: 1, window: .visible), .wait)
        XCTAssertEqual(verdict(gap: 1, window: .gone), .wait)
    }

    /// Minimized window pauses SCK delivery by design → wait, never restart.
    func testVerdictMinimizedWaits() {
        XCTAssertEqual(verdict(window: .minimized), .wait)
    }

    /// Locked/asleep display pauses all capture → wait, never restart.
    func testVerdictDisplayLockedOrAsleepWaits() {
        XCTAssertEqual(verdict(window: .displayLockedOrAsleep), .wait)
    }

    /// Vanished window → fall back to whole-display capture (under the cap).
    func testVerdictGoneFallsBackToDisplay() {
        XCTAssertEqual(verdict(window: .gone), .fallbackToDisplay)
    }

    /// Undetermined visibility is treated like visible so a flaky enumeration
    /// can't silently disable stall recovery.
    func testVerdictUnknownRestarts() {
        XCTAssertEqual(verdict(window: .unknown), .restart)
    }

    /// At the consecutive-attempt cap: a stall gives up, a gone window gives up.
    func testVerdictAtCapGivesUp() {
        XCTAssertEqual(verdict(attempts: 5, window: .visible), .giveUp)
        XCTAssertEqual(verdict(attempts: 5, window: .gone), .giveUp)
        XCTAssertEqual(verdict(attempts: 5, window: .unknown), .giveUp)
    }

    /// Teardown (isRecording=false) → wait, even with an enormous gap.
    func testVerdictNotRecordingWaits() {
        XCTAssertEqual(verdict(gap: 999, window: .visible, recording: false), .wait)
    }

    // MARK: - restartBackoff progression

    /// Exponential 1/2/4/8/16, clamped at 16; sub-1 attempt is defensively 1 s.
    func testRestartBackoffProgression() {
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 1), 1)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 2), 2)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 3), 4)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 4), 8)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 5), 16)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 6), 16)
        XCTAssertEqual(ScreenRecorder.restartBackoff(consecutiveAttempts: 0), 1)
    }

    // MARK: - attemptsAfterFrameAppended (reset-on-frame)

    /// A successful frame resets the consecutive-failure counter to 0.
    func testAttemptsResetOnFrame() {
        XCTAssertEqual(ScreenRecorder.attemptsAfterFrameAppended(3), 0)
        XCTAssertEqual(ScreenRecorder.attemptsAfterFrameAppended(1), 0)
        XCTAssertEqual(ScreenRecorder.attemptsAfterFrameAppended(0), 0)
    }
}
