# QA-ONBOARD-001 — Wizard + Settings mount points

Read-only investigation. All citations `file:line` relative to repo root.

## App.tsx wizard gate (insertion point, condition, file:line)

`AppShell` reads `settings` already (`App.tsx:76` — `const { settings, setSettings } = useSettings()`). The render returns the `.app` flex shell at `App.tsx:117-196`.

Mount the wizard as an **early return inside `AppShell`, after the `settings` guard, before the `return (<div className="app">…)` at `App.tsx:117`**. Gate on the new field:

- Wait for settings to load (it is `null` until the initial IPC resolves — see `settings.tsx:33-43`). Render nothing/skeleton while `settings === null`.
- If `settings && !settings.onboardingCompletedAt` → `return <OnboardingWizard onDone={() => void setSettings({ onboardingCompletedAt: Date.now() })} />`. Because `AppShell` is wrapped by `SettingsProvider`/`TagsProvider` (`App.tsx:200-208`), the wizard sits inside both providers and can use `useSettings()` + the permission hooks directly.

This gates the entire UI: the sidebar/content (`App.tsx:118-196`) never renders on first run. The `⌘1-4` keyboard handler (`App.tsx:96-115`) is registered via `useEffect` *after* the early return, so it won't bind while the wizard owns the screen — good (no nav hijack). Persisting `onboardingCompletedAt` flips the gate and the normal shell renders next paint.

## Settings.tsx section pattern + insertion (file:line)

Pattern: `<Section icon title>{…}</Section>` wrapping `<SettingsRow label description>{control}</SettingsRow>` — `Section` defined `Settings.tsx:43-63`, `SettingsRow` `Settings.tsx:65-81`. The "Background behaviour" toggle section (`Settings.tsx:191-213`) is the closest existing precedent for a stateful control.

`SettingsView` returns `<div className="settings">` at `Settings.tsx:154-155` with `Output` first (`Settings.tsx:156-189`). Per TICKET B1, insert the new section as the **first child of `.settings`, immediately after `Settings.tsx:155`, above the Output `<Section>`**:

```
<Section icon={<ShieldCheck size={16} />} title="Setup & Permissions">
  <PermissionChecklist mode="settings" />
  {/* Re-run wizard button → setSettings({ onboardingCompletedAt: null }) */}
</Section>
```

Add the `lucide-react` icon to the import at `Settings.tsx:3-11`.

## Shared `<PermissionChecklist>` component contract (props, hooks)

One component, two mounts. Suggested NEW file `src/renderer/src/components/PermissionChecklist.tsx`.

Props:
```ts
interface PermissionChecklistProps {
  mode: 'wizard' | 'settings'
  // wizard: show step framing/auto-advance; settings: flat 3-row list.
  onAllGranted?: () => void   // wizard uses this to advance to verify step
}
```

Hooks consumed:
- New `useHelperPermissions()` (NEW `state/onboarding.tsx`) — returns live `{ screenRecording, microphone, accessibility }` `GrantStatus` for the HELPER (see next section). Polls every 2s only while mounted (TICKET C3).
- `useSettings()` (`settings.tsx:72`) — for the version-aware copy injection point and to read/write `onboardingCompletedAt`.
- Existing `usePermissions().openPane` (`permissions.tsx:16-55`) reuses `system:openSettings` for the "Open Screen Recording / Microphone / Accessibility" buttons — `openPane('accessibility')` already supported (`permissions.tsx:45`, `paneURL` case `permissions.ts:109-110`).

Version-specific copy is **injected, not hardcoded**: accept an optional `copy` map keyed by permission (the QA-VERSION agent owns its contents). Default to a `copy` resolved from a `useMacOsVersion()`/`window.api.system.osVersion()` lookup so wizard and Settings stay identical.

## Live helper-permission status IPC (proposed channel + where probe code exists)

`usePermissions()` reports **Mintr's own** TCC via `systemPreferences.getMediaAccessStatus` (`permissions.ts:61-76`) — wrong principal. We need `ai.nawaz.mintr-engine`'s grants.

The probe pattern already exists: `classifyHelperFailure` in `captureWatchdog.ts:514-535` runs `runLogShow` (`captureWatchdog.ts:543-560`) against `subsystem == "com.apple.TCC" AND eventMessage CONTAINS "ai.nawaz.mintr-engine"` (bundle id constant `captureWatchdog.ts:65`) and substring-matches `kTCCServiceAccessibility / kTCCServiceMicrophone / kTCCServiceScreenCapture`.

