/**
 * Capture watchdog + meetings-folder watcher.
 *
 * Two related concerns this module handles:
 *
 * ── A. Capture watchdog ───────────────────────────────────────────────
 *
 * v0.12 surfaced a "Google Meet detected in Chrome" card the moment the
 * AppleScript probe spotted a meet.google.com tab. That part works. What
 * DIDN'T work: the bundled MeetingTranscriber.app helper has bundle id
 * `com.meetingtranscriber.app` — different from Mintr's
 * `ai.nawaz.meeting-transcriber` — so they don't share TCC permissions.
 * When a user grants Screen Recording to Mintr, the helper still has no
 * permission, can't read window titles, never matches the Meet pattern,
 * and silently writes nothing. The user sees "Mintr is watching, Meet
 * detected" but finds zero meetings in the Meetings tab afterwards.
 *
 * The watchdog catches this by timing: when Chrome detects a Meet, start
 * a stopwatch. If `WATCHDOG_THRESHOLD_MS` passes with no new file written
 * under `liveRecordingsRoot`, the helper has failed silently — surface a
 * `helperPermissionLikely` signal so the renderer can show a focused
 * banner naming the right TCC entry.
 *
 * ── B. Meetings-folder watcher ────────────────────────────────────────
 *
 * Even on the happy path (engine working, file written), there was no
 * mechanism to tell the renderer that a new meeting had landed. The
 * Home view's recent list and the Meetings tab list pulled `meetings:list`
 * on mount but never refreshed mid-session. User complaint: "I stopped
 * the meeting and it didn't show up in either tab."
 *
 * `fs.watch` on both `liveRecordingsRoot` (engine outputs) AND
 * `outputFolder` (mt-batch file imports) catches new entries; we debounce
 * 1.5s (writes happen in bursts as the engine finalises a meeting) then
 * push `meetings:changed` to all renderer windows, which triggers a
 * re-fetch in `useMeetings` / Home's `loadRecent`.
 */
import { BrowserWindow, Notification } from 'electron'
import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { promises as fsp } from 'fs'
import { basename } from 'path'
import { getChromeMeetSnapshot } from './chromeProbe'
import { liveRecordingsRoot } from './meetings'
import { readSettings } from './settings'
import type {
  CaptureWatchdogSignal,
  WatchdogPermissionHint
} from '../shared/types'

const WATCHDOG_THRESHOLD_MS = 25_000 // 25s of "Meet detected, no file" → flag
const DEBOUNCE_MS = 1500
/**
 * How long a Chrome `meet.google.com` tab must be visible before we
 * surface a synthesised "Live · <id>" row in the meetings list
 * (TICKET-001). Short enough that the user sees feedback well before
 * the helper-permission watchdog fires at 25s, long enough to skip
 * tab-flicker / accidental open-and-close.
 * TODO: when the Settings UI lands, replace the constant read with
 *       `settings.livePlaceholderDelayMs ?? LIVE_PLACEHOLDER_DELAY_MS`.
 */
const LIVE_PLACEHOLDER_DELAY_MS = 10_000

/** Bundle id of the bundled MintrEngine.app helper (per Info.plist). */
const ENGINE_BUNDLE_ID = 'ai.nawaz.mintr-engine'
/** Per-call timeout for each `log show` invocation in classifyHelperFailure. */
const LOG_SHOW_TIMEOUT_MS = 2500

/**
 * In-memory live-meeting placeholder. Owned by this module — `meetings.ts`
 * reads it via `getLivePlaceholder()` and prepends a synthesised
 * `MeetingSummary` so the renderer's existing `meetings:list` / push flow
 * surfaces a "Live · <id>" row at the top of both lists.
 *
 * Lifecycle:
 *   create  — chrome tab visible AND `meetSeenAt` is older than
 *             `LIVE_PLACEHOLDER_DELAY_MS` AND no placeholder yet
 *   clear   — chrome tab disappears (user left the Meet)
 *           — OR a new engine file lands whose basename contains the
 *             placeholder's `meetingId` substring (file took over)
 */
interface LivePlaceholder {
  meetingId: string
  startedAt: number
  title: string
}

