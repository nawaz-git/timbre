# Feasibility: Using on-screen participant names as speaker labels

**Status:** Research only — no production code written.
**Date:** 2026-05-29
**Question (product owner):** When people join a video meeting their names are
visible on screen (Google Meet tiles / participant list). Could we capture those
on-screen names and use them as speaker labels instead of anonymous diarized
clusters (Speaker 1/2, Me/Remote)?

**One-line answer:** Capturing the **roster of names** is feasible and partly
already built. Automatically binding each name to the **right diarized voice** is
the hard, unreliable part. Recommended path: capture the roster and surface it as
suggested names in the existing speaker-rename picker — do **not** attempt
fully-automatic name to voice binding.

---

## 1. What the app already does today

The Swift engine already has a participant-reading feature, but it is wired for
**Microsoft Teams only**, and the rename UI already consumes the result.

### `ParticipantReader.swift` (engine)
`/Users/nawazpasha/Projects/meeting-transcriber/app/MeetingTranscriber/Sources/ParticipantReader.swift`

- `readParticipants(pid:) -> [String]?` scrapes the **macOS Accessibility tree**
  (`AXUIElementCreateApplication(pid)`) of the meeting app's process and returns a
  list of likely participant names. It tries three strategies in order:
  1. **Known panel identifiers** — `AXIdentifier` equal to `roster-list`,
     `people-pane`, `participant-list`, `roster-container` (these are Teams-specific
     identifiers), then extract `AXStaticText` values inside.
  2. **List/Table containers** — walk `AXList` / `AXTable` / `AXOutline` with >= 2
     children, take the first text of each row.
  3. **Window-title parsing** — parse `"Name1, Name2 | Microsoft Teams"`.
- `filterParticipantNames()` strips UI noise (mute/camera/share/chat/leave…),
  timestamps, URLs, `(you)` suffix, over-long strings, etc.
- Uses `AXHelper.getAttribute()` (`AXHelper.swift`) — a thin wrapper over
  `AXUIElementCopyAttributeValue`.

### Where the names are used
- `WatchLoop.swift` (lines ~333-340): participant reading is **gated to Teams**:
  ```swift
  if meeting.pattern.appName == "Microsoft Teams",
     let names = ParticipantReader.readParticipants(pid: meeting.windowPID), ... {
      participants = names
  }
  ```
  For Google Meet (`appName == "Google Meet"`, owner `Google Chrome`), this branch
  never runs — **so today Meet yields zero participant names.**
- Names flow into `PipelineJob.participants` -> `PipelineQueue` -> two consumers:
  1. **`SpeakerMatcher.preMatchParticipants()`** (SpeakerMatcher.swift ~456): a
     *heuristic* auto-assignment. When the count of unmatched voice clusters equals
     the count of unused participant names, it assigns names to clusters **by
     descending speaking-time order**. Explicitly documented as "a heuristic — the
     naming popup lets users correct mistakes." It does **not** know which cluster
     is actually which person.
  2. **`SpeakerNamingView.swift`** (~407): renders participant names as clickable
     **chips** in the rename dialog (`participantChips`), plus "Known:" chips from
     the voice DB. Typing filters the chips. This is the manual name-pick UI.

**Does the current AX approach work for Google Meet?** No, for two reasons:
(1) it is gated to Teams in `WatchLoop`; (2) even if un-gated, Strategy 1 keys off
Teams-specific `AXIdentifier`s and Strategy 3 off the Teams window-title format.
Meet runs inside Chrome — a totally different AX subtree (web content). The generic
Strategy 2 (AXList/AXTable) *might* catch something but is untested against Meet and
would need the Chrome web-content AX tree to be exposed (see 2a).

**Detection context for Meet** (`MeetingPatterns.swift`): Meet is detected purely by
Chrome **window title** (tab `document.title` like `"abc-defg-hij - Google Meet"`).
The Electron app's `chromeProbe.ts` independently reads Chrome tab **URLs** via
AppleScript and writes an `active_meeting.json` signal the engine consumes. So the
app already has a working AppleScript -> Chrome channel and the meeting PID.

---

## 2. Feasibility of reading Google Meet participant names on macOS

### 2a. macOS Accessibility API (AXUIElement) scraping the Chrome window

How it would work: reuse `ParticipantReader`'s AX traversal but pointed at Chrome's
PID, drilling into the web-content AX tree to find the participant-list panel text.

- **Chrome web-content a11y is NOT exposed by default.** Chrome only builds the full
  web-content accessibility tree when an assistive client requests it, and on macOS
  the renderer accessibility is often gated behind the `--force-renderer-accessibility`
  flag or triggered by VoiceOver/AX queries. In practice the AX tree you get from
  `AXUIElementCreateApplication(chromePID)` is frequently just chrome (toolbar, tabs,
  the web area as an opaque `AXWebArea`) without the deep DOM-derived elements — or it
  populates lazily and inconsistently. This is far less reliable than Teams (a native
  Electron/React app whose a11y tree is always built).
