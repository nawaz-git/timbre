import Atomics
import Foundation
import os.log

private let logger = Logger(subsystem: "com.meetingtranscriber.audiotap", category: "CaptureFileWriter")

/// Drains the app-audio SPSC `AudioRingBuffer` to disk on a dedicated `Thread`, so
/// the CoreAudio CATap IOProc never performs blocking I/O or per-sample math. A
/// plain `Thread` (not GCD) is used deliberately: it is immune to libdispatch pool
/// starvation, which is exactly the failure mode a disk stall would otherwise
/// trigger.
///
/// The writer owns everything that used to run inside the callback: the blocking
/// `write()` loop, the RMS/level computation that feeds `LevelPublisher`, and the
/// peak-abs accumulation that the tap-health watchdog consumes via
/// `takeRecentPeakAbs()`.
///
/// Threading: the drain thread is the ring's sole consumer. `takeRecentPeakAbs()`
/// (called from the health timer on the capture-control queue) and
/// `totalBytesWritten` are the only cross-thread reads and go through atomics — no
/// lock is ever held during the blocking `write()`. `@unchecked Sendable`: the
/// scratch buffer and `debugRMS` are touched only on the drain thread; everything
/// shared is atomic.
///
/// fd ownership: the writer `dup()`s the caller's descriptor at init and writes
/// ONLY through that private copy, and it is the SOLE closer of that copy (in the
/// drain thread, after the last possible write). This severs the writer from the
/// caller's fd lifecycle: when `flushAndClose` times out on a stalled disk, the
/// caller is free to close ITS fd (the session's `FileHandle`) without the kernel
/// reusing that number under a still-blocked drain thread — a resumed write can
/// then only ever land in this capture's own file (its private dup), never in an
/// unrelated file that happened to inherit a reused descriptor.
final class CaptureFileWriter: @unchecked Sendable {
    /// Private `dup()` of the caller's descriptor. The writer writes only through
    /// this copy and is its sole closer (drain thread, after its final flush), so
    /// the caller closing its own fd can never strand a stalled write on a reused
    /// descriptor. `-1` if the `dup()` failed (writes then no-op via EBADF).
    private let ownedFD: Int32
    private let ring: AudioRingBuffer
    private let levelPublisher: LevelPublisher
    private let debugLogging: Bool
    private let drainInterval: TimeInterval
    /// Reused staging buffer for each ring→disk copy. Drain-thread-only.
    private let scratch: UnsafeMutableRawBufferPointer

    private var thread: Thread?
    private let running = ManagedAtomic<Bool>(true)
    /// Set when `flushAndClose` gives up on a stalled write: the drain thread then
    /// issues NO further writes (checked in `drainAll` before every write), so a
    /// timed-out writer that later unblocks writes at most its in-flight chunk and
    /// then exits. Read/written cross-thread → atomic.
    private let aborted = ManagedAtomic<Bool>(false)
    /// Signalled once when the drain thread has fully exited (after its final flush
    /// and closing `ownedFD`).
    private let finished = DispatchSemaphore(value: 0)

    /// Drain-thread-only RMS accumulator (never read off-thread).
    private var debugRMS = DebugRMSReporter()
    /// Total bytes written to disk. Atomic because the stop-path debug log reads it
    /// from the control queue.
    private let totalBytes = ManagedAtomic<UInt64>(0)
    /// Running peak |sample| as a Float bit pattern. The drain thread raises it via
    /// monotonic-max CAS; the health timer takes-and-resets it. Both single-caller,
    /// so the only contention is drain-raise vs timer-reset, which the CAS resolves.
    private let peakBits = ManagedAtomic<UInt32>(0)

    init(
        fd: Int32,
        ring: AudioRingBuffer,
        levelPublisher: LevelPublisher,
        debugLogging: Bool,
        drainInterval: TimeInterval = CaptureTuning.writerDrainInterval,
        scratchBytes: Int = CaptureTuning.writerScratchBytes,
    ) {
        // Own a private copy of the descriptor so the caller's close of ITS fd
        // (and any subsequent kernel reuse of that number) can never redirect a
        // stalled drain write into an unrelated file.
        ownedFD = dup(fd)
        if ownedFD < 0 {
            logger.error("CaptureFileWriter dup(fd) failed (errno=\(errno)) — writes will no-op")
        }
        self.ring = ring
        self.levelPublisher = levelPublisher
        self.debugLogging = debugLogging
        self.drainInterval = drainInterval
        scratch = UnsafeMutableRawBufferPointer.allocate(byteCount: scratchBytes, alignment: 64)
    }

    deinit {
        scratch.deallocate()
        // The drain thread is the sole closer of `ownedFD` once started. Close it
        // here only if the thread was never spawned (created-but-never-started),
        // so a private dup can't leak on that path.
        if thread == nil, ownedFD >= 0 { close(ownedFD) }
    }

    func start() {
        let drainThread = Thread { [weak self] in self?.runLoop() }
        drainThread.name = "audiotap.filewriter"
        drainThread.qualityOfService = .userInitiated
        thread = drainThread
        drainThread.start()
    }

