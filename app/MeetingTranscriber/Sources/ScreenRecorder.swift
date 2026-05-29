// Sources/ScreenRecorder.swift
//
// Whole-display video capture via ScreenCaptureKit, feeding AVAssetWriter to an
// HEVC .mp4. Runs CONCURRENTLY with DualSourceRecorder's audio capture: SCK video
// frames come from the window-server compositor and never touch the CoreAudio
// CATap aggregate device (tools/audiotap/AppAudioCapture.swift), so there is no
// contention. SCK audio is explicitly disabled — the CATap is the audio source
// of record. Relies on the existing Screen Recording TCC grant the engine bundle
// (ai.nawaz.mintr-engine) already holds — the same grant DebugRPCServer uses for
// one-shot screenshots; this just streams continuously.

import AppKit
// @preconcurrency: AVFoundation/CoreMedia types (CMSampleBuffer, AVAssetWriter*)
// lack Sendable annotations — same gap guarded in DualSourceRecorder.swift.
@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import os.log
// @preconcurrency: SCStreamConfiguration/SCContentFilter aren't Sendable-annotated.
@preconcurrency import ScreenCaptureKit

private let logger = Logger(subsystem: AppPaths.logSubsystem, category: "ScreenRecorder")

/// Tunables for a screen-recording session. Size/privacy-first defaults
/// (5 fps, 1080p cap, HEVC). Hardcoded for v1; surface via AppSettings later.
struct ScreenRecorderConfig: Sendable {
    var framesPerSecond: Int = 5
    var maxLongEdge: Int = 1080 // cap long side; 0 = display-native
    var useHEVC: Bool = true // HEVC hw-accelerated on Apple Silicon
    var showsCursor: Bool = true
    /// Target average bitrate. nil → derive from pixel count (see setupWriter()).
    var averageBitRate: Int?

    static let `default` = ScreenRecorderConfig()
}

enum ScreenRecorderError: LocalizedError {
    case noDisplay
    case notRecording
    case writerSetupFailed(String)
    case noFramesCaptured

    var errorDescription: String? {
        switch self {
        case .noDisplay: "No capturable display found"
        case .notRecording: "Screen recorder is not running"
        case let .writerSetupFailed(r): "Failed to set up video writer: \(r)"
        case .noFramesCaptured: "No video frames were captured"
        }
    }
}

