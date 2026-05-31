// `@preconcurrency` mirrors AudioMixer.swift in the main app: AVFoundation
// isn't fully Sendable-annotated yet, but the synchronous reader pattern is
// safe in practice.
@preconcurrency import AVFoundation
import Foundation

/// Loads any AVAsset-compatible audio or video container into a mono Float32
/// buffer at 16 kHz, and writes the same buffer back as a 16-bit PCM WAV.
///
/// This is a standalone re-implementation of the load + resample + save
/// pieces of `AudioMixer` from the main app — same algorithms, same target
/// sample rate, no echo suppression or mic-delay logic (the batch CLI only
/// processes one mono input).
enum AudioLoader {
    /// Target sample rate everything downstream (WhisperKit, FluidAudio
    /// diarizer) expects. Matches `AudioConstants.targetSampleRate` in the
    /// main app.
    static let targetSampleRate = 16000

    enum Error: Swift.Error, LocalizedError {
        case bufferCreationFailed
        case formatCreationFailed
        case noAudioTrack
        case audioExtractionFailed(String)
        case unreadable(String)

        var errorDescription: String? {
            switch self {
            case .bufferCreationFailed: "Failed to create audio buffer"
            case .formatCreationFailed: "Failed to create audio format"
            case .noAudioTrack: "File contains no audio track"
            case let .audioExtractionFailed(detail): "Audio extraction failed: \(detail)"
            case let .unreadable(detail): "Audio file unreadable: \(detail)"
            }
        }
    }

    /// Load any audio or video file as mono Float32 samples + source rate.
    ///
    /// Two-tier fallback:
    /// 1. `AVAudioFile` (fast, covers WAV/MP3/M4A/AIFF/FLAC/CAF).
    /// 2. `AVAsset` (covers MP4/MOV and other video containers via track
    ///    extraction at the target sample rate directly).
    ///
    /// Returns samples in the *source* sample rate. The caller is responsible
    /// for resampling to the target rate. (The AVAsset path already returns
    /// `targetSampleRate` samples; the AVAudioFile path returns the source's
    /// native rate.)
    static func loadAsFloat32(url: URL) async throws -> (samples: [Float], sampleRate: Int) {
        // Fast path: AVAudioFile handles the common audio formats.
        do {
            let file = try AVAudioFile(forReading: url)
            let sampleRate = Int(file.processingFormat.sampleRate)
            let samples = try readSamplesFromAudioFile(file)
            return (samples, sampleRate)
        } catch let audioFileError {
            // Fallback: AVAsset for video containers (MP4/MOV/etc). Resamples
            // to `targetSampleRate` as part of the reader output settings, so
            // the caller doesn't need a second resampling pass for these.
            do {
                return try await loadAudioFromAVAsset(url: url)
            } catch {
                throw Error.unreadable(
                    "AVAudioFile: \(audioFileError.localizedDescription); AVAsset: \(error.localizedDescription)",
                )
            }
        }
    }

    /// Extract audio from a video / non-PCM container using AVAsset.
    /// Output settings force mono Float32 at the target sample rate, so the
    /// returned buffer is ready to feed straight to the engines.
    static func loadAudioFromAVAsset(url: URL) async throws -> (samples: [Float], sampleRate: Int) {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard let audioTrack = tracks.first else {
            throw Error.noAudioTrack
        }

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: targetSampleRate,
        ]
        let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(output)

        guard reader.startReading() else {
            throw Error.audioExtractionFailed(
                reader.error?.localizedDescription ?? "Unknown error",
            )
        }