Propose a NEW main module `src/main/onboarding.ts` `probeGrant(service)` that runs the same `log show` query but classifies the **Auth verdict** per TICKET C2 (`Allowed (System Set|User Consent)` → granted; `Denied` → denied; no entry → not-determined), reusing `runLogShow`-style execFile. Surface it as:

- IPC enum: add `onboardingProbeGrant: 'onboarding:probeGrant'` to the `IPC` const (`types.ts:159-210`).
- Handler in `ipc/index.ts` (alongside the `system:*` block at `ipc/index.ts:332-394`).
- Preload: add `window.api.onboarding.probeGrant(service)` to the `api` object (`preload/index.ts:131-197` system surface is the template).
- Renderer `useHelperPermissions()` calls all three on a 2s interval while mounted.

Add `GrantStatus = 'unknown' | 'not-granted' | 'granted' | 'denied'` to `types.ts`.

## Reuse of restartHelper / revealHelper IPC

Both already exist end-to-end — no new IPC needed:
- **Restart engine after grant**: `window.api.system.restartHelper()` (preload `preload/index.ts:156-157`) → `IPC.systemRestartHelper` handler (`ipc/index.ts:371-394`) which `resetCaptureWatchdog()` + `killLiveRecorderSync()` + `startLiveRecorder()`. Wizard step 4→5 (TICKET A5) calls this; Settings exposes it as a "Restart engine" button (B2). Note: it does NOT currently wait for `WatchLoop started` — `onboarding:verifyHelper` (TICKET) is the gap to add.
- **Reveal in Finder**: `window.api.system.revealHelper()` (`preload/index.ts:164-165`) → `IPC.systemRevealHelper` (`ipc/index.ts:360-369`), `shell.showItemInFolder` on `resolveLiveRecorderApp()`. Wire to the secondary button in every row.

## onboardingCompletedAt settings field (pattern to copy, file:line)

Copy the `autoStartWatching` boolean precedent exactly (a nullable number instead of boolean):

1. **Type** — add to `Settings` interface (`types.ts:5-19`, after `autoStartWatching:18`): `onboardingCompletedAt?: number`.
2. **Default** — `defaultSettings()` (`settings.ts:27-39`) — add `onboardingCompletedAt: undefined` (or omit; read-side coalesces). `autoStartWatching: true` at `settings.ts:37` is the sibling line.
3. **Read** — `readSettings()` (`settings.ts:49-62`) — add `const onboardingCompletedAt = store.get<number>('onboardingCompletedAt')` and include in the returned object (`settings.ts:61`); the `autoStartWatchingRaw` read at `settings.ts:58-60` is the pattern.
4. **Write** — `writeSettings()` (`settings.ts:64-78`) — add `if (patch.onboardingCompletedAt !== undefined) store.set('onboardingCompletedAt', patch.onboardingCompletedAt)`. Allow `null` to clear (for "Re-run wizard"); the `autoStartWatching` set at `settings.ts:74-76` is the sibling. Renderer `setSettings` (`settings.tsx:58-62`) already merges arbitrary `Partial<Settings>` — no change.

## Recommended file create/modify list (no code)

CREATE:
- `src/renderer/src/components/PermissionChecklist.tsx` — shared 3-row checklist (wizard + settings).
- `src/renderer/src/views/Onboarding.tsx` — wizard shell/state machine wrapping `PermissionChecklist`.
- `src/renderer/src/state/onboarding.tsx` — `useHelperPermissions()` (2s poll) + `useMacOsVersion()`.
- `src/main/onboarding.ts` — `probeGrant` / `verifyHelper` / `markComplete` / `reset`.

MODIFY:
- `src/shared/types.ts` — `Settings.onboardingCompletedAt?`, `GrantStatus`, new `IPC` enum entries.
- `src/main/settings.ts` — default/read/write the new field (4 sites above).
- `src/main/ipc/index.ts` — register onboarding handlers (in the `system:*` block).
- `src/preload/index.ts` — expose `window.api.onboarding.*` (+ `system.osVersion()` if added).
- `src/renderer/src/App.tsx` — early-return `<OnboardingWizard />` gate after the `settings` guard, before `App.tsx:117`.
- `src/renderer/src/views/Settings.tsx` — insert "Setup & Permissions" `<Section>` at top (after `Settings.tsx:155`); add icon import.
