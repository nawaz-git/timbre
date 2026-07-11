import Atomics
import Foundation

/// Lock-free single-producer / single-consumer byte ring buffer. Sits between the
/// CoreAudio CATap IOProc (the sole producer, `write`) and the `CaptureFileWriter`
/// drain thread (the sole consumer, `read`). The IOProc only ever memcpys into the
/// ring and bumps an atomic — it never touches the file descriptor, never allocates,
/// and never takes a lock — so a disk stall can no longer overrun the audio IO cycle.
///
/// **SPSC contract (the invariant that makes this safe without locks):** exactly one
/// thread calls `write` and exactly one (other) thread calls `read`. `head` is
/// written only by the producer; `tail` only by the consumer. Each side loads its
/// OWN index with `.relaxed` (no cross-thread order needed to read a value only you
/// write) and the PEER's index with `.acquiring`.
///
/// **Release/acquire handshake (why the copied bytes are visible in order):**
///  - the producer publishes freshly-copied bytes by storing the advanced `head`
///    with `.releasing`; the consumer observes them by loading `head` with
///    `.acquiring`, so the byte copy *happens-before* the consumer's read;
///  - the consumer publishes reclaimed space by storing the advanced `tail` with
///    `.releasing`; the producer observes it by loading `tail` with `.acquiring`,
///    so the consumer's read *happens-before* the producer can overwrite that region.
///
/// This is the textbook Lamport bounded SPSC queue: inspection-provable
/// data-race-free and TSan-clean (there is no local test harness for the sanitizer
/// runs — see `AudioRingBufferTests` — so the safety here is argued from the memory
/// ordering, not observed). `@unchecked Sendable`: the backing storage is a single
/// immutable allocation and every concurrent access is mediated by the atomics.
final class AudioRingBuffer: @unchecked Sendable {
    /// Backing storage. Immutable pointer, fixed size for the ring's lifetime.
    private let storage: UnsafeMutableRawPointer
    /// Capacity in bytes — always a power of two so index wrapping is a mask, not a
    /// modulo/division in the audio callback.
    let capacity: Int
    private let mask: Int

    /// Monotonically increasing byte counters (never wrap in practice: at 48 kHz
    /// stereo Float32 ≈ 384 KiB/s an `Int` overflows after ~760,000 years). The
    /// physical slot is `counter & mask`; `head - tail` is the queued byte count,
    /// always within `0...capacity`.
    private let head = ManagedAtomic<Int>(0)
    private let tail = ManagedAtomic<Int>(0)
    private let dropped = ManagedAtomic<Int>(0)

    /// - Parameter capacityBytes: rounded UP to the next power of two. The default
    ///   (16 MiB ≈ 43 s of 48 kHz stereo Float32) is deep enough that a healthy
    ///   disk never overflows it, so capture stays byte-identical to the pre-ring
    ///   path (zero drops).
    init(capacityBytes: Int = CaptureTuning.ringCapacityBytes) {
        let rounded = AudioRingBuffer.roundUpPowerOfTwo(max(1, capacityBytes))
        capacity = rounded
        mask = rounded - 1
        storage = UnsafeMutableRawPointer.allocate(byteCount: rounded, alignment: 64)
    }

    deinit { storage.deallocate() }

    /// Producer side — called from the CATap IOProc. Copies `count` bytes in and
    /// returns `true`; if they do not fit it copies nothing, counts the drop, and
    /// returns `false`. Never blocks, never partially writes.
    @discardableResult
    func write(_ src: UnsafeRawPointer, count: Int) -> Bool {
        guard count > 0 else { return true }
        let h = head.load(ordering: .relaxed) // producer owns head
        let t = tail.load(ordering: .acquiring) // observe consumer's reclaimed space
        if count > capacity - (h - t) {
            dropped.wrappingIncrement(by: count, ordering: .relaxed)
            return false
        }
        let start = h & mask
        let firstChunk = min(count, capacity - start)
        storage.advanced(by: start).copyMemory(from: src, byteCount: firstChunk)
        if firstChunk < count {
            storage.copyMemory(from: src.advanced(by: firstChunk), byteCount: count - firstChunk)
        }
        head.store(h + count, ordering: .releasing) // publish the bytes
        return true
    }

    /// Consumer side — called from the drain thread. Copies up to `dst.count`
    /// available bytes out and returns the number copied (0 when empty).
    func read(into dst: UnsafeMutableRawBufferPointer) -> Int {
        guard let dstBase = dst.baseAddress, dst.count > 0 else { return 0 }
        let t = tail.load(ordering: .relaxed) // consumer owns tail
        let h = head.load(ordering: .acquiring) // observe producer's published bytes
        let available = h - t
        guard available > 0 else { return 0 }
        let n = min(available, dst.count)
        let start = t & mask
        let firstChunk = min(n, capacity - start)
        dstBase.copyMemory(from: storage.advanced(by: start), byteCount: firstChunk)
        if firstChunk < n {
            dstBase.advanced(by: firstChunk).copyMemory(from: storage, byteCount: n - firstChunk)
        }
        tail.store(t + n, ordering: .releasing) // publish the reclaimed space
        return n
    }

    /// Total bytes dropped on overflow across the ring's lifetime. Read at capture
    /// stop for the forensic "dropped bytes" counter (soak S1 asserts this is 0 on a
    /// healthy disk).
    var droppedBytes: Int { dropped.load(ordering: .relaxed) }

    /// Bytes currently queued (produced, not yet consumed). Test/introspection only.
    var availableBytes: Int {
        head.load(ordering: .acquiring) - tail.load(ordering: .relaxed)
    }

    /// Smallest power of two ≥ `n` (with `roundUpPowerOfTwo(1) == 1`). Pure so the
    /// masking invariant is unit-testable without allocating.
    static func roundUpPowerOfTwo(_ n: Int) -> Int {
        guard n > 1 else { return 1 }
        return 1 << (Int.bitWidth - (n - 1).leadingZeroBitCount)
    }
}
