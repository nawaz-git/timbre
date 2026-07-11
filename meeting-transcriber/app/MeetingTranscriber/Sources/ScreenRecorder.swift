// Sources/ScreenRecorder.swift
//
// Whole-display video capture via ScreenCaptureKit, feeding AVAssetWriter to an
// HEVC .mp4. Runs CONCURRENTLY with DualSourceRecorder's audio capture: SCK video
// frames come from the window-server compositor and never touch the CoreAudio
// CATap aggregate device (tools/audiotap/AppAudioCapture.swift), so there is no
// contention. SCK audio is explicitly disabled — the CATap is the audio source
// of record. Relies on the existing Screen Recording TCC grant the engine bundle
// (ai.nawaz.mintr-engine) already holds — the same grant DebugRPCServer uses for
// one-shot screenshots; this just streams continuously.

import AppKit

// @preconcurrency: AVFoundation/CoreMedia types (CMSampleBuffer, AVAssetWriter*)
// lack Sendable annotations — same gap guarded in DualSourceRecorder.swift.
@preconcurrency import AVFoundation
// CoreGraphics for the display-sleep / session-lock probes in resolveWindowState.
import CoreGraphics
import CoreMedia
import Foundation
import os.log

// @preconcurrency: SCStreamConfiguration/SCContentFilter aren't Sendable-annotated.
@preconcurrency import ScreenCaptureKit

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "ScreenRecorder")

/// Tunables for a screen-recording session. Size/privacy-first defaults
/// (5 fps, 1080p cap, HEVC). Hardcoded for v1; surface via AppSettings later.
struct ScreenRecorderConfig {
    var framesPerSecond: Int = 5
    var maxLongEdge: Int = 1080 // cap long side; 0 = display-native
    var useHEVC: Bool = true // HEVC hw-accelerated on Apple Silicon
    var showsCursor: Bool = true
    /// Target average bitrate. nil → derive from pixel count (see setupWriter()).
    var averageBitRate: Int?

    static let `default` = Self()
}

enum ScreenRecorderError: LocalizedError {
    case noDisplay
    case notRecording
    case writerSetupFailed(String)
    case noFramesCaptured

    var errorDescription: String? {
        switch self {
        case .noDisplay: "No capturable display found"
        case .notRecording: "Screen recorder is not running"
        case let .writerSetupFailed(r): "Failed to set up video writer: \(r)"
        case .noFramesCaptured: "No video frames were captured"
        }
    }
}