- The Meet participant list is also **collapsed by default** (the "People" panel is a
  side sheet the user must open). If the panel is closed, the names aren't in the tree
  at all. The tile labels in the main grid are rendered on `<canvas>`/video for many
  layouts, so names there may not be AX text either.
- Meet UI churns frequently (Dynamic layouts shipped 2025), so any
  identifier/structure assumptions rot.
- **Permission:** the engine helper already needs **Accessibility** TCC permission
  (`ai.nawaz.mintr-engine`) for its core operation — see
  `dev/tickets/TICKET-002-accessibility-permission-surface.md` — so no *new*
  permission class is introduced. That's a plus.

**Reliability: LOW.** Chrome web-content AX exposure is unreliable/lazy, panel must be
open, layouts change. Pros: no new permission, reuses existing code. Cons: brittle,
likely returns nothing for many sessions.

### 2b. Execute JavaScript in the Chrome tab to read the participant DOM

How it would work: the Electron app already talks to Chrome via AppleScript
(`chromeProbe.ts`, `osascript ... tabs of windows`). AppleScript can also run
`execute javascript` against the active tab and return a string. We'd run a small
script that reads participant names from the Meet page and return them.

```applescript
tell application "Google Chrome"
  tell active tab of front window to execute javascript "<reader JS>"
end tell
```

- **Hard friction — Chrome blocks this by default.** `execute javascript` only works
  if the user has enabled **View > Developer > "Allow JavaScript from Apple Events."**
  This is OFF by default, is a per-browser manual toggle, and Google has been
  tightening/deprecating AppleScript JS injection. Many users will never enable it,
  and it's a security-sensitive switch (ANY AppleScript could then inject JS into
  Chrome). On Brave/Edge/Arc/Vivaldi the toggle exists but is equally manual. **This
  alone makes 2b a non-starter as a default-on, zero-setup feature.**
- **Selectors are NOT stable.** Meet does not expose stable `data-participant-id` /
  semantic class names for participant tiles. The most reliable community technique
  (e.g. the widely-referenced participant-list gist) does **not** use CSS selectors at
  all — it reaches into Meet's **internal Closure state** (`window` keys starting with
  `closure_lm_`, recursive walk for `spaces/` objects). Its own author warns "the
  property names are non-deterministic and may change at any time." CSS/aria selectors
  break on every Meet UI revision.
- The People panel being collapsed is the same problem as 2a — DOM nodes for the full
  roster may not exist until the panel is opened (Meet virtualizes/lazy-renders).

**Reliability: LOW-MEDIUM when it works, but BLOCKED by default.** Pros: richest data
(could in principle also read the active-speaker highlight — see 3); reuses the
existing AppleScript channel. Cons: requires a manual, security-sensitive Chrome
toggle most users won't flip; selectors/internal-state are fragile; only the focused
window/profile is scriptable.

### 2c. Screen OCR of participant tiles (Vision framework)

How it would work: the engine already has Screen Recording permission (used for
window-title detection). Capture frames of the Meet window, run Apple's **Vision**
`VNRecognizeTextRequest` on the tile name-overlay regions, dedupe over time.

- **Feasibility: real, fully on-device, no Chrome toggle, no new permission.** Vision
  text recognition is fast and accurate on the small high-contrast name overlays Meet
  draws on each tile ("Alice Smith" bottom-left of a tile).
- **Accuracy caveats:** names only show when tiles are visible and not scrolled off;
  large meetings page the grid; self-view shows "You"; overlays auto-hide after a few
  seconds in some layouts; non-Latin names and stylized fonts reduce OCR accuracy. You
  capture *whoever is on screen*, not necessarily the full roster.
- **Cost:** periodic screen capture + OCR is heavier than a one-shot AX/JS read (CPU,
  and capturing frames of a meeting is privacy-sensitive even if processed locally).
- **Bonus:** OCR of the tile region is also the most robust way to read the
  **active-speaker highlight** (Meet draws a colored border / moves the speaker tile),
  which is the one signal that could bind a name to a voice (see 3).

**Reliability: MEDIUM for the roster, and uniquely able to also capture the
active-speaker cue.** Pros: on-device, no Chrome toggle, reuses Screen Recording. Cons:
only on-screen tiles, layout-dependent, heavier, OCR errors on some names.

### 2d. Google Meet APIs (REST / Media / Workspace Events)

Researched via Google's developer docs (sources below).

