@testable import mt_batch
import XCTest

/// The `transcribe` CLI contract: exactly one of `--input` or the
/// `--input-app`/`--input-mic` pair, and a known `--mode`. Validation runs
/// during `parse`, so a rejected combination throws.
final class TranscribeValidationTests: XCTestCase {
    func testSingleInputParses() {
        XCTAssertNoThrow(try Transcribe.parse(["--input", "a.wav", "--output-dir", "/tmp/o"]))
    }

    func testDualPairParses() {
        XCTAssertNoThrow(try Transcribe.parse(["--input-app", "a.wav", "--input-mic", "b.wav", "--output-dir", "/tmp/o"]))
    }

    func testBothSingleAndPairRejected() {
        XCTAssertThrowsError(
            try Transcribe.parse([
                "--input", "a.wav", "--input-app", "b.wav", "--input-mic", "c.wav", "--output-dir", "/tmp/o",
            ]),
        )
    }

    func testHalfOfPairRejected() {
        XCTAssertThrowsError(try Transcribe.parse(["--input-app", "b.wav", "--output-dir", "/tmp/o"]))
    }

    func testNoInputRejected() {
        XCTAssertThrowsError(try Transcribe.parse(["--output-dir", "/tmp/o"]))
    }

    func testUnknownModeRejected() {
        XCTAssertThrowsError(try Transcribe.parse(["--input", "a.wav", "--mode", "turbo", "--output-dir", "/tmp/o"]))
    }

    func testMaxModeAccepted() {
        XCTAssertNoThrow(try Transcribe.parse(["--input", "a.wav", "--mode", "max", "--output-dir", "/tmp/o"]))
    }
}
