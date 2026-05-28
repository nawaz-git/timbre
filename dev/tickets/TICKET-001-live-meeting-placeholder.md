# TICKET-001 — Create a placeholder meeting record on detection (10s threshold)

**Source QA report**: `dev/qa/qa-001-live-meeting-record-gap.md`
**Severity**: User-facing — first thing they expect to see when a meeting starts.
**Branch**: `v20-live-placeholder`

## Summary

When the AppleScript Chrome probe detects a `meet.google.com/...` URL AND
the engine has been in `watching` state for ≥ `LIVE_PLACEHOLDER_DELAY_MS`
(default 10_000), Mintr must immediately surface a placeholder meeting
record in BOTH lists:

- Home → Recent Meetings (top, with a "LIVE" badge)
- Meetings tab → meeting list (top, with a "LIVE" badge)

The placeholder is REPLACED (not duplicated) when the engine eventually
writes the actual transcript file. If the engine never writes (e.g.
permissions still bad), the placeholder remains visible until the user
leaves the Meet — then it auto-cleans up.

## Acceptance criteria

1. Open a Google Meet in Chrome. Within ~10s, a meeting card appears at
   the top of Home → Recent Meetings with title = the chrome meeting id
   (e.g. "Live · zpn-zvon-gyb"), date = now, and a visible "LIVE" badge.
2. Same card also appears at the top of the Meetings tab list.
3. When the engine finishes capturing and writes a file whose prefix
   matches the chrome meeting id (substring match, see below), the
   placeholder disappears and is replaced by the real meeting entry. No
   duplicate row.
4. If the user leaves the Meet (chrome.tab becomes null) BEFORE the
   engine writes anything, the placeholder disappears within 5 seconds.
5. Threshold is controlled by a constant `LIVE_PLACEHOLDER_DELAY_MS =
   10_000` in `captureWatchdog.ts`. Adding a Settings UI control is OUT
   OF SCOPE for this ticket — leave a TODO comment referencing the
   future Settings field name (`livePlaceholderDelayMs`).
6. Banner / status text on the placeholder card: "Recording in progress
   — full transcript will appear when meeting ends."

## Architecture (per QA-001)

- **Owner of placeholder state**: `src/main/captureWatchdog.ts`. It already
  tracks `meetSeenAt` and the 25s helper-permission watchdog timer; reuse
  the same tick-based pattern.
- **State shape**: extend the existing `state` object with:
  ```ts
  livePlaceholder: {
    meetingId: string         // chrome meeting id (e.g. "zpn-zvon-gyb")
    startedAt: number          // wall-clock ms when threshold first crossed
    title: string              // "Live · <meetingId>"
  } | null
  ```
- **When to create**: in `checkWatchdog` (already ticks every 2s).
  Conditions:
  - `chrome.tab !== null`
  - `now - state.meetSeenAt > LIVE_PLACEHOLDER_DELAY_MS` (i.e. Meet has
    been detected for ≥ 10s)
  - `state.livePlaceholder === null` (don't re-create if already set)
- **When to remove**:
  - `chrome.tab === null` (user left the Meet) — clear placeholder,
    push `meetings:changed`
  - An engine file lands in `liveRecordingsRoot/protocols/` whose
    basename CONTAINS the placeholder's `meetingId` substring (the
    engine filename pattern is `YYYYMMDD_HHmm_meet__<chromeId>_.txt`
    — the chrome id appears with double-underscore separators). Verify
    by reading the existing test file at
    `~/Downloads/MeetingTranscriber/protocols/20260528_1938_meet__ifh-kkfh-dzg_.txt`
    — its prefix slug contains the chrome id `ifh-kkfh-dzg`. Use that
    as the matching heuristic.
- **Surface to renderer**: NO new IPC channel needed. Reuse the existing
  `meetings:changed` push. The renderer's `loadRecent` / `refresh`
  already pull `meetings.list()` after every push.
- **`listMeetings` merge logic**: in `src/main/meetings.ts`, after the
  existing `imported + engineDefault` merge, prepend the placeholder
  (if any) when it's NOT already represented by a filesystem entry.
  De-dup check: if any meeting's id contains the placeholder's
  meetingId substring, the file has landed — drop the placeholder.
