/**
 * Capture heartbeat — the ONE truthful "audio is being written right now" signal.
 *
 * The engine has no direct IPC to Electron; the only live engine→Electron
 * channel is the filesystem. The engine writes the mic track
 * (`recordings/<prefix>_mic.wav`) continuously while a meeting records, so a
 * growing mic WAV is direct proof that capture is happening — far more honest
 * than "a Meet tab exists" (which the old UI inferred recording from, and which
 * lied whenever the engine silently failed on a missing permission). App audio
 * streams to a temp file and `<prefix>_app.wav` / `<prefix>_mix.wav` appear only
 * at finalization, so the mic WAV is the ONLY continuously-growing live signal —
 * the tracker follows it alone (see `captureSignalLogic.ts`).
 *
 * This module polls the newest live mic WAV every 2 s and derives a
 * `CaptureSignal`: `active` turns true when the file grows and stays true across
 * brief write stalls — it only flips to false after ~3 consecutive non-growing
 * ticks (the 6 s freshness window), so a one-tick zero-byte window (a mic
 * device-change restart, disk pressure, thermal throttle) never fakes a "stopped
 * → started" flap mid-meeting. Elapsed comes from the file birthtime; estimated
 * duration from bytes ÷ the WAV header's byteRate (read from the file, never
 * hardcoded). The growth / hysteresis / tracking rules live in the dep-free
 * `captureSignalLogic.ts` so they can be unit-tested without the main process.
 *
 * The detector sits behind a `CaptureSignalSource` interface so the engine crew
 * can later drop in a real status-file reader (`ipc/engine_status.json`, "ENG-1")
 * without touching any consumer: `EngineStatusFileSource` is tried first and the
 * WAV-growth detector is the always-available fallback.
 *
 * Consumers subscribe via `onCaptureSignalChange`; the app-status machine
 * (`status.ts`) is the primary one. On active transitions we also fire the
 * capture-lifecycle notifications (started / saved), replacing the interim
 * write-burst heuristic that used to live in `captureWatchdog.makeWatcher`.
 */
import { promises as fsp } from 'fs'
import { join } from 'path'
import { liveRecordingsRoot } from './meetings'
import {
  scheduleCaptureStartedNotification,
  scheduleCaptureEndedNotification
} from './captureWatchdog'
import { ENGINE_IPC_DIR } from './chromeProbe'
import {
  parseWavByteRate,
  estDurationSecFromSize,
  nextWavTrackState,
  INITIAL_WAV_TRACK,
  LIVE_WAV_RE,
  type WavObservation,
  type WavTrackState
} from './captureSignalLogic'

/**
 * The truthful capture signal every surface reads through `status.ts`.
 * `active` is the only field that gates a "Recording" indicator; the rest are
 * context (elapsed via `startedAt`, honest estimate via `estDurationSec`).
 */
export interface CaptureSignal {
  /** True iff audio is verifiably being written to disk right now. */
  active: boolean
  /** Epoch ms the current recording began (WAV birthtime), or null. */
  startedAt: number | null
  /** Absolute path of the WAV we're tracking, or null when none. */
  wavPath: string | null
  /** Size of the tracked WAV in bytes (0 when none). */
  bytesWritten: number
  /** Estimated recorded seconds from bytes ÷ header byteRate, or null when unknown. */
  estDurationSec: number | null
}

/**
 * A source of truth for the capture signal. The default is WAV-growth polling;
 * ENG-1 (an engine-written status file) can be added as a higher-priority
 * source without any consumer change — `poll()` returns null to defer to the
 * next source in the chain.
 */
export interface CaptureSignalSource {
  /** Resolve the current signal, or null to let a lower-priority source decide. */
  poll(now: number): Promise<CaptureSignal | null>
}

const INACTIVE: CaptureSignal = {
  active: false,
  startedAt: null,
  wavPath: null,
  bytesWritten: 0,
  estDurationSec: null
}

/** Poll cadence. */
const POLL_INTERVAL_MS = 2000
/** Max age of an ENG-1 status file before we ignore it and fall back to WAV growth. */
const ENGINE_STATUS_MAX_AGE_MS = 5000
const ENGINE_STATUS_FILE = join(ENGINE_IPC_DIR, 'engine_status.json')

/**
 * ENG-1 upgrade path: prefer an engine-written status file when it's fresh.
 * The engine crew ships `ipc/engine_status.json` (state/meetingId/startedAt/
 * stage/pct) as a future capability; until then the file is absent and this
 * source returns null every tick, deferring to WAV growth. Coded defensively —
 * any parse/shape/age problem returns null. This seam is untested until ENG-1
 * lands (no engine writer on this base).
 */
class EngineStatusFileSource implements CaptureSignalSource {
  async poll(now: number): Promise<CaptureSignal | null> {
    let raw: string
    try {
      raw = await fsp.readFile(ENGINE_STATUS_FILE, 'utf-8')
    } catch {
      return null
    }
    try {
      const obj = JSON.parse(raw) as {
        state?: string
        startedAt?: number
        updatedAt?: number
        estDurationSec?: number
      }
      if (typeof obj.updatedAt !== 'number' || now - obj.updatedAt > ENGINE_STATUS_MAX_AGE_MS) {
        return null
      }
      const active = obj.state === 'recording'
      return {
        active,
        startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : null,
        wavPath: null,
        bytesWritten: 0,
        estDurationSec: typeof obj.estDurationSec === 'number' ? obj.estDurationSec : null
      }
    } catch {
      return null
    }
  }
}

