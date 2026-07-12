// swiftlint:disable file_length
import AppKit
import AudioTapLib
import Foundation
import MTPipelineCore
import Observation
import os.log

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "AppState")

// MARK: - AppNotifying

/// Notification abstraction that keeps AppKit out of AppState.
///
/// Real implementation: `NotificationManager` (AppKit, used in menu bar app).
/// Test implementation: `RecordingNotifier` (records calls, no side effects).
protocol AppNotifying {
    func notify(title: String, body: String)
}

// MARK: - AppState

/// Observable ViewModel that owns all business state and derived UI properties.
///
/// Extracted from `MeetingTranscriberApp` so that:
/// - Badge/watching logic is testable without instantiating the `@main` App struct.
/// - `BadgeKind.compute(...)` can be called directly in tests.
@Observable
@MainActor
final class AppState { // swiftlint:disable:this type_body_length
    // MARK: - Dependencies

    let settings: AppSettings
    let whisperKit: WhisperKitEngine
    let parakeetEngine: ParakeetEngine
    private let notifier: any AppNotifying

    // MARK: - State

    var watchLoop: WatchLoop?
    var pipelineQueue: PipelineQueue
    var updateChecker: UpdateChecker
    var selectedNamingJobID: UUID?
    var permissionHealth: HealthCheckResult?

    /// True while the **mic** channel is silent and the app channel is carrying
    /// speech continuously for `settings.asymmetricSilenceWarningSeconds`. Drives
    /// the menu-bar **top-half** red tint. Latches until the dead channel recovers
    /// (or recording stops). At most one of `micSilentActive` / `appSilentActive`
    /// is true at a time — the monitor's channel-switch path resets when roles flip.
    var micSilentActive: Bool = false

    /// True while the **app-audio** channel is silent and the mic is carrying
    /// speech continuously for `settings.asymmetricSilenceWarningSeconds`. Drives
    /// the menu-bar **bottom-half** red tint.
    var appSilentActive: Bool = false

    /// True while **both** capture channels have been below the silence
    /// threshold continuously for `settings.asymmetricSilenceWarningSeconds`
    /// — the failure mode `ChannelHealthMonitor` intentionally ignores
    /// (symmetric silence). Drives the menu-bar **full red** waveform
    /// (both halves tinted simultaneously).
    var recordingSilentActive: Bool = false

    /// Pure state machine driven by the 10-Hz level poll while recording. Lives
    /// here (not on WatchLoop) so its lifecycle outlasts a single recording —
    /// observers of `micSilentActive` / `appSilentActive` keep their identity across the
    /// detect → record → process state churn.
    @ObservationIgnored private var channelHealthMonitor = ChannelHealthMonitor()

    /// Sibling monitor that catches the symmetric-silence case
    /// `ChannelHealthMonitor` intentionally skips. Shares the same
    /// debounce threshold; lifecycle managed alongside the channel-health
    /// monitor in `startChannelHealthMonitoring` / `stopChannelHealthMonitoring`.
    @ObservationIgnored private var silentRecordingMonitor = SilentRecordingMonitor()

    @ObservationIgnored private var levelMonitorTask: Task<Void, Never>?

    /// PoC live-transcription controller. Lazily created on first recording
    /// start where `settings.liveTranscriptionEnabled` is true AND the active
    /// engine is Parakeet (other engines silently no-op via
    /// `TranscriptionError.streamingNotSupported`). Kept across recordings so
    /// engine + VAD models stay warm.
    @ObservationIgnored private var liveTranscriptionController: LiveTranscriptionController?

    /// Observable state for the live caption overlay. Always present (the
    /// `LiveCaptionsOverlay` window observes this); content is only populated
    /// when live transcription is on AND a recording is active.
    let liveCaptions: LiveCaptionsState = .init()

    #if !APPSTORE
        /// Lazy-started debug RPC server. Only constructed if the env var is
        /// set — otherwise `nil` and zero overhead.
        var debugRPCServer: DebugRPCServer?

        /// Background `log stream` subprocess that mirrors our subsystems to
        /// `~/Library/Logs/MeetingTranscriber/diagnostics-YYYY-MM-DD.log`.
        /// Survives longer than OSLogStore retention (~1h for `.info`).
        private(set) var persistentLogStreamer: PersistentDiagnosticLog.Streamer?
    #endif

    // MARK: - Init