- **MeetingSummary shape**: add an optional `isLive?: boolean` field in
  `src/shared/types.ts`. The placeholder sets `isLive: true`; all real
  entries leave it `undefined` (which renders falsy).

## Files to modify

1. `src/shared/types.ts`
   - Add `isLive?: boolean` to `MeetingSummary`.
   - Add a constant `LIVE_PLACEHOLDER_DEFAULT_MS = 10_000` (export for
     reference; the watchdog reads its own copy).

2. `src/main/captureWatchdog.ts`
   - Add `LIVE_PLACEHOLDER_DELAY_MS = 10_000` near the existing
     `WATCHDOG_THRESHOLD_MS`.
   - Add `livePlaceholder` to `state`.
   - In `checkWatchdog`, after the existing meeting-id-change reset
     block, evaluate placeholder-create / placeholder-clear conditions.
     When state changes, call a new helper `pushPlaceholderChange()`
     that broadcasts `meetings:changed` on all renderer windows.
   - Export a new getter `getLivePlaceholder(): { meetingId, startedAt,
     title } | null` so `meetings.ts` can read it without an
     import cycle.
   - In the existing fs.watch handler (which already calls
     `queueMeetingsChange`), additionally call a `maybeClearPlaceholder`
     check — if the just-written filename contains the placeholder's
     meeting-id substring, null the placeholder.

3. `src/main/meetings.ts`
   - Import `getLivePlaceholder` from `./captureWatchdog`.
   - In `listMeetings`, after the merge + de-dup loop and BEFORE the
     final sort, check if `getLivePlaceholder()` returns non-null and no
     existing merged entry's id contains the placeholder's meetingId
     substring. If so, prepend a synthesised MeetingSummary:
     ```ts
     {
       id: `live:${placeholder.meetingId}`,
       title: placeholder.title,
       folderPath: ENGINE_DEFAULT_ROOT,
       date: new Date(placeholder.startedAt).toISOString(),
       durationSeconds: 0,
       speakerCount: 0,
       hasAudio: false,
       tagIds: [],
       additionalSpeakers: [],
       isLive: true
     }
     ```
   - Sort behaviour: the sort already does newest-first by date; the
     placeholder's date = now will naturally land at top.

4. `src/renderer/src/views/Home.tsx`
   - In the `recent-meetings__grid` map (around line 290+), if
     `m.isLive`, render a small pulsing red badge after the title:
     `<span className="recent-card__live-badge">● LIVE</span>`. Also
     swap the meta line from the default "27:06 · 2 speakers" to a
     literal "Recording in progress — full transcript when meeting
     ends." Wrap the whole card with a subtle accent-green border so
     it visually stands out from completed meetings.

5. `src/renderer/src/views/Meetings.tsx`
   - In the meetings list rendering, same treatment: live entries get
     a pulsing red dot before the title and the "Recording in progress…"
     subtitle. When clicked, the right pane shows an empty-state with
     copy: "Recording in progress. The transcript will appear here when
     the meeting ends." — gate this by checking `meeting.id.startsWith('live:')`.

6. `src/renderer/src/styles/app.css`
   - `.recent-card__live-badge` — small inline-flex pill, accent-red
     background `rgba(239,68,68,0.15)`, foreground red `--status-recording`,
     dot animates via the same `meet-live-pulse` keyframes already in the
     file (around line 415).
   - `.recent-card--live` — accent-green border on the whole card so
     live entries are visually distinct from completed.

## Testing

After implementation:
1. Run `npm run typecheck` (must pass).
2. Build via `npm run dist:mac`.
3. Install. Open a Meet. Verify within ~12s that a "Live · …" entry
   appears at the top of both lists with the LIVE badge.
4. Close the tab. Verify the placeholder disappears within 5s if no
   engine file has been written.
5. With a working engine, verify the placeholder is REPLACED by the
   real entry (no duplicate).

## Out of scope (do not touch)

- Adding a Settings UI control for the threshold (future ticket).
- Streaming live transcript text into the placeholder card.
- Changing the engine-side capture pipeline.