- **Meet REST API `conferenceRecords.participants.list`** returns the participant
  roster — but `conferenceRecords` are **post-conference artifacts**. The roster is
  reliably available **after** the meeting, not as a guaranteed live feed. Requires
  OAuth scopes `meetings.space.created` **or** `meetings.space.readonly`, and crucially
  `meetings.space.created` is **principal-scoped — it only covers spaces the token
  owner created**. So you'd only get rosters for meetings *your user organized*, not
  ones they merely joined. Heavy auth/consent + Google Cloud project + OAuth flow.
- **Workspace Events API** (`google.workspace.meet.participant.v2.joined` /
  `.left`) gives **real-time** participant join/leave events via Pub/Sub — this is the
  only true *live roster* signal. But it requires a Cloud project, Pub/Sub plumbing,
  OAuth consent, and access to the space; same principal/admin-scoping constraints.
- **Meet Media API** (real-time media + participant metadata over WebRTC) is in
  **Developer Preview** and requires **every participant in the call** plus the Cloud
  project and OAuth principal to be enrolled in the preview program. Not usable for a
  general consumer app.

**Reliability: HIGH data quality, but auth/scope cost is prohibitive** for a local,
zero-config menu-bar app. You'd force Google sign-in, a Cloud project, scopes that
only cover meetings the user *created*, and (for live/media) preview enrollment. This
contradicts the app's on-device, no-account posture.

### Feasibility summary table

| Avenue | Gets live roster? | Reliability | Setup friction | New permission? | Verdict |
|---|---|---|---|---|---|
| 2a. AX scrape Chrome | Only if People panel open & a11y tree built | LOW | None (AX already needed) | No | Brittle; Chrome web a11y not reliably exposed |
| 2b. AppleScript `execute javascript` | Yes when toggle on & panel open | LOW–MED, but **blocked by default** | HIGH (manual Chrome "Allow JS from Apple Events"; security toggle) | No | Non-starter as default; fragile internal-state selectors |
| 2c. Screen OCR (Vision) | On-screen tiles only | MEDIUM | None (Screen Recording already needed) | No | Best on-device option; also reads active-speaker cue |
| 2d. Meet REST / Events / Media API | Post-meeting (REST), live (Events), media (preview) | HIGH data | HIGH (OAuth, Cloud project, scopes, principal-scoped) | Google account | Too heavy; breaks on-device/no-account model |

---

## 3. The HARD part — mapping names to diarized voices

This is the crux the product owner intuited. Getting `{Alice, Bob, Carol}` tells you
*who is in the room*, not *which anonymous voice cluster is Alice*. Diarization yields
`R_speaker0`, `R_speaker1`, … with no names attached. Options, by effort vs reliability:

**A. Active-speaker time-correlation (full auto binding).**
Meet highlights the current speaker's tile. If we sample "who is highlighted" over
time (via 2b reading the highlight class, or 2c OCR'ing which tile has the active
border) and timestamp it, we could correlate the highlighted-name timeline against the
diarized-segment timeline: the name highlighted during cluster R_0's segments is that
cluster's person.
- *Reliability:* MEDIUM-LOW. Meet's active-speaker indicator lags, flickers, and gets
  confused by overlapping speech, background noise, and "pinned"/spotlight layouts. It
  reflects *loudest tile*, not ground-truth speaker. The clock alignment between the
  browser sampling and the engine's audio timeline adds drift. You'd get it right often
  but wrong enough to erode trust, and wrong bindings are worse than no binding.
- *Effort:* HIGH. New sampling loop (browser or OCR), timestamp plumbing across the
  Electron<->engine boundary, a correlation/assignment algorithm, and conflict handling.
- This is strictly better than what exists, but it's a research project, not a
  morning's work.

**B. Speaking-order / count heuristic (already implemented).**
`SpeakerMatcher.preMatchParticipants()` already assigns names to clusters by descending
speaking time **when the counts match exactly**. It's a guess and documented as such.
- *Reliability:* LOW (it's coincidental — the most-talkative cluster gets the
  first-listed name). *Effort:* ZERO (exists). It's really just a pre-fill the user is
  expected to correct.

**C. Roster as a name-pick list in the rename UI (already implemented for Teams).**
Surface the captured roster as the chip suggestions in `SpeakerNamingView` so the user
**clicks** the right name per cluster instead of typing it. The voice DB
(`SpeakerMatcher` / known voices) already auto-names returning speakers; the roster
just makes first-time naming a one-tap pick.
- *Reliability:* HIGH (human picks — no wrong auto-binding). *Effort:* LOW for Meet —
  the chip UI, the `participants` plumbing, and the pre-match already exist; we only
  need to *populate `participants` for Meet*. *Value:* HIGH — turns typing into tapping.

