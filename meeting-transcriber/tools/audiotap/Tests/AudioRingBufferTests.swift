@testable import AudioTapLib
import XCTest

/// Unit coverage for the lock-free SPSC `AudioRingBuffer`: byte-exact roundtrip,
/// wraparound, overflow drop counting, order preservation, and a concurrent
/// producer/consumer stress case. The concurrency test is the one exercised under
/// the CI ThreadSanitizer run (there is no local sanitizer harness); the rest are
/// deterministic single-threaded checks of the index math.
final class AudioRingBufferTests: XCTestCase {
    // MARK: - Helpers

    /// Write `bytes` via the raw pointer API; returns the ring's accept/reject verdict.
    @discardableResult
    private func write(_ ring: AudioRingBuffer, _ bytes: [UInt8]) -> Bool {
        bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return true }
            return ring.write(base, count: raw.count)
        }
    }

    /// Read up to `max` bytes out into a fresh array.
    private func read(_ ring: AudioRingBuffer, max: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: max)
        let n = out.withUnsafeMutableBytes { ring.read(into: $0) }
        return Array(out.prefix(n))
    }

    // MARK: - Power-of-two rounding

    func testRoundUpPowerOfTwo() {
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(1), 1)
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(2), 2)
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(3), 4)
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(16), 16)
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(17), 32)
        XCTAssertEqual(AudioRingBuffer.roundUpPowerOfTwo(1000), 1024)
    }

    func testCapacityRoundedUpToPowerOfTwo() {
        XCTAssertEqual(AudioRingBuffer(capacityBytes: 100).capacity, 128)
        XCTAssertEqual(AudioRingBuffer(capacityBytes: 64).capacity, 64)
    }

    // MARK: - Roundtrip + order

    func testWriteThenReadReturnsSameBytesInOrder() {
        let ring = AudioRingBuffer(capacityBytes: 64)
        XCTAssertTrue(write(ring, [1, 2, 3, 4, 5]))
        XCTAssertEqual(ring.availableBytes, 5)
        XCTAssertEqual(read(ring, max: 5), [1, 2, 3, 4, 5])
        XCTAssertEqual(ring.availableBytes, 0)
    }

    func testInterleavedWritesPreserveOrderAcrossReads() {
        let ring = AudioRingBuffer(capacityBytes: 64)
        write(ring, [10, 11])
        write(ring, [12, 13, 14])
        XCTAssertEqual(read(ring, max: 3), [10, 11, 12]) // partial read
        write(ring, [15])
        XCTAssertEqual(read(ring, max: 10), [13, 14, 15]) // remainder, in order
    }

    func testReadOnEmptyReturnsZero() {
        let ring = AudioRingBuffer(capacityBytes: 16)
        XCTAssertEqual(read(ring, max: 8), [])
    }

    // MARK: - Wraparound

    func testWraparoundCopiesAcrossTheEndBoundary() {
        // 16-byte ring. Fill 12, drain 12 (tail now at 12), then write 8 — the
        // second write straddles the physical end (slots 12..15 then 0..3).
        let ring = AudioRingBuffer(capacityBytes: 16)
        XCTAssertTrue(write(ring, Array(0 ..< 12)))
        XCTAssertEqual(read(ring, max: 12), Array(0 ..< 12))
        let straddling: [UInt8] = [100, 101, 102, 103, 104, 105, 106, 107]
        XCTAssertTrue(write(ring, straddling))
        XCTAssertEqual(read(ring, max: 8), straddling)
    }

    // MARK: - Overflow drop accounting

    func testOverflowDropsWholeWriteAndCountsBytes() {
        let ring = AudioRingBuffer(capacityBytes: 16)
        XCTAssertTrue(write(ring, Array(repeating: 1, count: 12)))
        // Only 4 bytes free; a 6-byte write cannot fit → rejected, nothing copied.
        XCTAssertFalse(write(ring, Array(repeating: 9, count: 6)))
        XCTAssertEqual(ring.droppedBytes, 6)
        XCTAssertEqual(ring.availableBytes, 12, "rejected write must not partially land")
        // The already-queued bytes are still intact and readable.
        XCTAssertEqual(read(ring, max: 12), Array(repeating: 1, count: 12))
    }

    func testWriteExactlyFillsToCapacity() {
        let ring = AudioRingBuffer(capacityBytes: 8)
        XCTAssertTrue(write(ring, Array(0 ..< 8)))
        XCTAssertFalse(write(ring, [42]), "no free byte remains")
        XCTAssertEqual(ring.droppedBytes, 1)
    }

    // MARK: - Concurrency (exercised under CI ThreadSanitizer)

    func testConcurrentProducerConsumerPreservesByteStream() {
        // One producer streams a known pseudo-random byte sequence; one consumer
        // drains it. The consumer asserts the bytes arrive in the exact produced
        // order with none lost or duplicated. The ring is deliberately far smaller
        // than the payload so the producer spins on backpressure (retrying dropped
        // writes) — that is the wraparound + full/empty contention TSan inspects.
        let total = 1 << 20 // 1 MiB
        let ring = AudioRingBuffer(capacityBytes: 4096)

        var expected = [UInt8](repeating: 0, count: total)
        var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
        for i in 0 ..< total {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            expected[i] = UInt8(truncatingIfNeeded: seed >> 33)
        }

        let producerDone = expectation(description: "producer")
        let consumerDone = expectation(description: "consumer")

        let producer = Thread {
            var offset = 0
            let chunk = 1500 // not a power of two → forces frequent wraparound
            while offset < total {
                let n = min(chunk, total - offset)
                let wrote = expected.withUnsafeBytes { raw -> Bool in
                    ring.write(raw.baseAddress!.advanced(by: offset), count: n)
                }
                if wrote { offset += n }
            }
            producerDone.fulfill()
        }

        let consumer = Thread {
            var received = [UInt8]()
            received.reserveCapacity(total)
            var scratch = [UInt8](repeating: 0, count: 777)
            while received.count < total {
                let n = scratch.withUnsafeMutableBytes { ring.read(into: $0) }
                if n > 0 { received.append(contentsOf: scratch[0 ..< n]) }
            }
            XCTAssertEqual(received, expected, "byte stream must survive intact and in order")
            consumerDone.fulfill()
        }

        consumer.start()
        producer.start()
        wait(for: [producerDone, consumerDone], timeout: 30)
        XCTAssertEqual(ring.availableBytes, 0)
    }
}
