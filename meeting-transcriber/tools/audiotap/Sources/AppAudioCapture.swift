import CoreAudio
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "AppAudioCapture")

/// Captures app audio via CATapDescription (macOS 14.2+, CoreAudio).
/// No Screen Recording permission needed — only Audio Capture.
/// Monitors default output device changes and recreates the tap when needed.
///
/// Every tap/aggregate lifecycle transition — `start`, `stop`, device-change
/// rebuilds, health re-taps, degraded retries — is serialized on the private
/// `captureControl` serial queue. That queue IS the manual-serialization
/// contract: the CoreAudio device-change listener block, the debounce timers,
/// and the public `start()`/`stop()` (dispatched sync) all run on it, so no two
/// lifecycle operations ever overlap. Audio buffers are handled separately on
/// `writeQueue` (the IOProc target), which never overlaps with itself for a
/// given tap. `@unchecked Sendable` reflects that this serialization is manual
/// rather than expressible to the compiler.
@available(macOS 14.2, *)
public class AppAudioCapture: @unchecked Sendable {
    /// `internal` (not `private`) so the cross-file `+PIDTranslation`
    /// extension can read it; it's not otherwise touched from outside.
    let pids: [pid_t]
    /// `sampleRate` and `liveSink` are `internal` (not `private`) so the
    /// cross-file `+LiveSink` extension can populate the live buffer struct.
    let sampleRate: Int
    private let channels: Int
    private let outputFileDescriptor: Int32
    /// `internal` (not `private`) so the cross-file `+DebugLogging` extension
    /// can drive the throttled dBFS log line.
    let debugLogging: Bool
    let liveSink: LiveAudioSink?
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var isRunning = false
    private var outputListenerInstalled = false
    /// Stored listener block so we can pass the same instance to remove.
    private var outputDeviceChangeListener: AudioObjectPropertyListenerBlock?
    private let writeQueue = DispatchQueue(
        label: "audiotap.writer", qos: .userInteractive,
    )
    /// Serial queue that owns ALL tap/aggregate lifecycle transitions (start,
    /// stop, rebuilds, retries), the device-change listener block, and the
    /// debounce timers. Injected by `AudioCaptureSession` so the mic engine and
    /// the tap share ONE queue and can't churn CoreAudio concurrently; defaults
    /// to a private queue for direct construction.
    private let captureControl: DispatchQueue

    /// `internal` (not `private`) so the cross-file `+DebugLogging` extension
    /// can drive the per-buffer RMS accumulator + dBFS report cadence.
    var debugRMS = DebugRMSReporter()
    var debugTotalBytes: UInt64 = 0
    let levelPublisher = LevelPublisher()

    /// Returns the instantaneous app-audio level in dBFS, decayed to -120 if
    /// no buffer arrived in the last 0.5 seconds (e.g. tap died, device
    /// unplugged) — without that, a stale reading would look like live audio.
    public var currentLevelDBFS: Double {
        levelPublisher.currentLevelDBFS
    }

