/**
 * Pure decision logic for the capture heartbeat — NO electron, NO fs — so the
 * growth / hysteresis / tracking rules are unit-testable in isolation (the
 * vitest harness imports THIS module without dragging in the main process).
 *
 * Why the mic WAV is the one true live signal: the engine writes the mic track
 * (`<prefix>_mic.wav`) continuously while a meeting records, but app audio
 * streams to a temp file and `<prefix>_app.wav` / `<prefix>_mix.wav` are written
 * only once, at finalization. So the mic WAV is the sole file that grows during
 * a recording; the tracker follows it alone. Tracking the newest-mtime raw WAV
 * (the old behaviour) meant the finalization files' fresh mtimes yanked the
 * tracker the instant a meeting ended, blipping the signal for a single meeting.
 */

/** How recently the tracked WAV must have been touched to count as "still writing". */
export const FRESH_WINDOW_MS = 6000

/** WAV canonical header size (PCM, no extra chunks) — used for duration math. */
export const WAV_HEADER_BYTES = 44

/**
 * Consecutive non-growing poll ticks required before capture is declared
 * stopped. At the 2 s poll cadence, 3 ticks ≈ the 6 s freshness window: a real
 * write stall (mic device-change restart, disk pressure, thermal throttling)
 * produces a single zero-byte window and must NOT end the recording — only a
 * sustained ~6 s pause does. A single equal-size tick therefore never flips
 * `active` to false.
 */
export const STALE_TICKS_TO_INACTIVE = 3

/** The one WAV suffix the engine grows LIVE while recording (the mic track). */
export const LIVE_WAV_RE = /_mic\.wav$/

/** Raw dual-source audio suffixes the engine emits (mic live; app/mix at finalization). */
const RAW_AUDIO_SUFFIXES = ['_mix.wav', '_app.wav', '_mic.wav'] as const

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
 * Pure per-tick growth check: the tracked WAV counts as actively growing only
 * when its size increased since the previous tick AND its mtime is within the
 * freshness window. Feeds the hysteresis in `nextWavTrackState`.
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
 * The engine prefix for a raw-audio path (`…/<prefix>_mic.wav` → `<prefix>`), or
 * null when the path isn't a raw-audio file. Used to exclude the live recording
 * from the processing scan — a growing `_mic.wav` with no transcript yet is the
 * meeting being RECORDED, not one being PROCESSED.
 */
export function enginePrefixFromRawAudioPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? ''
  const suffix = RAW_AUDIO_SUFFIXES.find((s) => base.endsWith(s))
  return suffix ? base.slice(0, -suffix.length) : null
}

/** Estimated recorded seconds from a tracked WAV's size + header byteRate, or null. */
export function estDurationSecFromSize(size: number, byteRate: number | null): number | null {
  return byteRate && size > WAV_HEADER_BYTES ? (size - WAV_HEADER_BYTES) / byteRate : null
}

/** Rolling state for the live-WAV growth tracker (one meeting records at a time). */
export interface WavTrackState {
  /** Absolute path of the live mic WAV we're tracking, or null when none. */
  path: string | null
  /** Last observed size of `path` in bytes. */
  size: number
  /** Consecutive ticks `path` has NOT grown (reset on verified growth). */
  staleTicks: number
  /** Post-hysteresis active flag (what the heartbeat reports). */
  active: boolean
}

/** This tick's observation of the newest live mic WAV (null path when none exists). */
export interface WavObservation {
  path: string | null
  size: number
  mtimeMs: number
}

export const INITIAL_WAV_TRACK: WavTrackState = {
  path: null,
  size: 0,
  staleTicks: 0,
  active: false
}

/**
 * Pure tracking + hysteresis transition. Given the previous state and this
 * tick's newest-live-WAV observation, return the next state:
 *
 *  - No live WAV present → fully reset (inactive).
 *  - Path switch (a new meeting's mic WAV, or the first sighting) → adopt it and
 *    SEED `size` from the file's CURRENT size, so the switch itself is never read
 *    as growth. This debounces the tracker against boundary churn and stops a
 *    just-discovered, already-sized file from registering a false "started"; the
 *    freshly-adopted file is reported inactive until it is observed growing.
 *  - Same file, verified growth (`isWavActivelyGrowing`) → active, clear the
 *    stale counter.
 *  - Same file, no growth → increment the stale counter; only flip active→false
 *    after STALE_TICKS_TO_INACTIVE consecutive non-growing ticks (hysteresis),
 *    so a single zero-byte window never ends a live recording.
 */
export function nextWavTrackState(
  prev: WavTrackState,
  obs: WavObservation,
  now: number
): WavTrackState {
  if (obs.path === null) return { ...INITIAL_WAV_TRACK }

  if (obs.path !== prev.path) {
    return { path: obs.path, size: obs.size, staleTicks: 0, active: false }
  }

  if (isWavActivelyGrowing(prev.size, obs.size, obs.mtimeMs, now)) {
    return { path: obs.path, size: obs.size, staleTicks: 0, active: true }
  }

  const staleTicks = prev.staleTicks + 1
  const active = prev.active && staleTicks < STALE_TICKS_TO_INACTIVE
  return { path: obs.path, size: obs.size, staleTicks, active }
}
