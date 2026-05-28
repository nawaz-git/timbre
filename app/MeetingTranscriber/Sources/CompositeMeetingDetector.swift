import Foundation

/// Combines multiple `MeetingDetecting` instances into one. Detectors are
/// polled in order; the first match wins.
///
/// The motivating case is browser-based meetings. `PowerAssertionDetector` is
/// reliable for native apps (Teams/Zoom/Webex) that hold a
/// `PreventUserIdleDisplaySleep` assertion for the whole call, but Chrome does
/// not create a stable per-tab assertion during a Google Meet — so Meet has
/// to be detected via `MeetingDetector`'s window-title path. Running both
/// detectors side by side keeps the existing power-assertion reliability for
/// native apps and adds window-title coverage for browser meetings without
/// per-detector branching elsewhere in the app.
final class CompositeMeetingDetector: MeetingDetecting {
    private let detectors: [any MeetingDetecting]

    init(_ detectors: [any MeetingDetecting]) {
        self.detectors = detectors
    }

    func checkOnce() -> DetectedMeeting? {
        for detector in detectors {
            if let meeting = detector.checkOnce() {
                return meeting
            }
        }
        return nil
    }

    func isMeetingActive(_ meeting: DetectedMeeting) -> Bool {
        detectors.contains { $0.isMeetingActive(meeting) }
    }

    func reset(appName: String? = nil) {
        for detector in detectors {
            detector.reset(appName: appName)
        }
    }
}
