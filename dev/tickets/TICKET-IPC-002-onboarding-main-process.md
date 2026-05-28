# TICKET-IPC-002 — Onboarding main-process surface (IPC contract + state)

**Source**: REQ-001 §Deliverable B · `dev/qa/qa-onboard-ui-001-*.md`
**Branch**: `v23-ipc`
**Lane**: Electron MAIN process + preload + shared types. NO renderer JSX.

## Why
The onboarding wizard (TICKET-UI-003) needs to query the HELPER's TCC
state (not Mintr's), restart the helper, reveal it in Finder, and persist
completion. `usePermissions()` today reports Mintr's own TCC — wrong
principal. This ticket builds the main-side contract the UI codes against.

## THE IPC CONTRACT (both this ticket and TICKET-UI-003 code against this)

Add to `src/shared/types.ts`:

```ts
// Per-helper TCC grant state for onboarding.
export type OnboardingService = 'screen-recording' | 'microphone' | 'accessibility'
export type GrantStatus = 'granted' | 'denied' | 'not-determined' | 'unknown'

export interface HelperPermissionSnapshot {
  screenRecording: GrantStatus
  microphone: GrantStatus
  accessibility: GrantStatus
  /** True once the engine has logged "Watch mode started" since last (re)launch. */
  watchLoopRunning: boolean
}

// Settings: add
//   onboardingCompletedAt?: number   // ms epoch; undefined => show wizard

// IPC channels (add to the IPC enum):
//   onboardingProbe:        'onboarding:probe'         () => HelperPermissionSnapshot
//   onboardingOpenPane:     'onboarding:openPane'      (svc: OnboardingService) => void
//   onboardingRevealHelper: 'onboarding:revealHelper'  () => void
//   onboardingRestartEngine:'onboarding:restartEngine' () => { ok: boolean; message?: string }
//   onboardingVerifyEngine: 'onboarding:verifyEngine'  () => { watchLoopRunning: boolean; detail?: string }
//   onboardingComplete:     'onboarding:complete'      () => void
//   onboardingReset:        'onboarding:reset'         () => void
```

## Implementation

### `src/main/onboarding.ts` (NEW)
- `probeHelperPermissions(): Promise<HelperPermissionSnapshot>`:
  Reuse the EXACT `/usr/bin/log show --last 15s --predicate
  'subsystem == "com.apple.TCC" AND eventMessage CONTAINS
  "ai.nawaz.mintr-engine"'` pattern already proven in
  `src/main/captureWatchdog.ts` (`classifyHelperFailure`). For each
  service parse the most-recent `Auth Right:` verdict:
  - `Allowed (System Set)` / `Allowed (User Consent)` → `granted`
  - `Denied` → `denied`
  - `Unknown (None)` → `not-determined`
  - no entry → `unknown`
  ALSO read the engine's own verdict file `/tmp/mt-permission.log` (the
  engine writes `screen=healthy mic=healthy ax=...` there) as a
  cross-check / fallback — it's the most authoritative since it's the
  engine's live `CGPreflightScreenCaptureAccess()` / `AXIsProcessTrusted()`
  result. Prefer mt-permission.log when present; fall back to tccd log.
  For `watchLoopRunning`: grep the engine subsystem log (last 60s) for
  `WatchLoop] Watch mode started`.
- `openPane(svc)`: delegate to the existing `openPrivacyPane()` in
  `src/main/permissions.ts` (maps service → the `x-apple.system
  preferences:` URL). Deep-links are version-independent (qa-version
  finding) so no version branching here.
- `revealHelper()`: delegate to existing `findEngineAudioForPrefix`-style
  resolve; actually reuse the existing `system:revealHelper` logic
  (`shell.showItemInFolder` on the MintrEngine.app path).
- `restartEngine()`: reuse `killLiveRecorderSync()` + `startLiveRecorder()`
  from backend.ts (the v0.21 `/usr/bin/open --args --auto-watch` path).
- `verifyEngine()`: after restart, poll the engine subsystem log up to 8s
  for `Watch mode started`; return `{ watchLoopRunning }`.
- `markComplete()` / `reset()`: set/clear `settings.onboardingCompletedAt`
  via the settings module.

### `src/main/settings.ts`
- Add `onboardingCompletedAt` to defaults (undefined), read, write —
  copy the `autoStartWatching` pattern at all 4 sites.

### `src/main/ipc/index.ts`
- Register the 7 handlers above, delegating to `onboarding.ts`.

### `src/preload/index.ts`
- Expose `window.api.onboarding.{probe, openPane, revealHelper,
  restartEngine, verifyEngine, complete, reset}` mirroring the contract.

### `src/shared/types.ts`
- Add the types + IPC enum entries above. (NOTE: TICKET-UI-003 also edits
  this file — coordinate merge; keep additions in distinct regions.)

## Acceptance
- `npm run typecheck` clean.
- From a renderer console (or a temporary test), `window.api.onboarding
  .probe()` returns a snapshot whose `microphone: 'granted'`,
  `screenRecording` matching the current engine state, and
  `watchLoopRunning: true` when the engine is running with --auto-watch.
- `onboarding.restartEngine()` then `verifyEngine()` returns
  `watchLoopRunning: true` within 8s.

## Out of scope
- The wizard UI + Settings section (TICKET-UI-003).
- Signing (TICKET-SIGN-001).
