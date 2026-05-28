# TICKET-003 — Restart engine clears stale red banner + shows verifying state

**Source QA report**: `dev/qa/qa-003-restart-engine-banner-stale.md`
**Severity**: UX confusion — user thinks Restart did nothing because the
red banner stays visible even after a successful restart.
**Branch**: `v20-restart-banner-reset`

## Summary

When the user clicks **Restart engine** in the helper-permission red
banner, today the helper is killed + respawned correctly, but the
`watchdog.helperPermissionLikely` flag is never reset, so the red banner
stays visible. The user sees inline "Helper restarted" text inside the
SAME red banner, which contradicts itself.

Fix: combine option B (renderer-side transitional state) with option C
(main-side watchdog reset) per QA-003's recommendation.

## Acceptance criteria

1. Click **Restart engine** in the red banner.
2. Banner immediately transitions to a yellow/neutral "verifying" state:
   > **Verifying capture (30s)…**
   > Mintr Engine restarted. Waiting to see if it can capture.
3. If within 30s the engine writes ANY file (i.e. `meetings:changed`
   fires), the verifying banner clears entirely. Done.
4. If 30s elapses without any file activity AND a Meet is still
   detected by the chrome probe, the red banner returns with the same
   `hint` it had before (TICKET-002's classification).
5. If the user leaves the Meet during the 30s verifying window
   (`chrome.tab` becomes null), the verifying banner clears
   immediately.
6. If `system:restartHelper` IPC returns `ok: false`, skip the
   verifying state entirely and show an error variant:
   > **Engine restart failed**: {message}

## Architecture (per QA-003)

- **Main-side reset**: add an exported function
  `resetCaptureWatchdog(): void` in `src/main/captureWatchdog.ts`. It
  sets `state.signal = { helperPermissionLikely: false }` and broadcasts
  via `setSignal(newSignal)` so renderers see the clean slate.
- Call this from `systemRestartHelper` IPC handler in
  `src/main/ipc/index.ts` BEFORE the kill + spawn (so the renderer
  sees the reset immediately).
- **Renderer-side transition**: in `Home.tsx`, when `handleRestartHelper`
  succeeds (`result.ok === true`):
  - Set a new local state `verifyingCapture: { startedAt: number } | null`.
  - Render a NEW yellow banner (`.permission-banner--verifying` —
    same shape as the existing variants, neutral / yellow tint) when
    `verifyingCapture !== null` AND `!watchdog.helperPermissionLikely`.
  - Auto-clear `verifyingCapture` when (a) 30s elapses, (b)
    `chrome.tab` becomes null, or (c) `liveCapture.active` flips
    true (engine wrote a file).
  - If the watchdog signal flips back to true within the 30s
    window, leave `verifyingCapture` null — the watchdog banner will
    take over again.

## Files to modify

1. `src/main/captureWatchdog.ts`
   - Add and export `resetCaptureWatchdog(): void`:
     ```ts
     export function resetCaptureWatchdog(): void {
       // Force the next checkWatchdog tick to re-evaluate from scratch:
       // null out the meet-seen timestamp so the threshold starts over,
       // and reset the alarm signal.
       state.meetSeenAt = Date.now()  // give the helper a fresh ~25s grace
       state.lastEngineWriteAt = Date.now()  // pretend an engine write just happened
       if (state.signal.helperPermissionLikely) {
         setSignal({ helperPermissionLikely: false })
       }
     }
     ```
   - Note: bumping both timestamps to now-time gives the helper a full
     grace window before the watchdog can fire again. This is what we
     want — restart deserves a fresh evaluation, not an immediate re-fire.

2. `src/main/ipc/index.ts`
   - In `IPC.systemRestartHelper` handler, import + call
     `resetCaptureWatchdog()` BEFORE `killLiveRecorderSync` so the
     renderer sees the reset push first, then the kill/respawn happens.

3. `src/renderer/src/views/Home.tsx`
   - Add `useState<{ startedAt: number } | null>` for `verifyingCapture`.
   - Modify `handleRestartHelper`:
     - On `result.ok === true`: set `verifyingCapture = { startedAt:
       Date.now() }`. Do NOT set `restartResult` text — the new banner
       carries the messaging.
     - On `result.ok === false`: set `restartResult = "Engine restart
       failed: " + result.message`, keep red banner visible (or render
       the error variant).
   - Add a `useEffect` to auto-clear `verifyingCapture`:
     - When `Date.now() - verifyingCapture.startedAt > 30_000`, null it.
     - When `chromeMeet.tab === null`, null it.
     - When `liveCapture.active === true`, null it.
   - Render a NEW banner just below the red banner block:
     ```tsx
     {verifyingCapture && !watchdog.helperPermissionLikely && (
       <div className="permission-banner permission-banner--verifying"
            role="status">
         <span className="permission-banner__icon">
           <Loader2 size={16} className="home-status-icon--spin" />
         </span>
         <div className="permission-banner__body">
           <div className="permission-banner__title">
             Verifying capture (30s)…
           </div>
           <div className="permission-banner__desc">
             Mintr Engine restarted. Waiting to see if it can capture
             your meeting.
           </div>
         </div>
       </div>
     )}
     ```

4. `src/renderer/src/styles/app.css`
   - Add `.permission-banner--verifying` rules right after
     `.permission-banner--danger`:
     ```css
     .permission-banner--verifying {
       border-color: rgba(245, 158, 11, 0.40);
       background: rgba(245, 158, 11, 0.07);
     }
     .permission-banner--verifying .permission-banner__icon {
       background: rgba(245, 158, 11, 0.18);
       color: #b45309;
     }
     ```
   - Plus dark-mode variant matching the danger banner's pattern.

## Testing

After implementation:
1. `npm run typecheck` passes.
2. Build, install, trigger the red banner (open a Meet without proper
   helper permissions).
3. Click Restart engine.
4. Verify the red banner immediately becomes the yellow "Verifying
   capture (30s)…" banner with a spinner.
5. Wait 30s without granting any new permission → red banner returns.
6. Restart again, then quickly grant the missing permission and let the
   helper write a file → yellow banner clears, no red banner.

## Out of scope

- Detecting actual capture START (writing audio) vs full pipeline finish.
  Any `meetings:changed` event satisfies this ticket.
- Showing per-second countdown text in the banner — a static "(30s)"
  is enough.