/// Records the whole MAIN display to an HEVC .mp4. Lifecycle mirrors
/// DualSourceRecorder: `try await start()` then `try await stop() -> URL`.
/// An `actor` (not @MainActor) so the per-frame append path never blocks the
/// @MainActor WatchLoop (frames arrive ~5/sec on SCK's private queue).
@available(macOS 14.0, *)
actor ScreenRecorder {
    /// Where to source the captured frames from. Stored on the actor so the
    /// watchdog `restartStream()` re-resolves the same scope without re-plumbing
    /// from `WatchLoop`. `.entireScreen` (the init default) preserves the
    /// historic whole-display behaviour for existing callers + tests.
    struct WindowHint {
        var scope: ScreenCaptureScope
        var pid: pid_t?
        var titleHint: String?
        var bundleId: String?

        init(
            scope: ScreenCaptureScope,
            pid: pid_t? = nil,
            titleHint: String? = nil,
            bundleId: String? = "com.google.Chrome",
        ) {
            self.scope = scope
            self.pid = pid
            self.titleHint = titleHint
            self.bundleId = bundleId
        }
    }

    /// Value-type projection of an `SCWindow`, so the window-selection logic
    /// (`pickWindow`) is pure and headless-testable without a live SCStream.
    struct WindowInfo {
        let id: CGWindowID?
        let pid: pid_t
        let title: String?
        let bundleId: String?
        let frameArea: CGFloat
    }

    private let config: ScreenRecorderConfig
    private let outputURL: URL
    private let windowHint: WindowHint

    private var stream: SCStream?
    private var output: FrameOutput?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?

    /// Real SCStreamDelegate so we OBSERVE a silent SCStream stop (the proven
    /// video defect: the stream stopped delivering after ~5 frames and, with
    /// `delegate: nil`, no `didStopWithError` was ever received — the recorder
    /// finalized a 0.98s file for a 13m+ meeting with zero log).
    private var observer: StreamObserver?
    /// Wall-clock of the last appended frame. The staleness watchdog restarts
    /// the stream if frames stop arriving while still recording — covers the
    /// case where frames silently stop WITHOUT a didStopWithError callback
    /// (display sleep/lock, content-filter change, queue backpressure).
    private var lastFrameWallClock = Date()
    private var restartAttempts = 0
    private var watchdogTask: Task<Void, Never>?
    /// Cached window-visibility verdict + when it was computed. The watchdog
    /// consults this at most once per `windowStateCacheSeconds`, so a stalled
    /// meeting can never trigger a full `SCShareableContent` enumeration on
    /// every tick (the enumeration is itself WindowServer pressure — the exact
    /// thing we're trying not to add to during a meeting).
    private var cachedWindowState: (state: WindowVisibility, at: Date)?

    private var sessionStarted = false
    private var frameCount = 0
    private(set) var isRecording = false

    /// - Parameter outputURL: where the .mp4 is written. Caller (WatchLoop) mints
    ///   the timestamped temp name `<ts>_screen.mp4` in AppPaths.recordingsDir,
    ///   parallel to the audio temp files DualSourceRecorder.start() creates;
    ///   PipelineQueue.copyAudioToOutput later renames it to `<slug>_screen.mp4`.
    init(
        outputURL: URL,
        config: ScreenRecorderConfig = .default,
        windowHint: WindowHint = WindowHint(scope: .entireScreen),
    ) {
        self.outputURL = outputURL
        self.config = config
        self.windowHint = windowHint
    }

    // MARK: - Start

    func start() async throws {
        guard !isRecording else { return }

        // 1-3. Pick the display, resolve the capture filter (window vs
        //      full-display fallback), and build the video-only stream config.
        let resolved = try await resolveStream(restart: false)
        let (filter, scConfig, outW, outH) = (
            resolved.filter, resolved.config, resolved.width, resolved.height,
        )

        // 4. AVAssetWriter → HEVC (HW on Apple Silicon) or H.264 fallback.
        try setupWriter(width: outW, height: outH)

        // 5. SCStream + delegate. Frames are delivered on the delegate's own
        //    queue; the delegate hops each one into this actor. The buffer is
        //    wrapped in `SampleBufferBox` so it crosses the actor hop without
        //    tripping Swift 6's `sending` check — CMSampleBuffer is a CF type
        //    (ref-counted, retained by the box capture) and is only read on the
        //    actor after the hop, never concurrently with the delegate queue.
        let out = FrameOutput { [weak self] box in
            guard let self else { return }
            Task { await self.appendVideo(box.buffer) }
        }
        // Real delegate: hop a didStopWithError into the actor so a silent
        // stream stop is no longer invisible.
        let obs = StreamObserver { [weak self] err in
            Task { await self?.handleStreamStopped(err) }
        }
        let stream = SCStream(filter: filter, configuration: scConfig, delegate: obs)
        try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: out.frameQueue)
        try await stream.startCapture()

        self.stream = stream
        output = out
        observer = obs
        lastFrameWallClock = Date()
        isRecording = true
        logger.info(
            "Screen recording started: \(outW)x\(outH) @ \(self.config.framesPerSecond)fps -> \(self.outputURL.lastPathComponent)",
        )

        // Frame-staleness watchdog: if frames stop arriving while still
        // recording, restart the stream. Essential because the observed symptom
        // (frames silently stopping) does NOT fire didStopWithError.
        startWatchdog()
    }

    private func setupWriter(width: Int, height: Int) throws {
        try? FileManager.default.removeItem(at: outputURL)
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw ScreenRecorderError.writerSetupFailed(error.localizedDescription)
        }
        // faststart: front-load the moov atom so `<video>` Range-seeks before the
        // file is fully read (Electron mt-audio:// 206 streaming relies on it).
        writer.shouldOptimizeForNetworkUse = true

        let codec: AVVideoCodecType = config.useHEVC ? .hevc : .h264
        // ~0.07 bits/pixel/frame is plenty for mostly-static screen-share; floor 800k.
        let bitrate = config.averageBitRate
            ?? max(800_000, Int(Double(width * height * config.framesPerSecond) * 0.07))

        let settings: [String: Any] = [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoMaxKeyFrameIntervalKey: max(config.framesPerSecond, 1) * 5,
                AVVideoExpectedSourceFrameRateKey: config.framesPerSecond,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw ScreenRecorderError.writerSetupFailed("writer cannot add video input")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw ScreenRecorderError.writerSetupFailed(
                writer.error?.localizedDescription ?? "startWriting returned false",
            )
        }
        self.writer = writer
        videoInput = input
    }

    // MARK: - Per-frame append (actor-isolated)

    private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        guard isRecording, let writer, let videoInput else { return }
        guard CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard writer.status == .writing else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }
        if videoInput.isReadyForMoreMediaData {
            videoInput.append(sampleBuffer)
            frameCount += 1
            lastFrameWallClock = Date()
            // A live frame proves the stream recovered — reset the
            // consecutive-failure counter so the cap bounds consecutive stalls,
            // not lifetime restarts (see attemptsAfterFrameAppended).
            restartAttempts = Self.attemptsAfterFrameAppended(restartAttempts)
        } // else: drop frame (back-pressure). Fine — no A/V sync to maintain.
    }

    // MARK: - Stop

    @discardableResult
    func stop() async throws -> URL {
        guard isRecording else { throw ScreenRecorderError.notRecording }
        // Cancel the watchdog FIRST so it observes isRecording=false and never
        // races a restart against teardown.
        watchdogTask?.cancel()
        watchdogTask = nil
        isRecording = false

        // Stop the stream BEFORE finishing the writer so no late frame appends
        // after markAsFinished() and faults the writer. Bounded: a wedged
        // stopCapture must never hang meeting finalization (WatchLoop awaits
        // this) — past the deadline we drop the stream and finalize anyway.
        if stream != nil {
            let outcome = await raceAgainstDeadline(seconds: Self.stopCaptureDeadline) { [weak self] in
                await self?.stopStreamCapture()
            }
            if outcome == .timedOut {
                PermissionHealthCheck.debugLog(
                    "[ScreenRecorder] stopCapture exceeded \(Int(Self.stopCaptureDeadline))s — "
                        + "dropping stream and finalizing anyway",
                )
            }
        }
        stream = nil
        output = nil
        observer = nil

        guard let writer, let videoInput else { throw ScreenRecorderError.notRecording }
        videoInput.markAsFinished()
        await writer.finishWriting()

        let finalStatus = writer.status
        let finalError = writer.error
        self.writer = nil
        self.videoInput = nil

        if finalStatus == .failed {
            throw ScreenRecorderError.writerSetupFailed(
                finalError?.localizedDescription ?? "finishWriting failed",
            )
        }
        guard frameCount > 0 else {
            try? FileManager.default.removeItem(at: outputURL)
            throw ScreenRecorderError.noFramesCaptured
        }
        logger.info(
            "Screen recording saved: \(self.outputURL.lastPathComponent) (\(self.frameCount) frames)",
        )
        return outputURL
    }

    /// Liveness snapshot for the engine heartbeat: the wall-clock of the
    /// last appended frame and the current consecutive-restart count. Actor-
    /// isolated so `lastFrameWallClock` / `restartAttempts` are never read
    /// off-actor (the actor-isolation contract). Returns nil only for symmetry with
    /// the `ScreenRecording` protocol default — the concrete recorder always has
    /// values.
    func sckLiveness() -> (lastFrameAt: Date, restartAttempts: Int)? {
        (lastFrameWallClock, restartAttempts)
    }

    // MARK: - Restart / watchdog

    /// Maximum stream-restart attempts before giving up and finalizing whatever
    /// was captured. Bounds runaway restart loops.
    private static let maxRestartAttempts = 5
    /// Seconds without an appended frame (while recording) that the watchdog
    /// treats as a stall worth restarting the stream for.
    private static let stallThreshold: Double = 3.0
    /// How long a computed `WindowVisibility` verdict is reused before the
    /// watchdog re-enumerates. Matched to the 5 s watchdog tick so there is at
    /// most one `SCShareableContent` enumeration per tick.
    private static let windowStateCacheSeconds: Double = 5.0
    /// Hard deadline for a single `SCStream.stopCapture()` await. SCK teardown
    /// can wedge when the WindowServer/coreaudiod is distressed; past this the
    /// stream reference is dropped and finalization proceeds so the meeting
    /// pipeline (`WatchLoop.handleMeeting`) can never hang on it. The OS
    /// reclaims the abandoned stream on process exit.
    private static let stopCaptureDeadline: Double = 5.0

    /// Where the captured target is, as far as frame delivery is concerned.
    /// Drives `watchdogVerdict`: SCK pauses delivery for a minimized window or a
    /// locked/asleep display BY DESIGN, so those are benign, not stalls.
    enum WindowVisibility: Equatable, Sendable {
        /// Target window is on-screen (or, for full-display scope, the display
        /// is awake and unlocked) — frames should be flowing.
        case visible
        /// Window-scoped capture whose target window is minimized/off-screen —
        /// SCK pauses delivery until it is restored.
        case minimized
        /// The captured window no longer exists (closed / moved off all spaces).
        case gone
        /// The display is asleep or the session is locked — all capture pauses.
        case displayLockedOrAsleep
        /// Visibility could not be determined (enumeration failed); treat as a
        /// possible genuine stall so recovery is not silently disabled.
        case unknown
    }

    /// What the watchdog should do about a stale frame gap, given the window
    /// state. Keeps the (freeze-relevant) "is this a real stall or an expected
    /// pause?" decision pure and headless-testable.
    enum WatchdogVerdict: Equatable, Sendable {
        /// Do nothing — either frames are fresh or the pause is expected
        /// (minimized window / locked-or-asleep display). Preserves the stream
        /// so delivery resumes on restore without a rebuild.
        case wait
        /// Genuine stall on a visible target — tear down and rebuild the stream.
        case restart
        /// The captured window is gone — rebuild against the display fallback.
        case fallbackToDisplay
        /// Consecutive-failure cap reached — stop retrying, finalize what exists.
        case giveUp
    }

    /// Pure, pause-aware watchdog decision. Extends `shouldRestart` with window
    /// state so an EXPECTED SCK pause (minimized window, locked/asleep display)
    /// no longer misfires a stream rebuild — the churn documented as the
    /// window-capture restart loop. Only a stale gap on a genuinely visible
    /// target restarts; a vanished window falls back to display capture; both
    /// are bounded by the consecutive-attempt cap.
    nonisolated static func watchdogVerdict(
        isRecording: Bool,
        secondsSinceLastFrame: Double,
        attemptsSoFar: Int,
        maxAttempts: Int,
        stallThreshold: Double,
        windowState: WindowVisibility,
    ) -> WatchdogVerdict {
        // Teardown in progress, or frames still arriving → nothing to do.
        guard isRecording, secondsSinceLastFrame >= stallThreshold else { return .wait }

        switch windowState {
        case .minimized, .displayLockedOrAsleep:
            // SCK stops delivering frames for a minimized window or a
            // locked/asleep display by design. The gap is EXPECTED — waiting
            // keeps the stream alive so it resumes on restore, instead of
            // hammering WindowServer with a rebuild that changes nothing.
            return .wait
        case .gone:
            // The target window vanished — re-resolving it will fail forever,
            // so switch to the whole-display fallback (bounded by the cap).
            return attemptsSoFar < maxAttempts ? .fallbackToDisplay : .giveUp
        case .visible, .unknown:
            // Visible-and-stale is a real stall. `.unknown` (enumeration
            // failed) is treated the same so a flaky lookup can't silently
            // disable recovery; the cap + backoff bound any resulting churn.
            return attemptsSoFar < maxAttempts ? .restart : .giveUp
        }
    }

    /// Exponential backoff (seconds) before the Nth CONSECUTIVE restart:
    /// 1, 2, 4, 8, 16, then clamped at 16. `consecutiveAttempts` is 1-based
    /// (the attempt about to run). Replaces the old flat 1 s sleep so a display
    /// that stays unavailable is retried with widening gaps, not a tight loop.
    nonisolated static func restartBackoff(consecutiveAttempts: Int) -> Double {
        guard consecutiveAttempts > 1 else { return 1.0 }
        return Double(min(16, 1 << min(consecutiveAttempts - 1, 4)))
    }

    /// The `restartAttempts` value after a frame is successfully appended: a
    /// live frame proves the stream recovered, so the consecutive-failure
    /// counter resets. This makes the cap bound CONSECUTIVE failures, not
    /// lifetime restarts — a long meeting with occasional pauses can't exhaust
    /// it. Pure so the reset invariant is unit-pinned.
    nonisolated static func attemptsAfterFrameAppended(_ current: Int) -> Int {
        current > 0 ? 0 : current
    }

    /// Pure decision boundary for restart, extracted so it is headless-testable
    /// without live ScreenCaptureKit frames. Restart only while still recording,
    /// under the attempt cap, and once the gap reaches the stall threshold.
    nonisolated static func shouldRestart(
        isRecording: Bool,
        secondsSinceLastFrame: Double,
        attemptsSoFar: Int,
        maxAttempts: Int,
        stallThreshold: Double,
    ) -> Bool {
        isRecording && attemptsSoFar < maxAttempts && secondsSinceLastFrame >= stallThreshold
    }

    /// Invoked from the SCStreamDelegate when the stream stops with an error.
    /// A didStopWithError means the stream is gone for certain, so restart
    /// immediately (stall threshold 0) as long as we're still recording and
    /// under the attempt cap.
    private func handleStreamStopped(_ error: (any Error)?) async {
        guard Self.shouldRestart(
            isRecording: isRecording,
            secondsSinceLastFrame: .greatestFiniteMagnitude,
            attemptsSoFar: restartAttempts,
            maxAttempts: Self.maxRestartAttempts,
            stallThreshold: 0,
        ) else {
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] stream stopped but not restarting "
                    + "(isRecording=\(isRecording) attempts=\(restartAttempts))",
            )
            return
        }
        restartAttempts += 1
        PermissionHealthCheck.debugLog(
            "[ScreenRecorder] restarting after stream stop (attempt \(restartAttempts)/\(Self.maxRestartAttempts)), error=\(String(describing: error))",
        )
        await restartStream()
    }

    /// Tear down ONLY the old SCStream and rebuild a fresh one, REUSING the same
    /// AVAssetWriter/videoInput/sessionStarted so appendVideo keeps appending to
    /// the same file with monotonic PTS. A screen-recording restart never
    /// touches the audio path (the CATap is independent), preserving the
    /// audio-isolation guarantee.
    private func restartStream() async {
        // Exponential backoff (1/2/4/8/16 s) keyed to the consecutive-attempt
        // count so we don't hot-loop against a display that is still
        // unavailable (sleep/lock). `restartAttempts` was already incremented
        // by the caller, so it is the 1-based number of this attempt.
        let backoff = Self.restartBackoff(consecutiveAttempts: restartAttempts)
        try? await Task.sleep(for: .seconds(backoff))
        guard isRecording else { return }

        // Tear down the old stream only — keep writer/videoInput/sessionStarted.
        // Bounded so a wedged stopCapture can't hang the watchdog task.
        if stream != nil {
            let outcome = await raceAgainstDeadline(seconds: Self.stopCaptureDeadline) { [weak self] in
                await self?.stopStreamCapture()
            }
            if outcome == .timedOut {
                PermissionHealthCheck.debugLog(
                    "[ScreenRecorder] restart: stopCapture exceeded \(Int(Self.stopCaptureDeadline))s — "
                        + "rebuilding over the abandoned stream",
                )
            }
        }
        stream = nil
        observer = nil

        do {
            // Re-resolve the SAME window-scope decision so the watchdog never
            // silently reverts to whole-display capture; fall back gracefully.
            let resolved = try await resolveStream(restart: true)
            let (filter, scConfig, outW, outH) = (
                resolved.filter, resolved.config, resolved.width, resolved.height,
            )

            // Re-add the SAME FrameOutput so frames feed back into appendVideo,
            // which keeps writing to the existing writer/videoInput.
            let out = output ?? FrameOutput { [weak self] box in
                guard let self else { return }
                Task { await self.appendVideo(box.buffer) }
            }
            let obs = StreamObserver { [weak self] err in
                Task { await self?.handleStreamStopped(err) }
            }
            let newStream = SCStream(filter: filter, configuration: scConfig, delegate: obs)
            try newStream.addStreamOutput(out, type: .screen, sampleHandlerQueue: out.frameQueue)
            try await newStream.startCapture()

            stream = newStream
            output = out
            observer = obs
            lastFrameWallClock = Date()
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] stream restarted (\(outW)x\(outH)); writer reused, frameCount=\(frameCount)",
            )
        } catch {
            // Leave isRecording true so the watchdog can retry later (up to cap).
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] stream restart FAILED: \(error)",
            )
        }
    }

    /// Periodic loop that restarts the stream when frames go stale while still
    /// recording. Cancelled in stop().
    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            while let self, await self.isRecording {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                await self.watchdogTick()
            }
        }
    }

    /// One watchdog evaluation — act on a stale frame gap, but only after
    /// ruling out an EXPECTED SCK pause (minimized window / locked-or-asleep
    /// display / vanished window) via `watchdogVerdict`.
    private func watchdogTick() async {
        let gap = Date().timeIntervalSince(lastFrameWallClock)
        // Cheap pre-gate: fresh frames need no window enumeration at all.
        guard isRecording, gap >= Self.stallThreshold else { return }

        let windowState = await currentWindowState()
        // isRecording may have flipped while we awaited the enumeration.
        guard isRecording else { return }

        let verdict = Self.watchdogVerdict(
            isRecording: isRecording,
            secondsSinceLastFrame: gap,
            attemptsSoFar: restartAttempts,
            maxAttempts: Self.maxRestartAttempts,
            stallThreshold: Self.stallThreshold,
            windowState: windowState,
        )
        switch verdict {
        case .wait:
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] frame gap \(Int(gap))s but windowState=\(windowState) — "
                    + "expected pause, not restarting",
            )
        case .restart:
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] frame stall \(Int(gap))s (windowState=\(windowState)) — "
                    + "restarting (attempt \(restartAttempts + 1)/\(Self.maxRestartAttempts))",
            )
            restartAttempts += 1
            await restartStream()
        case .fallbackToDisplay:
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] captured window gone — display fallback "
                    + "(attempt \(restartAttempts + 1)/\(Self.maxRestartAttempts))",
            )
            restartAttempts += 1
            await restartStream() // resolveStream re-resolves; no window → display filter
        case .giveUp:
            PermissionHealthCheck.debugLog(
                "[ScreenRecorder] frame stall \(Int(gap))s but restart cap reached "
                    + "(\(restartAttempts)/\(Self.maxRestartAttempts)) — leaving stream as-is",
            )
        }
    }

    /// Await the current SCStream's `stopCapture()` on the actor. Split out so
    /// `stop()`/`restartStream()` can race it against `stopCaptureDeadline` via
    /// `raceAgainstDeadline` WITHOUT the non-Sendable `SCStream` escaping actor
    /// isolation (the deadline task only captures `self`).
    private func stopStreamCapture() async {
        try? await stream?.stopCapture()
    }

    /// Cached window-visibility lookup — at most one `SCShareableContent`
    /// enumeration per `windowStateCacheSeconds` so the watchdog never adds
    /// per-tick WindowServer pressure during a stalled meeting.
    private func currentWindowState() async -> WindowVisibility {
        if let cached = cachedWindowState,
           Date().timeIntervalSince(cached.at) < Self.windowStateCacheSeconds {
            return cached.state
        }
        let state = await resolveWindowState()
        cachedWindowState = (state, Date())
        return state
    }

    /// Live (impure) window-visibility probe. Order matters: a locked/asleep
    /// display pauses ALL capture regardless of scope, so it is checked first.
    /// Full-display scope never pauses on a window minimize (no single target),
    /// so an awake, unlocked full-display gap is a genuine stall. Window scope
    /// distinguishes minimized (off-screen) from gone (not enumerated at all).
    private func resolveWindowState() async -> WindowVisibility {
        if Self.displayIsLockedOrAsleep() { return .displayLockedOrAsleep }
        guard windowHint.scope == .chromeWindow else { return .visible }

        guard let content = try? await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false,
        ) else {
            // Couldn't enumerate → don't silently disable recovery.
            return .unknown
        }
        let candidates: [WindowInfo] = content.windows.map { win in
            WindowInfo(
                id: win.windowID,
                pid: win.owningApplication?.processID ?? -1,
                title: win.title,
                bundleId: win.owningApplication?.bundleIdentifier,
                frameArea: win.frame.width * win.frame.height,
            )
        }
        guard let chosen = Self.pickWindow(
            candidates: candidates,
            pid: windowHint.pid,
            titleHint: windowHint.titleHint,
            bundleId: windowHint.bundleId,
        ),
            let scWindow = content.windows.first(where: { $0.windowID == chosen.id })
        else {
            return .gone
        }
        return scWindow.isOnScreen ? .visible : .minimized
    }

    /// True when the main display is asleep or the session is locked — both
    /// pause SCK frame delivery by design. `CGSessionCopyCurrentDictionary`'s
    /// `CGSSessionScreenIsLocked` is the standard lock signal; the engine is the
    /// non-sandboxed helper, so neither call is entitlement-restricted.
    nonisolated static func displayIsLockedOrAsleep() -> Bool {
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { return true }
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
           let locked = session["CGSSessionScreenIsLocked"] as? Int, locked == 1 {
            return true
        }
        return false
    }

    // MARK: - Window selection

    /// Pure, headless-testable window picker. Match priority:
    ///   1. PID match AND title contains `titleHint`
    ///   2. PID match (any title)
    ///   3. bundleId match
    /// Within each tier, ties break by largest `frameArea`. Returns nil when no
    /// candidate matches — the caller then falls back to whole-display capture.
    nonisolated static func pickWindow(
        candidates: [WindowInfo],
        pid: pid_t?,
        titleHint: String?,
        bundleId: String?,
    ) -> WindowInfo? {
        // Largest-area first within each filtered tier.
        func largest(_ ws: [WindowInfo]) -> WindowInfo? {
            ws.max { $0.frameArea < $1.frameArea }
        }

        if let pid {
            let pidMatches = candidates.filter { $0.pid == pid }
            if let hint = titleHint, !hint.isEmpty {
                let titled = pidMatches.filter { candidate in
                    (candidate.title?.localizedCaseInsensitiveContains(hint)) == true
                }
                if let win = largest(titled) { return win }
            }
            if let win = largest(pidMatches) { return win }
        }

        if let bundleId, !bundleId.isEmpty {
            let bundleMatches = candidates.filter { $0.bundleId == bundleId }
            if let win = largest(bundleMatches) { return win }
        }

        return nil
    }

    /// Fetch shareable content, pick the display, resolve the capture filter
    /// (single window when `windowHint.scope == .chromeWindow`, else the whole
    /// display — and the same full-display FALLBACK when no window resolves),
    /// and build the video-only `SCStreamConfiguration`. Shared by `start()` and
    /// `restartStream()` so the scope decision and stream config can't drift
    /// between the initial start and a watchdog restart. `restart` only varies
    /// the fallback debug-log wording.
    private func resolveStream(
        restart: Bool,
    ) async throws -> (filter: SCContentFilter, config: SCStreamConfiguration, width: Int, height: Int) {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false,
        )
        guard let display = content.displays.first(where: { d in
            d.displayID == CGMainDisplayID()
        }) ?? content.displays.first else {
            throw ScreenRecorderError.noDisplay
        }

        let scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let displayW = Int(CGFloat(display.width) * scale)
        let displayH = Int(CGFloat(display.height) * scale)

        let filter: SCContentFilter
        let outW: Int
        let outH: Int
        if let win = buildFilter(from: content, scale: scale) {
            filter = win.filter
            outW = win.width
            outH = win.height
        } else {
            if windowHint.scope == .chromeWindow {
                PermissionHealthCheck.debugLog(
                    restart
                        ? "[ScreenRecorder] restart: no Chrome window resolved — full-display fallback"
                        : "[ScreenRecorder] window scope requested but no Chrome window resolved — "
                        + "falling back to full display",
                )
            }
            (outW, outH) = Self.fit(
                width: displayW, height: displayH, maxLongEdge: config.maxLongEdge,
            )
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        // VIDEO ONLY; audio explicitly off so we never contend with the CATap
        // (tools/audiotap/AppAudioCapture.swift).
        let scConfig = SCStreamConfiguration()
        scConfig.width = outW
        scConfig.height = outH
        scConfig.minimumFrameInterval = CMTime(
            value: 1, timescale: CMTimeScale(max(config.framesPerSecond, 1)),
        )
        scConfig.queueDepth = 6
        scConfig.showsCursor = config.showsCursor
        scConfig.capturesAudio = false // audio stays on the CATap
        scConfig.pixelFormat = kCVPixelFormatType_32BGRA
        scConfig.colorSpaceName = CGColorSpace.sRGB

        return (filter, scConfig, outW, outH)
    }

    /// Build a single-window content filter from the live shareable content,
    /// honouring `windowHint`. Returns nil when scope is `.entireScreen` OR when
    /// no matching window resolves — in both cases the caller uses the display
    /// filter. The returned size is the window's frame scaled to backing pixels
    /// then capped via `fit()`.
    private func buildFilter(
        from content: SCShareableContent, scale: CGFloat,
    ) -> (filter: SCContentFilter, width: Int, height: Int)? {
        guard windowHint.scope == .chromeWindow else { return nil }

        let candidates: [WindowInfo] = content.windows.map { win in
            WindowInfo(
                id: win.windowID,
                pid: win.owningApplication?.processID ?? -1,
                title: win.title,
                bundleId: win.owningApplication?.bundleIdentifier,
                frameArea: win.frame.width * win.frame.height,
            )
        }
        guard let chosen = Self.pickWindow(
            candidates: candidates,
            pid: windowHint.pid,
            titleHint: windowHint.titleHint,
            bundleId: windowHint.bundleId,
        ),
            let scWindow = content.windows.first(where: { $0.windowID == chosen.id })
        else {
            return nil
        }

        let nativeW = Int(scWindow.frame.width * scale)
        let nativeH = Int(scWindow.frame.height * scale)
        let (outW, outH) = Self.fit(
            width: nativeW, height: nativeH, maxLongEdge: config.maxLongEdge,
        )
        let filter = SCContentFilter(desktopIndependentWindow: scWindow)
        return (filter, outW, outH)
    }

    // MARK: - Helpers

    /// Scale (w,h) down so the long edge <= maxLongEdge, preserving aspect and
    /// keeping both dims even (HEVC requires even dimensions). 0 = no cap.
    nonisolated static func fit(width: Int, height: Int, maxLongEdge: Int) -> (Int, Int) {
        guard maxLongEdge > 0 else { return (even(width), even(height)) }
        let longEdge = max(width, height)
        guard longEdge > maxLongEdge else { return (even(width), even(height)) }
        let ratio = Double(maxLongEdge) / Double(longEdge)
        return (even(Int(Double(width) * ratio)), even(Int(Double(height) * ratio)))
    }

    nonisolated static func even(_ v: Int) -> Int {
        max(2, v - (v % 2))
    }
}

