// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AudioTapLib",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AudioTapLib", targets: ["AudioTapLib"]),
    ],
    dependencies: [
        // Lock-free atomics for the SPSC capture ring buffer (head/tail indices +
        // drop counter) so the CoreAudio IOProc never takes a lock. Pinned to the
        // exact swift-atomics revision already resolved elsewhere in the engine
        // dependency tree. NOTE: contrary to an earlier assumption this is NOT a
        // transitive FluidAudio dependency (FluidAudio declares no external
        // packages) — it is a genuine new direct dependency of AudioTapLib.
        .package(url: "https://github.com/apple/swift-atomics.git", exact: "1.2.0"),
    ],
    targets: [
        .target(
            name: "AudioTapLib",
            dependencies: [
                .product(name: "Atomics", package: "swift-atomics"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "AudioTapLibTests",
            dependencies: ["AudioTapLib"],
            path: "Tests"
        ),
    ]
)
