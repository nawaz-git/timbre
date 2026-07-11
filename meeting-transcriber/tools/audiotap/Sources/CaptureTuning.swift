import Foundation

/// Shared tuning constants for the capture lifecycle. Hoisted into one place so
/// the tap lifecycle coordinator and the mic restart coalescer use the SAME
/// device-change debounce, and every rebuild / cap policy has a single source of
/// truth rather than magic numbers scattered across the capture path.
enum CaptureTuning {
    /// Debounce window for coalescing output/input device-change bursts. A
    /// Bluetooth HFP↔A2DP flip is not one event — it arrives as several
    /// notifications (device removed, re-added, rate renegotiated, default
    /// output bounced). We wait for the device identity to be quiet this long
    /// before tearing anything down.
    static let deviceChangeDebounce: TimeInterval = 2.0

    /// Minimum wall-clock between successive full tap rebuild cycles, so a storm
    /// can never drive a hot rebuild loop against a device coreaudiod is itself
    /// still reconfiguring.
    static let minRebuildInterval: TimeInterval = 5.0

    /// Consecutive failed rebuild cycles before giving up into the degraded
    /// state (tap off, level publisher reports -120) instead of hot-looping.
    static let maxRebuilds: Int = 3

    /// Backoff before re-attempting a rebuild from the degraded state.
    static let degradedBackoff: TimeInterval = 30.0

    /// Hard cap on the number of process objects a single tap fans in. A Chrome
    /// tree is 40-100 helpers, but only a small, stable set actually owns audio.
    static let maxTapPIDs: Int = 8

    /// Capacity of the SPSC capture ring buffer that decouples the CATap IOProc
    /// from disk writes. 16 MiB ≈ 43 s of 48 kHz stereo Float32 — deep enough that
    /// a healthy disk never overflows it, so capture stays byte-identical to the
    /// pre-ring direct-write path.
    static let ringCapacityBytes: Int = 16 * 1024 * 1024

    /// How often the capture writer thread drains the ring to disk. 50 ms keeps
    /// worst-case queued audio well under the ring capacity on a healthy disk while
    /// staying far below the writer's stop deadline.
    static let writerDrainInterval: TimeInterval = 0.05

    /// Staging-buffer size for each ring→disk copy. 512 KiB ≈ 1.3 s of 48 kHz stereo
    /// Float32, so a backed-up ring drains in a few loop iterations.
    static let writerScratchBytes: Int = 512 * 1024

    /// Upper bound on how long capture stop waits for the writer's final flush
    /// before proceeding — the bounded replacement for the old unbounded drain
    /// barrier, so a stalled disk can never hang teardown.
    static let writerFlushDeadline: TimeInterval = 3.0

    /// How often the tap-health watchdog evaluates the capture.
    static let tapHealthCheckInterval: TimeInterval = 5.0

    /// The IOProc has not fired for this long while the device claims running →
    /// the tap is dead (no-callback fault).
    static let tapNoCallbackTimeout: TimeInterval = 5.0

    /// Every captured sample has been zero for this long *while the mic is
    /// non-silent* → the tap is delivering silence (all-zero fault). Long enough to
    /// never trip on natural pauses.
    static let tapAllZeroTimeout: TimeInterval = 60.0

    /// A peer (mic) channel above this dBFS counts as "non-silent" for the all-zero
    /// asymmetry guard. Matches `ChannelHealthMonitor`'s silence floor.
    static let micSilenceFloorDBFS: Double = -60
}
