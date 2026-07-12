@testable import MeetingTranscriber
import XCTest

@MainActor
private final class StubRecorder: RecordingProvider {
    let mixPath = URL(fileURLWithPath: "/tmp/test_engine_config_recorder.wav")
    var appLevelDBFS: Double = -120
    var micLevelDBFS: Double = -120

    func start(
        appPID _: pid_t,
        noMic _: Bool,
        micDeviceUID _: String?,
        debugLogging _: Bool,
        disableAppAudioTap _: Bool,
    ) {}

    func stop() -> RecordingResult {
        RecordingResult(
            mixPath: mixPath,
            appPath: nil,
            micPath: nil,
            micDelay: 0,
            recordingStart: ProcessInfo.processInfo.systemUptime,
        )
    }
}

private final class InactiveDetector: MeetingDetecting {
    func checkOnce() -> DetectedMeeting? { nil }
    func isMeetingActive(_: DetectedMeeting) -> Bool { false }
    func reset(appName _: String?) {}
}

/// Proves `handleMeeting` reads the cross-process bridge and forwards it to the
/// injected `applyEngineConfig` hook exactly once, before finalising the
/// recording. The parsed field VALUES are covered by `EngineConfigTests`; this
/// pins the wiring that makes those overrides reach a live meeting.
@MainActor
final class WatchLoopEngineConfigTests: XCTestCase {
    func testHandleMeetingAppliesEngineConfigOnce() async throws {
        nonisolated(unsafe) var applied: [EngineConfig] = []
        let loop = WatchLoop(
            detector: InactiveDetector(),
            recorderFactory: { StubRecorder() },
            pipelineQueue: nil,
            pollInterval: 0.01,
            endGracePeriod: 0.01,
            maxDuration: 10,
            noMic: { true },
            applyEngineConfig: { applied.append($0) },
        )
        loop.permissionChecker = {
            HealthCheckResult(screenRecording: .healthy, microphone: .healthy)
        }

        let meeting = DetectedMeeting(
            pattern: .teams,
            windowTitle: "Test Meeting | Microsoft Teams",
            ownerName: "Microsoft Teams",
            windowPID: 9999,
        )

        try await loop.handleMeeting(meeting)

        XCTAssertEqual(applied.count, 1, "applyEngineConfig must run exactly once per meeting")
    }

    /// The default hook is a harmless no-op — a WatchLoop built without wiring
    /// the bridge still finalises a meeting.
    func testDefaultHookIsNoOp() async throws {
        let loop = WatchLoop(
            detector: InactiveDetector(),
            recorderFactory: { StubRecorder() },
            pipelineQueue: nil,
            pollInterval: 0.01,
            endGracePeriod: 0.01,
            maxDuration: 10,
            noMic: { true },
        )
        loop.permissionChecker = {
            HealthCheckResult(screenRecording: .healthy, microphone: .healthy)
        }

        let meeting = DetectedMeeting(
            pattern: .teams,
            windowTitle: "Test Meeting | Microsoft Teams",
            ownerName: "Microsoft Teams",
            windowPID: 9999,
        )

        // Should not throw despite no applyEngineConfig being supplied.
        try await loop.handleMeeting(meeting)
    }
}
