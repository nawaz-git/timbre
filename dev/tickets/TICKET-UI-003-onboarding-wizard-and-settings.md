# TICKET-UI-003 — Onboarding wizard + Settings mirror (shared component)

**Source**: REQ-001 §Deliverable B · `dev/qa/qa-onboard-ui-001-*.md` ·
`dev/qa/qa-version-001-permission-matrix.md`
**Branch**: `v23-ui`
**Lane**: Electron RENDERER (React/CSS) only. Codes AGAINST the IPC
contract defined in TICKET-IPC-002 (`window.api.onboarding.*`) — that
surface is being built in parallel; assume it exists per the contract.

## Why
A production user drags Mintr to Applications and opens it. From there the
journey to "all permissions granted, engine capturing" must be a guided,
no-terminal, version-correct wizard. Same content also lives in Settings
for later access.

## Cross-macOS reality (from qa-version-001 — simpler than feared)
- Deep-link URLs are IDENTICAL across macOS 14/15/26 → no per-version URLs.
- **Microphone**: prompt-only on ALL versions (no `+` button ever). Flow:
  the engine fires `requestAccess` at startup (already wired v0.22) → OS
  shows "MintrEngine wants to access the microphone" → user clicks Allow.
  If previously denied: the row stays in the Mic pane with a toggle →
  "flip MintrEngine on" (NOT "click +").
- **Screen Recording + Accessibility**: have `+`/`−` on ALL versions.
  Flow: open pane → click `+` → ⌘⇧G → paste path → Open → toggle on.
  OR (after a rebuild invalidated it, pre-SIGN-001) toggle off→on.
- Version detection (for copy nuance only): Electron
  `process.getSystemVersion()` returns e.g. `"26.5"` — parse major. Expose
  it via a tiny IPC or `process` bridge if needed; the copy differences
  are minor so a single accurate string set is acceptable.

## Components

### `src/renderer/src/components/PermissionChecklist.tsx` (NEW)
The SHARED component used by both the wizard and Settings. Props:
`{ mode: 'wizard' | 'settings' }`. Renders 3 permission rows:
- Each row: icon, name, live status chip (green granted / yellow
  not-determined / red denied) sourced from `window.api.onboarding.probe()`
  polled every 2s while mounted.
- Per-row primary action:
  - Mic: button "Request microphone access" → calls restartEngine (which
    re-fires the prompt) OR if denied, "Open Microphone settings" +
    "flip MintrEngine on" copy.
  - Screen Recording / Accessibility: "Open <pane>" (openPane) +
    "Reveal MintrEngine in Finder" (revealHelper) + inline 4-step diagram
    (click + → ⌘⇧G → paste path → Open). Copyable monospace path:
    `/Applications/Mintr.app/Contents/Resources/MintrEngine.app`
- After all three are `granted`, show a "Restart engine & verify" button
  → restartEngine + verifyEngine; show ✅ when `watchLoopRunning`.

### `src/renderer/src/state/onboarding.tsx` (NEW)
`useHelperPermissions()` hook: polls `onboarding.probe()` every 2s,
returns the snapshot. `useOnboardingComplete()` reads/sets via settings.

### `src/renderer/src/views/Onboarding.tsx` (NEW)
Full-pane 5-step wizard (Welcome → the PermissionChecklist (steps 2-4
collapsed into the checklist) → Done) gated by App.tsx. "Skip for now"
link sets complete + dismisses. "Done"/all-granted → markComplete.

### `src/renderer/src/App.tsx`
Early-return the wizard when `settings && !settings.onboardingCompletedAt`
— mount `<Onboarding onDone={...}/>` INSTEAD of the normal AppShell body.
Keep it minimal; do not disturb the existing nav/keyboard-shortcut code
(note: App.tsx already has a Network tab + ⌘1-4 shortcuts — preserve them).

### `src/renderer/src/views/Settings.tsx`
Add a "Setup & Permissions" `<Section>` at the TOP (above Output) that
renders `<PermissionChecklist mode="settings" />` + a "Re-run setup
wizard" button (calls `onboarding.reset()` then triggers the wizard).

### `src/renderer/src/styles/app.css`
Styles for the checklist rows, status chips (reuse `--status-*` tokens),
the step diagram, wizard layout. Reuse existing tokens; no new palette.

## Acceptance
- `npm run typecheck` clean.
- Fresh launch (no `onboardingCompletedAt`) shows the wizard, not Home.
- Each permission row shows a live status chip that flips green when
  granted (verified by granting in System Settings and watching the chip).
- Mic row guides the prompt flow (no "click +" text for Mic).
- Screen Rec / Accessibility rows show the + / ⌘⇧G / paste flow with the
  copyable path + Reveal-in-Finder.
- Settings → "Setup & Permissions" shows the same checklist + "Re-run".
- Completing → wizard dismisses, never reappears (until Re-run).

## Out of scope
- The IPC implementation (TICKET-IPC-002 — code against the contract).
- Signing (TICKET-SIGN-001).
- Animated GIFs (static diagram only).
