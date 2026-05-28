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
    /// reflects the active tab's `document.title`. Meet sets it to
    /// "Meet - <code>" (or "Meet - <meeting name>" once joined). Unlike Teams/
    /// Zoom/Webex, Chrome does not create a stable `PreventUserIdleDisplaySleep`
    /// assertion per-tab during a Meet call, so detection has to fall back to
    /// the window-title path (`MeetingDetector`) rather than the power-
    /// assertion path (`PowerAssertionDetector`).
    static let googleMeet = AppMeetingPattern(
        appName: "Google Meet",
        ownerNames: ["Google Chrome"],
        meetingPatterns: [
            #"^Meet\s*[-—–]\s*\S"#,
        ],
        idlePatterns: [
            #"^New Tab$"#,
            #"^Google Chrome$"#,
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
