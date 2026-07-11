import Atomics
import CoreAudio
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "AppAudioCapture")
private let healthLogger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "TapHealth")

/// Tap lifecycle triggers for `AppAudioCapture`, extracted from the main file so it
/// stays under the file-length cap. Everything here runs on `captureControl` (the
/// device-change listener block, the debounce timers, the rebuild machinery, and
/// the health watchdog), so no two lifecycle operations ever overlap. Two distinct
/// entry points feed the SAME coordinator + rebuild path: a debounced
/// `deviceChanged` (Bluetooth/route churn) and an urgent `healthCheckFailed`
/// (zero/stalled tap).
@available(macOS 14.2, *)
extension AppAudioCapture {
    // MARK: - Output device change handling

    func installOutputDeviceChangeListener() {
        guard !outputListenerInstalled else { return }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.handleOutputDeviceChanged()
        }
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultOutputAddress,
            captureControl,
            listener,
        )
        if status == noErr {
            outputDeviceChangeListener = listener
            outputListenerInstalled = true
            logger.info("App audio: listening for default output device changes")
        }
    }

    func handleOutputDeviceChanged() {
        guard isRunning else { return }
        deviceChangeEvents += 1 // session forensics counter
        if debugLogging {
            let newName = getDefaultOutputDeviceName() ?? "?"
            let newUID = getDefaultOutputDeviceUID() ?? "?"
            logger.info(
                "[debug] Output device change → name=\(newName, privacy: .public) uid=\(newUID, privacy: .public)",
            )
        }
        // Debounced single-flight: a burst of device-change events (an HFP↔A2DP
        // flip is several) coalesces into one rebuild once the identity has been
        // quiet for the debounce window. Runs on `captureControl`.
        apply(captureLifecycle.handle(.deviceChanged(at: Date())))
    }

    /// Apply a lifecycle action on `captureControl`. Every branch runs on that
    /// queue, so rebuilds, stops, and retries can never overlap.
    private func apply(_ action: CaptureLifecycleCoordinator.Action) {
        switch action {
        case .ignore:
            break
        case let .scheduleQuietWindow(at):
            scheduleQuietWindow(at: at)
        case .rebuild:
            performRebuild()
        case let .enterDegraded(reattemptAt):
            enterDegraded(reattemptAt: reattemptAt)
        }
    }

    /// Cancel any pending timer and schedule a fresh quiet-window callback on
    /// `captureControl`. Cancelling collapses a burst of triggers to the single
    /// latest window (the coordinator's stale-timer guard is the belt-and-braces).
    private func scheduleQuietWindow(at deadline: Date) {
        pendingQuietWindow?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.apply(self.captureLifecycle.handle(.quietWindowElapsed(at: Date())))
        }
        pendingQuietWindow = item
        let delay = max(0, deadline.timeIntervalSinceNow)
        captureControl.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// The forum-proven recovery: full ordered teardown then recreate.
    /// `stopCapture` destroys IOProc → aggregate → tap in order; `startCapture`
    /// recreates both (re-resolving the audio-active PID set). Outcome is fed
    /// back so the machine can retry / degrade.
    private func performRebuild() {
        logger.info("Tap lifecycle rebuild: full teardown + recreate")
        rebuildsPerformed += 1 // session forensics counter
        stopCapture()
        let success: Bool
        do {
            try startCapture()
            success = actualSampleRate > 0
        } catch {
            logger.error("Tap rebuild failed: \(error)")
            success = false
        }
        apply(captureLifecycle.handle(.rebuildFinished(success: success)))
    }

    /// Too many consecutive failed rebuilds: leave the tap off, report silence on
    /// the level publisher, and schedule a single backoff re-attempt — never a
    /// hot loop against a device coreaudiod is still reconfiguring.
    private func enterDegraded(reattemptAt: Date) {
        logger.error("Tap lifecycle degraded — tap off, re-attempting at next quiet window")
        stopCapture()
        levelPublisher.publish(level: -120)
        scheduleQuietWindow(at: reattemptAt)
    }

    // MARK: - Tap-health watchdog

    /// Start the repeating health check. Called from `start()` on `captureControl`.
    /// A sick verdict feeds a `healthCheckFailed` into the same coordinator + rebuild
    /// path as a device change — this adds only the trigger, no new teardown code.
    func startHealthTimer() {
        guard healthTimer == nil else { return }
        // The callback clock is seeded by `startCapture` on every (re)start, so a
        // tap that never delivers its first buffer is still caught here.
        let timer = DispatchSource.makeTimerSource(queue: captureControl)
        timer.schedule(
            deadline: .now() + CaptureTuning.tapHealthCheckInterval,
            repeating: CaptureTuning.tapHealthCheckInterval,
        )
        timer.setEventHandler { [weak self] in self?.evaluateTapHealth() }
        healthTimer = timer
        timer.resume()
    }

    /// Cancel the health check. Called from `stop()` on `captureControl`.
    func stopHealthTimer() {
        healthTimer?.cancel()
        healthTimer = nil
    }

    /// Install a peer-activity probe (the mic channel's non-silence) used as the
    /// asymmetry guard for the all-zero verdict. Set on `captureControl` so the
    /// health timer reads it without a race; a nil peer (no mic) means the all-zero
    /// fault never trips — with no reference channel, an all-zero tap cannot be
    /// distinguished from genuine silence.
    func setPeerActivityProvider(_ provider: @escaping @Sendable () -> Bool) {
        captureControl.async { [weak self] in
            self?.peerActivityProvider = provider
        }
    }

    /// One health tick on `captureControl`: read the callback clock + the writer's
    /// recent peak + the mic guard, ask the monitor, and on a sick verdict log the
    /// reason and feed a `healthCheckFailed` into the coordinator (which debounces /
    /// rate-limits / degrades). Reset the monitor so the fault window restarts
    /// rather than re-firing every tick during the ensuing rebuild.
    func evaluateTapHealth() {
        guard isRunning else { return }
        let now = Date()
        let lastTicks = lastCallbackTicks.load(ordering: .relaxed)
        let secondsSinceCallback: TimeInterval = lastTicks == 0
            ? 0
            : machTicksToSeconds(mach_absolute_time() &- lastTicks)
        let peak = writer?.takeRecentPeakAbs() ?? 0
        let micNonSilent = peerActivityProvider?() ?? false

        let verdict = tapHealth.evaluate(
            now: now,
            secondsSinceLastCallback: secondsSinceCallback,
            recentPeakAbs: peak,
            micNonSilent: micNonSilent,
        )
        switch verdict {
        case .healthy:
            return
        case let .noCallbacks(secondsStale):
            healthLogger.error("Tap health rebuild: reason=noCallbacks window=\(Int(secondsStale), privacy: .public)s")
        case let .allZero(secondsStale):
            zeroSignalWindows += 1 // session forensics counter
            healthLogger.error("Tap health rebuild: reason=allZero window=\(Int(secondsStale), privacy: .public)s")
        }
        tapHealth.reset()
        apply(captureLifecycle.handle(.healthCheckFailed(at: now)))
    }
}
