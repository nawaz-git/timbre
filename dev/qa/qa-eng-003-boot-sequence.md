# QA-ENG-003 — App boot sequence + rebuild path

Repo: `/Users/nawazpasha/Projects/meeting-transcriber/` (branch `add-google-meet-detection`). READ-ONLY analysis.

## Startup order (@main → watch start), with file:line

1. `@main struct MeetingTranscriberApp` — `MeetingTranscriberApp.swift:46-47`. No AppDelegate.
2. `@State private var appState = AppState(notifier:)` — eagerly constructs AppState before `init()` runs. `MeetingTranscriberApp.swift:48`.
3. `AppState.init` runs synchronously: engines created, `syncLanguageSettings()` / `observeEngineSettings()` / `setupLiveTranscriptionPrewarm()`, and (non-AppStore) debug RPC + persistent log streamer. `AppState.swift:109-198`. Note: init does **not** touch the mic or request any permission.
4. `MeetingTranscriberApp.init()` runs: `AppPaths.migrateIfNeeded()`, `NotificationManager.shared.setUp()`, `DualSourceRecorder.cleanupTempFiles()`, then schedules an auto-watch post at +3 s **only if** `--auto-watch` or `UserDefaults autoWatch` is set. `MeetingTranscriberApp.swift:53-70`.
5. First frame: `body` builds the `MenuBarExtra` scene; SwiftUI runs the `.task` modifiers attached to the menu-bar label. `MeetingTranscriberApp.swift:72-165`. Three `.task` blocks fire on appear:
   - load the active ASR model — `MeetingTranscriberApp.swift:125-141`
   - `updateChecker.startPeriodicChecks` — `MeetingTranscriberApp.swift:142-144`
   - `await appState.checkPermissions()` — `MeetingTranscriberApp.swift:145-147` (read-only TCC verdict + 500 ms probe; **does not** prompt).
6. Watch start: only if step 4 scheduled it — at +3 s `.autoWatchStart` posts (`MeetingTranscriberApp.swift:66-68`), the label's `.onReceive` calls `appState.toggleWatching()` (`MeetingTranscriberApp.swift:111-115`).
7. `toggleWatching()` enters a `Task { @MainActor … }` whose **first line** is `await Permissions.ensureMicrophoneAccess()` — `AppState.swift:433-434`, then builds + starts `WatchLoop`. `AppState.swift:445-471`.

Key finding: the only `AVCaptureDevice.requestAccess(for: .audio)` call is inside `Permissions.ensureMicrophoneAccess()` (`Permissions.swift:27-41`), reached **only** through `toggleWatching`/`startManualRecording` — i.e. gated behind watch-start, and only when `status == .notDetermined`. On a launch with auto-watch off, nothing ever prompts.

## LSUIElement / LSBackgroundOnly status (quote Info.plist)

`Info.plist:21-22`:
```
<key>LSUIElement</key>
<true/>
```
The app IS `LSUIElement` (menu-bar accessory, no Dock icon). There is **no** `LSBackgroundOnly` key anywhere in the plist (`Info.plist:1-34`). This is the correct state: accessory apps CAN present the TCC mic consent dialog; `LSBackgroundOnly=true` WOULD suppress it. So the boot path can legitimately show the prompt — it just never calls `requestAccess` proactively.

## Best injection point for a one-time startup requestAccess

The cleanest place that satisfies (a) runs every launch, (b) can present UI, (c) runs before/parallel to watch-start is a **new `.task` on the `MenuBarExtra` label**, alongside the existing `await appState.checkPermissions()` at `MeetingTranscriberApp.swift:145-147`. A `.task` fires once when the scene first appears, runs on the MainActor, and is independent of the +3 s auto-watch timer. `Permissions.ensureMicrophoneAccess()` (`Permissions.swift:27-41`) is already idempotent and no-ops when `.authorized` — only `.notDetermined` triggers the prompt — so calling it at boot is safe and self-throttling.

Alternative: call it inside `AppState.checkPermissions()` (`AppState.swift:768`) before the read-only probe. Avoid `AppState.init` — it runs off the first-frame timing and mixes a UI-presenting call into a synchronous constructor.

## Rebuild command + output .app path (vs what Mintr's electron-builder expects)

Command (`build_release.sh:103-107`): `cd app/MeetingTranscriber && swift build -c release --disable-sandbox`, then the binary is copied into a hand-assembled bundle.
- Output `.app`: `$PROJECT_ROOT/.build/release/MeetingTranscriber.app` (`build_release.sh` `BUILD_DIR`/`APP_BUNDLE` = `.build/release` + `MeetingTranscriber.app`).
- Mintr's `electron-builder.yml:32-33` copies `from: ../meeting-transcriber/.build/release/MeetingTranscriber.app`.

These match exactly — **no discrepancy**. For a quick unsigned dev rebuild use `./scripts/build_release.sh --no-notarize` (ad-hoc signs if no Developer ID). Note: the DMG step at the end **moves** the bundle into a staging dir and moves it back (`build_release.sh` Step 4), so the final `.app` lands back at `.build/release/MeetingTranscriber.app`.

## Recommended change (described, NOT implemented)

Add a fourth `.task` to the `MenuBarExtra` label near `MeetingTranscriberApp.swift:145-147`:

```
.task { _ = await Permissions.ensureMicrophoneAccess() }
```

This fires once per launch on the MainActor, before/parallel to the +3 s auto-watch timer, presents the consent dialog only when status is `.notDetermined`, and reuses the existing idempotent helper. Because the app is `LSUIElement` with no `LSBackgroundOnly`, macOS will render the prompt. No Info.plist change needed (`NSMicrophoneUsageDescription` already present, `Info.plist:27-28`). Rebuild via `./scripts/build_release.sh --no-notarize` → bundle at `.build/release/MeetingTranscriber.app`, which Mintr's electron-builder picks up unchanged.
