# REQ-001 — Stable code signing + cross-macOS permission onboarding

**Status**: Requirements (for swarm execution)
**Author**: Principal eng (orchestrator)
**Date**: 2026-05-28
**Supersedes / absorbs**: TICKET-ONBOARDING-001 (the wizard spec) — this
doc adds the signing prerequisite that makes the wizard actually durable.

---

## 1. Problem statement (the recurring loop, root-caused)

Across v0.12 → v0.22 the user has had to re-grant macOS permissions to the
bundled engine on nearly every install. The definitive cause, proven via
tccd logs + the engine's own permission verdict log:

> **Both Mintr.app and the bundled MintrEngine.app are AD-HOC signed
> (`codesign --sign -`). Every rebuild produces a new code-directory hash
> (cdhash). macOS TCC ties an ad-hoc app's permission grant to its exact
> cdhash. So every rebuild silently invalidates Screen Recording,
> Microphone, and Accessibility grants — the app still appears in the
> System Settings list, but `CGPreflightScreenCaptureAccess()`,
> `AVCaptureDevice.authorizationStatus`, and `AXIsProcessTrusted()` all
> report denied/not-determined for the new binary.**

Evidence (2026-05-28 23:02 engine verdict log, v0.22 binary):
```
checkScreenRecordingLive: systemAllowed=false ... → denied   (was granted on v0.21 binary)
checkAccessibilityLive:   trusted=false → denied             (was granted on v0.21 binary)
checkMicrophoneLive:      authStatus=authorized → healthy     (re-granted via fresh prompt)
```
Result: `MeetingDetector` can't read Chrome's "Meet -" window title →
never fires → no recording → zero files written.

This is unacceptable for production: a user who installs an app update
would silently lose capture until they re-grant. It must be fixed.

## 2. Two coupled deliverables

### Deliverable A — Stable code signing (the loop-breaker)

Sign Mintr.app AND the bundled MintrEngine.app with a **stable signing
identity** so the cdhash-independent Designated Requirement is constant
across rebuilds, and TCC grants persist.

Two tiers:

**A1. Developer / internal builds → stable self-signed certificate.**
- The sibling engine repo ALREADY has this:
  `meeting-transcriber/scripts/setup-self-hosted-runner.sh` creates a
  self-signed code-signing cert in a dedicated keychain and (important)
  works around the macOS 26 "Invalid Key Usage for policy" issue by
  setting the right extended key usage. `build_release.sh` already signs
  with `$SIGN_HASH` when a codesigning identity is found
  (`security find-identity -v -p codesigning`), falling back to ad-hoc.
- **Gap to close:** Mintr's `electron-builder.yml` has `identity: null`
  (forces ad-hoc), and `scripts/afterPack.js` re-signs the renamed
  MintrEngine with `codesign --force --deep --sign -` (ad-hoc). BOTH must
  switch to the stable identity. The engine binary copied in via
  extraResources must ALSO be built/signed with the same stable identity
  (currently `build_release.sh` ad-hoc signs it unless `DEVELOPER_ID` or a
  found identity is used).
- Net: one stable self-signed cert, used to sign (a) the engine .app at
  engine-build time, (b) Mintr.app + renamed MintrEngine.app at
  electron-builder afterPack/afterSign time. Grants set once survive every
  subsequent rebuild signed by the same cert.
- Self-signed is enough for the USER'S OWN machine (TCC keys off the cert's
  designated requirement, which is stable). It is NOT trusted by Gatekeeper
  on OTHER machines — that needs A2.

**A2. Production distribution → Developer ID + notarization.**
- For shipping to other users, sign with a "Developer ID Application"
  cert + notarize via `notarytool`. Then no quarantine prompt, no
  `xattr -dr`, and TCC grants persist across auto-updates.
- Requires an Apple Developer account ($99/yr). Out of scope for the
  immediate fix but REQUIRED before public launch. Document the steps.

**Acceptance for A:** After implementing A1, rebuild Mintr twice in a row.
Grant Screen Recording once after the first build. After the SECOND build +
reinstall, `CGPreflightScreenCaptureAccess()` for MintrEngine must STILL
return true WITHOUT re-granting. Verify via the engine's
`/tmp/mt-permission.log` showing `screen=healthy` on the second build.

### Deliverable B — Cross-macOS permission onboarding + Settings mirror

