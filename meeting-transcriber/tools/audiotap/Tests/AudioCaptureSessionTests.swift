@testable import AudioTapLib
import Foundation
import XCTest

@available(macOS 14.2, *)
final class AudioCaptureSessionTests: XCTestCase {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("audiocapturesession-\(UUID().uuidString).tmp")
    }

    /// A session that was never started holds no CoreAudio objects, so `stop()`
    /// must be safe AND idempotent: repeated calls return the same result and
    /// never re-run the (hardware) teardown that a double call would double-free.
    func testStopIsIdempotent() {
        let url = tempURL()
        let session = AudioCaptureSession(
            pids: [1234],
            appOutputURL: url,
            sampleRate: 48000,
            channels: 2,
        )

        let first = session.stop()
        let second = session.stop()

        XCTAssertEqual(first.actualSampleRate, second.actualSampleRate)
        XCTAssertEqual(first.actualChannels, second.actualChannels)
        XCTAssertEqual(first.appAudioFileURL, second.appAudioFileURL)
        // With no started capture the result falls back to the requested format.
        XCTAssertEqual(first.actualSampleRate, 48000)
        XCTAssertEqual(first.actualChannels, 2)
        XCTAssertNil(second.micAudioFileURL, "no mic was requested")
    }

    /// A session that was never started holds no live capture, so dropping it
    /// without calling `stop()` must NOT trip the `deinit` leak-guard assertion.
    /// Reaching the end of the test without a debug trap IS the assertion.
    func testDeinitWithoutStartDoesNotTrap() {
        _ = AudioCaptureSession(pids: [1], appOutputURL: tempURL())
    }
}
