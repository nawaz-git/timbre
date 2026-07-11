@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "MicCapture")

/// Records microphone audio to a WAV file via AVAudioEngine.
/// Monitors for device changes via CoreAudio property listener (default input device)
/// and AVAudioEngine configuration change notification (format/route changes).
/// Automatically restarts the engine on device switch, preserving the selected device
/// when still available or falling back to system default with a warning.
///
/// Public API (`start`/`stop`/`currentLevelDBFS`) is called from the main actor.
/// The `installTap` render-thread callback writes to per-buffer state guarded by
/// `LevelPublisher` (lock-protected) and to `outputFile` which is only mutated
/// between `engine.stop()` and `engine.start()` on the main thread, so concurrent
/// IO with the render thread is impossible by lifecycle. `@unchecked Sendable`
/// reflects that this discipline isn't expressible to the compiler.
public class MicCaptureHandler: @unchecked Sendable {
    private var engine = AVAudioEngine()
    private var outputFile: AVAudioFile?
    private let outputURL: URL
    private let debugLogging: Bool
    private let liveSink: LiveAudioSink?
    private var isRecording = false
    private var isRestarting = false
    /// Serial queue that owns the debounced restart. Shared with the app tap
    /// (injected by `AudioCaptureSession`) so mic-engine rebuilds and tap
    /// rebuilds serialize with each other instead of churning the HAL
    /// concurrently during a Bluetooth storm. All coalescer/restart work runs
    /// here; the listeners hop onto it.
    private let captureControl: DispatchQueue
    /// Schedules the coalesced restart after a delay. Injectable for tests;
    /// defaults to `captureControl.asyncAfter`.
    private let restartScheduler: (TimeInterval, DispatchWorkItem) -> Void
    /// Pure debounce decision — collapses a burst of input-device notifications
    /// into a single restart. Touched only on `captureControl`.
    private var restartCoalescer = MicRestartCoalescer()
    /// Currently-scheduled debounce timer, cancelled + replaced on each new
    /// notification. Touched only on `captureControl`.
    private var pendingRestart: DispatchWorkItem?
    private var deviceChangeListener: AudioObjectPropertyListenerBlock?
    private var configChangeObserver: NSObjectProtocol?
    private var selectedDeviceUID: String?
    private var fileSampleRate: Double = 0
    private var converter: AVAudioConverter?
    /// Pre-computed resampling ratio (fileSampleRate / tapSampleRate), avoids division in audio callback.
    private var resampleRatio: Double = 1.0
    /// The input rate the cached `converter` was built for. The tap is installed
    /// with `format: nil` so AVAudioEngine hands the node's NATIVE format
    /// per-buffer; if a Bluetooth headset renegotiates (HFP↔A2DP) mid-recording
    /// the delivered rate can change without an `AVAudioEngineConfigurationChange`
    /// firing. We rebuild the converter lazily whenever the live buffer's rate
    /// differs from this value so the resample ratio always tracks the ACTUAL
    /// delivered rate — never a stale rate pinned once at engine start.
    private var converterInputRate: Double = 0
    public private(set) var firstFrameTime: UInt64 = 0

    private var debugRMS = DebugRMSReporter()
    private let levelPublisher = LevelPublisher()

    /// Returns the instantaneous mic level in dBFS, decayed to -120 if no buffer
    /// arrived in the last 0.5 seconds (e.g. device muted or unplugged) — without
    /// that, a stale reading would look like live audio.
    public var currentLevelDBFS: Double {
        levelPublisher.currentLevelDBFS
    }

