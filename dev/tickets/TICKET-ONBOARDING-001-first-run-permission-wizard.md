# TICKET-ONBOARDING-001 — First-run permission wizard + Settings mirror

**Source observation**: `dev/observations/2026-05-28-onboarding-productionization.md`
**Severity**: Blocks productionization. Without this, every new user
hits the same TCC maze we just spent 9 ships debugging.
**Estimated scope**: ~1–1.5 days of focused work, split across 3 dev
agents (state machine + IPC, wizard UI, Settings mirror).

## Outcome

A user who:
1. Downloads `Mintr-X.Y.Z-arm64.dmg`
2. Drags `Mintr.app` to `/Applications/`
3. Opens Mintr for the first time

…sees a clean wizard, follows ≤ 4 clicks per permission, and ends up
with all three TCC grants applied AND the engine restarted. After
that, joining a Google Meet captures end-to-end without further
intervention.

The same wizard is accessible later via Settings → "Setup & Permissions"
so users who re-install macOS, change machines, or hit a regression
can re-run any single step.

## Acceptance criteria

### A. First-launch experience

A1. On Mintr's first launch (no `settings.onboardingCompletedAt` in
    electron-store), a modal/full-pane `<OnboardingWizard />` mounts
    inside `<AppShell />` BEFORE any other view renders. The user
    cannot interact with the sidebar, content, or tray menu items
    until they either finish OR explicitly click "Skip setup".
A2. The wizard has 5 steps with a step indicator at the top:
      1. Welcome
      2. Screen Recording grant
      3. Microphone grant
      4. Accessibility grant
      5. Done — "Open a Google Meet to test"
A3. Each permission step shows:
    - A heading explaining WHY the permission is needed (1 sentence)
    - The current grant status as a live-updating chip:
        - "Not granted yet" (yellow)
        - "Granted ✓" (green) — auto-detected
        - "Denied — open Settings and toggle on" (red, only if the
          user explicitly toggled OFF in System Settings)
    - A primary button "Open Screen Recording" (or Mic / Accessibility)
      that uses the existing `openPrivacyPane(pane)` API.
    - A secondary button "Reveal Mintr Engine in Finder" using the
      existing `system.revealHelper()` IPC.
    - An inline 4-step diagram showing the exact procedure inside
      System Settings: click `+` → press `⌘⇧G` → paste path → Open.
    - A copyable monospace path block:
        `/Applications/Mintr.app/Contents/Resources/MintrEngine.app`
    - A footer link "Skip — I'll do this later" that advances to the
      next step without checking grant state.
A4. When grant status flips to "Granted ✓", the step auto-advances
    after a 1.5s celebratory pause (so the user sees the change).
A5. After step 4 (Accessibility) is granted, the wizard:
    - Force-kills any existing Mintr Engine helper.
    - Spawns a fresh helper via `/usr/bin/open` (v0.21 path).
    - Waits up to 8s for the engine log to emit `WatchLoop started`.
    - Advances to step 5 with a "Mintr is ready" message.
A6. Setting `settings.onboardingCompletedAt = Date.now()` persists
    the completion. Mintr will not re-show the wizard on subsequent
    launches unless the user clicks "Re-run setup" in Settings.

### B. Settings mirror

B1. New Settings section "Setup & Permissions" (top of Settings
    page, above "Output"). Renders the same 3 permission rows the
    wizard uses, with the same live status chips.
B2. Each row has the same primary + secondary buttons (Open pane,
    Reveal in Finder).
B3. Below the 3 rows, a single button: "Re-run setup wizard" that
    resets `settings.onboardingCompletedAt = null` and remounts
    the wizard.
B4. The orphan "MeetingTranscriber" TCC entry detection: if a
    pre-v0.19 entry exists for `com.meetingtranscriber.app` in
    Screen Recording / Mic / Accessibility, surface a one-time chip
    "Remove old MeetingTranscriber entry" with instructions.

### C. Live permission detection

C1. The wizard polls every 2s. The poll runs ONE TCC log probe
    per service (via the existing `/usr/bin/log show --predicate
    'subsystem == "com.apple.TCC" AND eventMessage CONTAINS
    "ai.nawaz.mintr-engine"' --last 5s` pattern that v0.20's
    `classifyHelperFailure` already proved works).
C2. The result mapping:
    - `Auth Right: Allowed (System Set)` → granted ✓
    - `Auth Right: Allowed (User Consent)` → granted ✓
    - `Auth Right: Denied` → denied (red chip)
    - No matching entry in last 5s → unknown / not-determined →
      "Not granted yet" (yellow chip)
C3. The probe only fires while the wizard is mounted (or the
    Settings → Setup section is open). No background polling.

### D. Edge cases

D1. **User already has all 3 permissions** (e.g. they upgraded from
    a prior install with TCC carried over): wizard skips directly
    to step 5, shows "Mintr is already set up". User can dismiss.
D2. **User denies a permission and closes System Settings**: the
    chip turns red. The "Open Screen Recording" button is renamed
    to "Re-open Screen Recording" and the inline message says
    "macOS recorded a denial. Re-open the pane and toggle Mintr
    Engine ON."
D3. **User grants permission then revokes it later**: detected at
    next wizard mount (or via the existing capture watchdog),
    surfaces a separate "Mintr Engine permissions changed" banner
    on Home.
