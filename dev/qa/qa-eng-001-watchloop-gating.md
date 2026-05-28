# QA-ENG-001 — Does WatchLoop gate on permission health?

Repo: `meeting-transcriber` @ `add-google-meet-detection`. Read-only.

## Boot → WatchLoop start path (file:line)
Headless launch path (no menu click):
1. `MeetingTranscriberApp.init()` posts `.autoWatchStart` after a 3 s delay **iff** `--auto-watch` arg or `autoWatch` default is set — `MeetingTranscriberApp.swift:63-69`.
2. `.onReceive(.autoWatchStart)` (attached to the MenuBarExtra **label**) calls `appState.toggleWatching()` — `MeetingTranscriberApp.swift:111-115`.
3. `AppState.toggleWatching()` spawns a `Task { @MainActor in ... }`, `await Permissions.ensureMicrophoneAccess()`, builds the `WatchLoop`, then calls `loop.start()` — `AppState.swift:433-471`.
4. `WatchLoop.start()` sets phase `.watching` and logs **"Watch mode started (poll: …s, grace: …s)"** — `WatchLoop.swift:156-169`.

## Is there a permission gate before watch starts? (quote the code)
**No permission-health gate exists in `WatchLoop.start()`.** Its only guard is reentrancy:
```swift
func start() {
    guard watchTask == nil else { return }      // WatchLoop.swift:157
    ...
    logger.info("Watch mode started ...")        // :163
```
`permissionChecker` (`WatchLoop.swift:48`) is consulted **only** in `startManualRecording`, never in `start()`/`watchLoop()`:
```swift
let health = await permissionChecker()           // WatchLoop.swift:191
if !health.isHealthy { throw RecorderError.permissionDenied(...) }   // :192-193
```
So `runLive()` does **not** gate auto-watch.

The real blocker sits upstream in `toggleWatching`, **before** `loop.start()`:
```swift
Task { @MainActor in
    _ = await Permissions.ensureMicrophoneAccess()   // AppState.swift:434
    ... // build loop
    watchLoop = loop
    loop.start()                                       // AppState.swift:470
}
```
`ensureMicrophoneAccess()` calls `AVCaptureDevice.requestAccess(for: .audio)` whenever mic auth is `.notDetermined` — `Permissions.swift:30-31`. That triggers a TCC **prompt**.

## Behaviour when Mic=notDetermined, ScreenRec+Accessibility=healthy
- `runLive()` would return `microphone: .notDetermined`, which `HealthCheckResult.problems` treats as healthy (only `.denied`/`.broken` are problems — `PermissionHealthCheck.swift:70-74`, `83-85`). So health-wise watch is allowed.
- BUT `toggleWatching` reaches `await Permissions.ensureMicrophoneAccess()` first (`AppState.swift:434`). With mic `.notDetermined` it calls `requestAccess` (`Permissions.swift:30-31`) and **suspends the Task awaiting a user TCC prompt**. In a headless/`/usr/bin/open`-launched engine with no foreground UI to surface the prompt, that continuation may never resume — so `loop.start()` at `AppState.swift:470` never runs and "Watch mode started" is never logged. This matches the observed symptom (silence after `PermissionHealthCheck failed` + the `NotificationManager` denial).

## Most likely reason WatchLoop doesn't start under /usr/bin/open launch
Two independent suspects, both upstream of `WatchLoop`:
1. **Mic prompt await stall (highest confidence given the symptom).** `await Permissions.ensureMicrophoneAccess()` (`AppState.swift:434`) blocks the start Task on an interactive TCC prompt that a headless launchd-parented engine can't satisfy → `loop.start()` (`:470`) is never reached.
2. **Auto-watch may never be triggered at all.** `.autoWatchStart` only fires if `--auto-watch`/`autoWatch` is set (`MeetingTranscriberApp.swift:63-66`), AND its handler is `.onReceive` on the MenuBarExtra label (`:111`). Open question: whether SwiftUI evaluates/attaches that label modifier in the engine's launch context, and whether Electron passes `--auto-watch`. If neither auto-watch arg nor default is set, watch is **never** started — independent of permissions.

Note: `WatchLoop` itself is `@MainActor` (`WatchLoop.swift:16`); `toggleWatching`'s inner work runs in a `@MainActor` Task (`AppState.swift:433`). The `await` at `:434` is the ordering hazard — it suspends before `start()`.

## Recommended change (described, NOT implemented)
- Do **not** block auto-watch start on an interactive mic prompt. Reorder `toggleWatching` so `loop.start()` runs first (or in parallel), and request mic access non-blocking / fire-and-forget — recording can proceed app-audio-only (`noMic`) until mic resolves. The watch loop should never sit behind a TCC prompt that a headless engine can't answer.
- Add a `logger` line immediately on entry to the `toggleWatching` Task and around the `await` at `AppState.swift:434` so the "stalled before start" hypothesis is observable in unified log.
- Confirm (open question) Electron launches the engine with `--auto-watch`; if not, the loop never starts regardless.

— Findings are citations + one explicitly-marked hypothesis (item 1) and two open questions (item 2, Electron arg). No code changed.
