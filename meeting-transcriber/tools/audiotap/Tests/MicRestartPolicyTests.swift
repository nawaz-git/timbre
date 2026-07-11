@testable import AudioTapLib
import XCTest

final class MicRestartPolicyTests: XCTestCase {
    // MARK: - Skip Cases

    func testSkipsWhenNotRecording() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: false,
            isRestarting: false,
            selectedDeviceUID: nil,
            isSelectedDeviceAvailable: false,
        )
        XCTAssertEqual(action, .skip)
    }

    func testSkipsWhenAlreadyRestarting() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: true,
            isRestarting: true,
            selectedDeviceUID: nil,
            isSelectedDeviceAvailable: false,
        )
        XCTAssertEqual(action, .skip)
    }

    func testSkipsWhenNotRecordingEvenWithSelectedDevice() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: false,
            isRestarting: false,
            selectedDeviceUID: "com.apple.airpods",
            isSelectedDeviceAvailable: true,
        )
        XCTAssertEqual(action, .skip)
    }

    // MARK: - Restart with System Default

    func testRestartsWithDefaultWhenNoDeviceSelected() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: true,
            isRestarting: false,
            selectedDeviceUID: nil,
            isSelectedDeviceAvailable: false,
        )
        XCTAssertEqual(action, .restart(deviceUID: nil))
    }

    // MARK: - Restart with Selected Device

    func testRestartsWithSelectedDeviceWhenAvailable() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: true,
            isRestarting: false,
            selectedDeviceUID: "com.apple.airpods",
            isSelectedDeviceAvailable: true,
        )
        XCTAssertEqual(action, .restart(deviceUID: "com.apple.airpods"))
    }

    // MARK: - Device Fallback

    func testFallsBackToDefaultWhenSelectedDeviceGone() {
        let action = MicRestartPolicy.decideRestart(
            isRecording: true,
            isRestarting: false,
            selectedDeviceUID: "com.apple.airpods",
            isSelectedDeviceAvailable: false,
        )
        XCTAssertEqual(action, .restart(deviceUID: nil))
    }

    // MARK: - Edge Cases

    func testEmptyDeviceUIDTreatedAsSelected() {
        // Empty string is still a non-nil selectedDeviceUID
        let action = MicRestartPolicy.decideRestart(
            isRecording: true,
            isRestarting: false,
            selectedDeviceUID: "",
            isSelectedDeviceAvailable: false,
        )
        // Empty UID not available → falls back to default
        XCTAssertEqual(action, .restart(deviceUID: nil))
    }

    func testBothFlagsBlockRestart() {
        // Not recording AND already restarting
        let action = MicRestartPolicy.decideRestart(
            isRecording: false,
            isRestarting: true,
            selectedDeviceUID: "com.apple.airpods",
            isSelectedDeviceAvailable: true,
        )
        XCTAssertEqual(action, .skip)
    }
}

/// Coalescing tests for the mic-side debounce that collapses a burst of
/// input-device notifications (a Bluetooth HFP↔A2DP flip fires several) into a
/// single restart. All timing is injected so each scenario is deterministic.
final class MicRestartCoalescerTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 2_000_000)
    private func date(_ offset: TimeInterval) -> Date { base.addingTimeInterval(offset) }

    func testSingleChangeSchedulesDebounceThenRestarts() {
        var coalescer = MicRestartCoalescer(debounce: 2.0)
        XCTAssertEqual(coalescer.handle(.deviceChanged(at: date(0))), .scheduleDebounce(at: date(2)))
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2))), .restart)
    }

    func testBurstWithinDebounceCoalescesToOneRestart() {
        var coalescer = MicRestartCoalescer(debounce: 2.0)
        // Five notifications within 1 s — each pushes the window out.
        for offset in [0.0, 0.2, 0.4, 0.6, 0.8] {
            _ = coalescer.handle(.deviceChanged(at: date(offset)))
        }
        // Windows scheduled by the earlier notifications are stale.
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2.0))), .ignore)
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2.6))), .ignore)
        // Only the final window fires a single restart.
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2.8))), .restart)
    }

    func testStaleDebounceIgnoredWhenNewerChangeExtendedIt() {
        var coalescer = MicRestartCoalescer(debounce: 2.0)
        _ = coalescer.handle(.deviceChanged(at: date(0))) // window → 2
        _ = coalescer.handle(.deviceChanged(at: date(1))) // window → 3
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2))), .ignore)
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(3))), .restart)
    }

    func testDebounceElapsedWithNoPendingIsIgnored() {
        var coalescer = MicRestartCoalescer(debounce: 2.0)
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(0))), .ignore)
    }

    func testRestartClearsPendingSoNextElapsedIsIgnored() {
        var coalescer = MicRestartCoalescer(debounce: 2.0)
        _ = coalescer.handle(.deviceChanged(at: date(0)))
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(2))), .restart)
        // pendingUntil cleared → a spurious later window does nothing.
        XCTAssertEqual(coalescer.handle(.debounceElapsed(at: date(4))), .ignore)
    }
}
