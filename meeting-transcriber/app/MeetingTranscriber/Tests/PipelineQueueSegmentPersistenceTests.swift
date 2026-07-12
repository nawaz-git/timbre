@testable import MeetingTranscriber
import XCTest

/// Regression coverage for the integration bug where the persisted
/// `<slug>_segments.json` (the file the Electron UI renders) was written from
/// the PRE-diarization cache — tagging every meeting with only "Remote"/mic
/// labels regardless of what the diarizer found. These tests pin that the
/// DIARIZED speaker labels reach the sidecar, and stay in sync through the
/// naming-confirm rewrite.
@MainActor
final class PipelineQueueSegmentPersistenceTests: XCTestCase {
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var tmpDir: URL!

    override func setUp() async throws {
        try await super.setUp()
        tmpDir = try makeTempDirectory(prefix: "pipeline_segment_persistence")
    }

    /// Decode the single `*_segments.json` the pipeline persisted under
    /// `<outputDir>/recordings/` and return the set of distinct speaker labels.
    private func persistedSpeakerSet() throws -> Set<String> {
        let recordingsDir = tmpDir.appendingPathComponent("recordings")
        let entries = try FileManager.default.contentsOfDirectory(atPath: recordingsDir.path)
        guard let name = entries.first(where: { $0.hasSuffix("_segments.json") }) else {
            XCTFail("no _segments.json was persisted")
            return []
        }
        let data = try Data(contentsOf: recordingsDir.appendingPathComponent(name))
        let segments = try JSONDecoder().decode([TimestampedSegment].self, from: data)
        return Set(segments.map(\.speaker))
    }

    // MARK: - Diarized labels reach the sidecar

    /// Dual-source: the app track diarizes into three remote speakers and the
    /// mic track is the local "Me". The persisted segments must carry those
    /// four diarized labels — NOT the pre-diarization "Remote"/"Me" tags.
    func testDualSourcePersistsDiarizedSpeakersNotRemoteMe() async throws {
        let engine = MockEngine()
        engine.segmentsToReturn = [
            TimestampedSegment(start: 0, end: 5, text: "one"),
            TimestampedSegment(start: 5, end: 10, text: "two"),
            TimestampedSegment(start: 10, end: 15, text: "three"),
        ]
        let diarizer = PerTrackMockDiarization(
            app: DiarizationResult(
                segments: [
                    .init(start: 0, end: 5, speaker: "SPEAKER_00"),
                    .init(start: 5, end: 10, speaker: "SPEAKER_01"),
                    .init(start: 10, end: 15, speaker: "SPEAKER_02"),
                ],
                speakingTimes: ["SPEAKER_00": 5, "SPEAKER_01": 5, "SPEAKER_02": 5],
                autoNames: ["SPEAKER_00": "Speaker 1", "SPEAKER_01": "Speaker 2", "SPEAKER_02": "Speaker 3"],
                embeddings: nil,
            ),
            mic: DiarizationResult(
                segments: [.init(start: 0, end: 15, speaker: "SPEAKER_00")],
                speakingTimes: ["SPEAKER_00": 15],
                autoNames: ["SPEAKER_00": "Me"],
                embeddings: nil,
            ),
        )
        let queue = makeQueue(engine: engine, diarizer: diarizer)

        let base = try createTestAudioFile(in: tmpDir)
        let appPath = tmpDir.appendingPathComponent("app_audio.wav")
        let micPath = tmpDir.appendingPathComponent("mic_audio.wav")
        try FileManager.default.copyItem(at: base, to: appPath)
        try FileManager.default.copyItem(at: base, to: micPath)

        let job = PipelineJob(
            meetingTitle: "Standup",
            appName: "Microsoft Teams",
            mixPath: base,
            appPath: appPath,
            micPath: micPath,
            micDelay: 0,
        )
        queue.enqueue(job)
        await queue.processNext()

        let speakers = try persistedSpeakerSet()
        XCTAssertEqual(speakers, ["Speaker 1", "Speaker 2", "Speaker 3", "Me"])
        XCTAssertFalse(speakers.contains("Remote"), "pre-diarization 'Remote' tag must not survive to _segments.json")
    }

