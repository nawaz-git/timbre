@testable import MeetingTranscriber
import XCTest

private final class StubDetector: MeetingDetecting {
    var checkResult: DetectedMeeting?
    var activeResult: Bool = false
    private(set) var resetCallCount: Int = 0
    private(set) var lastResetAppName: String?

    func checkOnce() -> DetectedMeeting? {
        checkResult
    }

    func isMeetingActive(_: DetectedMeeting) -> Bool {
        activeResult
    }

    func reset(appName: String?) {
        resetCallCount += 1
        lastResetAppName = appName
    }
}

private func makeMeeting(appName: String) -> DetectedMeeting {
    DetectedMeeting(
        pattern: AppMeetingPattern.forAppName(appName) ?? AppMeetingPattern.teams,
        windowTitle: "Stub",
        ownerName: "Stub",
        windowPID: 1,
    )
}

final class CompositeMeetingDetectorTests: XCTestCase {
    func testReturnsFirstDetectorMatch() {
        let first = StubDetector()
        first.checkResult = makeMeeting(appName: "Microsoft Teams")
        let second = StubDetector()
        second.checkResult = makeMeeting(appName: "Google Meet")

        let composite = CompositeMeetingDetector([first, second])

        XCTAssertEqual(composite.checkOnce()?.pattern.appName, "Microsoft Teams")
    }

    func testFallsThroughWhenFirstDetectorReturnsNil() {
        let first = StubDetector()
        first.checkResult = nil
        let second = StubDetector()
        second.checkResult = makeMeeting(appName: "Google Meet")

        let composite = CompositeMeetingDetector([first, second])

        XCTAssertEqual(composite.checkOnce()?.pattern.appName, "Google Meet")
    }

    func testReturnsNilWhenAllDetectorsReturnNil() {
        let composite = CompositeMeetingDetector([StubDetector(), StubDetector()])
        XCTAssertNil(composite.checkOnce())
    }

    func testIsMeetingActiveTrueWhenAnyDetectorAgrees() {
        let first = StubDetector()
        first.activeResult = false
        let second = StubDetector()
        second.activeResult = true

        let composite = CompositeMeetingDetector([first, second])

        XCTAssertTrue(composite.isMeetingActive(makeMeeting(appName: "Google Meet")))
    }

    func testIsMeetingActiveFalseWhenAllDetectorsDisagree() {
        let composite = CompositeMeetingDetector([StubDetector(), StubDetector()])
        XCTAssertFalse(composite.isMeetingActive(makeMeeting(appName: "Google Meet")))
    }

    func testResetPropagatesToAllDetectors() {
        let first = StubDetector()
        let second = StubDetector()
        let composite = CompositeMeetingDetector([first, second])

        composite.reset(appName: "Google Meet")

        XCTAssertEqual(first.resetCallCount, 1)
        XCTAssertEqual(first.lastResetAppName, "Google Meet")
        XCTAssertEqual(second.resetCallCount, 1)
        XCTAssertEqual(second.lastResetAppName, "Google Meet")
    }
}
