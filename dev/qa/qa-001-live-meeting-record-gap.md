# QA-001 — Live meeting record never created on detection

## Symptom
When the Chrome probe detects `meet.google.com/<id>` and Mintr is watching, the green "Meet detected" card appears on Home but no row is created in the Recent or Meetings lists. The list only repopulates once the engine writes to disk at end-of-meeting. If the engine fails (helper-permission denied), nothing ever appears — the entire session is silently lost from the UI.

## Current Data Flow (with file:line citations)
1. `chromeProbe.tick` polls every 3s and on match emits `chrome-meet:update` (`src/main/chromeProbe.ts:102`, `:215-231`). State stored in module-local `state.snapshot`.
2. Renderer `useChromeMeet` subscribes and renders the green card at `src/renderer/src/views/Home.tsx:354-374`. **This card is purely cosmetic — no record is created in `meetings:list`.**
3. `captureWatchdog` runs an independent fs.watch on `liveRecordingsRoot` + `outputFolder` with `recursive: true` (`src/main/captureWatchdog.ts:137`). It debounces 1.5s then pushes `meetings:changed` (`:243-257`).
4. `useLiveCapture` (`src/renderer/src/state/permissions.tsx:101-137`) flips `active=true` ONLY when `meetings:changed` fires AND a write has occurred within `LIVE_WINDOW_MS = 6500` (`:90`). The live-capture card at `Home.tsx:386-419` is therefore gated on actual engine output.
5. `listMeetings` (`src/main/meetings.ts:290-307`) reads protocols/ and the per-folder import root. There is **no in-memory live source** merged in — the function is pure filesystem.
6. `IPC.meetingsList` handler (`src/main/ipc/index.ts:80-83`) just forwards `listMeetings`. Preload `meetings.list()` at `src/preload/index.ts:39` invokes it.

## Root Cause (the gap)
There is no in-memory "live meetings" registry. The Chrome detection (`chromeProbe.ts`) writes to a snapshot module variable read only by a banner. `listMeetings` (`src/main/meetings.ts:290`) is filesystem-only and has no concept of an in-progress meeting. `useLiveCapture` correctly observes "no engine writes yet" but has no fallback signal to surface a placeholder. The user's idea is **not partially implemented** — the green "Meet detected" card is the only live signal, and it lives outside the meetings list entirely.

## Recommended Implementation
- **Where to inject the placeholder.** Extend `captureWatchdog.ts` (it already owns `meetSeenAt` at `:69`, the 10-second-style threshold pattern at `:282-302`, and pushes `meetings:changed`). Add a `livePlaceholder: MeetingSummary | null` field to its state. When `checkWatchdog` sees `elapsed > LIVE_PLACEHOLDER_THRESHOLD_MS` AND no placeholder exists AND `lastEngineWriteAt < meetSeenAt`, construct one and push `meetings:changed`. Owning it here keeps the lifecycle (create / replace / drop) in one place and reuses `state.meetSeenAt`.
- **Shape in `listMeetings`.** Add `isLive?: true` and `liveStartedAt?: number` to `MeetingSummary` (`src/shared/types.ts:33-56`). Change `IPC.meetingsList` (`ipc/index.ts:80-83`) to merge `captureWatchdog.getLivePlaceholder()` ahead of the filesystem list — placeholder first because newest. Use id `live:<meetingId>` (e.g. `live:ntu-vwcf-onr`) to keep the namespace distinct from `engine:` / `imported:`.
- **10-second threshold.** Hardcode `const LIVE_PLACEHOLDER_THRESHOLD_MS = 10_000` at the top of `captureWatchdog.ts` next to `WATCHDOG_THRESHOLD_MS`. For later-configurability, add a `livePlaceholderDelayMs?: number` field to `Settings` (`src/shared/types.ts:5-19`) and read it via `readSettings()` in `startCaptureWatchdog` (already imported at `:44`), falling back to the constant. Settings UI then needs a single numeric input.
- **Replacement logic.** Engine writes `<root>/protocols/YYYYMMDD_HHmm_<slug>.txt` (`src/main/meetings.ts:69-75`). The slug **is not** the chrome meeting id — engine derives it from the Chrome window title (e.g. `meet-ntu-vwcf-onr`) so the chrome id `ntu-vwcf-onr` will appear as a substring but not equal it. **Verification hypothesis flagged for decision below.** Reasonable merge: when fs.watch fires inside `makeWatcher` (`:128`), if the new file's prefix slug contains the placeholder's `meetingId` substring, clear `livePlaceholder` and let the engine entry take over. If no substring match within `~5s` of first engine write since placeholder creation, drop the placeholder anyway (engine took over for some other meeting).
- **IPC + push event.** No new channel needed. Reuse `meetings:changed` — the renderer's `loadRecent` / `refresh` will pick up the placeholder on the next `listMeetings()` call. Optionally add `IPC.systemLivePlaceholder` for direct query but it would be redundant.
- **UI rendering.** In `Home.tsx:524-569` recent-card map, branch on `m.id.startsWith('live:')` to render a "Recording in progress" pill with a pulsing dot and elapsed timer (similar to `capture-live-card` at `:386`). In `Meetings.tsx` row map (`:910-1066`), same branch — disable `onSelect` (no transcript yet) or route to a stub detail pane. `MeetingsView.onSelect` (`:314-334`) currently calls `loadTranscript` which would 404 for `live:` ids; add an early return.