    /// Single-source: the persisted segments carry the diarized labels rather
    /// than the empty speaker of the pre-diarization cache.
    func testSingleSourcePersistsDiarizedLabels() async throws {
        let engine = MockEngine()
        engine.segmentsToReturn = [
            TimestampedSegment(start: 0, end: 5, text: "one"),
            TimestampedSegment(start: 5, end: 10, text: "two"),
        ]
        let diarizer = MockDiarization()
        diarizer.resultToReturn = DiarizationResult(
            segments: [
                .init(start: 0, end: 5, speaker: "SPEAKER_00"),
                .init(start: 5, end: 10, speaker: "SPEAKER_01"),
            ],
            speakingTimes: ["SPEAKER_00": 5, "SPEAKER_01": 5],
            autoNames: ["SPEAKER_00": "Speaker 1", "SPEAKER_01": "Speaker 2"],
            embeddings: nil,
        )
        let queue = makeQueue(engine: engine, diarizer: diarizer)

        let job = PipelineJob(
            meetingTitle: "Solo",
            appName: "Microsoft Teams",
            mixPath: try createTestAudioFile(in: tmpDir),
            appPath: nil,
            micPath: nil,
            micDelay: 0,
        )
        queue.enqueue(job)
        await queue.processNext()

        let speakers = try persistedSpeakerSet()
        XCTAssertEqual(speakers, ["Speaker 1", "Speaker 2"])
        XCTAssertFalse(speakers.contains(""), "diarized segments must not carry the empty pre-diarization speaker")
    }

    /// Diarization disabled → the pre-diarization cache is still persisted so
    /// the UI has segments to render (fallback path unchanged).
    func testDiarizationDisabledStillPersistsCachedSegments() async throws {
        let engine = MockEngine()
        engine.segmentsToReturn = [TimestampedSegment(start: 0, end: 5, text: "hello")]
        let queue = makeQueue(engine: engine, diarizer: MockDiarization(), diarizeEnabled: false)

        let job = PipelineJob(
            meetingTitle: "No Diar",
            appName: "Microsoft Teams",
            mixPath: try createTestAudioFile(in: tmpDir),
            appPath: nil,
            micPath: nil,
            micDelay: 0,
        )
        queue.enqueue(job)
        await queue.processNext()

        // No diarization → segments carry the engine's raw (empty) speaker.
        let speakers = try persistedSpeakerSet()
        XCTAssertEqual(speakers, [""])
    }

    // MARK: - Naming-confirm keeps the sidecar in sync

    /// Confirming "Speaker 1" → "Alice" rewrites the persisted segments so the
    /// renderer's speaker list matches the rewritten `.txt`.
    func testConfirmingNameRewritesSegmentsJson() async throws {
        let outputDir = tmpDir.appendingPathComponent("output")
        let recordingsDir = outputDir.appendingPathComponent("recordings")
        let protocolsDir = outputDir.appendingPathComponent("protocols")
        try FileManager.default.createDirectory(at: recordingsDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: protocolsDir, withIntermediateDirectories: true)

        let slug = "confirm_test"
        let seedSegments = [
            TimestampedSegment(start: 0, end: 5, text: "Hello", speaker: "Speaker 1"),
            TimestampedSegment(start: 5, end: 10, text: "Hi", speaker: "Speaker 2"),
        ]
        try JSONEncoder().encode(seedSegments)
            .write(to: recordingsDir.appendingPathComponent("\(slug)_segments.json"))

        let transcriptPath = protocolsDir.appendingPathComponent("\(slug).txt")
        try "[00:00] Speaker 1: Hello\n[00:05] Speaker 2: Hi"
            .write(to: transcriptPath, atomically: true, encoding: .utf8)

        let queue = PipelineQueue(
            engine: MockEngine(),
            diarizationFactory: { MockDiarization() },
            protocolGeneratorFactory: { nil },
            outputDir: outputDir,
            logDir: tmpDir,
            diarizeEnabled: true,
        )
        var job = PipelineJob(
            meetingTitle: "Confirm Test",
            appName: "Microsoft Teams",
            mixPath: URL(fileURLWithPath: "/tmp/mix.wav"),
            appPath: nil,
            micPath: nil,
            micDelay: 0,
        )
        job.state = .speakerNamingPending
        job.namingSlug = slug
        job.transcriptPath = transcriptPath
        queue.enqueue(job)
        queue.speakerNamingDataByJob[job.id] = PipelineQueue.SpeakerNamingData(
            jobID: job.id,
            meetingTitle: "Confirm Test",
            mapping: ["Speaker 1": "Speaker 1", "Speaker 2": "Speaker 2"],
            speakingTimes: ["Speaker 1": 5, "Speaker 2": 5],
            embeddings: ["Speaker 1": [1, 0], "Speaker 2": [0, 1]],
            audioPath: nil,
            segments: [],
            participants: [],
            isDualSource: false,
        )

        let done = XCTestExpectation(description: "job done")
        queue.onJobStateChange = { _, _, newState in
            if newState == .done { done.fulfill() }
        }
        queue.completeSpeakerNaming(jobID: job.id, result: .confirmed(["Speaker 1": "Alice"]))
        await fulfillment(of: [done], timeout: 5)

        let speakers = try persistedSpeakerSetForConfirm(recordingsDir: recordingsDir, slug: slug)
        XCTAssertTrue(speakers.contains("Alice"), "confirmed name must be written into _segments.json")
        XCTAssertFalse(speakers.contains("Speaker 1"), "renamed label must be gone from _segments.json")
        XCTAssertTrue(speakers.contains("Speaker 2"), "unmapped speaker must be left untouched")
    }

