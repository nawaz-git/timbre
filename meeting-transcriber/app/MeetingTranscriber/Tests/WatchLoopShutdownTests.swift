@testable import MeetingTranscriber
import XCTest

/// Coverage for `WatchLoop.shutdown()` — the awaitable teardown that the
/// engine's SIGTERM handler drives. Unlike `stop()` (fire-and-forget finalize),
/// `shutdown()` must AWAIT the finalize so the caller can guarantee the tap is
/// destroyed and the recording enqueued before the process exits, and it must
/// route through the same finalize machinery so it can never double-stop or
/// leak a recorder.
@MainActor
final class WatchLoopShutdownTests: XCTestCase {
    /// `shutdown()` during an active manual recording finalizes the recorder
    /// exactly once, enqueues the result, and returns only once that is done —
    /// no post-hoc polling required.
    func testShutdownDuringManualRecordingFinalizesExactlyOnceAndAwaits() async throws {
        let tmpDir = try makeTempDirectory(prefix: "wl-shutdown")
        let recorder = MockRecorder()
        recorder.mixPath = URL(fileURLWithPath: "/tmp/test_shutdown_mix.wav")
        let queue = PipelineQueue(logDir: tmpDir)

        let loop = WatchLoop(
            detector: makeSilentDetector(),
            recorderFactory: { recorder },
            pipelineQueue: queue,
            pollInterval: 0.05,
            endGracePeriod: 0.1,
            maxDuration: 100,
            noMic: { true },
            // Keep the monitor polling so it does NOT self-stop the recording —
            // shutdown() is what must finalize it.
            pidAliveCheck: { _ in true },
        )
        loop.permissionChecker = {
            HealthCheckResult(screenRecording: .healthy, microphone: .healthy)
        }

        try await loop.startManualRecording(pid: 4242, appName: "Zoom", title: "Standup")
        XCTAssertTrue(recorder.startCalled, "recorder.start must be called")

        await loop.shutdown()

        XCTAssertEqual(
            recorder.stopCallCount, 1,
            "the recorder must be finalized exactly once on shutdown",
        )
        XCTAssertEqual(
            queue.jobs.count, 1,
            "the finalized recording must be enqueued, not discarded",
        )
        XCTAssertNil(loop.activeRecorder, "activeRecorder cleared after shutdown")
        XCTAssertEqual(loop.state, .idle, "loop returns to idle after shutdown")
    }

    /// `shutdown()` while merely watching (no recording) is a clean no-op that
    /// returns promptly and leaves the loop idle.
    func testShutdownWhileWatchingIsCleanNoOp() async {
        let (loop, recorder) = makeTestWatchLoop()
        loop.start()
        XCTAssertEqual(loop.state, .watching)

        await loop.shutdown()

        XCTAssertFalse(recorder.stopCalled, "no recording in flight — nothing to finalize")
        XCTAssertEqual(loop.state, .idle, "loop returns to idle after shutdown")
    }
}