D4. **Helper fails to start after all grants are in place** (e.g.
    helper binary corrupt, missing extra-resource): step 5 surfaces
    a diagnostic with engine log tail, plus a "Re-install Mintr"
    button that opens the latest DMG download URL.
D5. **First launch but user skipped past everything**: wizard still
    sets `onboardingCompletedAt`. User can re-run via Settings.

## Architecture

### State machine

```
type OnboardingStep =
  | 'welcome'
  | 'screen-recording'
  | 'microphone'
  | 'accessibility'
  | 'verifying-helper'
  | 'done'

type GrantStatus = 'unknown' | 'not-granted' | 'granted' | 'denied'

interface OnboardingState {
  step: OnboardingStep
  screenRecording: GrantStatus
  microphone: GrantStatus
  accessibility: GrantStatus
  helperHealthy: boolean        // true once we observe WatchLoop started
}
```

Persist `onboardingCompletedAt: number | null` in `electron-store`.

### IPC additions

```ts
IPC.onboardingProbeGrant: 'onboarding:probeGrant'
  // (service: 'screen-recording' | 'microphone' | 'accessibility') => GrantStatus

IPC.onboardingVerifyHelper: 'onboarding:verifyHelper'
  // () => { healthy: boolean; lastLogLine?: string }

IPC.onboardingMarkComplete: 'onboarding:markComplete'
  // () => void  — sets settings.onboardingCompletedAt = Date.now()

IPC.onboardingReset: 'onboarding:reset'
  // () => void  — clears onboardingCompletedAt, kills helper
```

### Files to create / modify

NEW:
- `src/main/onboarding.ts`
  - `probeGrant(service)` runs the targeted `log show` query and
    classifies via the substring rules.
  - `verifyHelper()` kills + spawns the engine via the v0.21 `open`
    path and tails its log for ~8s looking for `WatchLoop started`.
  - `markComplete()` + `reset()` for the settings boolean.
- `src/renderer/src/views/Onboarding.tsx`
  - Top-level wizard component. 5-step state machine + render.
- `src/renderer/src/components/OnboardingStep.tsx`
  - Per-step row (heading + chip + buttons + diagram).
- `src/renderer/src/components/OnboardingDiagram.tsx`
  - The static 4-step "click `+` → ⌘⇧G → paste → Open" visual.
- `src/renderer/src/state/onboarding.tsx`
  - Hook `useOnboardingState()` returning the state machine.
- `src/renderer/src/views/Settings.tsx`
  - Add "Setup & Permissions" section at the top.

MODIFY:
- `src/main/ipc/index.ts` — register the 4 new IPC handlers.
- `src/preload/index.ts` — expose `window.api.onboarding.*`.
- `src/shared/types.ts` — `Settings.onboardingCompletedAt?: number`,
  add the `IPC` enum entries, add `GrantStatus` type.
- `src/main/settings.ts` — surface the new field with default `null`.
- `src/renderer/src/App.tsx` — early-mount the wizard when
  `!settings.onboardingCompletedAt`.

### Design tokens

Use existing tokens. No new colours. Pulls in:
- `--surface-base`, `--surface-raised`, `--surface-overlay`
- `--accent` for primary CTAs
- `--status-recording`, `--status-watching`, `--status-idle` for
  the grant chips (red/yellow/green).
- Existing `Loader2` + `home-status-icon--spin` for the verifying step.

## Out of scope

Explicitly DEFERRED to follow-up tickets:

- **Code signing / notarization.** Until we ship under a Developer ID
  certificate, macOS still says "from an unidentified developer" on
  first launch and the user has to `xattr -dr com.apple.quarantine`
  or right-click → Open. The wizard should detect quarantine and
  surface a step zero ("if you got a security warning, do this")
  but the actual signing infra is a separate ticket.
- **Auto-update infrastructure.** Sparkle or electron-updater wiring.
- **Crash reporting** (sentry-electron, posthog).
- **Privacy / Terms modal** on first launch.
- **Onboarding video / animated GIFs.** Static numbered diagram in
  this ticket; motion is a polish pass later.
- **Permission re-prompts.** macOS won't re-prompt for a denied
  permission; the user MUST go to System Settings. The wizard
  language reflects this.

## Test plan (for the future dev agent + QA)

1. Fresh macOS user (no TCC entries for Mintr at all): wizard walks
   through all 3 grants, helper starts, capture works end-to-end.
2. User who already has TCC entries from a prior install: wizard
   skips to step 5 with "already set up".
3. User who denies Screen Recording: red chip, retry button visible,
   helper fails to start until granted.
4. User who skips entire wizard: lands on Home, no engine running,
   menubar tray shows ⚠. Clicking Settings → Re-run setup brings
   them back.
5. User on macOS Sequoia + Sonoma + Ventura: deep-link URLs work
   on all three. (Tahoe added new TCC categories; verify our
   subset still works.)

## Rollout

Bump to `v0.22.0`. Multi-agent fix round:
- QA agent: verify the wizard state machine + IPC contracts.
- 3 dev agents in parallel git worktrees:
  - DEV-A: `src/main/onboarding.ts` + IPC + preload + shared types
  - DEV-B: `<OnboardingWizard />` + `<OnboardingStep />` + step machine
  - DEV-C: Settings mirror + orphan TCC detection
- Orchestrator (me) merges with sequential conflict resolution.
- Manual test by the human user, then we're production-ready for
  permission UX.