const state: {
  /** When did the current Chrome-detected meeting first appear? */
  meetSeenAt: number | null
  /** Last meeting id we observed so we can reset the timer on new meetings. */
  lastSeenMeetingId: string | null
  /** Last time we observed a new file under liveRecordingsRoot. */
  lastEngineWriteAt: number
  signal: CaptureWatchdogSignal
  /** Synthesised placeholder for a Meet that's been detected but not yet
   *  written by the engine. Read by `meetings.ts` via getLivePlaceholder. */
  livePlaceholder: LivePlaceholder | null
  watchers: FSWatcher[]
  debounceTimer: NodeJS.Timeout | null
  watchdogTimer: NodeJS.Timeout | null
} = {
  meetSeenAt: null,
  lastSeenMeetingId: null,
  lastEngineWriteAt: 0,
  signal: { helperPermissionLikely: false },
  livePlaceholder: null,
  watchers: [],
  debounceTimer: null,
  watchdogTimer: null
}

export function getWatchdogSignal(): CaptureWatchdogSignal {
  return state.signal
}

/**
 * Force a fresh evaluation window for the watchdog. Called when the user
 * restarts the helper from the red banner (TICKET-003): we want to clear
 * the stale `helperPermissionLikely` flag so the renderer's red banner
 * goes away, AND we want to give the freshly-respawned helper a full
 * grace window before the watchdog can fire again. Bumping both
 * `meetSeenAt` and `lastEngineWriteAt` to "now" achieves that — the next
 * 2s tick of `checkWatchdog` sees a brand-new clock.
 *
 * We deliberately do NOT call `checkWatchdog` synchronously here — if we
 * did, the next renderer paint would briefly clear the banner then
 * re-instate it (the helper hasn't had a chance to write yet). Letting
 * the organic 2s tick re-evaluate avoids that flash.
 */
export function resetCaptureWatchdog(): void {
  state.meetSeenAt = Date.now()
  state.lastEngineWriteAt = Date.now()
  if (state.signal.helperPermissionLikely) {
    setSignal({ helperPermissionLikely: false })
  }
}

/**
 * Current live-meeting placeholder, or null if none. `meetings.ts` reads
 * this and prepends a synthesised `MeetingSummary` to its list — keeping
 * the lifecycle (create/replace/clear) in this module avoids an import
 * cycle and keeps watchdog-owned state in one file.
 */
export function getLivePlaceholder(): LivePlaceholder | null {
  return state.livePlaceholder
}

/**
 * Begin watching the live + import folders and start the watchdog tick.
 * Safe to call repeatedly — second+ calls are no-ops.
 */
export async function startCaptureWatchdog(): Promise<void> {
  if (state.watchers.length > 0) return

  await ensureFolder(liveRecordingsRoot)
  const settings = await readSettings()
  await ensureFolder(settings.outputFolder)

  state.watchers.push(makeWatcher(liveRecordingsRoot, 'live'))
  state.watchers.push(makeWatcher(settings.outputFolder, 'imported'))

  // Tick every 2 seconds — checks Chrome-probe state vs. last-write time
  // and flips the signal when it crosses the threshold.
  state.watchdogTimer = setInterval(checkWatchdog, 2000)
}

export function stopCaptureWatchdog(): void {
  for (const w of state.watchers) {
    try {
      w.close()
    } catch {
      // ignore
    }
  }
  state.watchers = []
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer)
    state.watchdogTimer = null
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
}

async function ensureFolder(path: string): Promise<void> {
  try {
    await fsp.mkdir(path, { recursive: true })
  } catch {
    // best-effort — if mkdir fails, fs.watch will throw next anyway
  }
}

