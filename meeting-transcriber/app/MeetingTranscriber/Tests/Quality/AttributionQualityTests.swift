@testable import MeetingTranscriber
import MTPipelineCore
import XCTest

/// Word-level speaker-attribution quality lane. Skipped by default — gated by
/// `RUN_QUALITY_TESTS=1` so a normal `swift test` doesn't pull the ~1 GB ASR
/// model plus the diarizer models. CI's quality-baseline job sets the env var.
///
/// For every `*_truth.json` under `Tests/Fixtures/quality/attribution/`, this
/// runs the FAST attribution path the product ships — transcribe with word
/// timings, diarize, attribute per word through `MTPipelineCore` (the same
/// `WordTimeline` / `DualTrackAttribution` the live pipeline and mt-batch use)
/// — then scores WDER, DER and speaker-count against the truth and records a
/// `QualityResult` row.
///
/// **Gate philosophy (ratchet, not magic numbers).** The per-tier targets that
/// define "done" (dual-track WDER ≤ 10 % FAST / ≤ 5 % MAX; mixed ≤ 15 % / ≤ 8 %;
/// see docs/diarization-benchmarks.md) are calibrated for real conversational
/// audio. Rather than hard-code an absolute pass/fail that would either flap on
/// the synthetic committed fixtures or lock in a bad number, the hard assertion
/// is: (a) a catastrophic-failure sanity bound that always holds, and (b) a
/// ratchet against a checked-in baseline when one exists — fail if WDER is more
/// than 10 % relatively worse than the recorded baseline. The first CI run over
/// the AMI-derived fixtures records the baselines; from then on the targets are
/// enforced through the ratchet. Until then the lane records and sanity-checks.
///
/// MAX-tier numbers (Tier-2 targets) are produced by the nightly lane and the
/// `mt-batch --mode max --emit-metrics` sweep documented in the runbook; this
/// class measures the FAST tier that runs on every push.
@MainActor
final class AttributionQualityTests: XCTestCase {
    /// A WDER at or above this means the attribution path is broken (no
    /// segments, model not loaded, audio not decoded) rather than merely
    /// under-clustering — a two-speaker collapse only reaches ~0.5. Set high so
    /// it never flaps on a weak synthetic fixture while still tripping on a
    /// genuine breakage.
    private static let catastrophicWDER = 0.9

    /// A WDER regression beyond this fraction of the recorded baseline fails
    /// the lane once a baseline is checked in.
    private static let ratchetTolerance = 0.10

    func test_fast_attribution_matrix() async throws {
        try skipUnlessQualityRun()
        let fixtures = try Self.attributionFixtures()
        try XCTSkipIf(
            fixtures.isEmpty,
            "No attribution fixtures — run scripts/generate_dualtrack_fixtures.sh (or the CI fixtures-download step)",
        )
        var measured = 0
        for truthURL in fixtures {
            if try await runFast(truthURL: truthURL) { measured += 1 }
        }
        try XCTSkipIf(measured == 0, "Every attribution fixture was skipped (audio files missing)")
    }

    // MARK: - One fixture

