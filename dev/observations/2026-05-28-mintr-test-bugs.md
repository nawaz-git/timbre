# User observations — 2026-05-28 live-meeting test

Captured verbatim from the user during a real Google Meet test session on
v0.19.0 (the rebrand release). Raw → triaged into QA investigations in
`dev/qa/`.

## Setup at time of report

- Mintr v0.19.0 installed (fresh clean install per the rebrand plan)
- Helper renamed to `MintrEngine.app` with bundle id `ai.nawaz.mintr-engine`
- User granted permissions to: Mintr (Mic + Screen Recording), Mintr Engine
  (Screen Recording — manually via `+` button)
- User did NOT explicitly add Mintr Engine to: Microphone, Accessibility
- Real Google Meet opened in Chrome (`meet.google.com/zpn-zvon-gyb`)

## Observation 1 — no meeting record created when Meet is detected

> "I started speaking [in the] meeting, I closed the meeting tab. I did
> that for 10 seconds and then it didn't create a record while it says
> live meeting recording. Then only it should create a meetings record
> and start to show inside of home saying live meeting and inside of
> meeting also it should say one live meeting and start to do that stuff."

**Expected**: when Chrome probe detects a Meet AND watching is active for
≥ 10 seconds (configurable, default 10s), Mintr should immediately create
a placeholder meeting record. The record:
  - Shows on Home → Recent Meetings (top, with a "live" badge)
  - Shows on Meetings tab list (top, with a "live" badge)
  - Title: "Live meeting" (or the Chrome meeting id like "zpn-zvon-gyb")
  - Status: "Recording in progress…"
  - Gets REPLACED (not duplicated) when the engine writes the actual
    transcript / segments / audio files

**Constraint**: 10s threshold is the temporary default for testing. Later
this becomes configurable in Settings → Background behaviour. For now,
hardcode constant + add a Settings entry later.

**Why this matters**: even if live transcript streaming isn't possible
yet, the user wants visual confirmation that a meeting is being tracked.
Right now Home shows "Meet detected" but the meeting only appears in the
list AFTER the engine finishes writing — which may never happen if the
helper has any permission gap.

## Observation 2 — engine PermissionHealthCheck still fails after rebrand

> "It was saying meeting detected in Chrome but again it said this
> error [the engine-helper red banner]."

After granting Mintr Engine to Screen Recording, the red banner still
appears within ~25s of joining a Meet. `PermissionHealthCheck failed`
shows in the unified log on every helper launch (8 helper PIDs in 10
minutes observed). WatchLoop never starts. Likely additional missing
permissions: Microphone (for the new bundle id), Accessibility.

## Observation 3 — "Restart engine" success state lies

> "I clicked on restart engine. After doing the steps of adding the
> engine inside [the] Screen Recorder setting inside Mac app, but if I
> click on Restart engine it said helper restarted but the error stays
> there right? So that has to be better handled."

Clicking Restart engine in the red banner shows:
  - Banner result line: "Helper restarted — it should now pick up the
    granted permission"
  - But the red banner ITSELF stays — the `watchdog.helperPermissionLikely`
    state isn't re-evaluated after restart, so visually nothing changes.

Expected: after restart, banner should either auto-dismiss for ~30s
(give the helper time to start writing files), or transition to a
"Helper restarted, waiting for capture confirmation…" state that clears
when the engine actually starts writing.

## Observation 4 — onboarding doesn't walk through ALL required permissions

> "I dragged in the Mintr this thing, okay already, but it is asking
> me to drag the Mintr Engine as well. So either that has to be
> explicit during the setup."

The current "fix" flow:
  1. User joins Meet → red banner appears after 25s
  2. Click "Open Screen Recording" → user manually adds Mintr Engine

But there's no FIRST-RUN wizard that says "Mintr needs these 4
permissions across these 2 apps — here's a walkthrough." Plus user
discovered they ALSO need to add Mintr Engine to Microphone (we never
told them; manual instructions were given mid-test).

## Observation 5 — `<private>` log redaction hides which permission failed

The Swift engine logs:
```
[com.meetingtranscriber:PermissionHealthCheck] Permission health check failed: <private>
```

macOS redacts the actual permission name as `<private>`. Without source
access or unredacted logs, Mintr's UI can't tell the user "Accessibility
is missing" vs "Microphone is missing" specifically. We need either:
  - To capture helper stderr from Mintr's spawn (we already pipe it via
    `stdio: ['ignore', 'pipe', 'pipe']`) and parse for non-redacted output
  - To query each permission's TCC state from Mintr's side via
    `systemPreferences.getMediaAccessStatus` per service, then deduce
    what's missing from what the helper Info.plist declares.

## Workflow notes

User asked for parallel QA + dev pipeline:
  - **QA Manager** (= me) intakes observations, files tickets
  - **3 QA Engineer agents** (parallel): one ticket each, find ROOT
    CAUSE (no assumptions), write to `dev/qa/qa-NNN-*.md`
  - **Ticket Orchestrator** (= me): synthesises QA findings into
    structured tickets in `dev/tickets/`
  - **Dev Orchestrator** (= me): dispatches 3 parallel dev agents to
    execute tickets

Subagent cap = 3 per phase per standing instruction.