Effort vs reliability: **C >> A > B.** B already exists as a soft pre-fill; A is a
high-effort, medium-trust automation; C is the high-value, low-effort, low-risk win.

---

## 4. Recommendation

**Yes — capture the roster; no — do not attempt fully-automatic name->voice binding
(yet).**

Lowest-effort, highest-value: **populate the Meet participant roster and surface it as
suggested name chips in the existing speaker-rename picker** (option 3C). Concretely:

1. **Get the roster** with the least-friction source. The pragmatic on-device choice is
   **2c Screen OCR via Vision** (no Chrome toggle, no Google account, reuses the Screen
   Recording permission the engine already holds), with an optional **2b AppleScript-JS
   path as an opt-in power-user enhancement** for users who enable "Allow JavaScript
   from Apple Events" (richer/cleaner names when available). Avoid 2d (auth cost) and
   treat 2a as a cheap-to-try fallback only.
2. **Feed it into the path that already exists.** Un-gate `WatchLoop`'s participant
   branch for `appName == "Google Meet"` and set `PipelineJob.participants`. The chips
   (`SpeakerNamingView.participantChips`) and the soft pre-fill
   (`SpeakerMatcher.preMatchParticipants`) then light up for Meet with zero new UI.
3. **Keep B as the soft pre-fill** (it already only fires when counts match and is
   user-correctable). **Defer A** (active-speaker correlation) to a later spike — log
   that it's the only route to true auto-binding but is medium-reliability and
   high-effort.

This gives the product owner the visible win ("real attendee names show up as
one-tap suggestions when I name speakers") without shipping a confidently-wrong
automatic binding.

### Privacy implications (important)
- Participant names are **PII**. Whatever source is used, processing must stay
  **on-device** — Vision OCR is local; AppleScript-JS returns strings locally; both are
  consistent with the app's on-device posture. The Meet REST/Events/Media APIs would
  send identity to Google's cloud under the user's OAuth token and pull other
  attendees' identities — heavier privacy/consent surface; another reason to avoid 2d.
- Names should be stored only in the existing local meeting sidecar / speaker DB, never
  logged in plaintext (the engine already has `String+LogRedaction` /
  `.pseudonymized` for this — reuse it).
- OCR means periodically capturing meeting-window frames; even processed locally and
  discarded, document this in the privacy notes and ideally make roster-capture an
  opt-in setting.

---

## Sources

- [Work with participants | Google Meet REST API](https://developers.google.com/workspace/meet/api/guides/participants)
- [REST Resource: conferenceRecords.participants](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants)
- [Method: conferenceRecords.participants.list](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants/list)
- [Authenticate and authorize Meet REST API requests (scopes)](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)
- [Subscribe to Google Meet events (Workspace Events API, participant.v2.joined)](https://developers.google.com/workspace/events/guides/events-meet)
- [Respond to events from Google Meet](https://developers.google.com/workspace/meet/api/guides/events-overview)
- [Meet Media API overview (Developer Preview restrictions)](https://developers.google.com/workspace/meet/media-api/guides/overview)
- [Get started with Meet Media API (preview enrollment requirement)](https://developers.google.com/workspace/meet/media-api/guides/get-started)
- [Lists all participants in a Google Meet meeting (gist — internal closure_lm_ state, "non-deterministic" warning)](https://gist.github.com/71/7296ec9d44af7d0f1fb36b053bbe2219)
- [Google-Meet-presence-list (attendance-tracking extension)](https://github.com/benjamin-mauss/Google-Meet-presence-list)
- [Information for Third-party Applications on Mac (Chromium AppleScript)](https://www.chromium.org/developers/applescript/)
- [Chrome AppleScript: misleading error when 'Allow JavaScript from Apple Events' disabled (modelcontextprotocol/mcpb #34)](https://github.com/modelcontextprotocol/mcpb/issues/34)
- [Chrome 59: "Executing JavaScript through AppleScript is no longer supported" (Keyboard Maestro forum)](https://forum.keyboardmaestro.com/t/chrome-59-executing-javascript-through-applescript-is-no-longer-supported/6763)
- [AppleScript – Executing JavaScript in Safari and Chrome (Kevin Marsden)](https://kmarsden.com/2016/06/applescript-executing-javascript-in-safari-and-chrome/)
- [Dynamic layouts for Google Meet (2025 UI churn, AI active-speaker detection)](https://workspaceupdates.googleblog.com/2025/03/dynamic-layouts-for-google-meet.html)
- [How to get Google Meet transcripts programmatically (DOM fragility note)](https://www.recall.ai/blog/how-to-get-transcripts-from-google-meet-developer-edition)
