# QA-003 — "Restart engine" success doesn't clear the red banner

## Symptom
Clicking "Restart engine" sets `restartResult` to "Helper restarted — it should now pick up the granted permission" inside the red banner, but the banner itself never dismisses or transitions. Even if the engine starts capturing seconds later, the banner stays until the user changes the Meet (new meeting id). The success message and the error coexist forever — reads as a lie.

## State Flow Today (post Restart-engine click)
1. `handleRestartHelper` (`src/renderer/src/views/Home.tsx:117`) calls `window.api.system.restartHelper()` (`src/preload/index.ts:155`).
2. `systemRestartHelper` (`src/main/ipc/index.ts:371-387`) calls `killLiveRecorderSync()` (`src/main/backend.ts:254`) → 300ms pause → `startLiveRecorder()` (`src/main/backend.ts:321`). It returns `{ ok, message }` and does NOT touch watchdog state.
3. Renderer sets `restartResult` (`Home.tsx:122`) which renders inside the banner at `Home.tsx:318-320`.
4. `state.signal.helperPermissionLikely` stays `true`. `checkWatchdog` (`captureWatchdog.ts:259-303`) only un-alarms when the Chrome meeting id changes (`:269`) or Chrome no longer reports a Meet (`:276`). A helper restart triggers neither.
5. Banner stays visible (`Home.tsx:296` reads `watchdog.helperPermissionLikely`).

## Root Cause
`systemRestartHelper` is fire-and-forget on the watchdog axis. The watchdog only un-alarms via meeting-id-change or Meet-gone — never on helper lifecycle. Nothing resets `meetSeenAt`/`lastEngineWriteAt` after restart, so the 25s alarm clock that already expired stays expired indefinitely.

## Three Possible UX Fixes (compare)

### Option A — Auto-dismiss banner for 30s after restart
Renderer hides banner for 30s on `restartResult.ok`. Pros: zero main-process change, instant relief. Cons: lies if helper is still broken — user closes Mintr thinking they're fine, finds an empty Meetings tab. Worse than current on the unhappy path.

### Option B — Replace banner with "Helper restarted — verifying capture (30s)…"
Renderer adds a `verifying` local state on successful restart; banner switches to a neutral amber "verifying" variant; if `liveCapture.active` flips true within the window we dismiss, otherwise the red banner reappears with "still no audio". Pros: honest on both paths. Cons: more state (timer, banner variants), crosses two hooks (`useCaptureWatchdog` + `useLiveCapture`).

### Option C — Force watchdog re-check on restart
`systemRestartHelper` calls a new `resetCaptureWatchdog()` that clears `helperPermissionLikely` and resets `meetSeenAt = now`. Pros: cleanest, server-authoritative — if helper still can't capture, red banner returns after 25s. Cons: clean dismiss + 25s blank wait + return is a confusing UX (did it work?); depends on the engine writing within 25s.

## Recommended Approach
**Option B with C's reset folded in.** Reset the watchdog (C) on restart so source-of-truth is honest, AND show a transitional "verifying capture…" banner (B) so the user has clear feedback during the 25s grace instead of UI flicker. This is the only combination truthful on both paths.

## Files To Modify
- `src/main/captureWatchdog.ts` — export `resetCaptureWatchdog()` that clears the signal and rewinds `meetSeenAt`/`lastEngineWriteAt`.
- `src/main/ipc/index.ts` — `systemRestartHelper` calls `resetCaptureWatchdog()` after `startLiveRecorder()`.
- `src/renderer/src/views/Home.tsx` — `handleRestartHelper` sets `verifying` state for 30s; banner block at `:296` reads `verifying || helperPermissionLikely` and renders an amber "verifying capture…" variant when `verifying && !helperPermissionLikely`; auto-clears if `liveCapture.active` becomes true.

## Edge Cases
- **No Meet active**: `checkWatchdog` at `:275` early-exits; banner can't be true; restart button unreachable. No change needed.
- **5 rapid clicks**: each invocation kills+spawns and resets the watchdog. `killLiveRecorderSync` is idempotent. The existing `restartingHelper` disable (`Home.tsx:341`) covers this — extend it to also disable during the 30s verifying window.
- **User leaves meeting mid-restart**: `checkWatchdog`'s `currentId !== state.lastSeenMeetingId` branch (`:264`) clears the signal already. Verifying banner should also auto-dismiss when `chromeMeet.tab` becomes null.
- **`ok: false` from IPC**: skip the verifying transition; keep the red banner with the failure message (`Home.tsx:125`). Guard with `if (!result.ok) return` before entering verifying state.
