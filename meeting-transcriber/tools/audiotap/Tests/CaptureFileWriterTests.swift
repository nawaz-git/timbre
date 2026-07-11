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
}
