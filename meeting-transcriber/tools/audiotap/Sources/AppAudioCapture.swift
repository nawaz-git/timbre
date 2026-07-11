import Atomics
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
/// contract: the CoreAudio device-change listener block, the debounce timer, the
/// tap-health timer, and the public `start()`/`stop()` (dispatched sync) all run
/// on it, so no two lifecycle operations ever overlap. Audio buffers are handled
/// separately: the IOProc (on `writeQueue`) only memcpys them into the lock-free
/// SPSC `AudioRingBuffer`, and a dedicated `CaptureFileWriter` thread drains that
/// ring to disk — neither path overlaps the control queue. `@unchecked Sendable`
/// reflects that this serialization is manual rather than expressible to the
/// compiler.
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
    /// `internal` so the cross-file `+Lifecycle` extension can gate its verbose
    /// device-change logs, and so it can be forwarded to the `CaptureFileWriter`.
    let debugLogging: Bool
    let liveSink: LiveAudioSink?
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    /// Dedicated disk-writer draining the SPSC ring for the current capture. Owns
    /// the blocking `write()` + RMS/level/peak work that used to run inside the
    /// IOProc. Created per `startCapture`, torn down with a bounded flush in
    /// `stopCapture`. `internal` so the cross-file `+Lifecycle` extension can read the
    /// writer's recent peak-abs.
    var writer: CaptureFileWriter?
    /// `internal` so the cross-file `+Lifecycle` extension can gate the health tick.
    var isRunning = false
    /// `internal` (with the listener block below and `defaultOutputAddress`) so the
    /// cross-file `+Lifecycle` extension can install/remove the device listener.
    var outputListenerInstalled = false
    /// Stored listener block so we can pass the same instance to remove.
    var outputDeviceChangeListener: AudioObjectPropertyListenerBlock?
    private let writeQueue = DispatchQueue(
        label: "audiotap.writer", qos: .userInteractive,
    )
    /// Serial queue that owns ALL tap/aggregate lifecycle transitions (start,
    /// stop, rebuilds, retries), the device-change listener block, and the
    /// debounce + health timers. Injected by `AudioCaptureSession` so the mic
    /// engine and the tap share ONE queue and can't churn CoreAudio concurrently;
    /// defaults to a private queue for direct construction. `internal` so the
    /// cross-file `+Lifecycle` extension schedules its timer on the same queue.
    let captureControl: DispatchQueue

    /// Per-buffer level source for the menu-bar indicator. Published from the
    /// `CaptureFileWriter` drain thread (which owns all RMS/level/peak work now
    /// that it is off the IOProc) and read via `currentLevelDBFS`.
    let levelPublisher = LevelPublisher()

    /// Returns the instantaneous app-audio level in dBFS, decayed to -120 if
    /// no buffer arrived in the last 0.5 seconds (e.g. tap died, device
    /// unplugged) — without that, a stale reading would look like live audio.
    public var currentLevelDBFS: Double {
        levelPublisher.currentLevelDBFS
    }

    /// Wall-clock of the most recent IOProc callback, or nil if the tap has
    /// never delivered a buffer. Derived from the monotonic callback clock by
    /// subtracting the elapsed interval from now, so the real-time path stores
    /// only mach ticks (no `Date`). Sourced by the engine heartbeat.
    public var lastIOCallbackAt: Date? {
        let ticks = lastCallbackTicks.load(ordering: .relaxed)
        guard ticks != 0 else { return nil }
        return Date().addingTimeInterval(-machTicksToSeconds(mach_absolute_time() &- ticks))
    }

    /// Number of PIDs in the live app tap set (post audio-active filter).
    public var tapPIDCount: Int {
        activeTapPIDCount.load(ordering: .relaxed)
    }

    /// CoreAudio property address for default output device changes. `internal`
    /// for the cross-file `+Lifecycle` extension's listener install/remove.
    var defaultOutputAddress = AudioObjectPropertyAddress(
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
    /// health-check triggers. Mutated only on `captureControl`. `internal` so the
    /// cross-file `+Lifecycle` extension can feed it `healthCheckFailed`.
    var captureLifecycle = CaptureLifecycleCoordinator()
    /// The currently-scheduled debounce/quiet-window timer, cancelled + replaced
    /// on each new trigger so a burst coalesces to a single rebuild. `internal` for
    /// the cross-file `+Lifecycle` extension (scheduling) and `stop()` (cancel).
    var pendingQuietWindow: DispatchWorkItem?
    /// mach ticks of the last IOProc callback — set on the audio thread, read by
    /// the health timer. `internal` for the cross-file `+Lifecycle` extension.
    let lastCallbackTicks = ManagedAtomic<UInt64>(0)
    /// Number of process objects in the live tap set (post audio-active filter),
    /// stored on each `startCapture`. Read cross-thread by the engine heartbeat.
    let activeTapPIDCount = ManagedAtomic<Int>(0)
    /// Pure tap-health verdict machine. Mutated only on `captureControl` (the
    /// health timer). `internal` for the cross-file `+Lifecycle` extension.
    var tapHealth = TapHealthMonitor()
    /// Repeating tap-health timer on `captureControl` (nil when not capturing).
    var healthTimer: DispatchSourceTimer?
    /// Peer (mic) non-silence probe — the all-zero asymmetry guard. Touched only
    /// on `captureControl`. Nil when there is no mic reference channel.
    var peerActivityProvider: (@Sendable () -> Bool)?

    // MARK: - Session forensics counters
    // All touched ONLY on `captureControl` (the device-change / health / rebuild
    // path in `+Lifecycle`, plus `stopCapture`), read once at session `stop()` on
    // that same queue — no atomics needed. Accumulate across rebuilds within a
    // session and are logged as one greppable summary line at stop.

    /// Output-device-change notifications observed this session.
    var deviceChangeEvents = 0
    /// Full teardown+recreate cycles this session (device-change or health).
    var rebuildsPerformed = 0
    /// All-zero health faults (the tap delivered silence while the mic was live).
    var zeroSignalWindows = 0
    /// Ring bytes dropped on writer overflow, summed across this session's writers.
    private var sessionDroppedBytes = 0

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
            startHealthTimer()
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
    // `internal` so the cross-file `+Lifecycle` extension can recreate the tap
    // during a rebuild.
    func startCapture() throws {
        let translated = try translatePIDs()
        let processObjectIDs = translated.map(\.audioObjectID)
        // Publish the live tap fan-in for the engine heartbeat; re-set on
        // every rebuild so a health re-tap's fresh PID set is reflected.
        activeTapPIDCount.store(translated.count, ordering: .relaxed)

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
        let tapStatus = Self.timedHALCall("createProcessTap") {
            AudioHardwareCreateProcessTap(tap, &newTapID)
        }
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
        let aggStatus = Self.timedHALCall("createAggregate") {
            AudioHardwareCreateAggregateDevice(desc as CFDictionary, &newAggregateID)
        }
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

        // SPSC ring between this IOProc (producer) and the writer thread
        // (consumer). Captured by value into the IOProc so it is paired with
        // exactly the writer created for this capture — a rebuild makes a fresh
        // ring + writer, never aliasing a previous one.
        let ring = AudioRingBuffer()

        // Set up IOProc to hand audio to the ring — no blocking I/O in the callback.
        var newProcID: AudioDeviceIOProcID?
        let ioProcStatus = AudioDeviceCreateIOProcIDWithBlock(
            &newProcID, aggregateID, writeQueue,
        ) { [weak self, ring] _, inInputData, _, _, _ in
            guard let self, self.isRunning else { return }
            // Liveness beat for the tap-health watchdog — one relaxed atomic store,
            // no per-sample work on this real-time path.
            self.lastCallbackTicks.store(mach_absolute_time(), ordering: .relaxed)
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

            // CATapDescription delivers interleaved float32. Hand the buffer to
            // the SPSC ring and return; the writer thread does the blocking disk
            // write + RMS/level/peak off this real-time path. Live-sink forwarding
            // stays here — it already copies and must not be delayed by draining.
            guard let data = abl.mBuffers.mData else { return }
            let byteCount = Int(abl.mBuffers.mDataByteSize)
            ring.write(data, count: byteCount)
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

        // Spin up the drain thread before opening the IOProc gate (`isRunning`) so
        // the ring is being emptied the instant buffers start flowing.
        let fileWriter = CaptureFileWriter(
            fd: outputFileDescriptor, ring: ring,
            levelPublisher: levelPublisher, debugLogging: debugLogging,
        )
        fileWriter.start()
        writer = fileWriter

        isRunning = true
        // Seed the health watchdog's callback clock on every (re)start so the
        // no-callback window measures from now — otherwise a rebuild that succeeds
        // could inherit a stale timestamp and spuriously re-trigger before the
        // first fresh callback lands.
        lastCallbackTicks.store(mach_absolute_time(), ordering: .relaxed)

        actualSampleRate = Self.resolveActualSampleRate(
            deviceID: aggregateID, tapID: tapID, requestedRate: sampleRate,
        )
        logger.info("Audio capture started (PIDs \(self.pids), rate: \(self.actualSampleRate) Hz)")
    }

    /// `internal` so the cross-file `+Lifecycle` extension can tear the tap down
    /// during a rebuild / degrade.
    func stopCapture() {
        isRunning = false

        if let procID {
            Self.timedHALCall("audioDeviceStop") { AudioDeviceStop(aggregateID, procID) }
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            self.procID = nil
        }
        // Ordering barrier: an IOProc block that already passed the `isRunning`
        // guard may still be mid-`ring.write`; draining writeQueue lets it finish
        // before the writer's final flush, so no produced bytes are lost (keeps
        // capture byte-identical). This is now BOUNDED — the IOProc only memcpys
        // into the ring — unlike the old barrier, which waited on the callback's
        // own synchronous disk write and could hang on a stalled disk.
        writeQueue.sync {}
        // Bounded final drain of the ring to disk, then stop the writer thread.
        if let writer {
            writer.flushAndClose(deadline: .now() + CaptureTuning.writerFlushDeadline)
            // Accumulate the session dropped-byte total before the writer (and its
            // ring) go away on a rebuild — the summary line reports the whole run.
            sessionDroppedBytes += writer.droppedBytes
            if debugLogging {
                logger.info(
                    "[debug] App audio capture stopping: totalBytes=\(writer.totalBytesWritten, privacy: .public), droppedBytes=\(writer.droppedBytes, privacy: .public)",
                )
            }
            self.writer = nil
        }
        if aggregateID != kAudioObjectUnknown {
            Self.timedHALCall("destroyAggregate") { AudioHardwareDestroyAggregateDevice(aggregateID) }
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            Self.timedHALCall("destroyProcessTap") { AudioHardwareDestroyProcessTap(tapID) }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        didLogFormat = false
    }

    public func stop() {
        captureControl.sync {
            // Stop the health watchdog and cancel any pending debounce/degraded
            // retry so neither can revive a stopped capture after teardown.
            stopHealthTimer()
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
            // One greppable per-session forensics line. Logged inside the
            // control-queue block so the counters are read on the queue that owns
            // them, after the final `stopCapture` folded in the last writer's drops.
            // Built as a plain string (all fields are non-sensitive Int counters)
            // then logged public — keeps the line under the length cap.
            let summary = "Capture session summary: "
                + "deviceChanges=\(deviceChangeEvents) rebuilds=\(rebuildsPerformed) "
                + "zeroWindows=\(zeroSignalWindows) droppedBytes=\(sessionDroppedBytes) "
                + "tapPIDs=\(tapPIDCount)"
            logger.info("\(summary, privacy: .public)")
        }
        logger.info("Audio capture stopped")
    }

    /// Time a CoreAudio HAL call and log at error level when it exceeds
    /// `CaptureTuning.halCallSlowThreshold` — an early coreaudiod-distress
    /// tripwire that feeds the HAL-liveness sentinel's evidence. The call
    /// runs inline (non-escaping body) so `inout` OSStatus out-params work.
    @discardableResult
    static func timedHALCall<Result>(_ label: String, _ body: () -> Result) -> Result {
        let start = mach_absolute_time()
        let result = body()
        let elapsed = machTicksToSeconds(mach_absolute_time() &- start)
        if elapsed > CaptureTuning.halCallSlowThreshold {
            logger.error(
                "HAL call slow: \(label, privacy: .public) took \(String(format: "%.2f", elapsed), privacy: .public)s",
            )
        }
        return result
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
