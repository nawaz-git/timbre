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
}