    private func persistedSpeakerSetForConfirm(recordingsDir: URL, slug: String) throws -> Set<String> {
        let data = try Data(contentsOf: recordingsDir.appendingPathComponent("\(slug)_segments.json"))
        return Set(try JSONDecoder().decode([TimestampedSegment].self, from: data).map(\.speaker))
    }

    // MARK: - applySpeakerNameMapping (pure)

    func testApplyMappingReplacesRawLabel() {
        let segments = [TimestampedSegment(start: 0, end: 1, text: "hi", speaker: "SPEAKER_0")]
        let result = PipelineQueue.applySpeakerNameMapping(
            to: segments, userMapping: ["SPEAKER_0": "Alice"], priorMapping: [:],
        )
        XCTAssertEqual(result.first?.speaker, "Alice")
    }

    func testApplyMappingReplacesPriorAutoName() {
        // Auto-matcher had labeled SPEAKER_0 as "John"; the user corrects to "Jonathan".
        let segments = [TimestampedSegment(start: 0, end: 1, text: "hi", speaker: "John")]
        let result = PipelineQueue.applySpeakerNameMapping(
            to: segments, userMapping: ["SPEAKER_0": "Jonathan"], priorMapping: ["SPEAKER_0": "John"],
        )
        XCTAssertEqual(result.first?.speaker, "Jonathan")
    }

    func testApplyMappingSkipsEmptyName() {
        let segments = [TimestampedSegment(start: 0, end: 1, text: "hi", speaker: "SPEAKER_0")]
        let result = PipelineQueue.applySpeakerNameMapping(
            to: segments, userMapping: ["SPEAKER_0": ""], priorMapping: [:],
        )
        XCTAssertEqual(result.first?.speaker, "SPEAKER_0")
    }

    func testApplyMappingLeavesUnmatchedSpeakerUnchanged() {
        let segments = [TimestampedSegment(start: 0, end: 1, text: "hi", speaker: "SPEAKER_9")]
        let result = PipelineQueue.applySpeakerNameMapping(
            to: segments, userMapping: ["SPEAKER_0": "Alice"], priorMapping: [:],
        )
        XCTAssertEqual(result.first?.speaker, "SPEAKER_9")
    }

    // MARK: - Helpers

    private func makeQueue(
        engine: MockEngine,
        diarizer: any DiarizationProvider,
        diarizeEnabled: Bool = true,
    ) -> PipelineQueue {
        PipelineQueue(
            engine: engine,
            diarizationFactory: { diarizer },
            protocolGeneratorFactory: { MockProtocolGen() },
            outputDir: tmpDir,
            logDir: tmpDir,
            diarizeEnabled: diarizeEnabled,
            micLabel: "Me",
        )
    }
}

/// Diarization mock that returns a different result per track, keyed on the
/// resampled filename the pipeline feeds it (`app_16k.wav` / `mic_16k.wav`).
/// Lets a dual-source test assert real per-track speaker attribution — the
/// shared `MockDiarization` returns one result for every call.
private final class PerTrackMockDiarization: DiarizationProvider, @unchecked Sendable {
    let isAvailable = true
    let mode: DiarizerMode = .offline
    private let app: DiarizationResult
    private let mic: DiarizationResult

    init(app: DiarizationResult, mic: DiarizationResult) {
        self.app = app
        self.mic = mic
    }

    func run(audioPath: URL, numSpeakers _: Int?, meetingTitle _: String) -> DiarizationResult {
        audioPath.lastPathComponent.hasSuffix("mic_16k.wav") ? mic : app
    }
}