    private var defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    )

    public init(
        outputURL: URL,
        debugLogging: Bool = false,
        liveSink: LiveAudioSink? = nil,
        captureControl: DispatchQueue? = nil,
        restartScheduler: ((TimeInterval, DispatchWorkItem) -> Void)? = nil,
    ) {
        self.outputURL = outputURL
        self.debugLogging = debugLogging
        self.liveSink = liveSink
        let control = captureControl
            ?? DispatchQueue(label: "audiotap.control.mic", qos: .userInitiated)
        self.captureControl = control
        self.restartScheduler = restartScheduler ?? { delay, item in
            control.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    deinit {
        stop()
    }

    private static func deviceIDForUID(_ uid: String) -> AudioDeviceID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        )
        var deviceID: AudioDeviceID = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var cfUID: Unmanaged<CFString>? = Unmanaged.passUnretained(uid as CFString)
        let qualifierSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address, qualifierSize, &cfUID,
            &size, &deviceID,
        )
        return deviceID
    }

    public func start(deviceUID: String? = nil) throws {
        selectedDeviceUID = deviceUID
        try startEngine(deviceUID: deviceUID)
        installDeviceChangeListener()
        installConfigChangeObserver()
    }

    // swiftlint:disable:next function_body_length
    private func startEngine(deviceUID: String? = nil) throws {
        // No input device available (e.g. Mac Mini server without mic hardware) —
        // accessing AVAudioEngine.inputNode would throw an uncatchable NSException.
        guard AVCaptureDevice.default(for: .audio) != nil else {
            throw MicCaptureError.noInputDevice
        }

        let inputNode = engine.inputNode

        if let uid = deviceUID {
            var deviceID = Self.deviceIDForUID(uid)
            if deviceID != kAudioObjectUnknown {
                let audioUnit = inputNode.audioUnit! // swiftlint:disable:this force_unwrapping
                AudioUnitSetProperty(
                    audioUnit,
                    kAudioOutputUnitProperty_CurrentDevice,
                    kAudioUnitScope_Global, 0,
                    &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size),
                )
                logger.info("Mic device set: \(uid) (ID \(deviceID))")
            } else {
                logger.warning("Unknown mic device UID '\(uid)', using default")
            }
        }

        let hwFormat = inputNode.outputFormat(forBus: 0)
        logger.info("Mic hardware format: \(hwFormat.sampleRate) Hz, \(hwFormat.channelCount)ch")

        if debugLogging {
            let inUID = getDefaultInputDeviceUID() ?? "?"
            let inName = getDefaultInputDeviceName() ?? "?"
            logger.info(
                "[debug] Mic input device: name=\(inName, privacy: .public) uid=\(inUID, privacy: .public) hwRate=\(hwFormat.sampleRate, privacy: .public) hwChannels=\(hwFormat.channelCount, privacy: .public)",
            )
        }

        // Always 16kHz — WhisperKit target rate
        if outputFile == nil {
            fileSampleRate = speechSampleRate
            let wavSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: fileSampleRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            outputFile = try AVAudioFile(forWriting: outputURL, settings: wavSettings)
            // Restrict permissions to owner-only (0600) — audio may contain sensitive meeting content
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: outputURL.path,
            )
        }

        // The converter, resampleRatio, and converterInputRate are NOT pinned
        // here. Pinning the tap format to `hwFormat.sampleRate` read once at
        // engine start is exactly the defect that produced the ~1.84x stretch:
        // AirPods reported one rate at start but delivered another after an
        // HFP↔A2DP renegotiation, and AVAudioEngineConfigurationChange does not
        // reliably fire on that switch. Instead the converter is rebuilt lazily
        // inside the tap closure from each live buffer's ACTUAL format.
        converter = nil
        resampleRatio = 1.0
        converterInputRate = 0

        // swiftlint:disable closure_parameter_position closure_body_length
        // `format: nil` → AVAudioEngine hands the node's native per-buffer format,
        // so a mid-recording rate change is observable on the very next buffer.
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) {
            [weak self] buffer, _ in
            // swiftlint:enable closure_parameter_position closure_body_length
            guard let self, self.isRecording else { return }
            if self.firstFrameTime == 0 {
                self.firstFrameTime = mach_absolute_time()
            }
            self.accumulateDebugRMS(buffer: buffer)
            self.publishCurrentLevel()
            self.maybeReportDebugRMS()

            // Track the ACTUAL delivered rate per-buffer. Rebuild the converter
            // (and resample ratio) only when it changes — the steady-state hot
            // path skips this entirely. Mutating these ivars from the render
            // thread is consistent with the documented single-tap-closure
            // discipline (only one tap closure runs at a time; @unchecked
            // Sendable already covers it).
            let bufRate = buffer.format.sampleRate
            if self.converter == nil || bufRate != self.converterInputRate {
                if bufRate == self.fileSampleRate {
                    self.converter = nil
                } else {
                    let inFmt = AVAudioFormat(
                        standardFormatWithSampleRate: bufRate, channels: 1,
                    )! // swiftlint:disable:this force_unwrapping
                    let outFmt = AVAudioFormat(
                        standardFormatWithSampleRate: self.fileSampleRate, channels: 1,
                    )! // swiftlint:disable:this force_unwrapping
                    self.converter = AVAudioConverter(from: inFmt, to: outFmt)
                }
                self.resampleRatio = self.fileSampleRate / bufRate
                self.converterInputRate = bufRate
                logger.warning(
                    "Mic delivered rate changed to \(Int(bufRate)) Hz — rebuilt converter (ratio \(self.resampleRatio))",
                )
            }

            do {
                if let converter = self.converter {
                    let outputFrames = AVAudioFrameCount(
                        Double(buffer.frameLength) * self.resampleRatio,
                    )
                    guard let outputBuffer = AVAudioPCMBuffer(
                        pcmFormat: converter.outputFormat,
                        frameCapacity: outputFrames,
                    ) else { return }
                    var error: NSError?
                    // The converter input block is typed `@Sendable`, so a
                    // captured `var Bool` would trip Swift 6's concurrent-
                    // capture check — even though the block actually runs
                    // synchronously while `convert(to:error:withInputFrom:)`
                    // is on the stack. Box the flag so the closure captures
                    // it by-reference.
                    final class InputState: @unchecked Sendable { var consumed = false }
                    let inputState = InputState()
                    converter.convert(to: outputBuffer, error: &error) { _, outStatus in
                        if inputState.consumed {
                            outStatus.pointee = .noDataNow
                            return nil
                        }
                        inputState.consumed = true
                        outStatus.pointee = .haveData
                        return buffer
                    }
                    if let error {
                        logger.warning("Mic resample error: \(error)")
                    } else {
                        try self.outputFile?.write(from: outputBuffer)
                        self.forwardToLiveSink(buffer: outputBuffer)
                    }
                } else {
                    try self.outputFile?.write(from: buffer)
                    self.forwardToLiveSink(buffer: buffer)
                }
            } catch {
                logger.warning("Mic write error: \(error)")
            }
        }

        engine.prepare()
        try engine.start()
        isRecording = true
        logger.info("Mic recording started: \(self.outputURL.lastPathComponent)")
    }

    private func installDeviceChangeListener() {
        guard deviceChangeListener == nil else { return }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.handleDefaultInputDeviceChanged()
        }
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultInputAddress,
            DispatchQueue.main,
            listener,
        )
        if status == noErr {
            deviceChangeListener = listener
            logger.info("Mic: listening for default input device changes")
        } else {
            logger.warning("Failed to install device change listener (status: \(status))")
        }
    }

    /// Listen for AVAudioEngine configuration changes (format changes on current device).
    private func installConfigChangeObserver() {
        guard configChangeObserver == nil else { return }
        configChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main,
        ) { [weak self] _ in
            self?.handleEngineConfigChange()
        }
        logger.info("Mic: listening for engine configuration changes")
    }

    private func handleEngineConfigChange() {
        logger.info("Mic: engine configuration changed (format/route change)")
        handleDeviceChange()
    }

    private func handleDefaultInputDeviceChanged() {
        logger.info("Mic: default input device changed")
        handleDeviceChange()
    }

    /// Called from the device-change / config-change listeners (on the main
    /// queue). Hops onto `captureControl` so the coalescer and the restart
    /// serialize with the tap lifecycle and never race the listeners.
    private func handleDeviceChange() {
        captureControl.async { [weak self] in
            guard let self else { return }
            self.applyCoalescer(self.restartCoalescer.handle(.deviceChanged(at: Date())))
        }
    }

    private func applyCoalescer(_ action: MicRestartCoalescer.Action) {
        switch action {
        case .ignore:
            break
        case let .scheduleDebounce(at):
            scheduleDebounce(at: at)
        case .restart:
            evaluateAndRestart()
        }
    }

    private func scheduleDebounce(at deadline: Date) {
        pendingRestart?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.applyCoalescer(self.restartCoalescer.handle(.debounceElapsed(at: Date())))
        }
        pendingRestart = item
        let delay = max(0, deadline.timeIntervalSinceNow)
        restartScheduler(delay, item)
    }

    /// Re-evaluate the restart decision at fire time — device availability may
    /// have changed during the debounce window — then restart if still warranted.
    private func evaluateAndRestart() {
        let isDeviceAvailable = selectedDeviceUID.map { Self.deviceIDForUID($0) != kAudioObjectUnknown } ?? false
        let action = MicRestartPolicy.decideRestart(
            isRecording: isRecording,
            isRestarting: isRestarting,
            selectedDeviceUID: selectedDeviceUID,
            isSelectedDeviceAvailable: isDeviceAvailable,
        )
        switch action {
        case let .restart(deviceUID):
            executeRestart(deviceUID: deviceUID)
        case .skip:
            break
        }
    }

    private func executeRestart(deviceUID: String?) {
        isRestarting = true
        defer { isRestarting = false }

        if deviceUID == nil, let uid = selectedDeviceUID {
            logger.warning("Mic: selected device '\(uid)' no longer available, falling back to system default")
        }

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine.reset()

        if let observer = configChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            configChangeObserver = nil
        }

        // AVAudioEngine can be in a bad state after config change — must recreate.
        // Hold a strong reference to the old engine for a grace period so any
        // in-flight `AVAudioIOUnit::IOUnitPropertyListener` blocks that
        // AVFoundation queued on a libdispatch worker fire against a live
        // object. Without this hold, dropping the last reference here races
        // against those blocks and crashes with EXC_BAD_ACCESS in
        // `objc_msgSend` on the freed engine.
        let oldEngine = engine
        engine = AVAudioEngine()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            _ = oldEngine
        }

        do {
            // startEngine resets converter/resampleRatio/converterInputRate to
            // the lazy initial state, so the first post-restart buffer rebuilds
            // the converter from its ACTUAL delivered rate — no reliance on
            // startEngine pre-building the converter from a queried hw format.
            try startEngine(deviceUID: deviceUID)
            let hwRate = engine.inputNode.outputFormat(forBus: 0).sampleRate
            if hwRate <= 0 {
                logger.warning("Mic: hardware format rate is \(hwRate) after restart — may produce incorrect audio")
            }
            installConfigChangeObserver()
            logger.info("Mic: engine restarted on \(deviceUID != nil ? "selected" : "default") device (\(Int(hwRate)) Hz)")
        } catch {
            isRecording = false
            logger.error("Failed to restart mic after device change: \(error)")
        }
    }

    public func stop() {
        // Set isRecording=false first so any in-flight tap closure short-circuits
        // before touching the soon-released AVAudioFile.
        isRecording = false
        if let listener = deviceChangeListener {
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &defaultInputAddress,
                DispatchQueue.main,
                listener,
            )
            deviceChangeListener = nil
        }
        if let observer = configChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            configChangeObserver = nil
        }
        // Cancel any pending/in-flight coalesced restart before tearing the
        // engine down. Listeners are already removed, so no new restart can be
        // scheduled; the sync barrier drains any restart currently running on
        // `captureControl`, and cancelling `pendingRestart` drops a scheduled
        // one. (Even a slipped-through debounce would no-op: `isRecording` is
        // now false, so `MicRestartPolicy` returns `.skip`.)
        captureControl.sync {
            pendingRestart?.cancel()
            pendingRestart = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine.reset()
        outputFile = nil

        // Mirror the retain-grace from executeRestart: if the caller drops
        // MicCaptureHandler immediately after stop() returns, the engine
        // ivar's last reference would race against any in-flight
        // AVAudioIOUnit::IOUnitPropertyListener block AVFoundation queued
        // on a libdispatch worker. Holding a local ref for 500 ms lets
        // those blocks fire against a live object.
        let retainedEngine = engine
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            _ = retainedEngine
        }
        logger.info("Mic recording stopped")
    }
}

