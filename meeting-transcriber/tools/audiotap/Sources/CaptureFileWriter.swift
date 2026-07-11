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
final class CaptureFileWriter: @unchecked Sendable {
    /// Owned by the caller (the session's `FileHandle`), NOT by this writer — the
    /// writer only writes; it never closes the fd. See `flushAndClose`.
    private let fd: Int32
    private let ring: AudioRingBuffer
    private let levelPublisher: LevelPublisher
    private let debugLogging: Bool
    private let drainInterval: TimeInterval
    /// Reused staging buffer for each ring→disk copy. Drain-thread-only.
    private let scratch: UnsafeMutableRawBufferPointer

    private var thread: Thread?
    private let running = ManagedAtomic<Bool>(true)
    /// Signalled once when the drain thread has fully exited (after its final flush).
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
        self.fd = fd
        self.ring = ring
        self.levelPublisher = levelPublisher
        self.debugLogging = debugLogging
        self.drainInterval = drainInterval
        scratch = UnsafeMutableRawBufferPointer.allocate(byteCount: scratchBytes, alignment: 64)
    }

    deinit { scratch.deallocate() }

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
    /// The fd is owned by the caller — this method never closes it ("Close" here
    /// means closing the *writer*, not the descriptor).
    func flushAndClose(deadline: DispatchTime) {
        running.store(false, ordering: .relaxed)
        if finished.wait(timeout: deadline) == .timedOut {
            logger.error("CaptureFileWriter flush exceeded deadline — proceeding; drain thread will exit when the write unblocks")
        }
    }

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
        drainAll() // final flush after the stop signal
        finished.signal()
    }

    private func drainAll() {
        var didDrain = false
        while true {
            let n = ring.read(into: scratch)
            if n == 0 { break }
            didDrain = true
            if let base = scratch.baseAddress {
                writeAllToFileHandle(fd, base, count: n)
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
