# TICKET-002 — Detect + surface missing Accessibility permission for Mintr Engine

**Source QA report**: `dev/qa/qa-002-permission-health-check.md`
**Severity**: This is the actual root cause of "no audio ever captured" — the engine's PermissionHealthCheck fails specifically because Accessibility isn't granted to `ai.nawaz.mintr-engine`.
**Branch**: `v20-accessibility-surface`

## Summary

The engine helper logs `PermissionHealthCheck failed: <private>` on every
launch — QA confirmed via un-redacted TCC log that the missing permission
is `kTCCServiceAccessibility` for bundle id `ai.nawaz.mintr-engine`. macOS
does NOT auto-prompt for Accessibility (unlike Mic and Screen Recording).
The user must manually drag `MintrEngine.app` into System Settings →
Privacy & Security → Accessibility.

Right now Mintr's UI says "engine helper isn't capturing" without
naming the specific permission. This ticket surfaces it explicitly.

## Acceptance criteria

1. On every Mintr launch, AFTER the helper has been alive for >5s, Mintr
   checks the helper's unified-log output via `/usr/bin/log show --last 10s
   --predicate 'process == "MintrEngine"'`, searches for the line
   `PermissionHealthCheck failed`, and sets a flag.
2. Independently, Mintr probes Accessibility for the helper by attempting
   a non-destructive call from Mintr itself. Approach: Mintr launches a
   short-lived audit child (the engine binary with an `--audit-permissions`
   flag if it exists, or — since we can't modify the engine — by checking
   whether the engine binary has produced any `transcript_saved` log entry
   in the last 30 days. If it has, the permission was granted at some
   point; if it hasn't AND the watchdog has fired, surface Accessibility
   as the most-likely missing.) **Update**: simpler approach below.

3. **Simpler approach (preferred)**: Combine the watchdog signal with a
   `hint` field. When the watchdog flips `helperPermissionLikely: true`,
   ALSO inspect the helper's recent unified log for known failure
   strings:
   - `Permission health check failed` → set hint = `"accessibility"`
   - `denied AVCaptureDevice` → hint = `"microphone"`
   - `CGWindowList ... <empty>` → hint = `"screenRecording"`
   - Otherwise → hint = `"unknown"`
   Surface this hint in the renderer banner and adjust copy + button
   per hint.

4. UI: when `hint === "accessibility"`, the red banner copy becomes:
   > **Mintr Engine needs Accessibility permission**
   > macOS doesn't prompt for this automatically. Click "Open
   > Accessibility" then drag `MintrEngine.app` from the Finder
   > window onto the Accessibility list. Then click "Restart engine".
   Three buttons: **Open Accessibility** (deep-links to the right
   pane), **Reveal engine in Finder**, **Restart engine**.

5. The `Open Accessibility` button uses `openPrivacyPane('accessibility')`
   — already implemented in `src/main/permissions.ts`.

6. If `hint === "unknown"`, fall back to the existing generic banner copy.

## Architecture (per QA-002)

- **Where the hint is computed**: `src/main/captureWatchdog.ts`. After
  setting `helperPermissionLikely: true`, fire-and-forget a helper
  log-grep via `execFile('/usr/bin/log', ['show', '--last', '15s',
  '--predicate', 'process == "MintrEngine"', '--info'])`. Search the
  stdout for the known error substrings, classify, and store the hint
  in the signal payload.

- **Signal shape extension**: extend `CaptureWatchdogSignal` (`src/renderer/
  src/state/permissions.tsx` + `src/main/captureWatchdog.ts`) with an
  optional `hint?: 'accessibility' | 'microphone' | 'screenRecording' |
  'unknown'`.

- **Renderer change**: in `Home.tsx`, in the helper-permission banner
  block, switch on `watchdog.hint` to render different copy + buttons.
  Pass `'accessibility'` to `openPane` when applicable.

## Files to modify

1. `src/shared/types.ts`
   - No type changes required IF the hint type is local to
     `captureWatchdog.ts` + renderer state. Verify and add a shared
     type if both ends need it. Recommended: add
     ```ts
     export type WatchdogPermissionHint =
       | 'accessibility'
       | 'microphone'
       | 'screenRecording'
       | 'unknown'
     ```
     and extend `ChromeMeetSnapshot`-style — actually add a new
     interface `CaptureWatchdogSignal { helperPermissionLikely:
     boolean; hint?: WatchdogPermissionHint; meetingId?: string;
     firedAt?: number }` in shared/types.ts. Currently the type lives
     only in permissions.tsx — move it to shared.

2. `src/main/captureWatchdog.ts`
   - Add a helper `async function classifyHelperFailure(): Promise<WatchdogPermissionHint>`:
     - Runs `execFile('/usr/bin/log', ['show', '--last', '15s',
       '--predicate', 'process == "MintrEngine"', '--info'])` with a
       2.5s timeout, captures stdout.
     - Greps for the failure-substring rules above. Returns the hint.
     - On error / empty output, returns `'unknown'`.
   - In `checkWatchdog`, when transitioning to `helperPermissionLikely:
     true`, await `classifyHelperFailure()` and include the result in
     the signal sent via `setSignal`.
   - Export the renamed `CaptureWatchdogSignal` if not already.

3. `src/renderer/src/state/permissions.tsx`
   - Remove the local `CaptureWatchdogSignal` interface and import the
     shared one from `'../../../shared/types'`.

4. `src/renderer/src/views/Home.tsx`
   - In the helper-permission banner block (around `watchdog.helperPermissionLikely`):
     - Switch on `watchdog.hint`.
     - For `'accessibility'`: title "Mintr Engine needs Accessibility
       permission", body per the acceptance criteria above, primary
       button "Open Accessibility" calling `openPane('accessibility')`.
     - For `'microphone'`: title "Mintr Engine needs Microphone access",
       button "Open Microphone" calling `openPane('microphone')`.
     - For `'screenRecording'`: existing copy.
     - For `'unknown'` (or undefined): existing copy.

## Testing

After implementation:
1. `npm run typecheck` passes.
2. Build, install, open a Meet.
3. Without granting Accessibility to MintrEngine, the watchdog should fire
   AND the banner should show "Mintr Engine needs Accessibility permission"
   specifically.
4. Click Open Accessibility → System Settings opens at the right pane.

## Out of scope

- Modifying the Swift engine's logging to un-redact `<private>`.
- Adding a per-permission Settings UI page (one-off banner suffices).
- Auto-adding the helper to TCC (impossible — Apple disallows).