/// SCStreamOutput delegate. Lives outside the actor because SCK delivers frames
/// on its own dispatch queue; forwards each CMSampleBuffer to the actor via the
/// injected closure. `@unchecked Sendable` because the only stored state is the
/// immutable closure + queue (same manual-serialization rationale as
/// AppAudioCapture's `@unchecked Sendable`).
@available(macOS 14.0, *)
final class FrameOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let frameQueue = DispatchQueue(label: "screenrecorder.frames", qos: .userInitiated)
    private let onFrame: @Sendable (SampleBufferBox) -> Void

    init(onFrame: @escaping @Sendable (SampleBufferBox) -> Void) {
        self.onFrame = onFrame
    }

    func stream(
        _: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType,
    ) {
        guard type == .screen else { return }
        // Only forward .complete frames; skip .idle/.blank/.suspended so idle
        // screens cost nothing. Status lives in the sample attachments.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false,
        ) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw),
            status == .complete else { return }
        onFrame(SampleBufferBox(sampleBuffer))
    }
}

/// SCStreamDelegate that forwards a `didStopWithError` into the ScreenRecorder
/// actor via an injected closure. Created with `delegate: obs` (was `nil`) so a
/// silent stream stop is observable. `@unchecked Sendable` because the only
/// stored state is the immutable `@Sendable` closure — same manual-serialization
/// rationale as `FrameOutput`.
@available(macOS 14.0, *)
final class StreamObserver: NSObject, SCStreamDelegate, @unchecked Sendable {
    private let onStop: @Sendable ((any Error)?) -> Void

    init(onStop: @escaping @Sendable ((any Error)?) -> Void) {
        self.onStop = onStop
    }

    func stream(_: SCStream, didStopWithError error: any Error) {
        PermissionHealthCheck.debugLog("[ScreenRecorder] stream STOPPED: \(error)")
        onStop(error)
    }
}

/// `@unchecked Sendable` envelope for a `CMSampleBuffer` so it can cross the
/// delegate-queue → actor hop without tripping Swift 6 strict-concurrency's
/// `sending` diagnostic. `CMSampleBuffer` is a CoreFoundation type (no Sendable
/// conformance) but is reference-counted; capturing it here retains it across
/// the hop. Ownership is transferred — the box is consumed exactly once on the
/// actor and the delegate queue never touches the buffer again — so there is no
/// concurrent access. Same manual-serialization rationale as `FrameOutput`.
@available(macOS 14.0, *)
struct SampleBufferBox: @unchecked Sendable {
    let buffer: CMSampleBuffer
    init(_ buffer: CMSampleBuffer) {
        self.buffer = buffer
    }
}