## Files To Modify
- `src/shared/types.ts` — add `isLive`, `liveStartedAt`, optional `livePlaceholderDelayMs` setting.
- `src/main/captureWatchdog.ts` — threshold constant, placeholder state, getter, replacement on first engine write.
- `src/main/meetings.ts` — `listMeetings` merges placeholder; export type unchanged otherwise.
- `src/main/ipc/index.ts` — `IPC.meetingsList` calls watchdog getter.
- `src/renderer/src/views/Home.tsx` — recent-card branch for `live:` ids.
- `src/renderer/src/views/Meetings.tsx` — list-row branch + `onSelect` guard.
- `src/renderer/src/state/permissions.tsx` — optionally let `useLiveCapture` also consider the placeholder (so the capture-live card lights up immediately too).

## Risks / Edge Cases
- **Two Meet tabs.** `chromeProbe.findFirstMeetTab` (`:130-153`) returns the first match in browser priority order, so the second tab is invisible. Placeholder would track only the first; switching tabs would change `meetingId` and trigger the existing reset at `captureWatchdog.ts:264-273`. Document as "single live meeting tracked" — multi-meeting placeholder is out of scope.
- **Detection fires then stops within 10s.** Threshold not crossed → no placeholder ever created. Correct behaviour — avoids ghost rows from tab-flicker.
- **Engine writes for a different meeting id.** The substring match (above) protects the happy case but is heuristic. If user joins meet A, engine captures meet B (e.g. window-title race), placeholder would not be replaced and would orphan. Mitigation: drop placeholder after `meetSeenAt` ages past `LIVE_MAX_AGE_MS` (e.g. 6h) or on `chromeMeet.tab === null` for >30s.
- **Mintr quits with a placeholder live.** Placeholder is in-memory only — disappears on quit. On next launch, `listMeetings` is filesystem-only, no stale rows. Safe.

## Open Questions
- Engine slug derivation: does the slug **always** contain the chrome meeting id as a substring, or can it diverge (e.g. user renames the Chrome window, engine reads a localised "Meet -" prefix)? Could not determine from code; the Swift engine source is outside this repo. Flag for decision — if the answer is "may diverge", we need a different correlation key (start-time proximity? always replace the most recent placeholder on first engine write?).
- Should the placeholder also write to disk (e.g. an empty `protocols/<prefix>.txt`) so it survives an Electron restart mid-meeting? Reasonable no — engine owns disk, Electron owns UI state. Flag for decision.
- Is `IPC.meetingsList` cheap enough to call on every `meetings:changed`, given it now merges in-memory state? Currently it does two `fs.readdir` calls per invocation (`meetings.ts:291-294`). Adding the merge costs nothing extra. Safe.
