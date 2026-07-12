/**
 * AppStatus — the single source of truth for what Timbre is doing.
 *
 * Design principle #1: "the status never lies." One state machine in the main
 * process owns the app's status and every surface (tray glyph + menu, Home
 * hero, meeting rows, notifications, dock) renders THIS object instead of
 * re-deriving its own. "Recording" is shown only when audio is verifiably being
 * written to disk (the capture heartbeat), never because a Chrome tab exists.
 *
 * Inputs (all pushed, no polling of the renderer):
 *   - recording.ts   — watching / paused, and the mt-batch "transcribing" state
 *   - captureSignal  — the truthful "audio is being written" heartbeat
 *   - chromeProbe    — is a Google Meet tab open?
 *   - captureWatchdog— did a detected Meet fail to produce any capture?
 *   - processing set — engine meetings whose pipeline is still running (T-owned
 *                      by the processing-lifecycle work via `setProcessingEntries`)
 *   - engine perms   — the bundled engine's TCC verdict (Screen Recording)
 *   - engine present — whether the bundled engine app resolves at all
 *
 * The ladder (strict priority, first match wins):
 *   attention → recording → processing → meet-detected → watching → paused
 *
 * `recompute()` runs on every input's change hook plus a 1 s tick while
 * recording or processing (so time-based transitions — elapsed, stuck — are
 * caught). Structural changes are broadcast over `app-status:update`; elapsed
 * is recomputed live on every read so pulls are always current without a
 * per-second broadcast.
 */
import { BrowserWindow } from 'electron'
import type {
  ActivityKind,
  AppAttention,
  AppStatus,
  CaptureWatchdogSignal,
  ChromeMeetSnapshot,
  GrantStatus,
  HelperPermissionSnapshot,
  ProcessingItem,
  RecordingState
} from '../shared/types'
import { getStatus, onStatusChange } from './recording'
import { getCaptureSignal, onCaptureSignalChange, type CaptureSignal } from './captureSignal'
import { getChromeMeetSnapshot, onChromeMeetChange } from './chromeProbe'
import { getWatchdogSignal, onWatchdogSignalChange } from './captureWatchdog'
import { resolveLiveRecorderApp } from './backend'

/** All inputs the pure resolver needs — passed in so it's unit-testable. */
export interface AppStatusInputs {
  recordingState: RecordingState
  capture: CaptureSignal
  chrome: ChromeMeetSnapshot
  watchdog: CaptureWatchdogSignal
  /** Engine meetings currently in the pipeline (empty until the processing tracker feeds them). */
  processing: ProcessingItem[]
  enginePerms: HelperPermissionSnapshot
  /** True when the bundled engine app can't be resolved (nothing can record). */
  engineMissing: boolean
  now: number
}

/** Only an explicit denial/undetermined counts as "missing" — 'unknown' (pre-probe) does not. */
function permMissing(s: GrantStatus): boolean {
  return s === 'denied' || s === 'not-determined'
}

/**
 * Resolve the ladder from a full set of inputs. PURE — no clock, no I/O — so
 * the priority table can be exercised with faked inputs.
 *
 * Two things are computed:
 *   - `activityKind`: what's actually happening (recording > processing >
 *     meet-detected > watching > paused). Recording requires the heartbeat.
 *   - `attention`: the single highest-priority problem, if any. Capture-broken
 *     problems (permission / engine-missing / capture-failed) only fire while
 *     we're trying to capture (watching, not idle) and NOT already verifiably
 *     recording — because a growing WAV is proof capture works. Processing-stuck
 *     is independent of live capture.
 *
 * `kind` is `attention` when an attention exists, otherwise `activityKind`.
 */
export function resolveAppStatus(inputs: AppStatusInputs): AppStatus {
  const { recordingState, capture, chrome, watchdog, processing, enginePerms, engineMissing } =
    inputs

  const meetTab = chrome.tab ? { meetingId: chrome.tab.meetingId, url: chrome.tab.url } : null
  const engineProcessing = processing.length > 0
  const isProcessing = engineProcessing || recordingState === 'transcribing'

  // ── activity kind (ladder minus attention) ──
  let activityKind: ActivityKind
  if (capture.active) activityKind = 'recording'
  else if (isProcessing) activityKind = 'processing'
  else if (meetTab) activityKind = 'meet-detected'
  else if (recordingState === 'watching' || recordingState === 'recording')
    activityKind = 'watching'
  else activityKind = 'paused'

  // ── attention (sub-priority) ──
  const watchingOn = recordingState !== 'idle'
  const capturing = capture.active
  const stuck = processing.find((p) => p.stuck)
  let attention: AppAttention | undefined
  if (!capturing && watchingOn && permMissing(enginePerms.screenRecording)) {
    attention = {
      code: 'permission',
      message: 'Screen Recording permission is needed to detect and record your meetings.'
    }
  } else if (!capturing && watchingOn && engineMissing) {
    attention = {
      code: 'engine-missing',
      message: "The recording engine isn't available, so meetings can't be captured."
    }
  } else if (!capturing && watchdog.helperPermissionLikely) {
    attention = {
      code: 'capture-failed',
      message: "A meeting is open but Timbre isn't capturing it.",
      ...(watchdog.meetingId ? { meetingId: watchdog.meetingId } : {})
    }
  } else if (stuck) {
    attention = {
      code: 'processing-stuck',
      message: `Processing didn't finish for "${stuck.title}".`,
      meetingId: stuck.id
    }
  }

  const status: AppStatus = {
    kind: attention ? 'attention' : activityKind,
    activityKind,
    meetTab
  }

  if (capture.active) {
    if (capture.startedAt) status.recordingStartedAt = capture.startedAt
    if (chrome.tab) status.recordingMeetingId = chrome.tab.meetingId
  }

  if (isProcessing) {
    status.processing = processing
    status.processingCount = engineProcessing ? processing.length : 1
  }

  if (attention) status.attention = attention

  return status
}

