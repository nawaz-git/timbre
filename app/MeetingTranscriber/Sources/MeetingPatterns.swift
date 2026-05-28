import CoreGraphics

/// Pattern definition for detecting active meetings via window titles.
struct AppMeetingPattern: Equatable {
    let appName: String
    let ownerNames: [String]
    let meetingPatterns: [String]
    let idlePatterns: [String]
    let minWindowWidth: CGFloat
    let minWindowHeight: CGFloat

    init(
        appName: String,
        ownerNames: [String],
        meetingPatterns: [String],
        idlePatterns: [String] = [],
        minWindowWidth: CGFloat = 200,
        minWindowHeight: CGFloat = 200,
    ) {
        self.appName = appName
        self.ownerNames = ownerNames
        self.meetingPatterns = meetingPatterns
        self.idlePatterns = idlePatterns
        self.minWindowWidth = minWindowWidth
        self.minWindowHeight = minWindowHeight
    }
}

extension AppMeetingPattern {
    static let teams = AppMeetingPattern(
        appName: "Microsoft Teams",
        ownerNames: ["Microsoft Teams", "Microsoft Teams (work or school)"],
        meetingPatterns: [
            #".+\s+\|\s+Microsoft Teams"#,
        ],
        idlePatterns: [
            #"^Microsoft Teams$"#,
            #"^Microsoft Teams \(work or school\)$"#,
            #"^Chat \|"#,
            #"^Activity \|"#,
            #"^Calendar \|"#,
            #"^Teams \|"#,
            #"^Files \|"#,
            #"^Assignments \|"#,
            #"^Settings \|"#,
            #"^Calls \|"#,
            #"^People \|"#,
            #"^Notifications \|"#,
        ],
    )

    static let zoom = AppMeetingPattern(
        appName: "Zoom",
        ownerNames: ["zoom.us"],
        meetingPatterns: [
            #"^Zoom Meeting$"#,
            #"^Zoom Webinar$"#,
            #".+\s*-\s*Zoom$"#,
        ],
        idlePatterns: [
            #"^Zoom$"#,
            #"^Zoom Workplace$"#,
            #"^Home$"#,
        ],
    )

    static let webex = AppMeetingPattern(
        appName: "Webex",
        ownerNames: ["Webex", "Cisco Webex Meetings"],
        meetingPatterns: [
            #".+\s*-\s*Webex$"#,
            #"^Meeting \|"#,
            #".+'s Personal Room"#,
        ],
        idlePatterns: [
            #"^Webex$"#,
            #"^Cisco Webex Meetings$"#,
        ],
    )

    /// Google Meet runs in a browser tab (Chrome on macOS); the window title
    /// (`kCGWindowName`) is the active tab's raw `document.title` — Chrome does
    /// NOT append its " - Google Chrome – <profile>" suffix to `kCGWindowName`
    /// (verified live: a Slack tab reports exactly "Where work happens | Slack").
    ///
    /// Real in-call Meet `document.title` values vary by Meet version and how the
    /// call was created, e.g. "fza-ukvk-tyg - Google Meet", "Meet - <name>", or a
    /// bare meeting code "fza-ukvk-tyg" (codes are lowercase `xxx-xxxx-xxx`). The
    /// old single anchored pattern `^Meet -` only matched the legacy "Meet - X"
    /// form, so a call titled "<code> - Google Meet" was NEVER detected and the
    /// engine recorded nothing. We now match any of: a leading "Meet -", the
    /// phrase "Google Meet" anywhere, or a bare Meet meeting-code — while still
    /// excluding the idle landing page ("Google Meet" with no code/name).
    ///
    /// Unlike Teams/Zoom/Webex, Chrome does not create a stable
    /// `PreventUserIdleDisplaySleep` assertion per-tab during a Meet call, so
    /// detection relies on this window-title path (`MeetingDetector`) rather than
    /// the power-assertion path (`PowerAssertionDetector`).
    static let googleMeet = AppMeetingPattern(
        appName: "Google Meet",
        ownerNames: ["Google Chrome"],
        meetingPatterns: [
            #"^Meet\s*[-—–]\s*\S"#,
            #"\bGoogle Meet\b"#,
            #"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b"#,
        ],
        idlePatterns: [
            #"^New Tab$"#,
            #"^Google Chrome$"#,
            #"^Google Meet$"#,
        ],
    )

    /// Debug simulator for testing the full pipeline without a real meeting app.
    /// Run: cd tools/meeting-simulator && swift run
    static let simulator = AppMeetingPattern(
        appName: "MeetingSimulator",
        ownerNames: ["meeting-simulator"],
        meetingPatterns: [
            #"Simulator Meeting"#,
        ],
        minWindowWidth: 100,
        minWindowHeight: 100,
    )

    static let all: [AppMeetingPattern] = [teams, zoom, webex, googleMeet, simulator]

    static let byName: [String: AppMeetingPattern] = {
        var dict: [String: AppMeetingPattern] = [:]
        for p in all {
            dict[p.appName.lowercased()] = p
        }
        return dict
    }()

    /// Lookup pattern by app name (case-insensitive).
    static func forAppName(_ name: String) -> AppMeetingPattern? {
        byName[name.lowercased()]
    }
}