function makeWatcher(path: string, kind: 'live' | 'imported'): FSWatcher {
  // Critical: recursive: true. The engine writes its outputs inside
  //   <root>/protocols/<file>.txt    — transcripts
  //   <root>/recordings/<file>.wav   — audio
  // With recursive: false, fs.watch only fires on changes to the immediate
  // directory entries — writes inside protocols/ or recordings/ are
  // invisible. v0.15 logged a real captured meeting at 19:38 that never
  // surfaced in the UI because of exactly this. macOS's fs.watch
  // supports `recursive: true` natively (via FSEvents under the hood).
  const w = watch(path, { persistent: false, recursive: true }, (eventType, filename) => {
    const wasIdle = state.lastEngineWriteAt === 0
    const previousAge = Date.now() - state.lastEngineWriteAt
    // Any change at all bumps the engine-write timestamp — this is the
    // signal that the helper IS doing work (which clears the watchdog).
    state.lastEngineWriteAt = Date.now()
    // TICKET-001: if a freshly-written engine file's name carries the
    // chrome meeting id we'd been holding a placeholder for, the real
    // entry is about to show up via `listMeetings` — drop the
    // placeholder so the list shows one row, not two.
    if (kind === 'live' && filename) maybeClearPlaceholderForFile(filename)
    queueMeetingsChange(kind, filename ?? null, eventType)

    // v0.14+: emit macOS notifications on capture lifecycle events so
    // the user gets out-of-app feedback. Heuristic:
    //   - FIRST write in a long quiet window (or ever) = capture STARTED
    //   - Settle-down (no writes for >3s) after activity = capture ENDED
    // We don't have explicit start/end events from the engine (its
    // JSONL stream is for mt-batch imports, not live), so we synthesize
    // these from the file-change pattern.
    if (kind === 'live') {
      const recentlyQuiet = previousAge > 8000
      if (wasIdle || recentlyQuiet) {
        scheduleCaptureStartedNotification(filename ?? undefined)
      }
      scheduleCaptureEndedNotification(filename ?? undefined)
    }
  })
  w.on('error', (err) => {
    console.warn(`[watchdog] watcher on ${path} errored`, err)
  })
  return w
}

// ─── Notifications ────────────────────────────────────────────────────
//
// macOS Notifications API via Electron's Notification class. We only
// fire one of each per logical capture session to avoid spamming the
// user, and we coalesce rapid filesystem-event bursts (engine writes
// audio.wav + transcript.json + metadata.json in quick succession when
// finalising a meeting).

let lastStartNotificationAt = 0
let endedNotificationTimer: NodeJS.Timeout | null = null

function scheduleCaptureStartedNotification(filename?: string): void {
  // Debounce — multiple file-change events when a new meeting folder
  // appears should produce ONE notification, not five.
  const now = Date.now()
  if (now - lastStartNotificationAt < 5000) return
  lastStartNotificationAt = now
  try {
    const n = new Notification({
      title: 'Mintr — capture started',
      body: filename
        ? `Recording ${prettyMeetingName(filename)}`
        : 'Recording your meeting…',
      silent: false
    })
    n.show()
  } catch (err) {
    console.warn('[watchdog] capture-started notification failed', err)
  }
}

function scheduleCaptureEndedNotification(filename?: string): void {
  // Notification fires only after writes settle (no new event for 3.5s).
  // The "ended" notification therefore lands ~3s after the user clicks
  // Leave on the Meet.
  if (endedNotificationTimer) clearTimeout(endedNotificationTimer)
  endedNotificationTimer = setTimeout(() => {
    endedNotificationTimer = null
    try {
      const n = new Notification({
        title: 'Mintr — meeting captured',
        body: filename
          ? `Saved ${prettyMeetingName(filename)}. Open Mintr to view the transcript.`
          : 'Meeting saved. Open Mintr to view the transcript.',
        silent: false
      })
      n.show()
      n.on('click', () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
            break
          }
        }
      })
    } catch (err) {
      console.warn('[watchdog] capture-ended notification failed', err)
    }
  }, 3500)
}

function prettyMeetingName(filename: string): string {
  // The engine writes `<timestamp>_<slug>.txt` style names. Strip the
  // extension and the leading timestamp so the notification reads
  // "<slug>" rather than "20260528_1913_meet-ntu-vwcf-onr.txt".
  const base = basename(filename).replace(/\.[^.]+$/, '')
  const m = /^\d{8}_\d{4}_(.+)$/.exec(base)
  return (m ? m[1] : base).replace(/-/g, ' ')
}

/**
 * Debounce per-folder file events into a single `meetings:changed` push.
 * The engine writes ~5 files when it finalises a meeting (audio.wav,
 * transcript.txt, transcript.json, speakers.json, metadata.json) — we
 * don't want to spam the renderer with 5 re-fetches.
 */