// MARK: - Debug logging helpers

extension MicCaptureHandler {
    /// Publish the most recent per-buffer dBFS reading so UI consumers
    /// (menu bar level indicator) can poll it. Called from the
    /// AVAudioEngine tap callback after `accumulateDebugRMS`.
    func publishCurrentLevel() {
        levelPublisher.publish(level: debugRMS.lastLevelDBFS)
    }

    /// Sum squares across all channels of an AVAudioPCMBuffer into the shared
    /// reporter. AVAudioEngine taps deliver float buffers in practice; the int16
    /// branch is a safety net.
    func accumulateDebugRMS(buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frames > 0, channelCount > 0 else { return }
        let sumSq: Double
        if let floatData = buffer.floatChannelData {
            sumSq = sumOfSquaresFloat(floatData, frames: frames, channels: channelCount)
        } else if let int16Data = buffer.int16ChannelData {
            sumSq = sumOfSquaresInt16(int16Data, frames: frames, channels: channelCount)
        } else {
            return
        }
        debugRMS.add(sumSq: sumSq, samples: frames * channelCount)
    }

    /// Drain the 5-s throttle and emit one RMS-energy log line per tick, but
    /// only when `debugLogging` is on. The drain itself runs unconditionally
    /// so the reporter's accumulators stay bounded for long sessions.
    func maybeReportDebugRMS() {
        guard let report = debugRMS.tick() else { return }
        guard debugLogging else { return }
        let dBStr = String(format: "%.1f", report.dBFS)
        logger.info(
            "[debug] Mic RMS (5s): \(dBStr, privacy: .public) dBFS, samples=\(report.samples, privacy: .public)",
        )
    }

