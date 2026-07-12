// swift-tools-version: 6.0
//
// Standalone CLI package for headless batch transcription + diarization.
//
// Why a separate package (rather than an executableTarget in
// `app/MeetingTranscriber/Package.swift`):
//  - The main app's target is an `executableTarget` whose sources are
//    internal-visibility and tied to AppState / AppKit; an executable
//    target cannot be imported by another target.
//  - mt-batch needs the same runtime deps (WhisperKit, FluidAudio, swift-
//    argument-parser) but is otherwise a pure subprocess — no NSApplication,
//    no menu bar, no TCC interaction. Keeping it standalone makes it easy
//    for an Electron parent (or any other process) to launch and parse.
//
// The build artifact ends up at `tools/mt-batch/.build/release/mt-batch`,
// consistent with the path the Electron driver expects.

import PackageDescription

let package = Package(
    name: "mt-batch",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "1.0.0"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.5"),
        .package(path: "../pipeline-core"),
    ],
    targets: [
        .executableTarget(
            name: "mt-batch",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "WhisperKit", package: "WhisperKit"),
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "MTPipelineCore", package: "pipeline-core"),
            ],
            path: "Sources/mt-batch",
        ),
    ],
)