// ─── Stateful layer ──────────────────────────────────────────────────────

type StatusListener = (status: AppStatus) => void

const state: {
  /** Structural snapshot (elapsed is added live on read). */
  current: AppStatus
  listeners: Set<StatusListener>
  processing: ProcessingItem[]
  enginePerms: HelperPermissionSnapshot
  engineMissing: boolean
  tick: NodeJS.Timeout | null
  permPoll: NodeJS.Timeout | null
  unsubs: Array<() => void>
  lastSignature: string
} = {
  current: { kind: 'paused', activityKind: 'paused', meetTab: null },
  listeners: new Set(),
  processing: [],
  enginePerms: {
    screenRecording: 'unknown',
    microphone: 'unknown',
    accessibility: 'unknown',
    watchLoopRunning: false
  },
  engineMissing: false,
  tick: null,
  permPoll: null,
  unsubs: [],
  lastSignature: ''
}

/** Add the live elapsed value to a structural snapshot at read time. */
function withLiveElapsed(status: AppStatus, now: number): AppStatus {
  if (status.recordingStartedAt) {
    return {
      ...status,
      recordingElapsedSec: Math.max(0, Math.floor((now - status.recordingStartedAt) / 1000))
    }
  }
  return status
}

/** The current app status, with elapsed recomputed live. */
export function getAppStatus(): AppStatus {
  return withLiveElapsed(state.current, Date.now())
}

/** Subscribe to app-status changes (structural — not every elapsed second). */
export function onAppStatusChange(fn: StatusListener): () => void {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

/**
 * Feed the engine-processing set. Owned by the processing-lifecycle tracker;
 * empty until it starts. Triggers a recompute so attention/kind reflect it.
 */
export function setProcessingEntries(entries: ProcessingItem[]): void {
  state.processing = entries
  recompute()
}

/**
 * A compact structural signature so we broadcast only on meaningful changes
 * (kind / attention / meet / recording start / processing shape), never merely
 * because elapsed advanced.
 */
function signatureOf(s: AppStatus): string {
  const proc = (s.processing ?? [])
    .map((p) => `${p.id}:${p.stage}:${p.percent ?? ''}:${p.stuck ? 1 : 0}`)
    .join(',')
  return [
    s.kind,
    s.activityKind,
    s.recordingStartedAt ?? '',
    s.recordingMeetingId ?? '',
    s.meetTab?.meetingId ?? '',
    s.attention?.code ?? '',
    s.attention?.message ?? '',
    s.attention?.meetingId ?? '',
    s.processingCount ?? '',
    proc
  ].join('|')
}

/** Recompute from live inputs; broadcast + notify only on a structural change. */
export function recompute(): void {
  const now = Date.now()
  const next = resolveAppStatus({
    recordingState: getStatus().state,
    capture: getCaptureSignal(),
    chrome: getChromeMeetSnapshot(),
    watchdog: getWatchdogSignal(),
    processing: state.processing,
    enginePerms: state.enginePerms,
    engineMissing: state.engineMissing,
    now
  })
  const sig = signatureOf(next)
  const changed = sig !== state.lastSignature
  state.current = next
  state.lastSignature = sig

  // Keep the 1 s tick alive only while there's a moving/aging value to watch.
  manageTick(next)

  if (changed) {
    const withElapsed = withLiveElapsed(next, now)
    broadcast(withElapsed)
    for (const fn of state.listeners) {
      try {
        fn(withElapsed)
      } catch (err) {
        console.error('[status] listener threw', err)
      }
    }
  }
}

function manageTick(status: AppStatus): void {
  const needsTick = status.activityKind === 'recording' || status.activityKind === 'processing'
  if (needsTick && !state.tick) {
    state.tick = setInterval(() => recompute(), 1000)
  } else if (!needsTick && state.tick) {
    clearInterval(state.tick)
    state.tick = null
  }
}

function broadcast(status: AppStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app-status:update', status)
    }
  }
}

/**
 * Refresh the engine's TCC verdict + whether the engine app resolves. Uses a
 * dynamic import for `probeHelperPermissions` so `status.ts` has no static
 * dependency on `onboarding.ts` (which imports `confirmIfRecording` from here).
 */
async function refreshEngineFacts(): Promise<void> {
  state.engineMissing = resolveLiveRecorderApp() === null
  try {
    const { probeHelperPermissions } = await import('./onboarding')
    state.enginePerms = await probeHelperPermissions()
  } catch {
    // Keep the last-known verdict on any probe error.
  }
  recompute()
}

/**
 * Start the machine: subscribe to every input's change hook, poll the engine
 * verdict every 10 s (TCC has no push), and compute an initial status.
 * Idempotent.
 */
export function startAppStatus(): void {
  if (state.unsubs.length > 0) return
  state.unsubs.push(onStatusChange(() => recompute()))
  state.unsubs.push(onCaptureSignalChange(() => recompute()))
  state.unsubs.push(onChromeMeetChange(() => recompute()))
  state.unsubs.push(onWatchdogSignalChange(() => recompute()))
  void refreshEngineFacts()
  state.permPoll = setInterval(() => void refreshEngineFacts(), 10_000)
  recompute()
}

export function stopAppStatus(): void {
  for (const unsub of state.unsubs) unsub()
  state.unsubs = []
  if (state.tick) {
    clearInterval(state.tick)
    state.tick = null
  }
  if (state.permPoll) {
    clearInterval(state.permPoll)
    state.permPoll = null
  }
}