function queueMeetingsChange(
  kind: 'live' | 'imported',
  filename: string | null,
  _eventType: string
): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('meetings:changed', { kind, filename })
      }
    }
  }, DEBOUNCE_MS)
}

function checkWatchdog(): void {
  const chrome = getChromeMeetSnapshot()
  const now = Date.now()
  const currentId = chrome.tab?.meetingId ?? null

  if (currentId !== state.lastSeenMeetingId) {
    state.lastSeenMeetingId = currentId
    state.meetSeenAt = currentId ? now : null
    // Reset the alarm whenever the Meet identity changes — new meeting,
    // new chance for the engine to either succeed or fail.
    if (state.signal.helperPermissionLikely) {
      setSignal({ helperPermissionLikely: false })
    }
    // Meeting identity changed → any placeholder we were holding is for
    // a now-stale id. Drop it; if the new tab survives past the
    // detection threshold a fresh one will be created below on the next
    // tick.
    if (state.livePlaceholder) setLivePlaceholder(null)
    return
  }

  if (!currentId || !state.meetSeenAt) {
    if (state.signal.helperPermissionLikely) {
      setSignal({ helperPermissionLikely: false })
    }
    // No Meet visible → drop the placeholder. This satisfies the
    // "placeholder disappears within 5s when the user leaves the Meet"
    // acceptance criterion, since checkWatchdog ticks every 2s.
    if (state.livePlaceholder) setLivePlaceholder(null)
    return
  }

  const elapsed = now - state.meetSeenAt
  const writeAge = now - state.lastEngineWriteAt

  // TICKET-001: once the Meet has been visible for the detection
  // threshold and we haven't yet surfaced a placeholder for it,
  // create one. We don't gate on engine-quiet here — the placeholder
  // is purely a "UI saw the meeting" affordance; the existing
  // helper-permission watchdog below handles the "engine fell over"
  // case independently.
  if (
    elapsed > LIVE_PLACEHOLDER_DELAY_MS &&
    state.livePlaceholder === null
  ) {
    setLivePlaceholder({
      meetingId: currentId,
      startedAt: state.meetSeenAt,
      title: `Live · ${currentId}`
    })
  }

  // The watchdog fires when:
  //   1. A Chrome Meet has been visible for at least the threshold, AND
  //   2. The engine hasn't written anything since the Meet appeared.
  // The second clause is the important one — if the engine touched a
  // file (any file) under either watched folder AFTER the Meet was
  // detected, we trust it's doing work.
  if (
    elapsed > WATCHDOG_THRESHOLD_MS &&
    state.lastEngineWriteAt < state.meetSeenAt &&
    writeAge > WATCHDOG_THRESHOLD_MS
  ) {
    if (!state.signal.helperPermissionLikely) {
      const firedAt = now
      // Flip the signal immediately so the renderer can render its banner
      // without waiting for the log-grep classifier. The hint starts
      // undefined; we follow up with an updated signal once
      // classifyHelperFailure resolves (fire-and-forget, so the watchdog
      // tick doesn't stall on the unified-log shell-out).
      setSignal({
        helperPermissionLikely: true,
        meetingId: currentId,
        firedAt
      })
      void classifyHelperFailure()
        .then((hint) => {
          // Re-check before pushing — the user may have closed the Meet
          // (or a fresh meeting may have started) while we were waiting
          // on `log show`, in which case the alarm has already cleared.
          if (
            state.signal.helperPermissionLikely &&
            state.signal.firedAt === firedAt
          ) {
            setSignal({
              helperPermissionLikely: true,
              hint,
              meetingId: currentId,
              firedAt
            })
          }
        })
        .catch((err) => {
          console.warn('[watchdog] classifyHelperFailure threw', err)
        })
    }
  }
}

/**
 * If the fs.watch handler just saw a new file whose basename contains
 * the current placeholder's chrome meeting id, the engine has taken
 * over — drop the placeholder so the renderer's next `meetings:list`
 * shows the real entry instead of both.
 *
 * Matching rule (from the QA-001 investigation): the engine writes
 * `YYYYMMDD_HHmm_meet__<chromeId>_.txt` — the chrome id appears as a
 * substring (surrounded by `__` and `_`), so `filename.includes(id)`
 * is the right test. See the existing protocols file
 * `20260528_1938_meet__ifh-kkfh-dzg_.txt` for shape.
 */