    /// Signal stop, let the thread do one final drain, and wait up to `deadline` for
    /// it to exit. Bounded on purpose: on a stalled disk we return after the
    /// deadline instead of hanging the caller forever (the failure mode of the old
    /// unbounded `writeQueue.sync {}` barrier). The drain thread exits on its own
    /// once the write unblocks; it keeps the ring + scratch alive until then (it
    /// holds a strong self-reference while running), so proceeding is memory-safe.
    ///
    /// On timeout we ALSO latch `aborted`, so a drain thread that later unblocks
    /// writes at most its in-flight chunk (into this capture's own private dup) and
    /// then exits without draining the rest — it never issues fresh writes after
    /// the caller has moved on. The drain thread remains the sole closer of the
    /// private `ownedFD`; this method never closes any descriptor.
    func flushAndClose(deadline: DispatchTime) {
        running.store(false, ordering: .relaxed)
        if finished.wait(timeout: deadline) == .timedOut {
            aborted.store(true, ordering: .relaxed)
            logger.error("CaptureFileWriter flush exceeded deadline — aborting further writes; drain thread will exit (and close its private fd) when the write unblocks")
        }
    }

    /// Whether `flushAndClose` gave up on a stalled write and latched the abort.
    /// Exposed for tests that assert the timed-out-writer contract.
    var isAborted: Bool { aborted.load(ordering: .relaxed) }

    /// Peak |sample| observed since the previous call, then reset to zero. Read by
    /// the tap-health timer each tick.
    func takeRecentPeakAbs() -> Float {
        Float(bitPattern: peakBits.exchange(0, ordering: .relaxed))
    }

    var totalBytesWritten: UInt64 { totalBytes.load(ordering: .relaxed) }
    var droppedBytes: Int { ring.droppedBytes }

    // MARK: - Drain thread

    private func runLoop() {
        while running.load(ordering: .relaxed) {
            drainAll()
            Thread.sleep(forTimeInterval: drainInterval)
        }
        drainAll() // final flush after the stop signal (skipped if aborted)
        // Sole closer of the private dup, after the last possible write — so a
        // stalled-then-resumed thread frees ITS descriptor, never one the caller
        // (or the kernel) has since reassigned.
        if ownedFD >= 0 { close(ownedFD) }
        finished.signal()
    }

    private func drainAll() {
        var didDrain = false
        while true {
            // A timed-out `flushAndClose` latched the abort — issue no further
            // writes so a resumed drain doesn't keep spilling the ring after the
            // caller has moved past teardown.
            if aborted.load(ordering: .relaxed) { break }
            let n = ring.read(into: scratch)
            if n == 0 { break }
            didDrain = true
            if let base = scratch.baseAddress {
                // Re-check right before the blocking write: the abort may have
                // latched while `ring.read` ran.
                if aborted.load(ordering: .relaxed) { break }
                writeAllToFileHandle(ownedFD, base, count: n)
                let stats = Self.analyze(base, byteCount: n)
                debugRMS.add(sumSq: stats.sumSq, samples: stats.samples)
                recordPeak(stats.peakAbs)
            }
            totalBytes.wrappingIncrement(by: UInt64(n), ordering: .relaxed)
            if n < scratch.count { break } // ring drained this pass
        }
        if didDrain {
            levelPublisher.publish(level: debugRMS.lastLevelDBFS)
        }
        maybeReportRMS()
    }

    /// Raise the running peak toward `peak` (monotonic max). Only the drain thread
    /// calls this; the CAS loop resolves the race against `takeRecentPeakAbs`'s reset.
    private func recordPeak(_ peak: Float) {
        guard peak > 0 else { return }
        var current = peakBits.load(ordering: .relaxed)
        while peak > Float(bitPattern: current) {
            let (won, actual) = peakBits.weakCompareExchange(
                expected: current, desired: peak.bitPattern, ordering: .relaxed,
            )
            if won { return }
            current = actual
        }
    }

    private func maybeReportRMS() {
        guard let report = debugRMS.tick() else { return }
        guard debugLogging else { return }
        let dBStr = String(format: "%.1f", report.dBFS)
        logger.info(
            "[debug] App audio RMS (5s): \(dBStr, privacy: .public) dBFS, samples=\(report.samples, privacy: .public), totalBytes=\(self.totalBytesWritten, privacy: .public)",
        )
    }

    /// Pure per-drain analysis of an interleaved Float32 byte region: sum-of-squares
    /// (for RMS) and peak |sample|. Extracted static so the numeric behaviour is
    /// unit-testable without spinning the drain thread.
    static func analyze(
        _ bytes: UnsafeRawPointer, byteCount: Int,
    ) -> (sumSq: Double, samples: Int, peakAbs: Float) {
        let count = byteCount / MemoryLayout<Float>.size
        guard count > 0 else { return (0, 0, 0) }
        let buf = UnsafeBufferPointer(
            start: bytes.assumingMemoryBound(to: Float.self), count: count,
        )
        var sumSq = 0.0
        var peak: Float = 0
        for sample in buf {
            sumSq += Double(sample) * Double(sample)
            let magnitude = abs(sample)
            if magnitude > peak { peak = magnitude }
        }
        return (sumSq, count, peak)
    }
}
