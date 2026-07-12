@testable import MeetingTranscriber
import XCTest

/// Unit coverage for the engine-heartbeat wire contract: the pure
/// state-precedence rule, the millisecond timestamp convention Electron's reuse
/// probe + supervisor depend on, and the JSON shape (exact keys, omitted
/// optionals) mirrored by `el/shared/types.ts`.
final class EngineHeartbeatTests: XCTestCase {
    // MARK: - Liveness-state precedence

    func testRecordingWinsOverEverything() {
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .recording, pipelineProcessing: true),
            .recording,
        )
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .recording, pipelineProcessing: false),
            .recording,
        )
    }

    func testWatchingWithBusyPipelineReadsAsProcessing() {
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .watching, pipelineProcessing: true),
            .processing,
        )
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .watching, pipelineProcessing: false),
            .watching,
        )
    }

    func testFinalizingOutranksEveryPhaseAsProcessing() {
        // A recording finalize now runs off the main actor with the heartbeat still
        // beating; advertising `processing` (not `recording`) is what lets Electron
        // distinguish a legitimately long mix from a wedge and extend its grace.
        XCTAssertEqual(
            EngineHeartbeat.livenessState(
                watchPhase: .recording, pipelineProcessing: false, finalizing: true,
            ),
            .processing,
        )
        XCTAssertEqual(
            EngineHeartbeat.livenessState(
                watchPhase: .idle, pipelineProcessing: false, finalizing: true,
            ),
            .processing,
        )
    }

    func testDefaultFinalizingFalsePreservesLegacyPrecedence() {
        // The added parameter is defaulted, so existing call sites keep the exact
        // recording-wins precedence.
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .recording, pipelineProcessing: true),
            .recording,
        )
    }

    func testIdleAndErrorMapToIdleOrProcessing() {
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .idle, pipelineProcessing: false),
            .idle,
        )
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .idle, pipelineProcessing: true),
            .processing,
        )
        // A transient error phase advertises idle, not error (the loop self-heals
        // back to watching, so `error` would only flap the supervisor).
        XCTAssertEqual(
            EngineHeartbeat.livenessState(watchPhase: .error, pipelineProcessing: false),
            .idle,
        )
    }

    // MARK: - Millisecond timestamps

    func testEpochMillisIsMillisecondsNotSeconds() {
        let date = Date(timeIntervalSince1970: 1_700_000_000.5)
        XCTAssertEqual(EngineHeartbeat.epochMillis(date), 1_700_000_000_500)
    }

    func testEpochMillisIsWellIntoTheTrillions() {
        // A real wall-clock heartbeat must be > 1e12 ms — the guard against
        // accidentally shipping Swift's default seconds (which broke reuse).
        XCTAssertGreaterThan(EngineHeartbeat.epochMillis(Date()), 1_000_000_000_000)
    }

    // MARK: - Wire shape (mirrors el/shared/types.ts)

    private func encodedObject(_ heartbeat: EngineHeartbeat) throws -> [String: Any] {
        let data = try JSONEncoder().encode(heartbeat)
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any])
    }

    func testStateEncodesAsTheRawUnionString() throws {
        let heartbeat = EngineHeartbeat(
            pid: 42, version: "0.39.0", state: .recording,
            startedAt: 1, lastIOCallbackAt: nil, lastSCKFrameAt: nil,
            tapPIDCount: nil, updatedAt: 2,
        )
        XCTAssertEqual(try encodedObject(heartbeat)["state"] as? String, "recording")
    }

    func testOptionalFieldsAreOmittedWhenNil() throws {
        let heartbeat = EngineHeartbeat(
            pid: 7, version: "0.39.0", state: .watching,
            startedAt: 100, lastIOCallbackAt: nil, lastSCKFrameAt: nil,
            tapPIDCount: nil, updatedAt: 200,
        )
        let json = try encodedObject(heartbeat)
        // Required keys present…
        XCTAssertNotNil(json["pid"])
        XCTAssertNotNil(json["version"])
        XCTAssertNotNil(json["state"])
        XCTAssertNotNil(json["startedAt"])
        XCTAssertNotNil(json["updatedAt"])
        // …optionals omitted, not encoded as null (matches the `?` TS fields).
        XCTAssertNil(json["lastIOCallbackAt"])
        XCTAssertNil(json["lastSCKFrameAt"])
        XCTAssertNil(json["tapPIDCount"])
    }

    func testPresentOptionalFieldsAreEncoded() throws {
        let heartbeat = EngineHeartbeat(
            pid: 7, version: "0.39.0", state: .recording,
            startedAt: 100, lastIOCallbackAt: 150, lastSCKFrameAt: 160,
            tapPIDCount: 3, updatedAt: 200,
        )
        let json = try encodedObject(heartbeat)
        XCTAssertEqual(json["lastIOCallbackAt"] as? Int, 150)
        XCTAssertEqual(json["lastSCKFrameAt"] as? Int, 160)
        XCTAssertEqual(json["tapPIDCount"] as? Int, 3)
    }

    func testRoundTripThroughJSON() throws {
        let heartbeat = EngineHeartbeat(
            pid: 999, version: "0.39.0", state: .processing,
            startedAt: 1_700_000_000_000, lastIOCallbackAt: 1_700_000_001_000,
            lastSCKFrameAt: nil, tapPIDCount: 5, updatedAt: 1_700_000_002_000,
        )
        let data = try JSONEncoder().encode(heartbeat)
        let decoded = try JSONDecoder().decode(EngineHeartbeat.self, from: data)
        XCTAssertEqual(decoded, heartbeat)
    }
}