function maybeClearPlaceholderForFile(filename: string): void {
  const ph = state.livePlaceholder
  if (!ph) return
  const base = basename(filename)
  if (base.includes(ph.meetingId)) {
    setLivePlaceholder(null)
  }
}

function setLivePlaceholder(next: LivePlaceholder | null): void {
  state.livePlaceholder = next
  pushPlaceholderChange()
}

/**
 * Broadcast a `meetings:changed` push so any open renderer window
 * re-runs `meetings.list()` and picks up the placeholder
 * create/clear. We intentionally reuse the existing channel rather
 * than adding a new one — `listMeetings` already merges the placeholder
 * into its response so the renderer's existing handler is enough.
 */
function pushPlaceholderChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('meetings:changed', {
        kind: 'live-placeholder',
        filename: null
      })
    }
  }
}

function setSignal(next: CaptureWatchdogSignal): void {
  state.signal = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture-watchdog:update', next)
    }
  }
}

/**
 * Best-effort classification of WHICH TCC service the engine helper is
 * missing. macOS `os_log` redacts the service name in the engine's own
 * `Permission health check failed: <private>` line, but un-redacted
 * attribution lives in two other places we CAN read without
 * elevated privileges:
 *
 *   Pass A — the helper's own process-level log entries (the redacted
 *     `<private>` from the engine's `os_log` still appears here, BUT
 *     the surrounding TCC subsystem messages emitted to the same
 *     process attribution often carry the un-redacted service name).
 *   Pass B — TCC's own subsystem log, filtered to messages mentioning
 *     the helper's bundle id (`ai.nawaz.mintr-engine`). This is the
 *     smoking gun the QA report identified: TCC writes
 *     `kTCCServiceAccessibility ... ai.nawaz.mintr-engine` un-redacted.
 *
 * Both passes are bounded to 2.5s each via `execFile`'s `timeout`
 * option, capping total wall-clock at ~3s (we await sequentially so
 * we can short-circuit on the first hit). On any error, empty output,
 * or no recognised substring, we return `'unknown'` and the renderer
 * falls back to the generic banner copy.
 *
 * NOTE: this is intentionally a heuristic. False negatives (returning
 * `'unknown'` when Accessibility IS the cause) are fine — the user
 * gets the existing generic banner. False positives (claiming
 * Accessibility when Microphone was actually missing) are the bigger
 * risk, mitigated by ordering the checks Accessibility → Microphone →
 * Screen Recording, since Accessibility is the one the engine actually
 * fails on per QA-002 and the unified TCC log consistently names it
 * as `kTCCServiceAccessibility`.
 */
async function classifyHelperFailure(): Promise<WatchdogPermissionHint> {
  const [passA, passB] = await Promise.all([
    runLogShow(['show', '--last', '15s', '--predicate', 'process == "MintrEngine"', '--info']),
    runLogShow([
      'show',
      '--last',
      '15s',
      '--predicate',
      `subsystem == "com.apple.TCC" AND eventMessage CONTAINS "${ENGINE_BUNDLE_ID}"`,
      '--info'
    ])
  ])
  const combined = passA + '\n' + passB
  if (!combined.trim()) return 'unknown'
  // Order matters: per QA-002, Accessibility is the actual root cause
  // and the TCC log line we want to catch is
  // `kTCCServiceAccessibility ... ai.nawaz.mintr-engine`.
  if (combined.includes('kTCCServiceAccessibility')) return 'accessibility'
  if (combined.includes('kTCCServiceMicrophone')) return 'microphone'
  if (combined.includes('kTCCServiceScreenCapture')) return 'screenRecording'
  return 'unknown'
}

/**
 * Runs `/usr/bin/log` with the supplied args, capped at
 * `LOG_SHOW_TIMEOUT_MS`. Always resolves (never rejects) — returns the
 * captured stdout or empty string on any error so the caller can
 * concatenate both passes' output safely.
 */
function runLogShow(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/log',
      args,
      { timeout: LOG_SHOW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // Timeout, non-zero exit, or spawn failure — all benign for
          // classification purposes. Treat as no signal.
          resolve('')
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}
