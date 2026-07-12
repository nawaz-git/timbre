import { describe, it, expect } from 'vitest'
import {
  parseWavByteRate,
  isWavActivelyGrowing,
  enginePrefixFromRawAudioPath,
  estDurationSecFromSize,
  nextWavTrackState,
  INITIAL_WAV_TRACK,
  FRESH_WINDOW_MS,
  STALE_TICKS_TO_INACTIVE,
  type WavObservation,
  type WavTrackState
} from '../src/main/captureSignalLogic'

/** Minimal valid 44-byte RIFF/WAVE header carrying `byteRate` at offset 28. */
function wavHeader(byteRate: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0, 'ascii')
  b.write('WAVE', 8, 'ascii')
  b.writeUInt32LE(byteRate, 28)
  return b
}

describe('parseWavByteRate', () => {
  it('reads the little-endian byteRate from a valid header', () => {
    expect(parseWavByteRate(wavHeader(32000))).toBe(32000)
  })

  it('returns null for a too-short buffer', () => {
    expect(parseWavByteRate(Buffer.alloc(16))).toBeNull()
  })

  it('returns null when the RIFF/WAVE magic is missing', () => {
    expect(parseWavByteRate(Buffer.alloc(44))).toBeNull()
  })

  it('returns null for a zero byteRate rather than guessing', () => {
    expect(parseWavByteRate(wavHeader(0))).toBeNull()
  })
})

describe('isWavActivelyGrowing', () => {
  const now = 1_000_000

  it('is true when size grew and the mtime is fresh', () => {
    expect(isWavActivelyGrowing(100, 200, now - 1000, now)).toBe(true)
  })

  it('is false when size grew but the mtime is stale', () => {
    expect(isWavActivelyGrowing(100, 200, now - (FRESH_WINDOW_MS + 1), now)).toBe(false)
  })

  it('is false when the size did not change', () => {
    expect(isWavActivelyGrowing(200, 200, now, now)).toBe(false)
  })

  it('is false when the size shrank', () => {
    expect(isWavActivelyGrowing(200, 100, now, now)).toBe(false)
  })
})

describe('enginePrefixFromRawAudioPath', () => {
  it('strips the _mic.wav suffix (the live signal)', () => {
    expect(enginePrefixFromRawAudioPath('/rec/recordings/20260712_1000_meet_mic.wav')).toBe(
      '20260712_1000_meet'
    )
  })

  it('strips _app.wav and _mix.wav too', () => {
    expect(enginePrefixFromRawAudioPath('/r/20260712_1000_x_app.wav')).toBe('20260712_1000_x')
    expect(enginePrefixFromRawAudioPath('/r/20260712_1000_x_mix.wav')).toBe('20260712_1000_x')
  })

  it('returns null for a non-raw-audio path', () => {
    expect(enginePrefixFromRawAudioPath('/r/protocols/20260712_1000_x.txt')).toBeNull()
    expect(enginePrefixFromRawAudioPath('20260712_1000_x_screen.mp4')).toBeNull()
  })
})

describe('estDurationSecFromSize', () => {
  it('returns null when the byteRate is unknown', () => {
    expect(estDurationSecFromSize(320044, null)).toBeNull()
  })

  it('returns null when the file is only the header', () => {
    expect(estDurationSecFromSize(44, 32000)).toBeNull()
  })

  it('divides (size - header) by the byteRate', () => {
    // 320044 bytes - 44 header = 320000 payload / 32000 B/s = 10s.
    expect(estDurationSecFromSize(320044, 32000)).toBe(10)
  })
})

describe('nextWavTrackState — tracking + hysteresis', () => {
  const now = 1_000_000
  const fresh = (): number => now - 500
  const mic = '/rec/recordings/20260712_1000_meet_mic.wav'
  const mic2 = '/rec/recordings/20260712_1100_meet_mic.wav'

  const obs = (path: string | null, size: number, mtimeMs = fresh()): WavObservation => ({
    path,
    size,
    mtimeMs
  })

  it('stays inactive and resets when no live WAV is present', () => {
    const active: WavTrackState = { path: mic, size: 500, staleTicks: 0, active: true }
    expect(nextWavTrackState(active, obs(null, 0), now)).toEqual(INITIAL_WAV_TRACK)
  })

  it('adopts a newly-seen file WITHOUT reading it as growth (seed from current size)', () => {
    const next = nextWavTrackState(INITIAL_WAV_TRACK, obs(mic, 4096), now)
    expect(next.path).toBe(mic)
    expect(next.size).toBe(4096)
    expect(next.active).toBe(false)
    expect(next.staleTicks).toBe(0)
  })

  it('goes active once the adopted file is observed growing', () => {
    const adopted = nextWavTrackState(INITIAL_WAV_TRACK, obs(mic, 4096), now)
    const grown = nextWavTrackState(adopted, obs(mic, 8192), now)
    expect(grown.active).toBe(true)
    expect(grown.staleTicks).toBe(0)
  })

  it('does NOT flip inactive on a single non-growing tick (a brief stall)', () => {
    let s: WavTrackState = { path: mic, size: 8192, staleTicks: 0, active: true }
    s = nextWavTrackState(s, obs(mic, 8192), now) // one zero-byte window
    expect(s.active).toBe(true)
    expect(s.staleTicks).toBe(1)
  })

  it(`flips inactive only after ${STALE_TICKS_TO_INACTIVE} consecutive non-growing ticks`, () => {
    let s: WavTrackState = { path: mic, size: 8192, staleTicks: 0, active: true }
    for (let i = 1; i < STALE_TICKS_TO_INACTIVE; i++) {
      s = nextWavTrackState(s, obs(mic, 8192), now)
      expect(s.active).toBe(true) // still bridging the stall
    }
    s = nextWavTrackState(s, obs(mic, 8192), now) // the STALE_TICKS-th tick
    expect(s.active).toBe(false)
    expect(s.staleTicks).toBe(STALE_TICKS_TO_INACTIVE)
  })

  it('a mid-stall resume clears the stale counter and keeps it active', () => {
    let s: WavTrackState = { path: mic, size: 8192, staleTicks: 2, active: true }
    s = nextWavTrackState(s, obs(mic, 9000), now) // resumes writing
    expect(s.active).toBe(true)
    expect(s.staleTicks).toBe(0)
  })

  it('treats a grown-but-stale-mtime file as non-growth (frozen finalized file)', () => {
    const staleMtime = now - (FRESH_WINDOW_MS + 1)
    let s: WavTrackState = { path: mic, size: 8192, staleTicks: 2, active: true }
    s = nextWavTrackState(s, obs(mic, 9000, staleMtime), now)
    expect(s.active).toBe(false)
    expect(s.staleTicks).toBe(3)
  })

  it('a real meeting boundary (path switch) marks inactive then re-arms on the new file', () => {
    // Meeting 1 active, then meeting 2's mic WAV becomes the newest file.
    const m1: WavTrackState = { path: mic, size: 500_000, staleTicks: 0, active: true }
    const switched = nextWavTrackState(m1, obs(mic2, 4096), now)
    expect(switched.path).toBe(mic2)
    expect(switched.size).toBe(4096) // seeded, not counted as growth
    expect(switched.active).toBe(false)
    const grown = nextWavTrackState(switched, obs(mic2, 8192), now)
    expect(grown.active).toBe(true)
  })
})
