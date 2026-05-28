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
import { watch, type FSWatcher } from 'fs'
import { promises as fsp } from 'fs'
import { basename } from 'path'
import { getChromeMeetSnapshot } from './chromeProbe'
import { liveRecordingsRoot } from './meetings'
import { readSettings } from './settings'

const WATCHDOG_THRESHOLD_MS = 25_000 // 25s of "Meet detected, no file" → flag
const DEBOUNCE_MS = 1500

interface WatchdogSignal {
  helperPermissionLikely: boolean
  /** Meeting id we were watching when the watchdog fired (for context in UI). */
  meetingId?: string
  /** Wall-clock ms when the signal flipped. UI uses this to render time-since. */
  firedAt?: number
}

const state: {
  /** When did the current Chrome-detected meeting first appear? */
  meetSeenAt: number | null
  /** Last meeting id we observed so we can reset the timer on new meetings. */
  lastSeenMeetingId: string | null
  /** Last time we observed a new file under liveRecordingsRoot. */
  lastEngineWriteAt: number
  signal: WatchdogSignal
  watchers: FSWatcher[]
  debounceTimer: NodeJS.Timeout | null
  watchdogTimer: NodeJS.Timeout | null
} = {
  meetSeenAt: null,
  lastSeenMeetingId: null,
  lastEngineWriteAt: 0,
  signal: { helperPermissionLikely: false },
  watchers: [],
  debounceTimer: null,
  watchdogTimer: null
}

export function getWatchdogSignal(): WatchdogSignal {
  return state.signal
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
  const w = watch(path, { persistent: false, recursive: false }, (eventType, filename) => {
    const wasIdle = state.lastEngineWriteAt === 0
    const previousAge = Date.now() - state.lastEngineWriteAt
    // Any change at all bumps the engine-write timestamp — this is the
    // signal that the helper IS doing work (which clears the watchdog).
    state.lastEngineWriteAt = Date.now()
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
    return
  }

  if (!currentId || !state.meetSeenAt) {
    if (state.signal.helperPermissionLikely) {
      setSignal({ helperPermissionLikely: false })
    }
    return
  }

  const elapsed = now - state.meetSeenAt
  const writeAge = now - state.lastEngineWriteAt
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
      setSignal({
        helperPermissionLikely: true,
        meetingId: currentId,
        firedAt: now
      })
    }
  }
}

function setSignal(next: WatchdogSignal): void {
  state.signal = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture-watchdog:update', next)
    }
  }
}