    /// Returns `true` when the fixture was measured, `false` when skipped for
    /// missing audio (so the caller can tell "all skipped" from "ran").
    private func runFast(truthURL: URL) async throws -> Bool {
        let truth = try JSONDecoder().decode(AttributionTruth.self, from: Data(contentsOf: truthURL))
        let dir = truthURL.deletingLastPathComponent()

        let engine = WhisperKitEngine()
        engine.language = nil // auto-detect: WDER is time-projected, decode language is not load-bearing
        let diarizer = FluidDiarizer(mode: .offline)

        let hypSegments: [TimestampedSegment]
        switch truth.kind {
        case "dualtrack":
            guard let appName = truth.appAudio, let micName = truth.micAudio else {
                XCTFail("\(truth.fixture): dualtrack truth missing appAudio/micAudio"); return false
            }
            let appURL = dir.appendingPathComponent(appName)
            let micURL = dir.appendingPathComponent(micName)
            guard exists(appURL), exists(micURL) else { return false }
            await engine.loadModel()
            XCTAssertEqual(engine.modelState, .loaded, "WhisperKit model failed to load")
            let (_, appWords) = try await engine.transcribeWords(audioPath: appURL, source: .app)
            let (_, micWords) = try await engine.transcribeWords(audioPath: micURL, source: .mic)
            let appDiar = try await diarizer.run(
                audioPath: appURL, numSpeakers: nil, meetingTitle: truth.fixture,
            ).segments
            hypSegments = DualTrackAttribution.attribute(
                appWords: appWords,
                micWords: micWords,
                appTurns: appDiar,
                micTurns: nil,
                micLabel: truth.micSpeaker ?? "Me",
                micDelay: truth.micDelay ?? 0,
            ).kept

        default: // "mixed" — single combined track (the import path)
            guard let audioName = truth.audio else {
                XCTFail("\(truth.fixture): mixed truth missing audio"); return false
            }
            let audioURL = dir.appendingPathComponent(audioName)
            guard exists(audioURL) else { return false }
            await engine.loadModel()
            XCTAssertEqual(engine.modelState, .loaded, "WhisperKit model failed to load")
            let (_, words) = try await engine.transcribeWords(audioPath: audioURL, source: .app)
            let diar = try await diarizer.run(
                audioPath: audioURL, numSpeakers: nil, meetingTitle: truth.fixture,
            ).segments
            hypSegments = WordTimeline.attribute(words: words, diarization: diar)
        }

        let hypTurns = hypSegments.map { SpeakerSegment(start: $0.start, end: $0.end, speaker: $0.speaker) }
        let wder = DiarizationMetrics.wder(referenceWords: truth.words, hypothesisTurns: hypTurns)
        let der = DiarizationMetrics.der(referenceTurns: truth.referenceTurns, hypothesisTurns: hypTurns)
        let speakerCountError = DiarizationMetrics.speakerCountError(
            referenceTurns: truth.referenceTurns, hypothesisTurns: hypTurns,
        )

        QualityResultsWriter.shared.append(QualityResult(
            engine: "attribution.fast.\(truth.kind)",
            fixture: truth.fixture,
            modelVariant: nil,
            wer: nil,
            der: der.der,
            werBreakdown: nil,
            derBreakdown: nil,
            appVersion: qualityAppVersion,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            durationSeconds: truth.duration,
            wder: wder.errorRate,
            tier: "fast",
            speakerCountError: speakerCountError,
        ))
        _ = try? QualityResultsWriter.shared.flush()

        XCTAssertFalse(hypTurns.isEmpty, "\(truth.fixture): attribution produced no segments")
        XCTAssertLessThan(
            wder.errorRate, Self.catastrophicWDER,
            "\(truth.fixture): WDER catastrophic (\(wder.errorRate)) — "
                + "\(hypTurns.count) hyp segments across \(Set(hypTurns.map(\.speaker)).count) speakers",
        )
        try ratchet(fixture: truth.fixture, tier: "fast", wder: wder.errorRate)
        return true
    }

    // MARK: - Ratchet

    /// Fail if `wder` regressed more than `ratchetTolerance` past a checked-in
    /// baseline. No-op until a baseline is recorded (the record-only phase).
    private func ratchet(fixture: String, tier: String, wder: Double) throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("attribution_baselines.json")
        guard let data = try? Data(contentsOf: url),
              let baselines = try? JSONDecoder().decode([String: Double].self, from: data),
              let baseline = baselines["\(fixture)|\(tier)"]
        else {
            return
        }
        let ceiling = baseline * (1 + Self.ratchetTolerance)
        XCTAssertLessThanOrEqual(
            wder, ceiling,
            "\(fixture) [\(tier)]: WDER \(wder) regressed past baseline \(baseline) "
                + "(ceiling \(ceiling), tolerance \(Int(Self.ratchetTolerance * 100))%)",
        )
    }

    // MARK: - Fixture discovery

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    static var attributionFixturesDir: URL {
        URL(fileURLWithPath: #filePath) // Quality/AttributionQualityTests.swift
            .deletingLastPathComponent() // Quality/
            .deletingLastPathComponent() // Tests/
            .appendingPathComponent("Fixtures")
            .appendingPathComponent("quality")
            .appendingPathComponent("attribution")
    }

    static func attributionFixtures() throws -> [URL] {
        let dir = attributionFixturesDir
        guard FileManager.default.fileExists(atPath: dir.path) else { return [] }
        return try FileManager.default
            .contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix("_truth.json") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
