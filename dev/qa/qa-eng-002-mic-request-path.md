# QA-ENG-002 — Where does/should the engine request Microphone?

## Existing requestAccess usage (file:line, or "none found")
Exactly ONE call: `app/MeetingTranscriber/Sources/Permissions.swift:31`
```swift
let granted = await AVCaptureDevice.requestAccess(for: .audio)
```
It lives inside `Permissions.ensureMicrophoneAccess()` (Permissions.swift:27-41), guarded so it only fires when `authorizationStatus == .notDetermined` (line 30). All other `AVCaptureDevice` references are passive `authorizationStatus`/`default`/`DiscoverySession` reads (PermissionHealthCheck.swift:232,304; Permissions.swift:28; MicRecorder.swift:31; MicCaptureHandler.swift:96; AudioSettingsView.swift:47; AdvancedSettingsView.swift:171) — none prompt.

`ensureMicrophoneAccess()` is NOT on the startup path. Its only production callers are the two recording-start entry points:
- `AppState.swift:434` — `toggleWatching()` (auto-watch)
- `AppState.swift:483` — `startManualRecording()`

So the prompt can only fire when the user actively starts watching/recording — never on first launch.

## What the recording-start path does re: mic permission
The recording path DOES request access (it does not just blindly start the engine):
1. `toggleWatching()` / `startManualRecording()` → `await Permissions.ensureMicrophoneAccess()` (AppState.swift:434/483) — this is the one place that would surface the OS consent dialog (when status is `.notDetermined`). Its return value is discarded (`_ =`), so a denial does not block recording.
2. Recording then proceeds via `WatchLoop` → `DualSourceRecorder.start()` → `session.start()` (DualSourceRecorder.swift:158) → `AudioCaptureSession` → `MicCaptureHandler.start()` → `engine.start()` (MicCaptureHandler.swift:219). This leg assumes access and would silently capture silence/fail if not granted — it never calls `requestAccess`.

Net: a prompt CAN fire here, but only at recording time, and only if TCC still considers the bundle id `.notDetermined`.

## Existing Permissions.requestMicrophone helper? (quote)
Yes — named `ensureMicrophoneAccess()`, not `requestMicrophone`. Permissions.swift:27-41:
```swift
static func ensureMicrophoneAccess() async -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .authorized { return true }
    if status == .notDetermined {
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        if !granted {
            logger.warning("permission_denied resource=microphone status=user_denied_prompt")
        }
        return granted
    }
    logger.warning("permission_denied resource=microphone status=\(status.rawValue, privacy: .public)")
    return false
}
```

## NSMicrophoneUsageDescription value
Present in `app/MeetingTranscriber/Sources/Info.plist:27-28`:
> "Meeting Transcriber needs microphone access to record meeting audio for transcription."

(Note: `CFBundleIdentifier` in this Info.plist is `com.meetingtranscriber.app` at line 6, not `ai.nawaz.mintr-engine` — worth confirming which bundle id the shipped engine actually runs under.)

## Cleanest injection point for proactive startup requestAccess
`MeetingTranscriberApp.swift:145-147` — the startup `.task { await appState.checkPermissions() }` modifier on the menu-bar scene. This is the first-launch async hook that already runs the (passive) permission health check; the existing `Permissions.ensureMicrophoneAccess()` helper can be awaited from here. Calling it at app launch makes the OS consent prompt fire on first run, registering `ai.nawaz.mintr-engine` in the TCC Microphone list (the only way to appear there on Tahoe, given no "+" button).

## Recommended change (described, NOT implemented)
Add `await Permissions.ensureMicrophoneAccess()` early in the startup `.task` at MeetingTranscriberApp.swift:145 (before or after `checkPermissions()`), so the consent prompt fires once on first launch instead of waiting for the first recording. The helper is already idempotent — it returns immediately when status is `.authorized` and only prompts on `.notDetermined`, so re-running on every launch is harmless. No new code/API is required; only the call site moves earlier. The recording-start calls at AppState.swift:434/483 can stay as a safety net. This guarantees a Microphone TCC entry exists well before the detector ever hands off to `MicCaptureHandler.start()`, closing the "zero Microphone history" gap.
