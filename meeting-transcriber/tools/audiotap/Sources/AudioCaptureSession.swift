import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "AudioCaptureSession")

/// Orchestrates app audio capture + optional mic recording.
/// Replaces the CLI entry point — call `start()` and `stop()` directly from the host app.
@available(macOS 14.2, *)
public class AudioCaptureSession {
    private let pids: [pid_t]
    private let sampleRate: Int
    private let channels: Int
    private let appOutputURL: URL
    private let micOutputURL: URL?
    private let micDeviceUID: String?
    private let debugLogging: Bool
    private let appLiveSink: LiveAudioSink?
    private let micLiveSink: LiveAudioSink?
    /// When false, the session records the microphone only — it creates NO
    /// CoreAudio process tap or aggregate device (the `disableAppAudioTap`
    /// kill switch). No IOProc runs, so the tap-health watchdog and the
    /// heartbeat's `lastIOCallbackAt` stay dormant.
    private let captureAppAudio: Bool

    /// One serial queue shared by the tap and the mic engine so their lifecycle
    /// operations (start, stop, device-change rebuilds) serialize with each other
    /// and never churn CoreAudio concurrently during a Bluetooth storm.
    private let captureControl = DispatchQueue(label: "audiotap.control", qos: .userInitiated)

    private var appCapture: AppAudioCapture?
    private var micCapture: MicCaptureHandler?
    private var appFileHandle: FileHandle?

    /// Latches on the first `stop()` so a second call is a no-op that returns the
    /// same result — a double `stop()` would otherwise double-destroy the tap +
    /// aggregate device in coreaudiod. Paired with the `deinit` backstop, no code
    /// path can drop a live tap or tear one down twice.
    private var isStopped = false
    private var stopResult: AudioCaptureResult?

    /// - Parameter pids: PIDs to capture audio from. For Electron/WebView2
    ///   apps (Teams 2.x, Slack, Discord) this should include the root PID
    ///   plus helper/renderer children; for native Cocoa apps a
    ///   single-element array is fine.
    /// - Parameter appLiveSink: Optional real-time buffer callback for the app
    ///   audio track (CATap output, interleaved Float32 at the tap's native
    ///   rate, typically 48 kHz). Called from the IOProc thread — non-blocking.
    /// - Parameter micLiveSink: Optional real-time buffer callback for the mic
    ///   track (mono Float32 at file rate, typically 16 kHz post-resample).
    ///   Called from the AVAudioEngine tap thread — non-blocking.
    /// - Parameter captureAppAudio: When false, skip the app-audio process tap
    ///   entirely and record the microphone only (the `disableAppAudioTap` kill
    ///   switch). Defaults to true (normal dual-source capture).
    public init(
        pids: [pid_t],
        appOutputURL: URL,
        sampleRate: Int = 48000,
        channels: Int = 2,
        micOutputURL: URL? = nil,
        micDeviceUID: String? = nil,
        debugLogging: Bool = false,
        appLiveSink: LiveAudioSink? = nil,
        micLiveSink: LiveAudioSink? = nil,
        captureAppAudio: Bool = true,
    ) {
        self.pids = pids
        self.sampleRate = sampleRate
        self.channels = channels
        self.appOutputURL = appOutputURL
        self.micOutputURL = micOutputURL
        self.micDeviceUID = micDeviceUID
        self.debugLogging = debugLogging
        self.appLiveSink = appLiveSink
        self.micLiveSink = micLiveSink
        self.captureAppAudio = captureAppAudio
    }

    /// Start capturing app audio (and optionally mic audio).
    public func start() throws {
        // App-audio process tap. Skipped entirely in mic-only mode
        // (`captureAppAudio == false`, the kill switch): no output file, no
        // aggregate device, no process tap, no IOProc — the mic below is the
        // sole source. `startedAppCapture` is nil in that mode so the watchdog
        // wiring is skipped too.
        var startedAppCapture: AppAudioCapture?
        if captureAppAudio {
            // Create app output file and get its file descriptor
            // Restrict permissions to owner-only (0600) — audio may contain sensitive meeting content
            FileManager.default.createFile(
                atPath: appOutputURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600],
            )
            let handle = try FileHandle(forWritingTo: appOutputURL)

            let capture = AppAudioCapture(
                pids: pids,
                outputFileDescriptor: handle.fileDescriptor,
                sampleRate: sampleRate,
                channels: channels,
                debugLogging: debugLogging,
                liveSink: appLiveSink,
                captureControl: captureControl,
            )
            do {
                try capture.start()
            } catch {
                try? handle.close()
                throw error
            }
            appFileHandle = handle
            appCapture = capture
            startedAppCapture = capture
        }