/// Records the whole MAIN display to an HEVC .mp4. Lifecycle mirrors
/// DualSourceRecorder: `try await start()` then `try await stop() -> URL`.
/// An `actor` (not @MainActor) so the per-frame append path never blocks the
/// @MainActor WatchLoop (frames arrive ~5/sec on SCK's private queue).
@available(macOS 14.0, *)
actor ScreenRecorder {
    private let config: ScreenRecorderConfig
    private let outputURL: URL

    private var stream: SCStream?
    private var output: FrameOutput?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?

    private var sessionStarted = false
    private var frameCount = 0
    private(set) var isRecording = false

    /// - Parameter outputURL: where the .mp4 is written. Caller (WatchLoop) mints
    ///   the timestamped temp name `<ts>_screen.mp4` in AppPaths.recordingsDir,
    ///   parallel to the audio temp files DualSourceRecorder.start() creates;
    ///   PipelineQueue.copyAudioToOutput later renames it to `<slug>_screen.mp4`.
    init(outputURL: URL, config: ScreenRecorderConfig = .default) {
        self.outputURL = outputURL
        self.config = config
    }

    // MARK: - Start

    func start() async throws {
        guard !isRecording else { return }

        // 1. Pick the MAIN display (menu-bar display); fall back to first.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false,
        )
        guard let display = content.displays.first(where: {
            $0.displayID == CGMainDisplayID()
        }) ?? content.displays.first else {
            throw ScreenRecorderError.noDisplay
        }

        // 2. Output pixel size: cap long edge to maxLongEdge, preserve aspect,
        //    respect Retina backing scale so text stays sharp before downscale.
        let scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let nativeW = Int(CGFloat(display.width) * scale)
        let nativeH = Int(CGFloat(display.height) * scale)
        let (outW, outH) = Self.fit(
            width: nativeW, height: nativeH, maxLongEdge: config.maxLongEdge,
        )

        // 3. SCStreamConfiguration — VIDEO ONLY; audio explicitly off so we never
        //    contend with the CATap (tools/audiotap/AppAudioCapture.swift).
        let scConfig = SCStreamConfiguration()
        scConfig.width = outW
        scConfig.height = outH
        scConfig.minimumFrameInterval = CMTime(
            value: 1, timescale: CMTimeScale(max(config.framesPerSecond, 1)),
        )
        scConfig.queueDepth = 6
        scConfig.showsCursor = config.showsCursor
        scConfig.capturesAudio = false // audio stays on the CATap
        scConfig.pixelFormat = kCVPixelFormatType_32BGRA
        scConfig.colorSpaceName = CGColorSpace.sRGB

        let filter = SCContentFilter(display: display, excludingWindows: [])

        // 4. AVAssetWriter → HEVC (HW on Apple Silicon) or H.264 fallback.
        try setupWriter(width: outW, height: outH)

        // 5. SCStream + delegate. Frames are delivered on the delegate's own
        //    queue; the delegate hops each one into this actor. The buffer is
        //    wrapped in `SampleBufferBox` so it crosses the actor hop without
        //    tripping Swift 6's `sending` check — CMSampleBuffer is a CF type
        //    (ref-counted, retained by the box capture) and is only read on the
        //    actor after the hop, never concurrently with the delegate queue.
        let out = FrameOutput { [weak self] box in
            guard let self else { return }
            Task { await self.appendVideo(box.buffer) }
        }
        let stream = SCStream(filter: filter, configuration: scConfig, delegate: nil)
        try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: out.frameQueue)
        try await stream.startCapture()

        self.stream = stream
        output = out
        isRecording = true
        logger.info(
            "Screen recording started: \(outW)x\(outH) @ \(self.config.framesPerSecond)fps -> \(self.outputURL.lastPathComponent)",
        )
    }

    private func setupWriter(width: Int, height: Int) throws {
        try? FileManager.default.removeItem(at: outputURL)
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw ScreenRecorderError.writerSetupFailed(error.localizedDescription)
        }
        // faststart: front-load the moov atom so `<video>` Range-seeks before the
        // file is fully read (Electron mt-audio:// 206 streaming relies on it).
        writer.shouldOptimizeForNetworkUse = true

        let codec: AVVideoCodecType = config.useHEVC ? .hevc : .h264
        // ~0.07 bits/pixel/frame is plenty for mostly-static screen-share; floor 800k.
        let bitrate = config.averageBitRate
            ?? max(800_000, Int(Double(width * height * config.framesPerSecond) * 0.07))

        let settings: [String: Any] = [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoMaxKeyFrameIntervalKey: max(config.framesPerSecond, 1) * 5,
                AVVideoExpectedSourceFrameRateKey: config.framesPerSecond,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw ScreenRecorderError.writerSetupFailed("writer cannot add video input")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw ScreenRecorderError.writerSetupFailed(
                writer.error?.localizedDescription ?? "startWriting returned false",
            )
        }
        self.writer = writer
        videoInput = input
    }

    // MARK: - Per-frame append (actor-isolated)

    private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        guard isRecording, let writer, let videoInput else { return }
        guard CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard writer.status == .writing else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }
        if videoInput.isReadyForMoreMediaData {
            videoInput.append(sampleBuffer)
            frameCount += 1
        } // else: drop frame (back-pressure). Fine — no A/V sync to maintain.
    }

    // MARK: - Stop

    @discardableResult
    func stop() async throws -> URL {
        guard isRecording else { throw ScreenRecorderError.notRecording }
        isRecording = false

        // Stop the stream BEFORE finishing the writer so no late frame appends
        // after markAsFinished() and faults the writer.
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        output = nil

        guard let writer, let videoInput else { throw ScreenRecorderError.notRecording }
        videoInput.markAsFinished()
        await writer.finishWriting()

        let finalStatus = writer.status
        let finalError = writer.error
        self.writer = nil
        self.videoInput = nil

        if finalStatus == .failed {
            throw ScreenRecorderError.writerSetupFailed(
                finalError?.localizedDescription ?? "finishWriting failed",
            )
        }
        guard frameCount > 0 else {
            try? FileManager.default.removeItem(at: outputURL)
            throw ScreenRecorderError.noFramesCaptured
        }
        logger.info(
            "Screen recording saved: \(self.outputURL.lastPathComponent) (\(self.frameCount) frames)",
        )
        return outputURL
    }

    // MARK: - Helpers

    /// Scale (w,h) down so the long edge <= maxLongEdge, preserving aspect and
    /// keeping both dims even (HEVC requires even dimensions). 0 = no cap.
    nonisolated static func fit(width: Int, height: Int, maxLongEdge: Int) -> (Int, Int) {
        guard maxLongEdge > 0 else { return (even(width), even(height)) }
        let longEdge = max(width, height)
        guard longEdge > maxLongEdge else { return (even(width), even(height)) }
        let ratio = Double(maxLongEdge) / Double(longEdge)
        return (even(Int(Double(width) * ratio)), even(Int(Double(height) * ratio)))
    }

    nonisolated static func even(_ v: Int) -> Int { max(2, v - (v % 2)) }
}

/// SCStreamOutput delegate. Lives outside the actor because SCK delivers frames
/// on its own dispatch queue; forwards each CMSampleBuffer to the actor via the
/// injected closure. `@unchecked Sendable` because the only stored state is the
/// immutable closure + queue (same manual-serialization rationale as
/// AppAudioCapture's `@unchecked Sendable`).
@available(macOS 14.0, *)
final class FrameOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let frameQueue = DispatchQueue(label: "screenrecorder.frames", qos: .userInitiated)
    private let onFrame: @Sendable (SampleBufferBox) -> Void

    init(onFrame: @escaping @Sendable (SampleBufferBox) -> Void) {
        self.onFrame = onFrame
    }

    func stream(
        _: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType,
    ) {
        guard type == .screen else { return }
        // Only forward .complete frames; skip .idle/.blank/.suspended so idle
        // screens cost nothing. Status lives in the sample attachments.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false,
        ) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw),
            status == .complete else { return }
        onFrame(SampleBufferBox(sampleBuffer))
    }
}

/// `@unchecked Sendable` envelope for a `CMSampleBuffer` so it can cross the
/// delegate-queue → actor hop without tripping Swift 6 strict-concurrency's
/// `sending` diagnostic. `CMSampleBuffer` is a CoreFoundation type (no Sendable
/// conformance) but is reference-counted; capturing it here retains it across
/// the hop. Ownership is transferred — the box is consumed exactly once on the
/// actor and the delegate queue never touches the buffer again — so there is no
/// concurrent access. Same manual-serialization rationale as `FrameOutput`.
@available(macOS 14.0, *)
struct SampleBufferBox: @unchecked Sendable {
    let buffer: CMSampleBuffer
    init(_ buffer: CMSampleBuffer) { self.buffer = buffer }
}
