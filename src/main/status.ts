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
import { BrowserWindow, dialog } from 'electron'
import { spawnSync } from 'child_process'
import type {
  ActivityKind,
  AppAttention,
  AppStatus,
  CaptureWatchdogSignal,
  ChromeMeetSnapshot,
  GrantStatus,
  HelperPermissionSnapshot,
  ProcessingItem,
  ProcessingStage,
  RecordingState
} from '../shared/types'
import { getStatus, onStatusChange } from './recording'
import { getCaptureSignal, onCaptureSignalChange, type CaptureSignal } from './captureSignal'
import { enginePrefixFromRawAudioPath } from './captureSignalLogic'
import { getChromeMeetSnapshot, onChromeMeetChange } from './chromeProbe'
import { getWatchdogSignal, onWatchdogSignalChange, onMeetingsChanged } from './captureWatchdog'
import { resolveLiveRecorderApp } from './backend'
import { scanProcessingPrefixes, liveRecordingsRoot } from './meetings'

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
  procPoll: NodeJS.Timeout | null
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
  procPoll: null,
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

// ─── Processing lifecycle ─────────────────────────────────────────────────

/** How recently a `<prefix>*` file must have changed to read as "transcribing". */
const PROCESSING_ACTIVE_MS = 20_000
/** Floor for the stuck threshold — never flag a meeting as stuck before this. */
const STUCK_FLOOR_MS = 10 * 60_000
/** Engine binary paths to look for when deciding if the pipeline is still alive. */
const ENGINE_PROCESS_PATTERNS = [
  'MintrEngine.app/Contents/MacOS/MintrEngine',
  'MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber'
]

/**
 * Infer the pipeline stage without the (future) engine status file: segments
 * present ⇒ diarization done, summary being written; recent file activity ⇒
 * transcribing; otherwise unknown. PURE.
 */
export function inferProcessingStage(
  hasSegments: boolean,
  lastChangeMs: number,
  now: number
): ProcessingStage {
  if (hasSegments) return 'summarizing'
  if (now - lastChangeMs < PROCESSING_ACTIVE_MS) return 'transcribing'
  return 'unknown'
}

/**
 * Decide whether a processing meeting has stalled: nothing has changed for the
 * whole meeting length (min 10 min) AND the engine process is gone, so nothing
 * will ever finish it. Requiring the engine to be dead avoids false "stuck" on
 * a long, legitimately-slow best-quality run. PURE.
 */
export function isProcessingStuck(
  lastChangeMs: number,
  estDurationSec: number | undefined,
  now: number,
  engineAlive: boolean
): boolean {
  if (engineAlive) return false
  const thresholdMs = Math.max(STUCK_FLOOR_MS, (estDurationSec ?? 0) * 1000)
  return now - lastChangeMs > thresholdMs
}

/**
 * Is any engine binary currently running? (`pgrep -f` on both known paths.)
 *
 * Deliberately GLOBAL, not per-meeting: the app doesn't map engine PIDs to
 * meetings, so "some engine is alive" is the best available proxy for "this
 * meeting could still finish." It biases toward NOT flagging stuck (a live
 * engine could still complete the work) — acceptable because only one engine
 * runs at a time in practice, so "any alive" is effectively "the one that would
 * process this." The cost is a narrow false-negative: a genuinely stuck meeting
 * stays unflagged while an unrelated engine instance runs.
 */
export function isEngineProcessAlive(): boolean {
  for (const pattern of ENGINE_PROCESS_PATTERNS) {
    try {
      const res = spawnSync('/usr/bin/pgrep', ['-f', pattern], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      if (res.status === 0) return true
    } catch {
      // treat probe failure as "unknown" — fall through to the next pattern
    }
  }
  return false
}

/** Re-scan processing meetings, infer stage + stuck, and feed the machine. */
async function refreshProcessing(): Promise<void> {
  // Exclude the meeting being recorded right now (verified growing mic WAV) so
  // it isn't counted as "processing" while it's still capturing — recording
  // outranks processing, and it enters the scan honestly once capture stops.
  const capture = getCaptureSignal()
  const excludePrefix =
    capture.active && capture.wavPath ? enginePrefixFromRawAudioPath(capture.wavPath) : null
  let scan: Awaited<ReturnType<typeof scanProcessingPrefixes>>
  try {
    scan = await scanProcessingPrefixes(liveRecordingsRoot, excludePrefix)
  } catch (err) {
    console.warn('[status] scanProcessingPrefixes failed', err)
    scan = []
  }
  const now = Date.now()
  // Only shell out to pgrep when there's something to judge stuck.
  const engineAlive = scan.length > 0 ? isEngineProcessAlive() : true
  const items: ProcessingItem[] = scan.map((e) => {
    const item: ProcessingItem = {
      id: `engine:${e.prefix}`,
      title: e.title,
      startedAt: e.startedAt,
      stage: inferProcessingStage(e.hasSegments, e.lastChangeMs, now),
      stuck: isProcessingStuck(e.lastChangeMs, e.estDurationSec, now, engineAlive)
    }
    if (e.estDurationSec !== undefined) item.estDurationSec = e.estDurationSec
    return item
  })
  setProcessingEntries(items)
}

/**
 * Start the processing tracker: refresh on every meetings-folder change (catches
 * a meeting entering the pipeline) plus a 10 s poll while non-empty (ages stage
 * and stuck over time). Returns an unsubscribe for the folder hook.
 */
function startProcessingTracker(): () => void {
  const unsub = onMeetingsChanged(() => void refreshProcessing())
  void refreshProcessing()
  state.procPoll = setInterval(() => {
    if (state.processing.length > 0) void refreshProcessing()
  }, 10_000)
  return unsub
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
  state.unsubs.push(startProcessingTracker())
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
  if (state.procPoll) {
    clearInterval(state.procPoll)
    state.procPoll = null
  }
}

// ─── Recording-aware guards ───────────────────────────────────────────────

/**
 * Confirm a destructive action that would interrupt a live recording. Returns
 * true to proceed, false to abort. When nothing is verifiably recording it
 * returns true immediately (no dialog), so callers can wrap every stop/quit/
 * restart path unconditionally. Otherwise it shows a native, recording-aware
 * dialog whose default AND cancel are the SAFE choice ("Keep recording"), so an
 * accidental Return/Escape never ends a recording. Attached to the focused
 * window when there is one.
 */
export async function confirmIfRecording(action: 'stop' | 'quit' | 'restart'): Promise<boolean> {
  if (getAppStatus().kind !== 'recording') return true

  const copy = {
    stop: {
      title: 'Stop watching?',
      message: 'A meeting is being recorded right now.',
      detail:
        'Stopping ends the recording. Timbre saves everything captured so far and processes the transcript.',
      buttons: ['Keep recording', 'Stop and save']
    },
    quit: {
      title: 'Quit Timbre?',
      message: 'A meeting is being recorded right now.',
      detail:
        'Quitting stops the recording. Everything captured so far is saved and will be processed the next time Timbre starts.',
      buttons: ['Keep recording', 'Quit and save']
    },
    restart: {
      title: 'Restart the engine?',
      message: 'A meeting is being recorded right now.',
      detail: 'Restarting interrupts the recording. Do this only if capture is broken.',
      buttons: ['Cancel', 'Restart engine']
    }
  }[action]

  const focused = BrowserWindow.getFocusedWindow()
  const opts = {
    type: 'warning' as const,
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: copy.buttons,
    defaultId: 0,
    cancelId: 0
  }
  const { response } = focused
    ? await dialog.showMessageBox(focused, opts)
    : await dialog.showMessageBox(opts)
  return response === 1
}
