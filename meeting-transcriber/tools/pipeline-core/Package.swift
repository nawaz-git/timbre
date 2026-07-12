// swift-tools-version: 6.0
//
// Shared, pure speaker-attribution logic for the two batch consumers.
//
// The menu-bar app (`app/MeetingTranscriber`) and the headless CLI
// (`tools/mt-batch`) live in separate SPM packages — an executableTarget's
// sources are internal-visibility and cannot be imported by another target,
// so before this package the word-attribution core had to be duplicated
// between them. `MTPipelineCore` hoists that core into one place both consume
// as a local path dependency (mirroring how `tools/audiotap` is shared).
//
// Deliberately dependency-free: everything here is value types + static
// functions (no CoreML, no AVFoundation), so it builds fast and unit-tests
// without downloading any model. The consumers own the impure orchestration
// (file I/O, ASR/diarizer model calls, RMS-over-audio) and inject it in.
import PackageDescription

let package = Package(
    name: "MTPipelineCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MTPipelineCore", targets: ["MTPipelineCore"]),
    ],
    targets: [
        .target(
            name: "MTPipelineCore",
            path: "Sources"
        ),
    ],
    swiftLanguageModes: [.v6]
)
