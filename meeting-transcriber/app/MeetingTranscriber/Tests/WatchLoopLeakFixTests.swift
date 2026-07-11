@testable import MeetingTranscriber
import os
import XCTest

/// Regression coverage for the capture-leak paths: tearing the watch loop down
/// while a recording is in flight must finalize the recorder (stop the live
/// CoreAudio tap + enqueue the result) instead of dropping the reference, and a
/// throwing `recorder.stop()` in `handleMeeting` must still stop the screen
/// recorder rather than leak a running SCStream.
@available(macOS 14.0, *)
@MainActor
final class WatchLoopLeakFixTests: XCTestCase {
    /// `stop()` during an active manual recording must call the recorder's
    /// `stop()` exactly once (finalize, not leak) and enqueue the recording.
    func testStopDuringManualRecordingFinalizesRecorderExactlyOnce() async throws {
        let tmpDir = try makeTempDirectory(prefix: "wl-leak")
        let recorder = MockRecorder()
        recorder.mixPath = URL(fileURLWithPath: "/tmp/test_leak_mix.wav")
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
            // the teardown path is what must finalize it.
            pidAliveCheck: { _ in true },
        )
        loop.permissionChecker = {
            HealthCheckResult(screenRecording: .healthy, microphone: .healthy)
        }

        try await loop.startManualRecording(pid: 4242, appName: "Zoom", title: "Standup")
        XCTAssertTrue(recorder.startCalled, "recorder.start must be called")

        // Watch-loop teardown (e.g. Stop Watching / app quit) while recording.
        loop.stop()

        // cleanupManualRecording() finalizes on a spawned @MainActor task.
        await waitFor(recorder.stopCallCount == 1)

        XCTAssertEqual(
            recorder.stopCallCount, 1,
            "the live recorder must be stopped exactly once on watch-loop teardown",
        )
        XCTAssertEqual(
            queue.jobs.count, 1,
            "the finalized recording must be enqueued, not silently discarded",
        )
        XCTAssertNil(loop.activeRecorder, "activeRecorder cleared after teardown")
        XCTAssertEqual(loop.state, .idle, "loop returns to idle after stop")
    }

    /// A throwing `recorder.stop()` in `handleMeeting` must still tear the
    /// screen stream down via the `abortScreenRecorderIfStillActive()` defer.
    func testThrowingRecorderStopStillStopsScreenRecorder() async throws {
        let recorder = MockRecorder()
        recorder.mixPath = nil // → stop() throws RecorderError.noAudioData

        let spy = SpyScreenRecorder(url: URL(fileURLWithPath: "/tmp/spy_screen.mp4"))
        let loop = WatchLoop(
            detector: makeSilentDetector(),
            recorderFactory: { recorder },
            pipelineQueue: nil,
            pollInterval: 0.01,
            endGracePeriod: 0.01,
            maxDuration: 10,
            noMic: { true },
            recordScreenVideo: { true },
            screenRecorderFactory: { _, _ in spy },
            screenRecordingPermitted: { true },
        )
        loop.permissionChecker = {
            HealthCheckResult(screenRecording: .healthy, microphone: .healthy)
        }

        let meeting = DetectedMeeting(
            pattern: .teams,
            windowTitle: "Standup | Microsoft Teams",
            ownerName: "Microsoft Teams",
            windowPID: 4242,
        )

        // The screen recorder starts async — make sure it is active before the
        // finalize path runs, otherwise the assertion races the start Task.
        do {
            try await loop.handleMeeting(meeting)
            XCTFail("handleMeeting must rethrow the recorder.stop() failure")
        } catch {
            // expected — recorder.stop() threw noAudioData
        }

        XCTAssertTrue(recorder.stopCalled, "recorder.stop() was invoked (and threw)")

        // The defer stops the SCStream on a fire-and-forget task.
        await waitFor(spy.stopCalled)
        XCTAssertTrue(
            spy.stopCalled,
            "screen recorder must be stopped even when recorder.stop() throws — no leaked stream",
        )
    }
}

/// Observable stand-in for `ScreenRecorder` (a non-subclassable actor). Conforms
/// to the `ScreenRecording` seam so `WatchLoop`'s screen lifecycle is testable
/// without a live SCStream. Lock-guarded so the fire-and-forget stop Task and
/// the asserting test thread don't race the flags.
@available(macOS 14.0, *)
final class SpyScreenRecorder: ScreenRecording, @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: (started: false, stopped: false))
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    var startCalled: Bool { lock.withLock { $0.started } }
    var stopCalled: Bool { lock.withLock { $0.stopped } }

    func start() async throws {
        lock.withLock { $0.started = true }
    }

    func stop() async throws -> URL {
        lock.withLock { $0.stopped = true }
        return url
    }
}
