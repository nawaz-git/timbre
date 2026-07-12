@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

/// Drives the MAX-refine state machine in `PipelineQueue` with a stub refiner:
/// a completed FAST job flows FAST → refining → done, the `.refining` marker
/// lifecycle is correct, cancel stops the refine but keeps the FAST result.
@MainActor
final class PipelineQueueRefineTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("refine_test_\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root.appendingPathComponent("protocols"), withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: root.appendingPathComponent("recordings"), withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func stubReport() -> RefineQualityReport {
        RefineQualityReport(
            speakerCount: 2, utteranceReassignments: 3, overlapPercent: 0,
            llmWindowsAccepted: 0, llmWindowsRejected: 0, llmLabelsMoved: 0,
            passesRun: ["finalize"], wallClockSeconds: 0,
        )
    }

    /// Build a queue whose completed job has all the on-disk sidecars the
    /// refine reads, plus a stub refiner. Returns (queue, jobID, txtURL, marker).
    private func makeQueueWithCompletedJob(
        refiner: @escaping () -> any MaxRefining,
        delayMarkerCheck: Bool = false,
    ) -> (PipelineQueue, UUID, URL, URL) {
        let stem = "20260712_1200_test"
        let txtURL = root.appendingPathComponent("protocols/\(stem).txt")
        try? "FAST".write(to: txtURL, atomically: true, encoding: .utf8)
        // durable app track + FAST segments the refine reads.
        try? Data([0]).write(to: root.appendingPathComponent("recordings/\(stem)_app.wav"))
        let namingSlug = "\(stem)_abcd1234"
        let segs = [TimestampedSegment(start: 0, end: 1, text: "FAST", speaker: "Remote")]
        try? JSONEncoder().encode(segs).write(to: root.appendingPathComponent("recordings/\(namingSlug)_segments.json"))

        let queue = PipelineQueue(
            logDir: root.appendingPathComponent("ipc"),
            outputDir: root,
            maxRefinerFactory: refiner,
            processingModeProvider: { .max },
        )
        var job = PipelineJob(meetingTitle: "Test", appName: "Chrome", mixPath: nil, appPath: nil, micPath: nil, micDelay: 0)
        job.transcriptPath = txtURL
        job.namingSlug = namingSlug
        job.state = .generatingProtocol
        queue.insertJobForTesting(job)
        let marker = txtURL.deletingPathExtension().appendingPathExtension("refining")
        return (queue, job.id, txtURL, marker)
    }

    func testFastCompleteWithMaxRunsRefineToDone() async {
        let output = RefineOutput(
            segments: [TimestampedSegment(start: 0, end: 1, text: "REFINED", speaker: "Alice")],
            transcript: "[00:00:00] Alice: REFINED",
            report: stubReport(),
        )
        let (queue, jobID, txtURL, marker) = makeQueueWithCompletedJob(refiner: { StubRefiner(output: output) })

        queue.markFastComplete(jobID: jobID)
        // Synchronous part of startMaxRefine ran: state is refining, marker written.
        XCTAssertEqual(queue.jobs.first { $0.id == jobID }?.state, .refining)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "refine marker written")

        await queue.awaitRefineTasks()
        XCTAssertEqual(queue.jobs.first { $0.id == jobID }?.state, .done)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "marker removed on completion")
        XCTAssertEqual(try? String(contentsOf: txtURL, encoding: .utf8), "[00:00:00] Alice: REFINED", "transcript rewritten")
    }

    func testFastCancelKeepsFastResult() async {
        let output = RefineOutput(segments: [], transcript: "SHOULD_NOT_WRITE", report: stubReport())
        // Slow refiner so cancel wins the race.
        let (queue, jobID, txtURL, marker) = makeQueueWithCompletedJob(
            refiner: { StubRefiner(output: output, delay: .seconds(5)) },
        )
        queue.markFastComplete(jobID: jobID)
        XCTAssertEqual(queue.jobs.first { $0.id == jobID }?.state, .refining)

        queue.cancelJob(id: jobID)
        await queue.awaitRefineTasks()
        XCTAssertEqual(queue.jobs.first { $0.id == jobID }?.state, .done, "cancel settles at done, keeping the FAST result")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "marker removed on cancel")
        XCTAssertEqual(try? String(contentsOf: txtURL, encoding: .utf8), "FAST", "FAST transcript untouched by a cancelled refine")
    }

    func testFastModeSkipsRefine() async {
        // processingMode fast → no refine, straight to done.
        let stem = "20260712_1300_fast"
        let txtURL = root.appendingPathComponent("protocols/\(stem).txt")
        try? "FAST".write(to: txtURL, atomically: true, encoding: .utf8)
        let queue = PipelineQueue(
            logDir: root.appendingPathComponent("ipc"),
            outputDir: root,
            maxRefinerFactory: { StubRefiner(output: RefineOutput(segments: [], transcript: "X", report: stubReport())) },
            processingModeProvider: { .fast },
        )
        var job = PipelineJob(meetingTitle: "F", appName: "Chrome", mixPath: nil, appPath: nil, micPath: nil, micDelay: 0)
        job.transcriptPath = txtURL
        job.state = .generatingProtocol
        queue.insertJobForTesting(job)

        queue.markFastComplete(jobID: job.id)
        XCTAssertEqual(queue.jobs.first { $0.id == job.id }?.state, .done, "FAST mode never enters refining")
    }
}

/// Minimal `MaxRefining` stub — returns a fixed output after an optional delay,
/// honouring cancellation so the cancel test is deterministic.
private final class StubRefiner: MaxRefining, @unchecked Sendable {
    let output: RefineOutput
    let delay: Duration

    init(output: RefineOutput, delay: Duration = .zero) {
        self.output = output
        self.delay = delay
    }

    func refine(
        _: RefineInput,
        progress _: @escaping @Sendable (RefineStage, Double) -> Void,
    ) async throws -> RefineOutput {
        if delay != .zero { try await Task.sleep(for: delay) }
        try Task.checkCancellation()
        return output
    }
}
