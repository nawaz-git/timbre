import AppKit
import Foundation
import os.log

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "ElectronSignalDetector")

/// Detects browser meetings from a signal file written by the Mintr (Electron)
/// app, closing the gap left by `MeetingDetector`'s window-title path.
///
/// `MeetingDetector` reads `CGWindowListCopyWindowInfo`, which only ever exposes
/// the **frontmost** Chrome window's **active tab** title — a Google Meet in a
/// background tab (or a non-frontmost window, or while the user looks at another
/// app) is invisible to it, so the engine never starts recording. Mintr's
/// Electron layer, by contrast, detects Meet reliably by reading **all** Chrome
/// tab URLs via AppleScript regardless of focus. This detector lets that
/// reliable signal drive the engine's existing record→pipeline path.
///
/// Contract — `AppPaths.ipcDir/active_meeting.json`, written atomically by
/// Electron whenever its probe sees a live Meet and rewritten on every probe
/// tick (~3 s), then deleted when the Meet ends:
/// ```
/// { "meetingId": "abc-defg-hij",
///   "title": "abc-defg-hij - Google Meet",
///   "browserBundleId": "com.google.Chrome",
///   "url": "https://meet.google.com/abc-defg-hij",
///   "updatedAt": 1779990000000 }   // epoch ms
/// ```
/// Absence of the file — or an `updatedAt` older than `staleAfter` (Electron
/// stopped updating, e.g. quit/crashed) — means "no live meeting", so we never
/// record forever against a stale file.
final class ElectronSignalDetector: MeetingDetecting {
    private let signalFile: URL
    private let staleAfter: TimeInterval
    private let now: () -> Date
    /// Resolves a browser bundle id to its main PID. Injected so tests can run
    /// without a real browser; defaults to a live `NSRunningApplication` lookup.
    private let pidResolver: (String) -> pid_t?

    /// meetingId of the call currently being recorded (set when `checkOnce`
    /// returns it). Used by `isMeetingActive` to end the recording precisely
    /// when the signal for THIS meeting goes away (file removed or id changes).
    private var recordingMeetingId: String?
    /// meetingId we just finished; suppressed until the file's id changes or the
    /// file disappears, so a momentarily-lingering file can't immediately
    /// re-trigger the same meeting right after it ended.
    private var cooldownMeetingId: String?

    init(
        signalFile: URL = AppPaths.ipcDir.appendingPathComponent("active_meeting.json"),
        staleAfter: TimeInterval = 12,
        now: @escaping () -> Date = Date.init,
        pidResolver: @escaping (String) -> pid_t? = ElectronSignalDetector.runningAppPID,
    ) {
        self.signalFile = signalFile
        self.staleAfter = staleAfter
        self.now = now
        self.pidResolver = pidResolver
    }

    /// Default resolver: the main PID of the running app with `bundleId`, if any.
    static func runningAppPID(_ bundleId: String) -> pid_t? {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: bundleId)
            .first?.processIdentifier
    }

    private struct Signal: Decodable {
        let meetingId: String
        let title: String?
        let browserBundleId: String?
        let updatedAt: Double? // epoch milliseconds
    }

    /// Read + freshness-check the signal file. Returns nil when absent,
    /// malformed, missing a meetingId, or stale.
    private func readSignal() -> Signal? {
        guard let data = try? Data(contentsOf: signalFile),
              let sig = try? JSONDecoder().decode(Signal.self, from: data),
              !sig.meetingId.isEmpty
        else { return nil }
        if let ms = sig.updatedAt {
            let ageSeconds = now().timeIntervalSince1970 - ms / 1000.0
            if ageSeconds > staleAfter { return nil }
        }
        return sig
    }

    /// Resolve the browser's main PID from its bundle id (defaults to Chrome).
    /// `DualSourceRecorder` expands this to the renderer/helper PIDs via the
    /// process tree, so the main PID is the correct anchor for the audio tap.
    private func browserPID(_ bundleId: String?) -> pid_t? {
        let id = (bundleId.map { $0.isEmpty ? nil : $0 } ?? nil) ?? "com.google.Chrome"
        return pidResolver(id)
    }

    func checkOnce() -> DetectedMeeting? {
        guard let sig = readSignal() else {
            // No live signal: clear cooldown so the next meeting triggers cleanly.
            cooldownMeetingId = nil
            return nil
        }
        // Already handled this meeting (file hasn't been cleared yet).
        if sig.meetingId == cooldownMeetingId { return nil }

        guard let pid = browserPID(sig.browserBundleId) else {
            PermissionHealthCheck.debugLog(
                "[ElectronSignalDetector] signal present (meeting=\(sig.meetingId)) but browser " +
                    "\(sig.browserBundleId ?? "com.google.Chrome") is not running — cannot record")
            return nil
        }

        recordingMeetingId = sig.meetingId
        let meeting = DetectedMeeting(
            pattern: .googleMeet,
            windowTitle: sig.title ?? sig.meetingId,
            ownerName: "Google Chrome",
            windowPID: pid,
        )
        PermissionHealthCheck.debugLog(
            "[ElectronSignalDetector] meeting=\(sig.meetingId) browserPID=\(pid) → start recording")
        logger.info("Electron signal: recording meeting \(sig.meetingId, privacy: .public)")
        return meeting
    }

    func isMeetingActive(_ meeting: DetectedMeeting) -> Bool {
        // Active only while a FRESH signal for the meeting we started still
        // exists. If we didn't start this meeting (another detector did),
        // defer — the composite treats a meeting as active if ANY detector
        // agrees, so returning false here never ends another detector's call.
        guard let id = recordingMeetingId else { return false }
        return readSignal()?.meetingId == id
    }

    func reset(appName: String? = nil) {
        // Suppress re-triggering the meeting we just finished until the file's
        // id changes or it disappears.
        cooldownMeetingId = recordingMeetingId ?? readSignal()?.meetingId
        recordingMeetingId = nil
    }
}