A guided flow that gets a fresh user from "just dragged Mintr to
Applications" to "all permissions granted, engine capturing" with no
terminal, no typed paths, no log-grepping — AND that adapts to the macOS
version's permission UI differences.

**B1. Onboarding wizard (first launch).** Per TICKET-ONBOARDING-001's
5-step structure (Welcome → Screen Recording → Microphone → Accessibility
→ Verifying → Done), with these cross-version refinements:

| Permission | macOS ≤ 14 (Sonoma) | macOS 15 (Sequoia) | macOS 26 (Tahoe) |
|---|---|---|---|
| Microphone | `+` button OR prompt | prompt only (no `+`) | prompt only (no `+`) — fire `requestAccess` |
| Screen Recording | `+` button | `+` button | `+` button (still present) |
| Accessibility | `+` button | `+` button | `+` button |

- The wizard must DETECT the macOS major version (`ProcessInfo
  .processInfo.operatingSystemVersion`) and render the right instructions
  per permission: "click +, ⌘⇧G, paste path" where a `+` exists; "click
  Allow on the prompt we just triggered" where it doesn't.
- For Microphone on 15/26: the wizard triggers the engine's
  `requestAccess` (now wired at engine startup as of v0.22) and tells the
  user to click Allow — NOT to look for a non-existent `+`.
- For Screen Recording + Accessibility on ALL versions: deep-link to the
  pane + "Reveal MintrEngine in Finder" (existing IPC) so they can drag
  it onto the `+` dialog, plus toggle-off-then-on guidance for the
  re-grant-after-update case (only relevant pre-A1; after A1 grants
  persist).
- Live status chips per permission, polling tccd log (the proven
  `classifyHelperFailure` pattern) every 2s while the wizard is open.
- Auto-restart engine after the final grant; verify WatchLoop starts.

**B2. Settings mirror.** A "Setup & Permissions" section at the top of
Settings showing the same 3 permission rows + live status + the same
buttons (Open pane / Reveal in Finder / Restart engine), plus a "Re-run
setup wizard" button. The instruction content is SHARED between the
wizard and Settings (one component, two mount points) so they never drift.

**B3. Version-aware copy.** All instruction text must read correctly on
the user's actual macOS version. No hardcoded "click the + button" when
the user is on Tahoe-Microphone where there is none.

**Acceptance for B:** A fresh user on macOS 26 completes the wizard using
only on-screen instructions (no external help), ending with the engine
capturing a test meeting. The same flow works on a macOS 15 machine with
the version-appropriate instructions.

## 3. Swarm execution plan

**Phase 1 — QA investigation (3 parallel agents, read-only):**
- QA-SIGN: Map the exact signing change. Read engine
  `setup-self-hosted-runner.sh` + `build_release.sh` signing path; Mintr
  `electron-builder.yml` + `scripts/afterPack.js`. Specify precisely how
  to (a) provision a stable self-signed cert, (b) make build_release.sh
  use it for the engine, (c) make electron-builder + afterPack use the
  SAME cert for Mintr.app + MintrEngine.app. Flag any
  entitlements/hardened-runtime interactions. Output: signing change spec.
- QA-ONBOARD-UI: Map where the wizard + Settings section mount in the
  Electron renderer (App.tsx gating, Settings.tsx section, shared
  component). Refine TICKET-ONBOARDING-001 with the version-aware
  branching. Output: UI implementation spec.
- QA-VERSION: Research/confirm the per-macOS-version permission UI matrix
  (which panes have `+`, which require prompts, which deep-links work on
  14/15/26). Output: version matrix + the detection approach
  (`operatingSystemVersion`) + per-version copy strings.

**Phase 2 — Ticket orchestration (orchestrator):** synthesize QA into
TICKET-SIGN-001, TICKET-ONBOARD-002 (supersedes 001), TICKET-VERSION-003.

**Phase 3 — Dev execution (3 parallel worktrees):**
- DEV-SIGN: implement stable signing across both repos.
- DEV-ONBOARD: implement the wizard + Settings mirror (shared component).
- DEV-VERSION: implement version detection + per-version copy + branching.

**Phase 4 — orchestrator merges, rebuilds, the user does ONE final grant
(under the new stable cert), and from then on grants persist.**

## 4. Out of scope (future tickets)

- Apple Developer ID + notarization (A2) — needed before public launch,
  but self-signed (A1) unblocks the user's own machine now.
- Auto-update (Sparkle / electron-updater).
- Crash reporting, EULA/privacy modal, localization.
