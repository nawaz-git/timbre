@testable import AudioTapLib
import Darwin
import XCTest

/// Coverage for `CaptureFileWriter`: the pure per-drain `analyze` math (relocated
/// here from the old `AppAudioCapture+DebugLogging` IOProc helpers) plus an
/// end-to-end drain that proves the ring → disk path is byte-exact and feeds the
/// level publisher + peak accumulator.
final class CaptureFileWriterTests: XCTestCase {
    // MARK: - Pure analyze()

    func testAnalyzeComputesSumOfSquaresSampleCountAndPeak() {
        // Four interleaved Float samples: sum-of-squares = 2, peak |sample| = 1.
        let samples: [Float] = [1, 0, -1, 0]
        let byteCount = samples.count * MemoryLayout<Float>.size
        let stats = samples.withUnsafeBytes { raw in
            CaptureFileWriter.analyze(raw.baseAddress!, byteCount: byteCount)
        }
        XCTAssertEqual(stats.sumSq, 2.0, accuracy: 1e-9)
        XCTAssertEqual(stats.samples, 4)
        XCTAssertEqual(stats.peakAbs, 1.0, accuracy: 1e-9)
    }

    func testAnalyzeZeroBytesIsNoOp() {
        var dummy: Float = 0
        let stats = withUnsafeBytes(of: &dummy) { raw in
            CaptureFileWriter.analyze(raw.baseAddress!, byteCount: 0)
        }
        XCTAssertEqual(stats.sumSq, 0)
        XCTAssertEqual(stats.samples, 0)
        XCTAssertEqual(stats.peakAbs, 0)
    }

    func testAnalyzeTracksLargestMagnitudeRegardlessOfSign() {
        let samples: [Float] = [0.1, -0.9, 0.3, -0.2]
        let byteCount = samples.count * MemoryLayout<Float>.size
        let stats = samples.withUnsafeBytes { raw in
            CaptureFileWriter.analyze(raw.baseAddress!, byteCount: byteCount)
        }
        XCTAssertEqual(stats.peakAbs, 0.9, accuracy: 1e-6)
    }

    // MARK: - End-to-end drain (ring → temp file)