    /// CoreAudio property address for default output device changes.
    private var defaultOutputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    )

    /// mach_absolute_time() of first audio callback.
    public private(set) var appFirstFrameTime: UInt64 = 0
    /// Actual sample rate of the aggregate device (may differ from requested).
    public private(set) var actualSampleRate: Int = 0
    /// Actual channel count detected from first IOProc callback.
    public private(set) var actualChannels: Int = 0
    private var didLogFormat = false
    /// Pure state machine that decides when/what to do on device-change and
    /// health-check triggers. Mutated only on `captureControl`.
    private var captureLifecycle = CaptureLifecycleCoordinator()
    /// The currently-scheduled debounce/quiet-window timer, cancelled + replaced
    /// on each new trigger so a burst coalesces to a single rebuild.
    private var pendingQuietWindow: DispatchWorkItem?

    /// - Parameters:
    ///   - pids: Process IDs to capture audio from. Pass the meeting app's
    ///     root PID plus its helper/renderer child PIDs for Electron-based
    ///     apps (Teams 2.x, Slack, Discord); pass a single-element array
    ///     for native Cocoa apps. Helpers whose `translatePIDToProcessObject`
    ///     lookup fails (no audio-object entry) are skipped silently.
    ///   - outputFileDescriptor: File descriptor to write raw PCM data to.
    ///   - sampleRate: Desired sample rate (default 48000).
    ///   - channels: Number of audio channels (default 2).
    ///   - debugLogging: When true, emit verbose forensic logs (process identity,
    ///     output device, periodic RMS energy of captured samples).
    ///   - liveSink: Optional callback receiving a copy of each captured buffer.
    ///     Called on the audio IOProc thread — must not block. Nil = no-op,
    ///     existing batch path unchanged.
    public init(
        pids: [pid_t],
        outputFileDescriptor: Int32,
        sampleRate: Int = 48000,
        channels: Int = 2,
        debugLogging: Bool = false,
        liveSink: LiveAudioSink? = nil,
        captureControl: DispatchQueue? = nil,
    ) {
        self.pids = pids
        self.outputFileDescriptor = outputFileDescriptor
        self.sampleRate = sampleRate
        self.channels = channels
        self.debugLogging = debugLogging
        self.liveSink = liveSink
        self.captureControl = captureControl
            ?? DispatchQueue(label: "audiotap.control", qos: .userInitiated)
    }

    /// Start capturing. Synchronous to callers, but the work runs on
    /// `captureControl` so it serializes with every rebuild/stop. No reentrancy:
    /// callers must not call `start()`/`stop()` from within `captureControl`.
    public func start() throws {
        try captureControl.sync {
            try startCapture()
            installOutputDeviceChangeListener()
        }
    }

    /// Query nominal sample rate from a CoreAudio device.
    private static func queryNominalSampleRate(deviceID: AudioObjectID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &rate)
        if status != noErr {
            logger.warning("queryNominalSampleRate failed (status: \(status))")
            return 0
        }
        return Int(rate)
    }

    /// Query physical stream format sample rate from a CoreAudio device.
    private static func queryStreamSampleRate(deviceID: AudioObjectID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyPhysicalFormat,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain,
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &asbd)
        if status != noErr {
            // Not all devices support this query — non-fatal
            return 0
        }
        return Int(asbd.mSampleRate)
    }

    /// Query the tap's own format — most authoritative source for tap data rate.
    /// Uses kAudioTapPropertyFormat which returns the ASBD the tap delivers.
    private static func queryTapSampleRate(tapID: AudioObjectID) -> Int {
        guard tapID != kAudioObjectUnknown else { return 0 }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
        if status != noErr {
            logger.warning("queryTapSampleRate failed (status: \(status))")
            return 0
        }
        return Int(asbd.mSampleRate)
    }

    /// Query the actual measured sample rate from a running device.
    /// Only valid after AudioDeviceStart — returns the hardware-measured rate.
    private static func queryActualSampleRate(deviceID: AudioObjectID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyActualSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &rate)
        if status != noErr { return 0 }
        return Int(rate)
    }

    /// Query, cross-validate, and return the best available sample rate for a device.
    /// Priority: tap format > nominal rate > stream format > requested rate.
    private static func resolveActualSampleRate(
        deviceID: AudioObjectID,
        tapID: AudioObjectID,
        requestedRate: Int,
    ) -> Int {
        // 1. Query the tap directly — usually authoritative, BUT for an AirPods-
        //    backed aggregate in HFP duplex the tap's kAudioTapPropertyFormat can
        //    report a lower rate (e.g. 24000) than the aggregate clock actually
        //    runs (44100). Cross-check against the device's MEASURED actual rate
        //    (kAudioDevicePropertyActualSampleRate) — authoritative once the
        //    device is started (this is called after AudioDeviceStart). If they
        //    disagree by >5%, trust the measured rate: under-trusting the tap
        //    here is exactly what under-downsampled the app track ~1.84x.
        let tapRate = queryTapSampleRate(tapID: tapID)
        if tapRate > 0 {
            let measured = queryActualSampleRate(deviceID: deviceID)
            if measured > 0, abs(Double(measured - tapRate)) / Double(tapRate) > 0.05 {
                logger.warning(
                    "Tap rate \(tapRate) Hz disagrees with measured actual rate \(measured) Hz — trusting measured",
                )
                return SampleRateQuery.validateSampleRate(
                    queriedRate: measured, requestedRate: requestedRate,
                ).rate
            }
            let validated = SampleRateQuery.validateSampleRate(
                queriedRate: tapRate, requestedRate: requestedRate,
            )
            if validated.source == .queriedDiffersFromRequested {
                logger.warning("Tap rate \(tapRate) Hz differs from requested \(requestedRate) Hz")
            }
            logger.info("Using tap format rate: \(tapRate) Hz")
            return validated.rate
        }

        // 2. Fallback: nominal + stream cross-validation
        let nominalRate = queryNominalSampleRate(deviceID: deviceID)
        let streamRate = queryStreamSampleRate(deviceID: deviceID)

        let crossCheck = SampleRateQuery.crossValidateRate(
            nominalRate: nominalRate,
            streamRate: streamRate,
        )

        let bestRate: Int
        switch crossCheck {
        case let .consistent(rate):
            bestRate = rate

        case let .mismatch(nominal, stream):
            // Prefer nominal over stream — stream on output scope can return BT HFP rate
            logger.warning("Rate mismatch: nominal=\(nominal), stream=\(stream) — using nominal rate (stream scope may reflect BT HFP)")
            bestRate = nominal

        case let .onlyNominal(rate):
            bestRate = rate

        case let .onlyStream(rate):
            bestRate = rate

        case .neitherAvailable:
            logger.warning("Cannot query sample rate, using requested \(requestedRate) Hz")
            return requestedRate
        }

        let validated = SampleRateQuery.validateSampleRate(
            queriedRate: bestRate, requestedRate: requestedRate,
        )
        if validated.source == .queriedDiffersFromRequested {
            logger.warning("Aggregate device rate \(bestRate) Hz differs from requested \(requestedRate) Hz")
        }
        return validated.rate
    }

    // swiftlint:disable:next function_body_length
    private func startCapture() throws {
        let translated = try translatePIDs()
        let processObjectIDs = translated.map(\.audioObjectID)

        // Always log at info level with exe names so a "silent _app.wav"
        // report can be triaged without the user toggling Verbose Audio
        // Logging first — process names like "MSTeams Helper (Renderer)"
        // make issue-#84-style failures actionable.
        let tapSummary = translated.map { "\(getExecutableName(pid: $0.pid))(\($0.pid))" }.joined(separator: ", ")
        logger.info(
            "App audio tap: \(translated.count) PID(s) [\(tapSummary, privacy: .public)]",
        )

        if debugLogging {
            for entry in translated {
                let bundleID = getProcessBundleID(entry.audioObjectID) ?? "?"
                let exeName = getExecutableName(pid: entry.pid)
                logger.info(
                    "[debug] Tap target: pid=\(entry.pid, privacy: .public) exe=\(exeName, privacy: .public) bundle=\(bundleID, privacy: .public) audioObjectID=\(entry.audioObjectID, privacy: .public)",
                )
            }
        }

        // Get default output device UID
        guard let systemOutputUID = getDefaultOutputDeviceUID() else {
            throw NSError(
                domain: "audiotap", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Cannot get default output device UID"],
            )
        }
        logger.info("System output device: \(systemOutputUID)")

        if debugLogging {
            let deviceName = getDefaultOutputDeviceName() ?? "?"
            let transport = getDefaultOutputDeviceTransportType() ?? "?"
            let deviceRate = getDefaultOutputDeviceSampleRate() ?? 0
            logger.info(
                "[debug] Default output device: name=\(deviceName, privacy: .public) uid=\(systemOutputUID, privacy: .public) transport=\(transport, privacy: .public) rate=\(deviceRate, privacy: .public)",
            )
        }

        // Create CATapDescription for the target process(es). For Electron
        // apps this covers the helper tree so the renderer holding the audio
        // handle is included; for native apps the array is a single PID.
        let tap = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
        tap.uuid = UUID()
        tap.name = "MeetingTranscriber-tap"
        tap.isPrivate = true
        tap.muteBehavior = .unmuted

        var newTapID = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(tap, &newTapID)
        guard tapStatus == noErr else {
            let hint = Self.describeTapError(tapStatus)
            logger.error(
                "Failed to create process tap (pids=\(self.pids, privacy: .public)): \(hint, privacy: .public)",
            )
            throw NSError(
                domain: "audiotap", code: Int(tapStatus),
                userInfo: [NSLocalizedDescriptionKey: hint],
            )
        }
        tapID = newTapID
        logger.info("Created process tap: \(self.tapID)")

        if debugLogging {
            let tapRate = Self.queryTapSampleRate(tapID: tapID)
            logger.info(
                "[debug] Tap format: rate=\(tapRate, privacy: .public) Hz, tapID=\(self.tapID, privacy: .public)",
            )
        }

        // Create aggregate device with the tap. The name embeds the root PID
        // (first entry) — purely cosmetic for `system_profiler SPAudioDataType`.
        let nameTag = pids.first.map(String.init) ?? "0"
        let desc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "audiotap-\(nameTag)",
            kAudioAggregateDeviceUIDKey as String: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey as String: systemOutputUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [
                [kAudioSubDeviceUIDKey as String: systemOutputUID],
            ],
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: tap.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey as String: true,
                ],
            ],
        ]

        var newAggregateID = AudioObjectID(kAudioObjectUnknown)
        let aggStatus = AudioHardwareCreateAggregateDevice(
            desc as CFDictionary, &newAggregateID,
        )
        guard aggStatus == noErr else {
            AudioHardwareDestroyProcessTap(tapID)
            throw NSError(
                domain: "audiotap", code: Int(aggStatus),
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Failed to create aggregate device (status: \(aggStatus))",
                ],
            )
        }
        aggregateID = newAggregateID
        logger.info("Created aggregate device: \(self.aggregateID)")

        // Set up IOProc to read audio data and write to file descriptor
        let fd = outputFileDescriptor
        var newProcID: AudioDeviceIOProcID?
        let ioProcStatus = AudioDeviceCreateIOProcIDWithBlock(
            &newProcID, aggregateID, writeQueue,
        ) { [weak self] _, inInputData, _, _, _ in
            guard let self, self.isRunning else { return }
            let abl = inInputData.pointee

            // Log format on first callback
            if !self.didLogFormat {
                self.didLogFormat = true
                // Only record the very first frame time — not after device restarts.
                // MicCaptureHandler uses the same guard. Without this, a device change
                // mid-recording overwrites the timestamp, corrupting the micDelay
                // calculation and producing a mix.wav at 2× duration (see #99).
                if self.appFirstFrameTime == 0 {
                    self.appFirstFrameTime = mach_absolute_time()
                }
                self.actualChannels = Int(abl.mBuffers.mNumberChannels)

                // Device is running — query the measured actual rate
                let measuredRate = Self.queryActualSampleRate(deviceID: self.aggregateID)
                if measuredRate > 0, measuredRate != self.actualSampleRate {
                    logger.warning(
                        "Measured rate \(measuredRate) Hz differs from cached \(self.actualSampleRate) Hz — updating",
                    )
                    self.actualSampleRate = measuredRate
                }

                let ch = max(self.actualChannels, 1)
                let frames = Int(abl.mBuffers.mDataByteSize) / (MemoryLayout<Float>.size * ch)
                logger.info(
                    "Audio format: \(self.actualSampleRate) Hz, \(self.actualChannels)ch, \(abl.mNumberBuffers) buffers, \(frames) frames/buffer",
                )
            }

            // CATapDescription delivers interleaved float32 — write directly
            guard let data = abl.mBuffers.mData else { return }
            let byteCount = Int(abl.mBuffers.mDataByteSize)
            writeAllToFileHandle(fd, data, count: byteCount)

            self.accumulateDebugRMS(data: data, byteCount: byteCount)
            self.publishCurrentLevel()
            self.maybeReportDebugRMS()
            self.forwardToLiveSink(data: data, byteCount: byteCount)
        }

        guard ioProcStatus == noErr, let validProcID = newProcID else {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            AudioHardwareDestroyProcessTap(tapID)
            throw NSError(
                domain: "audiotap", code: Int(ioProcStatus),
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Failed to create IOProc (status: \(ioProcStatus))",
                ],
            )
        }
        procID = validProcID

        let startStatus = AudioDeviceStart(aggregateID, procID)
        guard startStatus == noErr else {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            AudioHardwareDestroyProcessTap(tapID)
            throw NSError(
                domain: "audiotap", code: Int(startStatus),
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Failed to start audio device (status: \(startStatus))",
                ],
            )
        }

        isRunning = true

        actualSampleRate = Self.resolveActualSampleRate(
            deviceID: aggregateID, tapID: tapID, requestedRate: sampleRate,
        )
        logger.info("Audio capture started (PIDs \(self.pids), rate: \(self.actualSampleRate) Hz)")
    }

    private func stopCapture() {
        isRunning = false

        if debugLogging {
            logger.info(
                "[debug] App audio capture stopping: totalBytes=\(self.debugTotalBytes, privacy: .public)",
            )
        }

        if let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            self.procID = nil
        }
        // Drain pending IOProc blocks before the caller closes the fd —
        // AudioDeviceStop doesn't synchronize against blocks already dispatched
        // onto writeQueue, so without this barrier a late buffer could write
        // to a closed/recycled fd.
        writeQueue.sync {}
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        didLogFormat = false
    }

    public func stop() {
        captureControl.sync {
            // Cancel any pending debounce/degraded-retry timer so it can't revive
            // a stopped capture after teardown.
            pendingQuietWindow?.cancel()
            pendingQuietWindow = nil
            stopCapture()
            if outputListenerInstalled, let listener = outputDeviceChangeListener {
                AudioObjectRemovePropertyListenerBlock(
                    AudioObjectID(kAudioObjectSystemObject),
                    &defaultOutputAddress,
                    captureControl,
                    listener,
                )
                outputDeviceChangeListener = nil
                outputListenerInstalled = false
            }
        }
        logger.info("Audio capture stopped")
    }

    /// Translates an `AudioHardwareCreateProcessTap` OSStatus to a human hint.
    /// Exposed `internal` for unit tests.
    static func describeTapError(_ status: OSStatus) -> String {
        switch status {
        case -12988:
            "OSStatus -12988: likely missing permission. " +
                "Check System Settings → Privacy & Security → Screen Recording " +
                "and enable Meeting Transcriber."

        case -10851:
            "OSStatus -10851 (kAudioUnitErr_InvalidProperty): " +
                "the tap target may have exited before the tap was created."

        case -50:
            "OSStatus -50 (paramErr): invalid CATapDescription parameter " +
                "(target process may not be capturable)."

        default:
            "OSStatus \(status): unrecognised — see CoreAudio headers."
        }
    }
}

// MARK: - Output device change handling

@available(macOS 14.2, *)
extension AppAudioCapture {
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
}