        // Start mic capture if requested
        if let micURL = micOutputURL {
            let mic = MicCaptureHandler(
                outputURL: micURL,
                debugLogging: debugLogging,
                liveSink: micLiveSink,
                captureControl: captureControl,
            )
            do {
                try mic.start(deviceUID: micDeviceUID)
                micCapture = mic
                // Give the app tap's health watchdog a mic-liveness reference so
                // its all-zero rebuild only fires when the meeting isn't simply
                // silent (the asymmetry guard). Only meaningful when there IS an
                // app tap — in mic-only mode there is no watchdog to feed.
                startedAppCapture?.setPeerActivityProvider { [weak mic] in
                    (mic?.currentLevelDBFS ?? -120) > CaptureTuning.micSilenceFloorDBFS
                }
            } catch {
                if captureAppAudio {
                    logger.error("Failed to start mic capture: \(error). Continuing with app audio only.")
                } else {
                    logger.error("Failed to start mic capture in mic-only mode: \(error). Recording will have no audio.")
                }
            }
        }

        logger.info("Capture session started (appTap: \(self.captureAppAudio), PIDs \(self.pids), rate: \(self.sampleRate), channels: \(self.channels))")
    }

    /// Instantaneous app-audio level in dBFS, decayed to -120 when no buffer has
    /// arrived in the last 0.5 s. Drives the menu-bar asymmetric-silence indicator.
    public var appLevelDBFS: Double {
        appCapture?.currentLevelDBFS ?? -120
    }

    /// Instantaneous mic level in dBFS, decayed to -120 when no buffer has arrived
    /// in the last 0.5 s. Drives the menu-bar asymmetric-silence indicator.
    public var micLevelDBFS: Double {
        micCapture?.currentLevelDBFS ?? -120
    }

    /// Wall-clock of the most recent app-tap IOProc callback, or nil when the tap
    /// has never delivered a buffer. Sourced by the engine heartbeat.
    public var lastIOCallbackAt: Date? {
        appCapture?.lastIOCallbackAt
    }

    /// Number of PIDs in the live app tap set (post audio-active filter).
    public var tapPIDCount: Int {
        appCapture?.tapPIDCount ?? 0
    }

    /// Stop all capture and return the result. Idempotent — safe to call more
    /// than once (e.g. an explicit stop() followed by a teardown path); the
    /// second call returns the cached result without touching CoreAudio again.
    public func stop() -> AudioCaptureResult {
        if isStopped, let stopResult { return stopResult }
        isStopped = true

        appCapture?.stop()
        micCapture?.stop()

        // Compute mic delay
        var micDelay: TimeInterval = 0
        if let app = appCapture, let mic = micCapture {
            let appTime = app.appFirstFrameTime
            let micTime = mic.firstFrameTime
            if appTime > 0 && micTime > 0 {
                micDelay = machTicksToSeconds(micTime) - machTicksToSeconds(appTime)
            }
        }

        let actualRate = appCapture?.actualSampleRate ?? 0
        let actualChannels = appCapture?.actualChannels ?? 0

        // Close the session's own descriptor. `appCapture?.stop()` above already ran
        // the writer's bounded `flushAndClose`; even if that timed out and left the
        // drain thread stalled, the writer holds a private `dup()` of this fd and is
        // its sole closer, so closing OURS here can never strand that thread on a
        // reused descriptor. Safe regardless of the writer's teardown outcome.
        try? appFileHandle?.close()
        appFileHandle = nil

        let result = AudioCaptureResult(
            appAudioFileURL: appOutputURL,
            micAudioFileURL: micCapture != nil ? micOutputURL : nil,
            actualSampleRate: actualRate > 0 ? actualRate : sampleRate,
            actualChannels: actualChannels > 0 ? actualChannels : channels,
            micDelay: micDelay,
        )

        appCapture = nil
        micCapture = nil
        stopResult = result

        logger.info("Capture session stopped (rate: \(result.actualSampleRate), channels: \(result.actualChannels), micDelay: \(result.micDelay))")
        return result
    }

    /// Debug-visible, release-safe backstop. If the session is deallocated while
    /// a capture is still live — i.e. `stop()` was never called — a process tap
    /// + aggregate device would leak inside coreaudiod (exactly the lifecycle
    /// stress this capture path is hardened against). Trap in debug so the
    /// offending path is caught in tests/dev, and best-effort stop in every
    /// build so production can never drop a running tap.
    deinit {
        // `micCapture` is checked too so a leaked mic-only session (kill-switch
        // mode, no `appCapture`) is still caught + stopped rather than dropping
        // a live AVAudioEngine tap.
        if appCapture != nil || micCapture != nil {
            assertionFailure("AudioCaptureSession deallocated with a live capture — stop() was never called")
            appCapture?.stop()
            micCapture?.stop()
        }
    }
}