/**
 * Default source: track the newest LIVE mic WAV under `recordings/`. App audio
 * streams to a temp file and `_app.wav`/`_mix.wav` land only at finalization, so
 * the mic WAV is the sole continuously-growing file — matching just it keeps
 * those fresh-mtime finalization artifacts from yanking the tracker mid-meeting.
 * The growth + hysteresis decision (stalls don't flip `active`; a path switch
 * seeds from the file's current size, never read as growth) is pure and lives in
 * `captureSignalLogic.nextWavTrackState`.
 */
class WavGrowthSource implements CaptureSignalSource {
  private track: WavTrackState = { ...INITIAL_WAV_TRACK }
  private byteRate: number | null = null
  private startedAtMs: number | null = null

  async poll(now: number): Promise<CaptureSignal | null> {
    const recordingsDir = join(liveRecordingsRoot, 'recordings')
    let entries: string[]
    try {
      entries = await fsp.readdir(recordingsDir)
    } catch {
      // Folder absent (no recording yet) or a transient read error. Do NOT
      // hard-reset — that would blip a spurious saved/started around a glitch.
      // Hold the current signal; hysteresis resumes on the next good poll.
      return this.buildSignal()
    }

    // Newest live mic WAV wins (deterministic tiebreak on equal mtime so
    // readdir order can never flap the selection between ties).
    let obs: WavObservation = { path: null, size: 0, mtimeMs: -1 }
    let birthtimeMs: number | null = null
    for (const e of entries) {
      if (!LIVE_WAV_RE.test(e)) continue
      const full = join(recordingsDir, e)
      try {
        const st = await fsp.stat(full)
        if (st.mtimeMs > obs.mtimeMs || (st.mtimeMs === obs.mtimeMs && full > (obs.path ?? ''))) {
          obs = { path: full, size: st.size, mtimeMs: st.mtimeMs }
          birthtimeMs = st.birthtimeMs || st.mtimeMs
        }
      } catch {
        // File vanished mid-poll — skip it.
        continue
      }
    }

    // On a path change, (re)read the header byteRate and latch the start time.
    // Both stay stable for the whole meeting since we no longer switch to the
    // finalization files.
    if (obs.path !== this.track.path) {
      this.byteRate = obs.path ? await this.readByteRate(obs.path) : null
      this.startedAtMs = obs.path ? birthtimeMs : null
    }

    this.track = nextWavTrackState(this.track, obs, now)
    return this.buildSignal()
  }

  /** Build the outward signal from the current (already-decided) track state. */
  private buildSignal(): CaptureSignal {
    if (!this.track.path) return INACTIVE
    return {
      active: this.track.active,
      startedAt: this.startedAtMs,
      wavPath: this.track.path,
      bytesWritten: this.track.size,
      estDurationSec: estDurationSecFromSize(this.track.size, this.byteRate)
    }
  }

  private async readByteRate(path: string): Promise<number | null> {
    try {
      const fh = await fsp.open(path, 'r')
      try {
        const buf = Buffer.alloc(44)
        await fh.read(buf, 0, 44, 0)
        return parseWavByteRate(buf)
      } finally {
        await fh.close()
      }
    } catch {
      return null
    }
  }
}

// ─── Module state + public API ──────────────────────────────────────────

type SignalListener = (signal: CaptureSignal) => void

const state: {
  sources: CaptureSignalSource[]
  signal: CaptureSignal
  timer: NodeJS.Timeout | null
  busy: boolean
  listeners: Set<SignalListener>
} = {
  sources: [new EngineStatusFileSource(), new WavGrowthSource()],
  signal: INACTIVE,
  timer: null,
  busy: false,
  listeners: new Set()
}

/** Current capture signal (synchronous read for `status.ts` and pulls). */
export function getCaptureSignal(): CaptureSignal {
  return state.signal
}

/** Subscribe to capture-signal changes. Returns an unsubscribe function. */
export function onCaptureSignalChange(fn: SignalListener): () => void {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

/**
 * Begin polling. Runs for the whole app lifetime (not just while watching) so a
 * manually-launched engine still produces truthful "Recording" UI. Idempotent.
 */
export function startCaptureSignal(): void {
  if (state.timer) return
  void tick()
  state.timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
}

export function stopCaptureSignal(): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

async function tick(): Promise<void> {
  if (state.busy) return
  state.busy = true
  try {
    const now = Date.now()
    let next: CaptureSignal | null = null
    for (const source of state.sources) {
      next = await source.poll(now)
      if (next) break
    }
    applySignal(next ?? INACTIVE)
  } catch (err) {
    console.warn('[captureSignal] tick failed', err)
  } finally {
    state.busy = false
  }
}

/**
 * Commit a new signal. Fires the capture-lifecycle notifications on active
 * transitions (start → "Recording started", stop → "Recording saved") and
 * notifies subscribers whenever a field they care about changed. Elapsed math
 * is left to consumers (they read `startedAt`), so we deliberately do NOT
 * re-notify just because a size grew by a few bytes — only on meaningful
 * changes (active flip or a different WAV / start time).
 */
function applySignal(next: CaptureSignal): void {
  const prev = state.signal
  const activeChanged = prev.active !== next.active
  const structuralChange =
    activeChanged || prev.wavPath !== next.wavPath || prev.startedAt !== next.startedAt
  state.signal = next

  if (activeChanged && next.active) {
    scheduleCaptureStartedNotification(next.wavPath ?? undefined)
  } else if (activeChanged && !next.active) {
    scheduleCaptureEndedNotification()
  }

  if (structuralChange) {
    for (const fn of state.listeners) {
      try {
        fn(next)
      } catch (err) {
        console.error('[captureSignal] listener threw', err)
      }
    }
  }
}