    func testDrainWritesRingBytesToDiskByteIdentical() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cfw-\(UUID().uuidString).pcm")
        let fd = open(url.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { try? FileManager.default.removeItem(at: url) }

        let ring = AudioRingBuffer(capacityBytes: 64 * 1024)
        let writer = CaptureFileWriter(
            fd: fd, ring: ring, levelPublisher: LevelPublisher(), debugLogging: false,
        )
        writer.start()

        // Produce a known Float32 stream through the ring.
        let samples: [Float] = (0 ..< 4096).map { Float($0 % 32) / 32.0 }
        samples.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = min(2048, raw.count - offset)
                while !ring.write(raw.baseAddress!.advanced(by: offset), count: n) {
                    Thread.sleep(forTimeInterval: 0.005) // backpressure — retry
                }
                offset += n
            }
        }

        writer.flushAndClose(deadline: .now() + 3)
        close(fd)

        let written = try Data(contentsOf: url)
        let expected = samples.withUnsafeBytes { Data($0) }
        XCTAssertEqual(written, expected, "drained bytes must match produced bytes exactly")
        XCTAssertEqual(writer.totalBytesWritten, UInt64(expected.count))
        XCTAssertEqual(writer.droppedBytes, 0, "a deep ring on a healthy disk drops nothing")
    }

    func testPeakAccumulatorReflectsDrainedSignalThenResets() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cfw-\(UUID().uuidString).pcm")
        let fd = open(url.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd); try? FileManager.default.removeItem(at: url) }

        let level = LevelPublisher()
        let ring = AudioRingBuffer(capacityBytes: 16 * 1024)
        let writer = CaptureFileWriter(fd: fd, ring: ring, levelPublisher: level, debugLogging: false)
        writer.start()

        let samples: [Float] = [0.0, 0.5, -0.75, 0.25]
        samples.withUnsafeBytes { raw in
            _ = ring.write(raw.baseAddress!, count: raw.count)
        }
        writer.flushAndClose(deadline: .now() + 3)

        XCTAssertEqual(writer.takeRecentPeakAbs(), 0.75, accuracy: 1e-6)
        // A second take (nothing new drained) resets to zero.
        XCTAssertEqual(writer.takeRecentPeakAbs(), 0.0, accuracy: 1e-9)
        // The level publisher saw a real (non-silent) reading from the drain.
        XCTAssertGreaterThan(level.currentLevelDBFS, -120)
    }

    // MARK: - fd ownership (dup) + abort semantics

    /// The writer `dup()`s the caller's fd at init, so the caller may close ITS
    /// descriptor immediately — writes still land in this capture's own file via
    /// the private dup. This is the core of the fd-corruption fix: the caller's
    /// close (and any kernel reuse of that number) can never redirect a drain
    /// write into an unrelated file.
    func testWriterWritesThroughItsOwnDupAfterCallerClosesFD() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cfw-dup-\(UUID().uuidString).pcm")
        let fd = open(url.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { try? FileManager.default.removeItem(at: url) }

        let ring = AudioRingBuffer(capacityBytes: 64 * 1024)
        let writer = CaptureFileWriter(
            fd: fd, ring: ring, levelPublisher: LevelPublisher(), debugLogging: false,
        )
        // Caller is done with ITS descriptor before any bytes flow — only the
        // writer's private dup keeps the file open.
        close(fd)
        writer.start()

        let samples: [Float] = (0 ..< 1024).map { Float($0 % 16) / 16.0 }
        samples.withUnsafeBytes { raw in
            _ = ring.write(raw.baseAddress!, count: raw.count)
        }
        writer.flushAndClose(deadline: .now() + 3)

        let written = try Data(contentsOf: url)
        let expected = samples.withUnsafeBytes { Data($0) }
        XCTAssertEqual(
            written, expected,
            "writes must land via the writer's private dup even after the caller closed its fd",
        )
        XCTAssertFalse(writer.isAborted, "a healthy flush must not latch the abort")
    }

    /// A normal `flushAndClose` closes ONLY the writer's private dup, never the
    /// caller's descriptor — the writer is the sole closer of its own copy.
    func testFlushAndCloseLeavesCallerDescriptorOpen() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cfw-owns-\(UUID().uuidString).pcm")
        let fd = open(url.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd); try? FileManager.default.removeItem(at: url) }

        let ring = AudioRingBuffer(capacityBytes: 16 * 1024)
        let writer = CaptureFileWriter(
            fd: fd, ring: ring, levelPublisher: LevelPublisher(), debugLogging: false,
        )
        writer.start()
        let samples: [Float] = [0.1, 0.2, 0.3, 0.4]
        samples.withUnsafeBytes { _ = ring.write($0.baseAddress!, count: $0.count) }
        writer.flushAndClose(deadline: .now() + 3)

        // fcntl(F_GETFD) returns -1 only for a closed/invalid fd; a still-open
        // caller descriptor returns its flags (>= 0).
        XCTAssertNotEqual(
            fcntl(fd, F_GETFD), -1,
            "the writer must close only its private dup, not the caller's descriptor",
        )
    }

    /// A `flushAndClose` that times out on a stalled write latches the abort so the
    /// drain thread, once unblocked, writes at most its in-flight chunk and stops —
    /// it never keeps spilling the rest of the ring after the caller moved on. A
    /// pipe whose read end we hold undrained is a deterministic stand-in for a
    /// stalled disk (its ~64 KiB kernel buffer blocks the write).
    func testTimedOutFlushLatchesAbortAndStopsDrainingRemainingRing() throws {
        // A write to a pipe whose read end later closes would raise SIGPIPE by
        // default; ignore it so the drain thread's write just returns an error.
        signal(SIGPIPE, SIG_IGN)

        var fds = [Int32](repeating: 0, count: 2)
        XCTAssertEqual(pipe(&fds), 0)
        let readEnd = fds[0]
        let writeEnd = fds[1]
        defer { close(readEnd); close(writeEnd) }

        // Ring holds far more than one scratch chunk (512 KiB) so a healthy drain
        // would need many writes — the abort must cut it short after the first.
        let ring = AudioRingBuffer(capacityBytes: 4 * 1024 * 1024)
        let writer = CaptureFileWriter(
            fd: writeEnd, ring: ring, levelPublisher: LevelPublisher(), debugLogging: false,
        )
        writer.start()

        let queued = 2 * 1024 * 1024
        let blob = [UInt8](repeating: 0xAB, count: queued)
        blob.withUnsafeBytes { _ = ring.write($0.baseAddress!, count: $0.count) }

        // Let the drain thread fill the pipe and block, then time out the flush.
        Thread.sleep(forTimeInterval: 0.15)
        writer.flushAndClose(deadline: .now() + .milliseconds(300))
        XCTAssertTrue(
            writer.isAborted,
            "a flush that times out on a stalled write must latch the abort",
        )

        // Drain the pipe so the blocked write can return; the resumed thread must
        // see the abort and stop after its in-flight chunk — far short of `queued`.
        let bufSize = 64 * 1024
        var scratch = [UInt8](repeating: 0, count: bufSize)
        _ = fcntl(readEnd, F_SETFL, O_NONBLOCK)
        let readDeadline = Date().addingTimeInterval(1.0)
        while Date() < readDeadline {
            let n = scratch.withUnsafeMutableBytes { read(readEnd, $0.baseAddress, bufSize) }
            if n == 0 { break } // EOF
            if n < 0 { Thread.sleep(forTimeInterval: 0.005) } // EAGAIN — writer mid-write
        }
        XCTAssertLessThan(
            Int(writer.totalBytesWritten), queued,
            "the abort must stop the writer before it drains the whole ring",
        )
    }
}
