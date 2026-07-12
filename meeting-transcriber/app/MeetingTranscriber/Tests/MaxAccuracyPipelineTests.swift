import FluidAudio
@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

// File-scope Sendable helpers so the injected @Sendable closures never capture
// the (non-Sendable) test case.
private let voiceA: [Float] = [1, 0, 0]
private let voiceB: [Float] = [0, 1, 0]

private func mkWord(_ start: TimeInterval, _ text: String) -> WordTimeline.Word {
    WordTimeline.Word(start: start, end: start + 0.9, text: text, source: .app)
}

/// Thread-safe recorder for the progress callback (which fires synchronously
/// inside `refine`, so it's fully populated by the time `refine` returns).
private final class ProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stages: Set<String> = []
    func record(_ stage: RefineStage) { lock.lock(); stages.insert(stage.rawValue); lock.unlock() }
    var seen: Set<String> { lock.lock(); defer { lock.unlock() }; return stages }
}

/// Tests the MAX orchestrator by injecting fake model closures — no CoreML.
/// Verifies the pass wiring: re-scoring actually moves a planted utterance,
/// the overlap flag lands on the output, the LLM pass is gated by the flag,
/// and empty ASR degrades to the FAST result.
final class MaxAccuracyPipelineTests: XCTestCase {
    private func makeAudioFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("max_\(UUID().uuidString)_app.wav")
        try Data([0]).write(to: url)
        return url
    }

    private func input(app: URL, fast: [TimestampedSegment], llm: Bool = false) -> RefineInput {
        RefineInput(
            title: "Test", appPath: app, micPath: nil, mixPath: nil,
            micDelay: 0, micLabel: "Me", numSpeakers: nil,
            llmRepairEnabled: llm, fastSegments: fast,
        )
    }

    func testRescoringMovesAPlantedUtterance() async throws {
        let app = try makeAudioFile()
        defer { try? FileManager.default.removeItem(at: app) }

        // Two words → two single-word utterances, labelled S0 then S1 by the
        // diarizer. Chunk embeddings say BOTH sound like voiceB (== S1's
        // centroid), so the first utterance must move S0 → S1.
        let pipeline = MaxAccuracyPipeline(
            resample16k: { _, _ in },
            transcribeWords: { _, _ in [mkWord(0, "hello"), mkWord(2, "there")] },
            diarizeOffline: { _, _, _, _ in
                DiarizationResult(
                    segments: [.init(start: 0, end: 1.5, speaker: "S0"), .init(start: 1.5, end: 3, speaker: "S1")],
                    speakingTimes: ["S0": 1.5, "S1": 1.5],
                    autoNames: [:],
                    embeddings: ["S0": voiceA, "S1": voiceB],
                    chunkEmbeddings: [
                        ChunkEmbedding(speakerId: "S0", chunkIndex: 0, speakerIndex: 0, startTimeSeconds: 0, endTimeSeconds: 1, embedding256: voiceB),
                        ChunkEmbedding(speakerId: "S1", chunkIndex: 1, speakerIndex: 1, startTimeSeconds: 2, endTimeSeconds: 3, embedding256: voiceB),
                    ],
                )
            },
            sweep: [0.6],
        )
        let out = try await pipeline.refine(input(app: app, fast: [.init(start: 0, end: 1.5, text: "hello", speaker: "S0")])) { _, _ in }
        XCTAssertEqual(Set(out.segments.map(\.speaker)), ["S1"], "both utterances re-scored to S1")
        XCTAssertTrue(out.report.passesRun.contains(RefineStage.rescore.rawValue))
    }

    func testEmptyTranscriptionKeepsFastResult() async throws {
        let app = try makeAudioFile()
        defer { try? FileManager.default.removeItem(at: app) }
        let fast = [TimestampedSegment(start: 0, end: 1, text: "kept", speaker: "Alice")]
        let pipeline = MaxAccuracyPipeline(
            resample16k: { _, _ in },
            transcribeWords: { _, _ in [] },
            diarizeOffline: { _, _, _, _ in DiarizationResult(segments: [], speakingTimes: [:], autoNames: [:], embeddings: nil) },
        )
        let out = try await pipeline.refine(input(app: app, fast: fast)) { _, _ in }
        XCTAssertEqual(out.segments, fast, "no words → FAST result returned verbatim")
    }

    func testOverlapFlagIsApplied() async throws {
        let app = try makeAudioFile()
        defer { try? FileManager.default.removeItem(at: app) }
        let pipeline = MaxAccuracyPipeline(
            resample16k: { _, _ in },
            transcribeWords: { _, _ in [mkWord(0, "a"), mkWord(2, "b")] },
            diarizeOffline: { _, _, _, _ in
                DiarizationResult(
                    segments: [.init(start: 0, end: 3, speaker: "S0")],
                    speakingTimes: ["S0": 3], autoNames: [:], embeddings: ["S0": voiceA],
                )
            },
            detectOverlap: { _ in [DiarizationConsensus.OverlapSpan(start: 1.5, end: 3, dominantSpeaker: nil)] },
            sweep: [0.6],
        )
        let out = try await pipeline.refine(input(app: app, fast: [])) { _, _ in }
        XCTAssertTrue(out.segments.contains { $0.overlap == true }, "a word inside the overlap span is flagged")
        XCTAssertTrue(out.report.passesRun.contains(RefineStage.overlap.rawValue))
    }

    func testLLMPassGatedByFlag() async throws {
        let app = try makeAudioFile()
        defer { try? FileManager.default.removeItem(at: app) }
        func pipeline() -> MaxAccuracyPipeline {
            MaxAccuracyPipeline(
                resample16k: { _, _ in },
                transcribeWords: { _, _ in [mkWord(0, "hi")] },
                diarizeOffline: { _, _, _, _ in
                    DiarizationResult(segments: [.init(start: 0, end: 1, speaker: "S0")], speakingTimes: ["S0": 1], autoNames: [:], embeddings: ["S0": voiceA])
                },
                llmComplete: { _ in "<spk:1> hi" },
                sweep: [0.6],
            )
        }
        let disabled = try await pipeline().refine(input(app: app, fast: [], llm: false)) { _, _ in }
        XCTAssertFalse(disabled.report.passesRun.contains(RefineStage.llmRepair.rawValue), "LLM pass skipped when the flag is off")

        let enabled = try await pipeline().refine(input(app: app, fast: [], llm: true)) { _, _ in }
        XCTAssertTrue(enabled.report.passesRun.contains(RefineStage.llmRepair.rawValue), "LLM pass runs when enabled + provider present")
    }

    func testProgressReportsAllCorePasses() async throws {
        let app = try makeAudioFile()
        defer { try? FileManager.default.removeItem(at: app) }
        let pipeline = MaxAccuracyPipeline(
            resample16k: { _, _ in },
            transcribeWords: { _, _ in [mkWord(0, "x")] },
            diarizeOffline: { _, _, _, _ in
                DiarizationResult(segments: [.init(start: 0, end: 1, speaker: "S0")], speakingTimes: ["S0": 1], autoNames: [:], embeddings: ["S0": voiceA])
            },
            sweep: [0.6],
        )
        let recorder = ProgressRecorder()
        _ = try await pipeline.refine(input(app: app, fast: [])) { stage, _ in recorder.record(stage) }
        let seen = recorder.seen
        XCTAssertTrue(seen.contains(RefineStage.reasr.rawValue))
        XCTAssertTrue(seen.contains(RefineStage.rescore.rawValue))
        XCTAssertTrue(seen.contains(RefineStage.finalize.rawValue))
    }
}
