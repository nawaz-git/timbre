import Foundation
import MTPipelineCore
import WhisperKit

/// Common interface for transcription engine implementations (WhisperKit, Parakeet, …).
@MainActor
protocol TranscribingEngine: AnyObject {
    var modelState: ModelState { get }
    var downloadProgress: Double { get }
    var transcriptionProgress: Double { get } // swiftlint:disable:this unused_declaration

    func loadModel() async
    func transcribeSegments(audioPath: URL) async throws -> [TimestampedSegment]
}

/// Engines that can transcribe an already-decoded `[Float]` buffer of
/// 16 kHz mono samples in memory — the API the live-transcription
/// pipeline feeds with VAD-bounded chunks straight off the audio tap.
///
/// Engines that can't do in-memory transcription (e.g. a chunk-batch-only
/// backend) simply don't conform. The caller's `as? StreamingTranscribingEngine`
/// cast is the static equivalent of
/// `TranscriptionEngineSetting.supportsLiveTranscription`.
@MainActor
protocol StreamingTranscribingEngine: TranscribingEngine {
    func transcribeSamples(_ samples: [Float]) async throws -> String
}

/// Engines that can additionally emit per-word timestamps, enabling
/// `WordTimeline` word-level speaker attribution. Kept as a capability
/// protocol (like `StreamingTranscribingEngine`) so a backend without
/// reliable word timings simply doesn't conform and the pipeline falls back
/// to per-segment assignment. Word emission is batch-only — the live-captions
/// `transcribeSamples` path is deliberately untouched.
@MainActor
protocol WordTimestampingEngine: TranscribingEngine {
    /// Transcribe a 16 kHz mono WAV and return both the display segments (same
    /// shape as `transcribeSegments`) and the per-word timeline, each word
    /// stamped with `source` so the dual-source pipeline can tell mic from app.
    func transcribeWords(
        audioPath: URL,
        source: WordTimeline.Track,
    ) async throws -> (segments: [TimestampedSegment], words: [WordTimeline.Word])
}

extension TranscribingEngine {
    /// Label and merge pre-transcribed app/mic segments by timestamp.
    func mergeDualSourceSegments(
        appSegments: [TimestampedSegment],
        micSegments: [TimestampedSegment],
        micDelay: TimeInterval = 0,
        micLabel: String = "Me",
    ) -> [TimestampedSegment] {
        var app = appSegments
        var mic = micSegments

        if micDelay != 0 {
            mic = mic.map { seg in
                TimestampedSegment(
                    start: seg.start + micDelay,
                    end: seg.end + micDelay,
                    text: seg.text,
                    speaker: seg.speaker,
                )
            }
        }

        for i in app.indices {
            app[i].speaker = "Remote"
        }
        for i in mic.indices {
            mic[i].speaker = micLabel
        }

        var result = app + mic
        result.sort { $0.start < $1.start }
        return result
    }
}
