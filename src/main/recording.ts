import { basename } from 'path'
import type { BrowserWindow } from 'electron'
import type { RecordingState, RecordingStatus } from '../shared/types'
import {
  createMeetingFolder,
  isLiveActive,
  makeWebContentsForwarder,
  runBatch,
  startLiveRecorder,
  stopLiveRecorder,
  type BatchEvent
} from './backend'

interface State {
  state: RecordingState
  title?: string
  startedAt?: number
  progressPercent?: number
  lastError?: string
  lastOutputDir?: string
}

const internal: State = { state: 'idle' }

/**
 * Tiny event bus so the tray (which lives in the main process, not the
 * renderer) can react to state transitions without polling. Listeners
 * fire on the next tick after every getStatus()-visible change. We
 * intentionally don't import EventEmitter to keep the dep surface small —
 * a Set of callbacks is enough.
 */
type StatusListener = (status: RecordingStatus) => void
const listeners = new Set<StatusListener>()

export function onStatusChange(fn: StatusListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emitChange(): void {
  const snap = getStatus()
  for (const fn of listeners) {
    try {
      fn(snap)
    } catch (err) {
      console.error('[recording] status listener threw', err)
    }
  }
}

function getMainWindow(): BrowserWindow | null {
  // Lazy import to avoid pulling BrowserWindow into module init.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BrowserWindow: BW } = require('electron')
  const wins = BW.getAllWindows() as BrowserWindow[]
  return wins[0] ?? null
}

export function startWatching(): RecordingStatus {
  const result = startLiveRecorder()
  if (!result.ok) {
    internal.state = 'idle'
    internal.lastError = result.message
    return getStatus()
  }
  internal.state = 'watching'
  internal.startedAt = Date.now()
  internal.title = 'Live meeting watch'
  emitChange()
  return getStatus()
}

export function stopWatching(): RecordingStatus {
  stopLiveRecorder()
  internal.state = 'idle'
  internal.startedAt = undefined
  internal.title = undefined
  internal.progressPercent = undefined
  emitChange()
  return getStatus()
}

export function getStatus(): RecordingStatus {
  const status: RecordingStatus = { state: internal.state }
  if (internal.title) status.title = internal.title
  if (internal.startedAt && (internal.state === 'watching' || internal.state === 'recording')) {
    status.elapsedSeconds = Math.floor((Date.now() - internal.startedAt) / 1000)
  }
  if (internal.state === 'transcribing' && typeof internal.progressPercent === 'number') {
    status.progressPercent = internal.progressPercent
  }
  // If the bundled live recorder process has exited and we believed we were watching,
  // reflect that back to the UI on the next poll.
  if (internal.state === 'watching' && !isLiveActive()) {
    // Live recorder typically lives independently of the `open` subprocess; we
    // only flip back to idle when the user clicks Stop. So no auto-reset here.
  }
  return status
}

export interface BatchInvocationResult {
  jobId: string
  outputDir: string
}

/**
 * Run a single file through the batch transcription pipeline. Updates
 * `internal.state` so the polled status reflects transcription progress, and
 * forwards each event to the renderer over `backend:event`.
 */
export async function importFile(
  filePath: string,
  outputRoot: string,
  jobId: string,
  numSpeakers?: number
): Promise<BatchInvocationResult> {
  const sourceName = basename(filePath)
  const folder = await createMeetingFolder(outputRoot, sourceName)

  internal.state = 'transcribing'
  internal.title = sourceName
  internal.startedAt = Date.now()
  internal.progressPercent = 0
  internal.lastError = undefined

  const win = getMainWindow()
  const forward = win
    ? makeWebContentsForwarder(win.webContents, jobId)
    : (_ev: BatchEvent): void => {}

  try {
    await runBatch({
      jobId,
      inputFile: filePath,
      outputDir: folder,
      numSpeakers,
      onEvent: (ev) => {
        if (ev.event === 'transcribing') {
          internal.progressPercent = Math.round(ev.progress * 100)
        }
        forward(ev)
      }
    })
    internal.lastOutputDir = folder
    return { jobId, outputDir: folder }
  } finally {
    internal.state = 'idle'
    internal.title = undefined
    internal.startedAt = undefined
    internal.progressPercent = undefined
  }
}

/**
 * Re-analyse an existing meeting in place. Mirrors `importFile`'s state
 * transitions so the UI shows transcribing-progress while it runs.
 */
export async function reanalyzeMeetingProc(opts: {
  outputFolder: string
  meetingId: string
  jobId: string
  numSpeakers?: number
}): Promise<BatchInvocationResult> {
  const { reanalyzeMeeting } = await import('./meetings')
  internal.state = 'transcribing'
  internal.title = `Re-analysing ${opts.meetingId}`
  internal.startedAt = Date.now()
  internal.progressPercent = 0
  internal.lastError = undefined

  const win = getMainWindow()
  const forward = win
    ? makeWebContentsForwarder(win.webContents, opts.jobId)
    : (_ev: BatchEvent): void => {}

  try {
    const outputDir = await reanalyzeMeeting({
      outputFolder: opts.outputFolder,
      meetingId: opts.meetingId,
      jobId: opts.jobId,
      numSpeakers: opts.numSpeakers,
      onEvent: (ev) => {
        if (ev.event === 'transcribing') {
          internal.progressPercent = Math.round(ev.progress * 100)
        }
        forward(ev)
      }
    })
    return { jobId: opts.jobId, outputDir }
  } finally {
    internal.state = 'idle'
    internal.title = undefined
    internal.startedAt = undefined
    internal.progressPercent = undefined
  }
}
