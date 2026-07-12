/**
 * Capture heartbeat — the ONE truthful "audio is being written right now" signal.
 *
 * The engine has no direct IPC to Electron; the only live engine→Electron
 * channel is the filesystem. The engine appends to
 * `recordings/<prefix>_mix.wav` continuously while a meeting records, so a
 * growing WAV is direct proof that capture is happening — far more honest than
 * "a Meet tab exists" (which the old UI inferred recording from, and which lied
 * whenever the engine silently failed on a missing permission).
 *
 * This module polls the newest raw-recording WAV every 2 s and derives a
 * `CaptureSignal`: `active` is true only when the file's mtime advanced AND its
 * size grew since the previous tick. Elapsed comes from the file birthtime;
 * estimated duration from bytes ÷ the WAV header's byteRate (read from the file,
 * never hardcoded).
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

/** Raw-recording WAV suffixes the engine writes the instant a meeting starts. */
const RAW_WAV_RE = /_mix\.wav$|_app\.wav$|_mic\.wav$/
/** How recently the WAV must have been touched to count as "still writing". */
const FRESH_WINDOW_MS = 6000
/** Poll cadence. */
const POLL_INTERVAL_MS = 2000
/** WAV canonical header size (PCM, no extra chunks) — used for duration math. */
const WAV_HEADER_BYTES = 44
/** Max age of an ENG-1 status file before we ignore it and fall back to WAV growth. */
const ENGINE_STATUS_MAX_AGE_MS = 5000
const ENGINE_STATUS_FILE = join(ENGINE_IPC_DIR, 'engine_status.json')

/**
 * Read the little-endian uint32 byteRate from a WAV header (offset 28). Returns
 * null when the buffer is too short or doesn't look like a RIFF/WAVE header, so
 * the caller reports `estDurationSec: null` ("we don't know") rather than
 * guessing a sample rate.
 */
export function parseWavByteRate(header: Buffer): number | null {
  if (header.length < 32) return null
  if (header.toString('ascii', 0, 4) !== 'RIFF') return null
  if (header.toString('ascii', 8, 12) !== 'WAVE') return null
  const byteRate = header.readUInt32LE(28)
  return byteRate > 0 ? byteRate : null
}

/**
 * Pure decision: is a tracked WAV actively growing? Encapsulated so the growth
 * rule (fresh mtime AND size increased since the last tick) is unit-testable
 * without touching the filesystem.
 */
export function isWavActivelyGrowing(
  prevSize: number,
  currSize: number,
  mtimeMs: number,
  now: number
): boolean {
  return now - mtimeMs < FRESH_WINDOW_MS && currSize > prevSize
}

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

/** Default source: poll the newest raw-recording WAV under `recordings/`. */
class WavGrowthSource implements CaptureSignalSource {
  private trackedPath: string | null = null
  private prevSize = 0
  private byteRate: number | null = null

  async poll(now: number): Promise<CaptureSignal | null> {
    const recordingsDir = join(liveRecordingsRoot, 'recordings')
    let entries: string[]
    try {
      entries = await fsp.readdir(recordingsDir)
    } catch {
      // Folder not there yet (no recording ever made) — inactive, reset.
      this.reset()
      return INACTIVE
    }

    // Newest raw WAV wins (handles multiple prefixes on the same day).
    let newestPath: string | null = null
    let newestMtime = -1
    let newestSize = 0
    for (const e of entries) {
      if (!RAW_WAV_RE.test(e)) continue
      const full = join(recordingsDir, e)
      try {
        const st = await fsp.stat(full)
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newestPath = full
          newestSize = st.size
        }
      } catch {
        // File vanished mid-poll — skip it.
        continue
      }
    }

    if (!newestPath) {
      this.reset()
      return INACTIVE
    }

    // New file since last tick → reset growth baseline + reread the byteRate.
    if (newestPath !== this.trackedPath) {
      this.trackedPath = newestPath
      this.prevSize = 0
      this.byteRate = await this.readByteRate(newestPath)
    }

    let birthtimeMs: number | null = null
    try {
      const st = await fsp.stat(newestPath)
      birthtimeMs = st.birthtimeMs || st.mtimeMs
    } catch {
      // Deleted between the scan and here — treat as inactive this tick.
      this.reset()
      return INACTIVE
    }

    const active = isWavActivelyGrowing(this.prevSize, newestSize, newestMtime, now)
    this.prevSize = newestSize

    const estDurationSec =
      this.byteRate && newestSize > WAV_HEADER_BYTES
        ? (newestSize - WAV_HEADER_BYTES) / this.byteRate
        : null

    return {
      active,
      startedAt: birthtimeMs,
      wavPath: newestPath,
      bytesWritten: newestSize,
      estDurationSec
    }
  }

  private reset(): void {
    this.trackedPath = null
    this.prevSize = 0
    this.byteRate = null
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
