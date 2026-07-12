import Foundation
import os.log
import UserNotifications

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "NotificationManager")

/// Sends macOS notifications for meeting state transitions. Marked
/// `@unchecked Sendable` because:
/// - `UNUserNotificationCenter` is thread-safe per Apple's docs
/// - `isSetUp` is written exactly once in `setUp()` (called from the
///   `@main` scene) and read thereafter, so no real race
/// `@MainActor` would be cleaner but conflicts with the
/// `UNUserNotificationCenterDelegate` callbacks, which the framework
/// invokes from arbitrary queues.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate, AppNotifying, @unchecked Sendable {
    static let shared = NotificationManager()

    private(set) var isSetUp = false

    override init() {
        super.init()
    }

    /// Set up delegate and request permission. Must be called after the app bundle is loaded.
    func setUp() {
        guard !isSetUp else { return }
        // UNUserNotificationCenter crashes without a proper app bundle
        guard Bundle.main.bundleIdentifier != nil else {
            logger.warning("Skipping setup — no app bundle")
            return
        }
        isSetUp = true

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                logger.error("Notification permission error: \(error.localizedDescription, privacy: .public)")
            }
            if !granted {
                logger.warning("Notification permission denied")
            }
        }
    }

    func notify(title: String, body: String) {
        guard isSetUp, Bundle.main.bundleIdentifier != nil else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil,
        )

        UNUserNotificationCenter.current().add(request)
    }

    /// Current notification-authorization state mapped to the wire vocabulary
    /// Electron surfaces (`authorized` / `denied` / `notDetermined` /
    /// `provisional`) so the product can tell the user when engine alerts are
    /// muted. Wraps the async `notificationSettings()` query. Returns
    /// `notDetermined` in any process that isn't a real `.app` (the query is
    /// unusable then). Static — it reads no instance state.
    static func notificationAuthStatusString() async -> String {
        // `UNUserNotificationCenter.current()` throws NSInternalInconsistencyException
        // ("bundleProxyForCurrentProcess is nil") in any process that isn't a real
        // `.app`. The xctest harness is exactly that: its `Bundle.main` is Xcode's
        // toolchain, which HAS a bundle identifier (so the old `bundleIdentifier !=
        // nil` guard passed) but no app proxy — the call then aborts the process on
        // a background thread. Gate on the XCTest environment AND on the bundle
        // actually being an `.app`; `notDetermined` is the neutral fallback.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return "notDetermined"
        }
        guard Bundle.main.bundleURL.pathExtension == "app" else { return "notDetermined" }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    /// Pure function: determines notification content for a state transition.
    /// Returns nil if no notification should be sent.
    static func notificationContent(
        for state: TranscriberState,
        status: TranscriberStatus,
    ) -> (title: String, body: String)? {
        switch state {
        case .recording:
            let meetingTitle = status.meeting?.title ?? "Unknown"
            let app = status.meeting?.app ?? ""
            return ("Meeting Detected", "Recording: \(meetingTitle) (\(app))")

        case .protocolReady:
            let meetingTitle = status.meeting?.title ?? "Meeting"
            return ("Protocol Ready", "Protocol for \"\(meetingTitle)\" is ready.")

        case .waitingForSpeakerNames:
            return ("Name Speakers", "Speakers detected — open the app to assign names")

        case .error:
            if let error = status.error {
                return ("Transcriber Error", error)
            }
            return nil

        default:
            return nil
        }
    }

    /// Handle state transitions and send appropriate notifications.
    func handleTransition(
        from _: TranscriberState?,
        to newState: TranscriberState,
        status: TranscriberStatus,
    ) {
        if let content = Self.notificationContent(for: newState, status: status) {
            notify(title: content.title, body: content.body)
        }
    }

    // Show notifications even when app is in foreground
    // swiftlint:disable:next async_without_await
    func userNotificationCenter(_: UNUserNotificationCenter, willPresent _: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
