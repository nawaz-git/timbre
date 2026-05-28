# QA-002 — Engine PermissionHealthCheck failure → no WatchLoop

## Symptom
Every Mintr-spawned `MintrEngine` logs `Notification permission denied` then `Permission health check failed: <private>`, and never starts WatchLoop (8 PIDs / 15 min). Shell-launched: same binary, WatchLoop starts. `<private>` hides the missing TCC service in `os_log` — but the unified TCC log shows it clearly.

## Helper's Declared Permission Surface
From `MintrEngine.app/Contents/Info.plist`:
- `CFBundleIdentifier = ai.nawaz.mintr-engine`, `LSUIElement = true`
- `NSMicrophoneUsageDescription` — record meeting audio
- `NSScreenCaptureUsageDescription` — read window titles
- `NSAccessibilityUsageDescription` — detect mute state and read participants

## Helper's Entitlements
`codesign -d --entitlements -` returns exactly one: `com.apple.security.device.audio-input = true`. No hardened-runtime exceptions, no `check-by-audit-token`. Helper depends entirely on runtime TCC prompts driven by the usage strings.

## Most Likely Missing TCC Service
**Accessibility (`kTCCServiceAccessibility`).** Smoking gun from `log show --predicate 'subsystem == "com.apple.TCC"'`, repeats on every MintrEngine PID:
```
TCCDProcess: identifier=ai.nawaz.mintr-engine, ... attempted to call
TCCAccessRequest for kTCCServiceAccessibility ...
```
The "recommended entitlement" warning is benign (path-based attribution). What matters: the engine IS asking for Accessibility, and the user never granted it — macOS doesn't auto-prompt for Accessibility; the user must manually drag the app into Privacy → Accessibility, which they didn't.

`Notification permission denied` is a secondary failure: `LSUIElement=true` helpers spawned by a foreground Electron parent often hit `UNAuthorizationStatusDenied`. Mic for the new bundle is un-prompted too, but the engine fails earlier on Accessibility and never opens an `AVCaptureSession` to trigger the mic prompt.

## Can We Capture Un-Redacted Helper Output?
Partly. `backend.ts:378-403` pipes `stdio: ['ignore', 'pipe', 'pipe']` and `child.stderr` lines go to `console.warn('[live-recorder:stderr]', ...)` (line 401) — Electron main's stdout (terminal in dev, NOT user-visible in packaged builds), stored nowhere. But the redacted line is `os_log`, not stderr, so our pipe can't see it. Two ways forward:
1. **(read-only, today)** Run `log show --predicate 'process == "MintrEngine" AND subsystem == "com.meetingtranscriber"' --info --last 30s` ~2s post-spawn and parse. No engine rebuild needed.
2. **(needs engine)** Flip the engine's `os_log` privacy specifier from `<private>` to `<public>` for the service-name string.

A 5s stderr ring buffer surfaced via IPC would catch crash banners but NOT the redacted line.

## Can Mintr Pre-Flight Each Required Permission?
Mostly no. Per Electron docs: `systemPreferences.getMediaAccessStatus(type)` accepts only `'microphone' | 'camera' | 'screen'` — `'accessibility'` rejected. `systemPreferences.isTrustedAccessibilityClient(prompt)` queries the CALLING process (Electron/Mintr), NOT the helper bundle id. No public Electron/AppKit API queries another bundle's TCC. Best heuristics from Mintr:
- Tail unified log for `ai.nawaz.mintr-engine ... kTCCServiceAccessibility ... attempted to call` — direct per-service signal.
- `captureWatchdog.lastEngineWriteAt` (currently 25s threshold gated on Chrome-detect, `captureWatchdog.ts:46`); shorten to ~5s post-spawn for a fast pre-flight.

## Recommended UX
Replace the single generic banner at `Home.tsx:296-352` with per-service banners:
- **Accessibility** — "Grant Mintr Engine Accessibility access. macOS doesn't auto-prompt for this — please add it manually." Buttons: "Open Accessibility settings" (`paneURL('accessibility')`, already wired at `permissions.ts:109`), "Reveal engine in Finder".
- **Microphone (engine)** — "Mintr Engine needs Microphone access." Button → `paneURL('microphone')`.
- **Screen Recording (engine)** — keep current copy.
- Small muted text under each: parsed `log show` reason.

## Files To Modify (list, no code yet)
- `src/main/permissions.ts` — add `getEnginePermissionStatus()`: parse `log show` for `kTCCServiceAccessibility/Microphone/ScreenCapture` denials against `ai.nawaz.mintr-engine`.
- `src/shared/types.ts:205-215` — extend `PermissionStatus` with `engine: { accessibility, microphone, screenRecording }`.
- `src/main/ipc/index.ts:337` — return new shape from `IPC.systemPermissions`.
- `src/main/backend.ts:401` — extend stderr into a 5s ring buffer surfaced via IPC.
- `src/renderer/src/views/Home.tsx:296-352` — split into per-service banners; demote watchdog banner to fallback.
- `src/main/captureWatchdog.ts:46` — consider lowering `WATCHDOG_THRESHOLD_MS` (25000) now we have a sharper signal.

## Open Questions
- Does PermissionHealthCheck require ALL of Accessibility + Mic + Screen + Notifications and fail-fast, or only Accessibility? Without source we can't tell — ask engine team to log the failing service `<public>` or stderr it.
- Why does shell-launch succeed when Mintr-launch fails, given the same `requesting=` bundle id? Hypothesis: macOS's responsibility chain (`responsible={identifier=Electron}` is in EVERY `AUTHREQ_ATTRIBUTION` even with `detached:true`) consults Mintr's TCC instead of the helper's. Test: `launchctl bsexec 1 ...` to truly detach — if PermissionHealthCheck then passes, `detached:true` isn't enough; we need a launch agent or `NSResponsibleProcessInfo`.
- Is `Notification permission denied` a HARD precondition? If yes, fixing Accessibility alone won't unblock WatchLoop.
