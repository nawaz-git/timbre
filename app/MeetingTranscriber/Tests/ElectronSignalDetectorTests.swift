@testable import MeetingTranscriber
import XCTest

final class ElectronSignalDetectorTests: XCTestCase {
    private var dir: URL!
    private var signalFile: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("mt-electron-signal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        signalFile = dir.appendingPathComponent("active_meeting.json")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ json: String) {
        try? json.write(to: signalFile, atomically: true, encoding: .utf8)
    }

    private func makeDetector(
        now: @escaping () -> Date = Date.init,
        pid: pid_t? = 4242,
    ) -> ElectronSignalDetector {
        ElectronSignalDetector(
            signalFile: signalFile,
            staleAfter: 12,
            now: now,
            pidResolver: { _ in pid },
        )
    }

    func testNoFileReturnsNil() {
        XCTAssertNil(makeDetector().checkOnce())
    }

    func testFreshSignalReturnsMeeting() {
        let now = Date()
        write("""
        {"meetingId":"abc-defg-hij","title":"abc-defg-hij - Google Meet",
         "browserBundleId":"com.google.Chrome","updatedAt":\(now.timeIntervalSince1970 * 1000)}
        """)
        let detector = makeDetector(now: { now }, pid: 9001)
        let meeting = detector.checkOnce()
        XCTAssertEqual(meeting?.windowPID, 9001)
        XCTAssertEqual(meeting?.windowTitle, "abc-defg-hij - Google Meet")
        XCTAssertEqual(meeting?.pattern.appName, "Google Meet")
    }

    func testStaleSignalIsIgnored() {
        let now = Date()
        // updatedAt 30s in the past, staleAfter is 12s.
        write("""
        {"meetingId":"abc-defg-hij","browserBundleId":"com.google.Chrome",
         "updatedAt":\((now.timeIntervalSince1970 - 30) * 1000)}
        """)
        XCTAssertNil(makeDetector(now: { now }).checkOnce())
    }

    func testBrowserNotRunningReturnsNil() {
        write("""
        {"meetingId":"abc-defg-hij","browserBundleId":"com.google.Chrome","updatedAt":\(Date().timeIntervalSince1970 * 1000)}
        """)
        XCTAssertNil(makeDetector(pid: nil).checkOnce())
    }

    func testIsMeetingActiveTracksSignalLifecycle() {
        let now = Date()
        let fresh = "\(now.timeIntervalSince1970 * 1000)"
        write("""
        {"meetingId":"abc-defg-hij","browserBundleId":"com.google.Chrome","updatedAt":\(fresh)}
        """)
        let detector = makeDetector(now: { now })
        guard let meeting = detector.checkOnce() else { return XCTFail("expected meeting") }
        XCTAssertTrue(detector.isMeetingActive(meeting))

        // File removed → meeting no longer active.
        try? FileManager.default.removeItem(at: signalFile)
        XCTAssertFalse(detector.isMeetingActive(meeting))
    }

    func testCooldownSuppressesSameMeetingAfterReset() {
        let now = Date()
        let fresh = "\(now.timeIntervalSince1970 * 1000)"
        let body = """
        {"meetingId":"abc-defg-hij","browserBundleId":"com.google.Chrome","updatedAt":\(fresh)}
        """
        write(body)
        let detector = makeDetector(now: { now })
        XCTAssertNotNil(detector.checkOnce())

        // Meeting finished — WatchLoop calls reset. The same lingering file
        // must NOT immediately re-trigger.
        detector.reset(appName: "Google Meet")
        write(body)
        XCTAssertNil(detector.checkOnce())

        // A different meeting id DOES trigger.
        write("""
        {"meetingId":"zzz-yyyy-xxx","browserBundleId":"com.google.Chrome","updatedAt":\(fresh)}
        """)
        XCTAssertNotNil(detector.checkOnce())
    }
}