        // Pre-allocate based on asset duration to avoid repeated array reallocations.
        var samples = [Float]()
        let duration = try await asset.load(.duration)
        let estimatedSamples = Int(CMTimeGetSeconds(duration) * Double(targetSampleRate))
        if estimatedSamples > 0 {
            samples.reserveCapacity(estimatedSamples)
        }
        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            let floatCount = length / MemoryLayout<Float>.size
            let offset = samples.count
            samples.append(contentsOf: repeatElement(Float(0), count: floatCount))
            _ = samples.withUnsafeMutableBufferPointer { buf in
                guard let base = buf.baseAddress else { return Int(noErr) }
                return Int(CMBlockBufferCopyDataBytes(
                    blockBuffer,
                    atOffset: 0,
                    dataLength: length,
                    destination: base + offset,
                ))
            }
        }

        if reader.status == .failed {
            throw Error.audioExtractionFailed(
                reader.error?.localizedDescription ?? "Unknown error",
            )
        }

        return (samples, targetSampleRate)
    }

    /// Convert `samples` from `sourceRate` to `targetRate` via AVAudioConverter
    /// (proper anti-aliasing filter). No-op when rates already match.
    static func resample(_ samples: [Float], from sourceRate: Int, to targetRate: Int) -> [Float] {
        guard sourceRate != targetRate, !samples.isEmpty else { return samples }

        guard let srcFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Double(sourceRate), channels: 1, interleaved: false,
        ), let dstFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Double(targetRate), channels: 1, interleaved: false,
        ), let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
            return samples
        }

        let frameCount = AVAudioFrameCount(samples.count)
        guard let srcBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: frameCount) else {
            return samples
        }
        srcBuffer.frameLength = frameCount
        samples.withUnsafeBufferPointer { ptr in
            guard let channels = srcBuffer.floatChannelData, let base = ptr.baseAddress else { return }
            channels[0].initialize(from: base, count: samples.count)
        }

        let outputCount = AVAudioFrameCount(Double(samples.count) * Double(targetRate) / Double(sourceRate))
        guard let dstBuffer = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: outputCount) else {
            return samples
        }

        // Boxed flag so the @Sendable input block can capture by reference
        // without tripping Swift 6's strict-concurrency check. The block runs
        // synchronously while convert(to:error:withInputFrom:) is on the
        // stack, so a single-shot consumed flag is safe.
        final class InputState: @unchecked Sendable { var consumed = false }
        let inputState = InputState()
        var error: NSError?
        converter.convert(to: dstBuffer, error: &error) { _, outStatus in
            if inputState.consumed {
                outStatus.pointee = .endOfStream
                return nil
            }
            inputState.consumed = true
            outStatus.pointee = .haveData
            return srcBuffer
        }
        if error != nil {
            return samples
        }
        guard let channels = dstBuffer.floatChannelData else { return samples }
        return Array(UnsafeBufferPointer(start: channels[0], count: Int(dstBuffer.frameLength)))
    }

    /// Save mono Float32 samples to a 16-bit PCM WAV file at `sampleRate`.
    static func saveWAV(samples: [Float], sampleRate: Int, url: URL) throws {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false,
        ) else {
            throw Error.formatCreationFailed
        }
        let file = try AVAudioFile(
            forWriting: url,
            settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
            ],
        )

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else {
            throw Error.bufferCreationFailed
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let channels = buffer.floatChannelData else {
            throw Error.bufferCreationFailed
        }
        samples.withUnsafeBufferPointer { src in
            guard let base = src.baseAddress else { return }
            channels[0].initialize(from: base, count: samples.count)
        }
        try file.write(from: buffer)

        // Restrict to owner-only (0600); audio may contain sensitive content.
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path,
        )
    }

    // MARK: - Private

    private static func readSamplesFromAudioFile(_ file: AVAudioFile) throws -> [Float] {
        let format = file.processingFormat
        let frameCount = AVAudioFrameCount(file.length)
        guard frameCount > 0 else { return [] }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            throw Error.bufferCreationFailed
        }
        try file.read(into: buffer)

        guard let floatData = buffer.floatChannelData else {
            throw Error.bufferCreationFailed
        }

        let channelCount = Int(format.channelCount)
        let sampleCount = Int(buffer.frameLength)

        if channelCount == 1 {
            return Array(UnsafeBufferPointer(start: floatData[0], count: sampleCount))
        }

        // Stereo / multi-channel → mono by averaging channels.
        var mono = [Float](repeating: 0, count: sampleCount)
        for ch in 0 ..< channelCount {
            let channelPtr = floatData[ch]
            for i in 0 ..< sampleCount {
                mono[i] += channelPtr[i]
            }
        }
        let scale = 1.0 / Float(channelCount)
        for i in 0 ..< sampleCount {
            mono[i] *= scale
        }
        return mono
    }
}