    init(
        settings: AppSettings = AppSettings(),
        whisperKit: WhisperKitEngine? = nil,
        parakeetEngine: ParakeetEngine? = nil,
        notifier: any AppNotifying = SilentNotifier(),
        updateChecker: UpdateChecker? = nil,
    ) {
        self.settings = settings
        self.whisperKit = whisperKit ?? WhisperKitEngine()
        self.parakeetEngine = parakeetEngine ?? ParakeetEngine()
        self.notifier = notifier
        self.updateChecker = updateChecker ?? UpdateChecker()
        self.pipelineQueue = PipelineQueue()
        self.channelHealthMonitor = ChannelHealthMonitor(
            debounceSeconds: settings.asymmetricSilenceWarningSeconds,
        )
        self.silentRecordingMonitor = SilentRecordingMonitor(
            debounceSeconds: settings.asymmetricSilenceWarningSeconds,
        )

        #if !APPSTORE
            // E2E hook: force a per-channel flag on at launch so a driver
            // script can assert the menu-bar red-tint pipeline end-to-end
            // without orchestrating real audio. Only honoured in non-AppStore
            // builds and only when explicitly enabled via env var. The driver
            // is also expected to set `MEETINGTRANSCRIBER_DEBUG_SUPPRESS_AUTOWATCH=1`
            // so an auto-watch state transition doesn't clear the flag at +3 s
            // through the regular `stopChannelHealthMonitoring()` path.
            let env = ProcessInfo.processInfo.environment
            if env["MEETINGTRANSCRIBER_DEBUG_FORCE_MIC_SILENT"] == "1" {
                micSilentActive = true
            }
            if env["MEETINGTRANSCRIBER_DEBUG_FORCE_APP_SILENT"] == "1" {
                appSilentActive = true
            }
            if env["MEETINGTRANSCRIBER_DEBUG_FORCE_RECORDING_SILENT"] == "1" {
                recordingSilentActive = true
            }
        #endif

        // Bring engines in line with the current settings up front so the
        // first transcription doesn't run against stale defaults, then
        // start observing for runtime changes.
        syncLanguageSettings()
        observeEngineSettings()
        setupLiveTranscriptionPrewarm()

        #if !APPSTORE
            // Env var force-enables at launch only — preserves back-compat with
            // scripts/test_rpc.sh and CI. After init, settings.debugRPCEnabled
            // is the sole driver, so toggling off mid-session works even when
            // the env var was set at launch.
            if DebugRPCServer.enabled || settings.debugRPCEnabled {
                startDebugRPCServer()
            }
            observeDebugRPCSetting()

            PersistentDiagnosticLog.cleanup()
            do {
                self.persistentLogStreamer = try PersistentDiagnosticLog.startForToday()
            } catch {
                Logger(subsystem: AppPaths.logSubsystem, category: "AppState")
                    .error("persistent_log_streamer_failed_to_start error=\(error.localizedDescription, privacy: .public)")
                self.persistentLogStreamer = nil
            }
            // Stop the streamer cleanly when the app terminates so the file
            // handle flushes and the child `log` process exits. Done via
            // NotificationCenter rather than a SwiftUI `.onReceive` so the
            // observer doesn't churn through the SwiftUI modifier-chain
            // `#if APPSTORE` minefield.
            // AppState lives for the entire process lifetime, so leaking
            // this notification observer until app exit is intentional —
            // there's no point removing it in a deinit that won't run.
            // swiftlint:disable:next discarded_notification_center_observer
            NotificationCenter.default.addObserver(
                forName: NSApplication.willTerminateNotification,
                object: nil, queue: .main,
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.stopPersistentLogStreamer()
                }
            }
        #endif
    }

    #if !APPSTORE
        /// Stop the persistent log streamer cleanly. Called from the
        /// `NSApplication.willTerminateNotification` handler.
        func stopPersistentLogStreamer() {
            persistentLogStreamer?.stop()
            persistentLogStreamer = nil
        }
    #endif

    #if !APPSTORE
        /// Reconcile the debug RPC server with the current setting.
        ///
        /// Called only from the settings-driven `observeDebugRPCSetting` path
        /// (init has its own gate). On a toggle off → on we rotate the bearer
        /// token before starting the listener: that way any token an attacker
        /// scraped while the server was previously running is invalidated by
        /// the act of turning it off and on again — the same gesture a user
        /// already performs to "reset" the feature.
        func applyDebugRPCSetting() {
            if settings.debugRPCEnabled, debugRPCServer == nil {
                DebugRPCServer.rotateToken()
                startDebugRPCServer()
            } else if !settings.debugRPCEnabled, let server = debugRPCServer {
                server.stop()
                debugRPCServer = nil
            }
        }

        private func startDebugRPCServer() {
            let snapshot: () -> RPCStateSnapshot = { [weak self] in
                self?.rpcStateSnapshot() ?? RPCStateSnapshot.empty
            }
            let skipNaming: () -> Void = { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    // Snapshot the pending job IDs and iterate the snapshot.
                    // Avoids infinite-loop hazard if completeSpeakerNaming
                    // ever short-circuits without transitioning state (e.g.
                    // missing speakerNamingDataByJob entry → early return,
                    // pending list unchanged) — observed live during E2E
                    // when the data dictionary was already cleared by an
                    // earlier skip race.
                    let pendingIDs = self.pipelineQueue.pendingSpeakerNamingJobs.map(\.id)
                    for jobID in pendingIDs {
                        self.pipelineQueue.completeSpeakerNaming(jobID: jobID, result: .skipped)
                    }
                }
            }
            // RPC counterpart to the NSOpenPanel "Open from Recording" flow.
            // Validates the file exists (RPC layer returns 400 on `false`),
            // then routes through the same `enqueueFiles` entry point the
            // menu uses, so the import code path is identical.
            let enqueueFile: (URL) -> Bool = { [weak self] url in
                guard let self, FileManager.default.fileExists(atPath: url.path) else { return false }
                Task { @MainActor in self.enqueueFiles([url]) }
                return true
            }
            let enqueueFilesRPC: ([URL]) -> Int = { [weak self] urls in
                self?.enqueueExistingFiles(urls) ?? 0
            }
            let server = DebugRPCServer(
                snapshot: snapshot,
                speakerActions: makeSpeakerDBActions(),
                skipNaming: skipNaming,
                enqueueFile: enqueueFile,
                enqueueFiles: enqueueFilesRPC,
            )
            server.start()
            debugRPCServer = server
        }

        /// `withObservationTracking` is one-shot — re-arm after each fire so
        /// the AppState reacts to every toggle of `settings.debugRPCEnabled`,
        /// not just the first one.
        private func observeDebugRPCSetting() {
            withObservationTracking {
                _ = settings.debugRPCEnabled
            } onChange: { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    self.applyDebugRPCSetting()
                    self.observeDebugRPCSetting()
                }
            }
        }
    #endif

    /// The active transcription engine based on the current settings.
    var activeTranscriptionEngine: any TranscribingEngine {
        switch settings.transcriptionEngine {
        case .parakeet:
            parakeetEngine

        case .whisperKit:
            whisperKit
        }
    }

    // MARK: - Derived properties

    var isWatching: Bool {
        watchLoop?.isActive == true && watchLoop?.isManualRecording == false
    }

    /// True when the caption-bar overlay should be visible: live transcription
    /// toggle on, engine implements `transcribeSamples`, and an actual
    /// recording is in progress.
    var shouldShowLiveCaptions: Bool {
        settings.liveTranscriptionEnabled
            && settings.transcriptionEngine.supportsLiveTranscription
            && watchLoop?.state == .recording
    }

    var currentBadge: BadgeKind {
        BadgeKind.compute(
            watchLoopActive: watchLoop?.isActive == true,
            watchLoopState: watchLoop?.state ?? .idle,
            transcriberState: watchLoop?.transcriberState ?? .idle,
            activeJobState: pipelineQueue.activeJobs.first?.state,
            updateAvailable: updateChecker.availableUpdate != nil,
            permissionProblem: permissionHealth?.isHealthy == false,
        )
    }

    var currentStateLabel: String {
        if let loop = watchLoop, loop.isActive {
            return loop.transcriberState.label
        }
        return "Idle"
    }

    private static let isoFormatter = ISO8601DateFormatter()

    var currentStatus: TranscriberStatus? {
        guard let loop = watchLoop, loop.isActive else { return nil }

        let meeting: MeetingInfo? = if let manual = loop.manualRecordingInfo {
            MeetingInfo(
                app: manual.appName,
                title: manual.title,
                pid: Int(manual.pid),
            )
        } else {
            loop.currentMeeting.map { meeting in
                MeetingInfo(
                    app: meeting.pattern.appName,
                    title: meeting.windowTitle,
                    pid: Int(meeting.windowPID),
                )
            }
        }

        return TranscriberStatus(
            version: 1,
            timestamp: Self.isoFormatter.string(from: Date()),
            state: loop.transcriberState,
            detail: loop.detail,
            meeting: meeting,
            protocolPath: nil,
            error: loop.lastError,
            audioPath: nil,
            pid: Int(ProcessInfo.processInfo.processIdentifier),
        )
    }

    // MARK: - Live transcription factory

    /// Build the `recorderFactory` closure for `WatchLoop`. Returns a fresh
    /// `DualSourceRecorder` on each invocation; when `liveTranscriptionEnabled`
    /// is on AND the active engine supports `transcribeSamples`, also installs
    /// mic + app live sinks that pipe captured buffers to the
    /// `LiveTranscriptionController`. PoC scope — see
    /// `LiveTranscriptionController` doc for what's logged.
    private func makeRecorderFactory() -> @MainActor () -> any RecordingProvider {
        { [weak self] in
            let recorder = DualSourceRecorder()
            guard let self else { return recorder }
            if self.settings.liveTranscriptionEnabled,
               self.settings.transcriptionEngine.supportsLiveTranscription,
               let controller = self.ensureLiveTranscriptionController() {
                controller.reset()
                recorder.micLiveSink = controller.micSink
                recorder.appLiveSink = controller.appSink
            }
            return recorder
        }
    }

    /// Lazily create + warm the live transcription controller against the
    /// currently-active engine. Safe to call repeatedly — `prepare()` is
    /// idempotent (engines dedupe concurrent `loadModel` calls). When the
    /// transcription-engine setting changes, the controller is invalidated
    /// via `observeEngineSettings` so the next call rebuilds against the
    /// new engine.
    ///
    /// Returns nil when the active engine doesn't conform to
    /// `StreamingTranscribingEngine` — the static equivalent of the
    /// `supportsLiveTranscription` enum-level gate. Both `prewarm…` and
    /// `makeRecorderFactory` callers already check that gate before
    /// invoking this, so a nil return here only happens if a regression
    /// breaks one of those guards.
    private func ensureLiveTranscriptionController() -> LiveTranscriptionController? {
        if let existing = liveTranscriptionController { return existing }
        guard let streamingEngine = activeTranscriptionEngine as? any StreamingTranscribingEngine else {
            return nil
        }
        let controller = LiveTranscriptionController(
            engine: streamingEngine,
            vad: FluidVAD(threshold: 0.5),
            captions: liveCaptions,
        ) { [weak self] in
            self?.settings.verboseDiagnostics ?? false
        }
        liveTranscriptionController = controller
        Task { @MainActor in await controller.prepare() }
        return controller
    }

    // MARK: - Start / Stop

    func toggleWatching() {
        if let loop = watchLoop, loop.isManualRecording { return }
        if let loop = watchLoop, loop.isActive {
            loop.stop()
            watchLoop = nil
        } else {
            Task { @MainActor in
                _ = await Permissions.ensureMicrophoneAccess()

                syncLanguageSettings()
                pipelineQueue = makePipelineQueue()

                var subDetectors: [any MeetingDetecting] = [PowerAssertionDetector()]
                if settings.watchGoogleMeet {
                    // Reliable browser-meeting trigger first: Mintr (Electron) writes a
                    // signal file when its all-tabs Chrome probe sees a live Meet, which
                    // works no matter which tab/window is frontmost. The window-title
                    // detector below only sees the frontmost Chrome tab, so it stays as a
                    // fallback for when the Meet happens to be foregrounded.
                    subDetectors.append(ElectronSignalDetector())
                    subDetectors.append(MeetingDetector(patterns: [.googleMeet]))
                }
                let detector: any MeetingDetecting = CompositeMeetingDetector(subDetectors)

                let loop = WatchLoop(
                    detector: detector,
                    recorderFactory: makeRecorderFactory(),
                    pipelineQueue: pipelineQueue,
                    pollInterval: settings.pollInterval,
                    endGracePeriod: settings.endGrace,
                    noMic: { [settings] in settings.noMic },
                    micDeviceUID: settings.micDeviceUID.isEmpty ? nil : settings.micDeviceUID,
                    verboseDiagnostics: { [settings] in settings.verboseDiagnostics },
                    recordOnly: { [settings] in settings.recordOnly },
                    recordOnlyDestination: { [settings] in
                        .production(parent: settings.effectiveOutputDir)
                    },
                    recordScreenVideo: { [settings] in settings.recordScreenVideo },
                    screenRecorderFactory: { ScreenRecorder(outputURL: $0, windowHint: $1) },
                    notifier: notifier,
                    applyEngineConfig: { [weak self] cfg in self?.applyBridgeConfigToEngines(cfg) },
                )

                attachStateChangeHandler(to: loop, notifyOnRecording: true)

                if let health = permissionHealth {
                    loop.permissionChecker = { health }
                }

                configurePipelineCallbacks()

                watchLoop = loop
                loop.start()
            }
        }
    }

    func startManualRecording(pid: pid_t, appName: String, title: String) {
        // Stop auto-watch if active
        if let loop = watchLoop, loop.isActive, !loop.isManualRecording {
            loop.stop()
            watchLoop = nil
        }

        Task { @MainActor in
            _ = await Permissions.ensureMicrophoneAccess()

            ensurePipelineQueue()

            let loop = WatchLoop(
                recorderFactory: makeRecorderFactory(),
                pipelineQueue: pipelineQueue,
                pollInterval: settings.pollInterval,
                noMic: { [settings] in settings.noMic },
                micDeviceUID: settings.micDeviceUID.isEmpty ? nil : settings.micDeviceUID,
                verboseDiagnostics: { [settings] in settings.verboseDiagnostics },
                recordOnly: { [settings] in settings.recordOnly },
                recordOnlyDestination: { [settings] in
                    .production(parent: settings.effectiveOutputDir)
                },
                recordScreenVideo: { [settings] in settings.recordScreenVideo },
                screenRecorderFactory: { ScreenRecorder(outputURL: $0, windowHint: $1) },
                notifier: notifier,
            )
            watchLoop = loop

            // Wire channel-health monitoring + error notification on state
            // transitions — same hook the auto-detect path installs, so the
            // red-tint indicator and asymmetric-silence notification work
            // for manual recordings too.
            attachStateChangeHandler(to: loop, notifyOnRecording: false)

            // Use cached health check result instead of live probe
            if let health = permissionHealth {
                loop.permissionChecker = { health }
            }

            do {
                try await loop.startManualRecording(pid: pid, appName: appName, title: title)
                notifier.notify(
                    title: "Manual Recording",
                    body: "Recording: \(title)",
                )
            } catch {
                notifier.notify(title: "Error", body: error.localizedDescription)
                watchLoop = nil
            }
        }
    }

    func stopManualRecording() {
        // WatchLoop.stopManualRecording is async (it awaits the screen-video
        // finalize). Capture the loop, clear the reference synchronously so the
        // UI reflects the stop immediately, then finalize on a @MainActor Task.
        let loop = watchLoop
        watchLoop = nil
        Task { @MainActor in
            await loop?.stopManualRecording()
        }
    }

    // MARK: - Graceful Shutdown

    /// Short deadline for the NON-finalize teardown tail (pipeline snapshot flush +
    /// log streamer stop). Kept under Electron's 8 s kill-escalation budget so a
    /// stuck tail self-exits via SIGTERM well before Electron reaches SIGKILL. The
    /// finalize itself is bounded separately by `finalizeShutdownCapSeconds`.
    static let shutdownDeadlineSeconds: Double = 5

    /// Generous ceiling on how long a graceful shutdown lets the recording finalize
    /// (whole-file load + resample + mix) run before the engine force-exits. The
    /// finalize now runs OFF the main actor with the heartbeat still beating, so
    /// this is NOT the wedge deadline (that's `shutdownDeadlineSeconds`, applied to
    /// the non-finalize tail) — it only bounds a legitimately long mix on a
    /// multi-hour meeting so an engine that outlives its Electron parent still
    /// self-terminates eventually. Electron's stop-escalation extends its own grace
    /// to the same order of magnitude while the heartbeat advertises `processing`;
    /// keep the two coupled if either changes.
    static let finalizeShutdownCapSeconds: Double = 1800 // 30 minutes

    private enum ShutdownPhase { case idle, inProgress, done }
    @ObservationIgnored private var shutdownPhase: ShutdownPhase = .idle
    @ObservationIgnored private var terminationSignalSources: [any DispatchSourceProtocol] = []

    /// Install SIGTERM + SIGINT handlers that drive `gracefulShutdown()`.
    /// Idempotent. Called once at app launch from the scene, NOT from `init`,
    /// so unit tests and CLI targets that construct `AppState` directly never
    /// install process-global signal handlers.
    func installTerminationSignalHandlers() {
        guard terminationSignalSources.isEmpty else { return }
        for sig in [SIGTERM, SIGINT] {
            // Ignore the default disposition so the dispatch source — not the
            // kernel's default terminate action — observes the signal.
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in
                    await self?.gracefulShutdown()
                }
            }
            source.resume()
            terminationSignalSources.append(source)
        }
        logger.info("Termination signal handlers installed (SIGTERM, SIGINT)")
    }

    /// Ordered, bounded shutdown: tear the watch loop down (destroying the
    /// CoreAudio tap and finalizing any in-flight recording), flush the
    /// pipeline snapshot, then terminate. Bounded by `shutdownDeadlineSeconds`:
    /// if the teardown wedges (e.g. a stalled HAL destroy or `replaceItemAt`),
    /// force-exit so a SIGTERM can never leave a zombie engine holding a tap.
    /// Idempotent across the SIGTERM / SIGINT sources.
    func gracefulShutdown() async {
        guard shutdownPhase == .idle else { return }
        shutdownPhase = .inProgress
        // Do NOT delete the heartbeat yet: it must keep beating (as `processing`,
        // via the shutdownPhase check in writeHeartbeat) through the off-main
        // finalize so Electron's stop-escalation extends its grace instead of
        // SIGKILLing a long mix. One immediate write flips the advertised state to
        // `processing` now, closing the window where a concurrent start's reuse
        // probe could still see a fresh `recording`. The file is deleted at the END.
        await writeHeartbeat()
        logger.info("graceful_shutdown starting (finalize cap \(Int(Self.finalizeShutdownCapSeconds))s)")

        // Generous cap on the WHOLE teardown: the finalize legitimately runs for
        // minutes off-main (heartbeat beating), so the short wedge deadline would
        // wrongly kill it — that short deadline is applied ONLY to the non-finalize
        // tail inside performOrderedTeardown. onTimeout force-exits on the deadline
        // task itself, i.e. OFF the (possibly wedged) main actor, so a stuck main
        // can never prevent the self-terminate.
        let outcome = await raceAgainstDeadline(
            seconds: Self.finalizeShutdownCapSeconds,
            onTimeout: {
                logger.error("graceful_shutdown exceeded the finalize cap — forcing exit(0)")
                exit(0)
            },
        ) { [weak self] in
            await self?.performOrderedTeardown()
        }

        // Teardown finished. Stop refreshing + delete the heartbeat now so a later
        // Electron start can't reuse this dying engine.
        stopEngineHeartbeat()
        shutdownPhase = .done
        switch outcome {
        case .completed:
            logger.info("graceful_shutdown complete — terminating")
            NSApp.terminate(nil)

        case .timedOut:
            // onTimeout already force-exited off-main; belt-and-suspenders.
            logger.error("graceful_shutdown timed out — forcing exit(0)")
            exit(0)
        }
    }

    /// Teardown order: finalize the in-flight recording FIRST via
    /// `WatchLoop.shutdown()` (the existing single-flight stop machinery; its heavy
    /// mix runs off-main, bounded by the gracefulShutdown-level finalize cap), then
    /// the non-finalize tail — pipeline snapshot flush + log streamer stop — bounded
    /// by the SHORT wedge deadline, because the recording is already safe and a
    /// stuck flush should proceed to exit rather than wait out the finalize cap.
    private func performOrderedTeardown() async {
        let loop = watchLoop
        watchLoop = nil
        await loop?.shutdown()
        _ = await raceAgainstDeadline(seconds: Self.shutdownDeadlineSeconds) { [weak self] in
            await self?.flushNonFinalizeState()
        }
        logger.info("graceful_shutdown: ordered teardown finished")
    }

    /// The bounded non-finalize teardown tail: persist the pipeline queue snapshot
    /// so the enqueued job survives the exit, then stop the log streamer.
    private func flushNonFinalizeState() async {
        await pipelineQueue.awaitSnapshotFlush()
        #if !APPSTORE
            stopPersistentLogStreamer()
        #endif
    }

    // MARK: - Engine Heartbeat

    /// Epoch-milliseconds this engine process came up — the heartbeat `startedAt`.
    @ObservationIgnored private let engineStartedAtMillis = EngineHeartbeat.epochMillis(Date())
    @ObservationIgnored private let heartbeatWriter = EngineHeartbeatWriter()
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?

    /// Start the ~2 s engine heartbeat. Idempotent. Runs for the WHOLE process
    /// lifetime (every liveness state, not only recording) so Electron's reuse
    /// probe and supervisor always have a fresh signal. Stopped + the file
    /// deleted at the very start of `gracefulShutdown`.
    func startEngineHeartbeat() {
        guard heartbeatTask == nil else { return }
        heartbeatTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.writeHeartbeat()
                try? await Task.sleep(for: .seconds(EngineHeartbeatWriter.intervalSeconds))
            }
        }
    }

    /// Cancel the beat and delete the heartbeat file (ordered after any pending
    /// write). Called first thing in `gracefulShutdown`.
    func stopEngineHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        heartbeatWriter.stopAndDelete()
    }

    /// Snapshot the current engine state and hand a heartbeat to the writer. The
    /// SCK-liveness read hops through the ScreenRecorder actor; the actual file
    /// write is dispatched off-main by `EngineHeartbeatWriter`, so this tick
    /// never blocks the main thread on disk.
    private func writeHeartbeat() async {
        let phase = watchLoop?.state ?? .idle
        let recorder = watchLoop?.activeRecorder
        let sck = await watchLoop?.currentScreenLiveness()
        // A finalize in flight (its heavy mix now runs off-main with this heartbeat
        // still beating) — or an in-progress graceful shutdown after `watchLoop` is
        // nil'd — advertises `processing` so Electron reads a long mix as busy, not
        // as a wedged `recording` engine.
        let finalizing = (watchLoop?.isFinalizing ?? false) || shutdownPhase == .inProgress
        let heartbeat = EngineHeartbeat(
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            version: Bundle.main.appVersion,
            state: EngineHeartbeat.livenessState(
                watchPhase: phase,
                pipelineProcessing: pipelineQueue.isProcessing,
                finalizing: finalizing,
            ),
            startedAt: engineStartedAtMillis,
            lastIOCallbackAt: recorder?.lastIOCallbackAt.map(EngineHeartbeat.epochMillis),
            lastSCKFrameAt: (sck?.lastFrameAt).map(EngineHeartbeat.epochMillis),
            tapPIDCount: recorder?.tapPIDCount,
            updatedAt: EngineHeartbeat.epochMillis(Date()),
        )
        heartbeatWriter.write(heartbeat)
    }

    // MARK: - HAL Liveness Sentinel

    @ObservationIgnored private var halMonitor: HALLivenessMonitor?

    /// User-facing message when the audio HAL stops responding. Carries the
    /// admin-friendly recovery one-liner — the app never escalates privilege to
    /// run it itself (that would treat the symptom, not the cause).
    nonisolated static let halUnresponsiveMessage: String =
        "macOS audio system has stopped responding. Meetings/browser audio may freeze. "
            + "Fix without restarting: run `sudo killall coreaudiod` in Terminal."

    /// Start the HAL-liveness sentinel (idempotent). Runs only while the engine
    /// is watching/recording. On `.unresponsive` it notifies the user with the
    /// recovery hint and writes a coreaudiod diagnostics snapshot.
    func startHALSentinel() {
        guard halMonitor == nil else { return }
        let monitor = HALLivenessMonitor { [weak self] verdict in
            Task { @MainActor in self?.handleHALVerdict(verdict) }
        }
        monitor.start()
        halMonitor = monitor
    }

    /// Stop the HAL-liveness sentinel. Idempotent.
    func stopHALSentinel() {
        halMonitor?.stop()
        halMonitor = nil
    }

    private func handleHALVerdict(_ verdict: HALLivenessSentinel.Verdict) {
        switch verdict {
        case .unresponsive:
            logger.error("HAL liveness sentinel: coreaudiod unresponsive — notifying + snapshotting")
            notifier.notify(title: "Audio System Unresponsive", body: Self.halUnresponsiveMessage)
            writeHALDiagnosticsSnapshot()

        case .recovered:
            logger.info("HAL liveness sentinel: recovered")

        case .healthy:
            break
        }
    }

    /// Write a coreaudiod-focused diagnostics snapshot to the output dir so a HAL
    /// wedge is attributable after the fact. Runs off the main thread (the
    /// `log show` subprocess can be slow) and wraps a security-scoped access for
    /// the sandboxed build's Output Folder bookmark.
    private func writeHALDiagnosticsSnapshot() {
        guard #available(macOS 12, *) else { return }
        let dir = settings.effectiveOutputDir
        let version = Bundle.main.appVersion
        let commit = Bundle.main.gitCommitHash
        let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        Task.detached(priority: .utility) {
            let accessing = dir.startAccessingSecurityScopedResource()
            defer { if accessing { dir.stopAccessingSecurityScopedResource() } }
            let url = dir.appendingPathComponent(
                "coreaudio-diagnostics-\(Int(Date().timeIntervalSince1970)).log",
            )
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let info = DiagnosticExporter.HeaderInfo(
                    appVersion: version, commit: commit,
                    macOSVersion: osVersion, settings: ["trigger": "hal-unresponsive"],
                )
                let count = try DiagnosticExporter.exportCoreAudioSnapshot(to: url, info: info)
                logger.info(
                    "Wrote HAL diagnostics snapshot (\(count, privacy: .public) lines) to \(url.lastPathComponent, privacy: .public)",
                )
            } catch {
                logger.error("Failed to write HAL diagnostics snapshot: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Filters `urls` to files that currently exist on disk, forwards them to
    /// `enqueueFiles`, and returns the existing count. RPC-friendly entry
    /// point; nil-callers (weak self) treat absent app as 0-enqueued.
    @discardableResult
    func enqueueExistingFiles(_ urls: [URL]) -> Int {
        let existing = urls.filter { FileManager.default.fileExists(atPath: $0.path) }
        guard !existing.isEmpty else { return 0 }
        enqueueFiles(existing)
        return existing.count
    }

    func enqueueFiles(_ urls: [URL]) {
        ensurePipelineQueue()

        let resolution = PairedRecordingResolver.resolve(urls: urls)

        for group in resolution.paired {
            let sidecar = RecordingSidecar.read(
                fromDirectory: group.directory,
                basename: group.stem,
            )
            let title = sidecar?.title ?? group.stem
            let appName = sidecar?.appName ?? "File"
            let micDelay = sidecar?.micDelaySeconds ?? 0
            let participants = sidecar?.participants ?? []

            // For paired groups: pass `group.mix` directly (nil when only app+mic
            // were selected — the pipeline mixes app+mic into the workdir cache
            // on the fly, no persistent `_mix.wav` is written to the user's
            // recordings dir).
            let job = PipelineJob(
                meetingTitle: title, appName: appName,
                mixPath: group.mix, appPath: group.app, micPath: group.mic,
                micDelay: micDelay, participants: participants,
            )
            pipelineQueue.enqueue(job)
        }

        for url in resolution.singletons {
            let title = url.deletingPathExtension().lastPathComponent
            let job = PipelineJob(
                meetingTitle: title,
                appName: "File",
                mixPath: url,
                appPath: nil,
                micPath: nil,
                micDelay: 0,
            )
            pipelineQueue.enqueue(job)
        }
    }

    // MARK: - Channel Health Monitor

    /// Attaches the state-change callback that drives channel-health monitoring
    /// and post-`.error` notifications. Shared between the auto-detect path
    /// (`toggleWatching`) and the manual-recording path (`startManualRecording`)
    /// so the red-tint indicator + asymmetric-silence notification fire in both.
    /// `notifyOnRecording` only fires "Meeting Detected" notifications for the
    /// auto-detect path; manual recording emits its own start notification.
    private func attachStateChangeHandler(to loop: WatchLoop, notifyOnRecording: Bool) {
        loop.onStateChange = { [weak self, weak loop, notifier] _, newState in
            switch newState {
            case .recording:
                if notifyOnRecording, let meeting = loop?.currentMeeting {
                    notifier.notify(
                        title: "Meeting Detected",
                        body: "Recording: \(meeting.windowTitle)",
                    )
                }
                self?.startChannelHealthMonitoring()
                self?.startHALSentinel()

            case .watching:
                // Channel-health only runs during recording, but the HAL sentinel
                // watches the whole active session (watching + recording).
                self?.stopChannelHealthMonitoring()
                self?.startHALSentinel()

            case .error:
                if let err = loop?.lastError {
                    notifier.notify(title: "Error", body: err)
                }
                self?.stopChannelHealthMonitoring()
                self?.stopHALSentinel()

            case .idle:
                self?.stopChannelHealthMonitoring()
                self?.stopHALSentinel()
            }
        }
    }

    /// Rebuilds `channelHealthMonitor` with the current settings-driven debounce.
    /// Called from `startChannelHealthMonitoring` and exposed as a test seam so
    /// `ChannelHealthIntegrationTests` can simulate the "user changed threshold
    /// between recordings" path without spinning up the polling Task.
    func simulateStartChannelHealthMonitoringForTests() {
        rebuildChannelHealthMonitor()
    }

    private func rebuildChannelHealthMonitor() {
        channelHealthMonitor = ChannelHealthMonitor(
            debounceSeconds: settings.asymmetricSilenceWarningSeconds,
        )
        silentRecordingMonitor = SilentRecordingMonitor(
            debounceSeconds: settings.asymmetricSilenceWarningSeconds,
        )
    }

    /// Starts a ~10 Hz polling task that feeds the active recorder's per-channel
    /// levels into `channelHealthMonitor` and flips `micSilentActive` /
    /// `appSilentActive` based on the resulting events. Idempotent: calling while already running
    /// is a no-op. Skips entirely when the master toggle is off.
    private func startChannelHealthMonitoring() {
        guard settings.perChannelIndicatorEnabled else { return }
        guard levelMonitorTask == nil else { return }
        rebuildChannelHealthMonitor()
        levelMonitorTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.tickChannelHealth()
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func tickChannelHealth() {
        guard let recorder = watchLoop?.activeRecorder else { return }
        applyChannelHealthTick(recorder: recorder, now: Date())
    }

    /// Internal test seam: drives one polling tick against an arbitrary
    /// recorder + clock. Production code uses `tickChannelHealth()` which
    /// reads the active recorder + wall clock.
    @discardableResult
    func applyChannelHealthTick(
        recorder: any RecordingProvider,
        now: Date,
    ) -> ChannelHealthEvent? {
        let mic = recorder.micLevelDBFS
        let app = recorder.appLevelDBFS

        let event = channelHealthMonitor.update(micDBFS: mic, appDBFS: app, now: now)
        switch event {
        case let .started(channel, _):
            switch channel {
            case .mic:
                micSilentActive = true
                appSilentActive = false

            case .app:
                appSilentActive = true
                micSilentActive = false
            }
            notifier.notify(
                title: "Capture Channel Silent",
                body: Self.asymmetricSilenceMessage(for: channel),
            )

        case .recovered:
            micSilentActive = false
            appSilentActive = false

        case .none:
            break
        }

        let silentEvent = silentRecordingMonitor.update(micDBFS: mic, appDBFS: app, now: now)
        switch silentEvent {
        case .started:
            recordingSilentActive = true
            notifier.notify(
                title: "Recording Appears Silent",
                body: Self.silentRecordingMessage,
            )

        case .recovered:
            recordingSilentActive = false

        case .none:
            break
        }

        return event
    }

    nonisolated static func asymmetricSilenceMessage(for channel: AudioChannel) -> String {
        switch channel {
        case .app:
            "The app-audio channel went silent while the mic is still carrying audio. "
                + "Check the meeting app's audio settings or system audio permission."

        case .mic:
            "The microphone went silent while the app audio is still recording. "
                + "Check the mic device, mute state, or microphone permission."
        }
    }

    nonisolated static let silentRecordingMessage: String =
        "Both capture channels have been silent since the recording started. "
            + "Check the audio routing — the meeting app may have claimed the mic "
            + "in exclusive mode (e.g. AirPods HFP), or the system input device may be muted."

    /// Stops the polling task and resets the monitor + UI flag. Called when
    /// recording ends or an error transition happens.
    private func stopChannelHealthMonitoring() {
        levelMonitorTask?.cancel()
        levelMonitorTask = nil
        channelHealthMonitor.reset()
        silentRecordingMonitor.reset()
        micSilentActive = false
        appSilentActive = false
        recordingSilentActive = false
    }

    // MARK: - Permission Health

    func handlePermissionHealth(_ result: HealthCheckResult) {
        let previousProblems = permissionHealth?.problems ?? []
        permissionHealth = result
        let line = "[PermissionHealthCheck] screen=\(result.screenRecording) mic=\(result.microphone) " +
            "ax=\(result.accessibility) healthy=\(result.isHealthy) problems=\(result.problems)"
        PermissionHealthCheck.debugLog(line)

        let problems = result.problems
        if !problems.isEmpty, problems != previousProblems {
            PermissionHealthCheck.debugLog("[PermissionHealthCheck] Sending notification: \(result.notificationBody)")
            notifier.notify(
                title: "Permission Problem",
                body: result.notificationBody,
            )
        }
    }

    /// Timestamp of the last completed `checkPermissions()` run. Used to debounce repeated
    /// calls triggered by `NSApplication.didBecomeActiveNotification` so the 500 ms mic
    /// probe doesn't churn the audio HAL on every Cmd-Tab.
    private var lastPermissionCheckAt: Date?

    /// Run the live permission health check.
    ///
    /// - Parameter minimumInterval: if non-nil, skip the run when the last completed check
    ///   happened less than `minimumInterval` seconds ago. The initial startup call passes
    ///   `nil` so it always runs; the `didBecomeActive` handler passes a small value to
    ///   avoid HAL churn on rapid re-activations.
    func checkPermissions(minimumInterval: TimeInterval? = nil) async {
        if let minimumInterval, let last = lastPermissionCheckAt,
           Date().timeIntervalSince(last) < minimumInterval {
            return
        }
        let result = await PermissionHealthCheck.runLive()
        lastPermissionCheckAt = Date()
        handlePermissionHealth(result)
    }

    // MARK: - Pipeline

    /// Push current language/vocabulary settings into the active engine.
    /// Idempotent — each branch only writes when the value actually differs,
    /// so unchanged settings don't churn the engine's `@Observable` watchers.
    private func syncLanguageSettings() {
        switch settings.transcriptionEngine {
        case .whisperKit:
            let next = settings.whisperLanguageOrNil
            if whisperKit.language != next { whisperKit.language = next }

        case .parakeet:
            let nextVocab = settings.customVocabularyPath
            if parakeetEngine.customVocabularyPath != nextVocab { parakeetEngine.customVocabularyPath = nextVocab }
            let nextLang = settings.parakeetLanguageOrNil
            if parakeetEngine.language != nextLang { parakeetEngine.language = nextLang }
        }
    }

    /// Push the fresh per-meeting `EngineConfig` bridge into the live engines.
    /// Wired into `WatchLoop.handleMeeting` (via its `applyEngineConfig` hook)
    /// so Timbre's ASR-language choice takes effect on the next meeting without
    /// rebuilding the pipeline queue — the engines here are the same instances
    /// the queue transcribes with. Empty `asrLanguage` = auto-detect (nil). The
    /// target engine follows the bridge's own engine override when present, else
    /// the local setting.
    func applyBridgeConfigToEngines(_ cfg: EngineConfig) {
        let language = cfg.asrLanguage.isEmpty ? nil : cfg.asrLanguage
        switch cfg.transcriptionEngine ?? settings.transcriptionEngine {
        case .whisperKit:
            if whisperKit.language != language { whisperKit.language = language }
        case .parakeet:
            if parakeetEngine.language != language { parakeetEngine.language = language }
        }
    }

    /// `withObservationTracking` is one-shot — re-arm after each fire so the
    /// AppState reacts to every settings change, not just the first one.
    /// Mirrors the `observeDebugRPCSetting` pattern.
    private func observeEngineSettings() {
        withObservationTracking {
            _ = settings.transcriptionEngine
            _ = settings.whisperLanguage
            _ = settings.customVocabularyPath
            _ = settings.parakeetLanguage
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.syncLanguageSettings()
                self.observeEngineSettings()
            }
        }
    }

    /// Eagerly load the FluidVAD + Parakeet models when the live-transcription
    /// toggle flips on (or is already on at launch with the right engine), so
    /// the first utterance after the recorder starts doesn't pay the cold-load
    /// cost (a few seconds for the first call to `engine.loadModel()` + VAD
    /// init). No-op when the conditions aren't met. Idempotent — the engines
    /// dedupe concurrent `loadModel` calls.
    private func prewarmLiveTranscriptionIfEligible() {
        guard settings.liveTranscriptionEnabled,
              settings.transcriptionEngine.supportsLiveTranscription
        else { return }
        _ = ensureLiveTranscriptionController()
    }

    /// Initial pre-warm of the live-transcription controller (when enabled +
    /// the active engine supports streaming) plus a re-arming
    /// `withObservationTracking` watcher on `liveTranscriptionEnabled` and
    /// `transcriptionEngine`. On every change, drop the cached controller so
    /// the next `ensureLiveTranscriptionController()` call rebuilds against
    /// the (possibly new) `activeTranscriptionEngine` and re-warms the right
    /// engine.
    ///
    /// Engine changes take effect on the **next** recording. Switching the
    /// engine mid-recording deallocates the controller (its sinks capture
    /// `[weak self]`), buffers from the running recorder no longer reach any
    /// engine, and the live overlay goes silent until the recording stops and
    /// a new one starts. Live mid-recording engine swap is a deferred follow-up
    /// — see PR #318 limitations.
    ///
    /// Combined into a single method (rather than two init-body calls) so the
    /// AppState init's type-check stays under the 300 ms `expression_type_check`
    /// lint budget. Same recurring flake as `feedback_local_verify_before_push`
    /// — the compiler's constraint solver gets slower with every method call
    /// inside a long initializer.
    private func setupLiveTranscriptionPrewarm() {
        prewarmLiveTranscriptionIfEligible()
        withObservationTracking {
            _ = settings.liveTranscriptionEnabled
            _ = settings.transcriptionEngine
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.liveTranscriptionController = nil
                self.setupLiveTranscriptionPrewarm()
            }
        }
    }

    func ensurePipelineQueue() {
        guard pipelineQueue.engine == nil else { return }
        pipelineQueue = makePipelineQueue()
        configurePipelineCallbacks()
    }

    /// One-stop FluidDiarizer instantiation. Captures the current tuning
    /// fields from settings so both the global-mode factory and the
    /// per-job mode-override factory stay in sync. Tuning only affects
    /// `.offline` mode, but is harmless when passed to `.sortformer`.
    private func makeFluidDiarizer(mode: DiarizerMode) -> FluidDiarizer {
        FluidDiarizer(
            mode: mode,
            tuning: OfflineDiarizerTuning(
                clusterThreshold: settings.clusterThreshold,
                warmStartFa: settings.warmStartFa,
                warmStartFb: settings.warmStartFb,
                minSegmentDurationSeconds: settings.minSegmentDurationSeconds,
                excludeOverlap: settings.excludeOverlap,
                exposeChunkEmbeddings: false,
            ),
        )
    }

    /// Resolve the transcription engine the bridge asks for, or `nil` when
    /// Timbre supplied no override (the engine keeps its own settings choice).
    private func bridgeEngine(_ cfg: EngineConfig) -> (any TranscribingEngine)? {
        switch cfg.transcriptionEngine {
        case .whisperKit: whisperKit
        case .parakeet: parakeetEngine
        case nil: nil
        }
    }

    func makePipelineQueue() -> PipelineQueue {
        // Read the Electron bridge FRESH so the pipeline built for this watch
        // session honours Timbre's engine / speaker-count / speaker-DB choices.
        // The ASR language is applied per-meeting instead (WatchLoop's
        // `applyEngineConfig` hook) so a mid-session change lands without a
        // pipeline rebuild.
        let cfg = EngineConfig.read()
        let dbPath = AppPaths.resolvedSpeakersDB(bridgeOverride: cfg.globalSpeakersDBPath)
        // One-time merge of the engine's legacy local speakers.json into the
        // shared global DB (no-op unless a bridge path is set + not yet merged).
        SpeakerMatcher.migrateLocalDBIntoGlobalIfNeeded(globalPath: dbPath)
        let numSpeakers = cfg.numSpeakersHint > 0 ? cfg.numSpeakersHint : settings.numSpeakers

        let queue = PipelineQueue(
            engine: bridgeEngine(cfg) ?? activeTranscriptionEngine,
            diarizationFactory: { [self] in makeFluidDiarizer(mode: settings.diarizerMode) },
            diarizationFactoryWithMode: { [self] mode in makeFluidDiarizer(mode: mode) },
            protocolGeneratorFactory: { [self] in makeProtocolGenerator() },
            outputDir: settings.effectiveOutputDir,
            diarizeEnabled: settings.diarize,
            numSpeakers: numSpeakers,
            micLabel: settings.micName,
            speakerMatcherFactory: { SpeakerMatcher(dbPath: dbPath) },
            vadConfig: settings.vadEnabled ? VADConfig(threshold: settings.vadThreshold) : nil,
            recognitionStatsLog: RecognitionStatsLog(),
            // MAX-tier refine: read the tier FRESH per completed job so a
            // mid-session switch to Max accuracy is honoured on the next meeting.
            maxRefinerFactory: { [self] in makeMaxRefiner(globalSpeakersDBPath: dbPath) },
            processingModeProvider: { EngineConfig.read().processingMode },
        )
        queue.loadSnapshot()
        // Fire-and-forget: dir scan + per-file attr probes run off-main so
        // app startup (and the first call to `enqueueFiles`) isn't blocked
        // by a slow filesystem. Recovered jobs appear in `queue.jobs` once
        // the scan returns.
        Task { await queue.recoverOrphanedRecordings() }
        queue.refreshKnownSpeakerNames()
        return queue
    }

    func makeProtocolGenerator() -> (any ProtocolGenerating)? {
        switch settings.protocolProvider {
        #if !APPSTORE
            case .claudeCLI:
                ClaudeCLIProtocolGenerator(claudeBin: settings.claudeBin, language: settings.protocolLanguage)
        #endif

        case .openAICompatible:
            OpenAIProtocolGenerator(
                endpoint: URL(string: settings.openAIEndpoint)
                    ?? URL(string: "http://localhost:11434/v1/chat/completions")!,
                model: settings.openAIModel,
                language: settings.protocolLanguage,
                apiKey: settings.openAIAPIKey.isEmpty ? nil : settings.openAIAPIKey,
            )

        case .none:
            nil
        }
    }

    // MARK: - MAX-tier refiner wiring

    /// Build a `MaxAccuracyPipeline` wired to the concrete engines. AppState is
    /// `@MainActor` (hence implicitly `Sendable`), so the refiner's `@Sendable`
    /// model closures capture `self` and hop back to the main actor to reach the
    /// engines; each hop immediately `await`s the engine's own async work, which
    /// runs off-main, so the UI isn't blocked during the long refine.
    func makeMaxRefiner(globalSpeakersDBPath dbPath: URL) -> MaxAccuracyPipeline {
        return MaxAccuracyPipeline(
            resample16k: { src, dst in try await AudioMixer.resampleFile(from: src, to: dst) },
            transcribeWords: { [self] audio, track in try await refineTranscribe(audio: audio, track: track) },
            diarizeOffline: { [self] audio, numSpeakers, threshold, expose in
                try await refineDiarize(audio: audio, numSpeakers: numSpeakers, clusterThreshold: threshold, exposeChunkEmbeddings: expose)
            },
            detectOverlap: { audio in try await FluidDiarizer(mode: .sortformer).detectOverlapSpans(audioPath: audio) },
            anchorNames: { centroids in
                guard !centroids.isEmpty else { return [:] }
                return SpeakerMatcher(dbPath: dbPath).matchVerbose(embeddings: centroids).mapValues(\.assignedName)
            },
            llmComplete: makeMaxLLMComplete(),
        )
    }

    /// Build the LLM-completion closure for MAX repair from the current
    /// provider settings. The concrete provider is constructed *inside* the
    /// nonisolated `@Sendable` closure from captured Sendable config, so no
    /// non-Sendable value is sent across the actor boundary. `nil` when no
    /// provider is configured → the LLM pass is skipped.
    private func makeMaxLLMComplete() -> (@Sendable (String) async throws -> String)? {
        let language = settings.protocolLanguage
        switch settings.protocolProvider {
        #if !APPSTORE
            case .claudeCLI:
                let claudeBin = settings.claudeBin
                return { prompt in
                    try await ClaudeCLIProtocolGenerator(claudeBin: claudeBin, language: language).complete(prompt: prompt)
                }
        #endif

        case .openAICompatible:
            let endpoint = settings.openAIEndpoint
            let model = settings.openAIModel
            let apiKey = settings.openAIAPIKey
            return { prompt in
                let generator = OpenAIProtocolGenerator(
                    endpoint: URL(string: endpoint) ?? URL(string: "http://localhost:11434/v1/chat/completions")!,
                    model: model,
                    language: language,
                    apiKey: apiKey.isEmpty ? nil : apiKey,
                )
                return try await generator.complete(prompt: prompt)
            }

        case .none:
            return nil
        }
    }

    /// Re-transcribe a durable track for MAX. WhisperKit large-v3-turbo is
    /// forced for both tracks (plan P0); it auto-loads its model on demand.
    private func refineTranscribe(audio: URL, track: WordTimeline.Track) async throws -> [WordTimeline.Word] {
        try await whisperKit.transcribeWords(audioPath: audio, source: track).words
    }

    /// One offline diarization run at a swept cluster threshold, chunk
    /// embeddings optionally exposed for the utterance re-scoring pass.
    private func refineDiarize(
        audio: URL, numSpeakers: Int?, clusterThreshold: Double, exposeChunkEmbeddings: Bool,
    ) async throws -> DiarizationResult {
        let tuning = OfflineDiarizerTuning(
            clusterThreshold: clusterThreshold,
            warmStartFa: settings.warmStartFa,
            warmStartFb: settings.warmStartFb,
            minSegmentDurationSeconds: settings.minSegmentDurationSeconds,
            excludeOverlap: settings.excludeOverlap,
            exposeChunkEmbeddings: exposeChunkEmbeddings,
        )
        return try await FluidDiarizer(mode: .offline, tuning: tuning)
            .run(audioPath: audio, numSpeakers: numSpeakers, meetingTitle: "")
    }

    func configurePipelineCallbacks() {
        pipelineQueue.onJobStateChange = { [notifier] job, _, newState in
            switch newState {
            case .done:
                let title = job.protocolPath != nil ? "Protocol Ready" : "Transcript Saved"
                notifier.notify(title: title, body: job.meetingTitle)

            case .error:
                if let err = job.error {
                    notifier.notify(title: "Error", body: err)
                }

            default:
                break
            }
        }
        pipelineQueue.onRefineComplete = { [notifier] job, report in
            let corrections = report.utteranceReassignments + report.llmLabelsMoved
            notifier.notify(
                title: "Speaker attribution upgraded",
                body: "\(job.meetingTitle): \(report.speakerCount) speakers, \(corrections) corrections",
            )
        }
    }
}

// MARK: - SilentNotifier

/// No-op notifier for CLI targets and tests that don't need notifications.
struct SilentNotifier: AppNotifying {
    func notify(title _: String, body _: String) {}
}
