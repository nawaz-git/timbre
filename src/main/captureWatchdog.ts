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
import { BrowserWindow } from 'electron'
import { watch, type FSWatcher } from 'fs'
import { promises as fsp } from 'fs'
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
    // Any change at all bumps the engine-write timestamp — this is the
    // signal that the helper IS doing work (which clears the watchdog).
    state.lastEngineWriteAt = Date.now()
    queueMeetingsChange(kind, filename ?? null, eventType)
  })
  w.on('error', (err) => {
    console.warn(`[watchdog] watcher on ${path} errored`, err)
  })
  return w
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
