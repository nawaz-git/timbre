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

    func testLoadSnapshotRemovesOrphanedRefineMarker() throws {
        // Simulate a crash mid-refine: a persisted `.refining` job plus its
        // marker file, with the FAST transcript already on disk.
        let stem = "20260712_1400_orphan"
        let ipcDir = root.appendingPathComponent("ipc")
        try FileManager.default.createDirectory(at: ipcDir, withIntermediateDirectories: true)
        let txtURL = root.appendingPathComponent("protocols/\(stem).txt")
        try "FAST".write(to: txtURL, atomically: true, encoding: .utf8)
        let marker = txtURL.deletingPathExtension().appendingPathExtension("refining")
        try Data().write(to: marker)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))

        var job = PipelineJob(meetingTitle: "Orphan", appName: "Chrome", mixPath: nil, appPath: nil, micPath: nil, micDelay: 0)
        job.transcriptPath = txtURL
        job.state = .refining
        try PipelineSnapshot.save([job], to: ipcDir)

        // A fresh queue restoring that snapshot must discard the stale refine
        // job AND delete the orphaned marker so Timbre doesn't show the meeting
        // as perpetually "Refining…".
        let queue = PipelineQueue(logDir: ipcDir, outputDir: root)
        queue.loadSnapshot()

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: marker.path),
            "orphaned .refining marker removed on snapshot restore",
        )
        XCTAssertNil(queue.jobs.first { $0.id == job.id }, "the interrupted refine job is discarded")
    }

    func testRefineQueueDrainedFiresOnCompletion() async {
        let output = RefineOutput(
            segments: [TimestampedSegment(start: 0, end: 1, text: "R", speaker: "Alice")],
            transcript: "[00:00:00] Alice: R", report: stubReport(),
        )
        let (queue, jobID, _, _) = makeQueueWithCompletedJob(refiner: { StubRefiner(output: output) })
        var drainedCount = 0
        queue.onRefineQueueDrained = { drainedCount += 1 }

        queue.markFastComplete(jobID: jobID)
        await queue.awaitRefineTasks()
        XCTAssertEqual(drainedCount, 1, "drain callback fires exactly once when the last refine finishes")
    }

    func testRefineQueueDrainedFiresOnCancel() async {
        let output = RefineOutput(segments: [], transcript: "X", report: stubReport())
        let (queue, jobID, _, _) = makeQueueWithCompletedJob(
            refiner: { StubRefiner(output: output, delay: .seconds(5)) },
        )
        var drained = false
        queue.onRefineQueueDrained = { drained = true }

        queue.markFastComplete(jobID: jobID)
        queue.cancelJob(id: jobID)
        await queue.awaitRefineTasks()
        XCTAssertTrue(drained, "drain fires after a cancelled refine unwinds so refine resources are freed")
    }

    func testConcurrentRefinesRunOneAtATime() async {
        // Two completed FAST jobs whose refines must NOT overlap — they share
        // the dedicated refine engine, so the queue serializes them FIFO.
        let tracker = OverlapTracker()
        let out = RefineOutput(segments: [], transcript: "X", report: stubReport())
        let queue = PipelineQueue(
            logDir: root.appendingPathComponent("ipc"),
            outputDir: root,
            maxRefinerFactory: { OverlapRefiner(tracker: tracker, output: out) },
            processingModeProvider: { .max },
        )
        func makeJob(_ stem: String) -> UUID {
            let txtURL = root.appendingPathComponent("protocols/\(stem).txt")
            try? "FAST".write(to: txtURL, atomically: true, encoding: .utf8)
            try? Data([0]).write(to: root.appendingPathComponent("recordings/\(stem)_app.wav"))
            let slug = "\(stem)_abcd1234"
            let segs = [TimestampedSegment(start: 0, end: 1, text: "FAST", speaker: "Remote")]
            try? JSONEncoder().encode(segs).write(to: root.appendingPathComponent("recordings/\(slug)_segments.json"))
            var job = PipelineJob(meetingTitle: stem, appName: "Chrome", mixPath: nil, appPath: nil, micPath: nil, micDelay: 0)
            job.transcriptPath = txtURL
            job.namingSlug = slug
            job.state = .generatingProtocol
            queue.insertJobForTesting(job)
            return job.id
        }
        let id1 = makeJob("20260712_1500_a")
        let id2 = makeJob("20260712_1600_b")

        queue.markFastComplete(jobID: id1)
        queue.markFastComplete(jobID: id2)
        await queue.awaitRefineTasks()

        let peak = await tracker.maxConcurrent
        XCTAssertEqual(peak, 1, "refines never overlap on the shared refine engine")
        XCTAssertEqual(queue.jobs.first { $0.id == id1 }?.state, .done)
        XCTAssertEqual(queue.jobs.first { $0.id == id2 }?.state, .done)
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

/// Tracks the peak number of concurrently-executing refines, so a test can
/// assert the FIFO gate never lets two overlap.
private actor OverlapTracker {
    private(set) var maxConcurrent = 0
    private var active = 0
    func enter() { active += 1; maxConcurrent = max(maxConcurrent, active) }
    func leave() { active -= 1 }
}

/// A refiner that marks itself active for a short window so two of them would
/// visibly overlap if the queue failed to serialize them.
private final class OverlapRefiner: MaxRefining, @unchecked Sendable {
    let tracker: OverlapTracker
    let output: RefineOutput

    init(tracker: OverlapTracker, output: RefineOutput) {
        self.tracker = tracker
        self.output = output
    }

    func refine(
        _: RefineInput,
        progress _: @escaping @Sendable (RefineStage, Double) -> Void,
    ) async throws -> RefineOutput {
        await tracker.enter()
        try? await Task.sleep(for: .milliseconds(50))
        await tracker.leave()
        return output
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