    /// Hand the freshly-written PCM buffer (mono Float32 at file rate, typically
    /// 16 kHz post-resample) to the optional live sink. Short-circuits when no
    /// sink is installed.
    func forwardToLiveSink(buffer: AVAudioPCMBuffer) {
        guard let sink = liveSink else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channelData = buffer.floatChannelData else { return }
        let ptr = channelData[0]
        let samples = Array(UnsafeBufferPointer(start: ptr, count: frames))
        sink(LiveAudioBuffer(
            samples: samples,
            channelCount: Int(buffer.format.channelCount),
            sampleRate: Int(buffer.format.sampleRate),
            hostTime: mach_absolute_time(),
        ))
    }
}

private func sumOfSquaresFloat(
    _ data: UnsafePointer<UnsafeMutablePointer<Float>>, frames: Int, channels: Int,
) -> Double {
    var sumSq: Double = 0
    for ch in 0 ..< channels {
        let ptr = data[ch]
        for i in 0 ..< frames {
            sumSq += Double(ptr[i]) * Double(ptr[i])
        }
    }
    return sumSq
}

private func sumOfSquaresInt16(
    _ data: UnsafePointer<UnsafeMutablePointer<Int16>>, frames: Int, channels: Int,
) -> Double {
    let scale = 1.0 / 32768.0
    var sumSq: Double = 0
    for ch in 0 ..< channels {
        let ptr = data[ch]
        for i in 0 ..< frames {
            let s = Double(ptr[i]) * scale
            sumSq += s * s
        }
    }
    return sumSq
}

public enum MicCaptureError: LocalizedError {
    case noInputDevice

    public var errorDescription: String? {
        switch self {
        case .noInputDevice: "No microphone hardware available"
        }
    }
}
