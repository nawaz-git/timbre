import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  deriveEngineStatus,
  exportMeeting,
  isEngineSidecarOf,
  listEngineFailedMeetings,
  retryFailedMeeting
} from './meetings'

// meetings.ts transitively imports electron via ./backend + ./captureWatchdog;
// the vitest `electron` alias handles that (no per-test mock needed).

const HOUR = 60 * 60 * 1000

async function fileExists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

/** Yield a macrotask so detached promise chains (and their async fs ops) settle. */
const flushAsync = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `pred` until it holds or the timeout elapses (for detached-completion assertions). */
async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await flushAsync(5)
  }
}

describe('deriveEngineStatus', () => {
  const now = 1_000_000_000_000

  it('stays processing for fresh audio with no transcript or sidecar', () => {
    expect(deriveEngineStatus(false, false, now - HOUR, now)).toBe('processing')
  })

  it('fails immediately when an error sidecar exists', () => {
    expect(deriveEngineStatus(false, true, now, now)).toBe('failed')
  })

  it('fails once raw audio is older than the 6h stale cap', () => {
    expect(deriveEngineStatus(false, false, now - 7 * HOUR, now)).toBe('failed')
    expect(deriveEngineStatus(false, false, now - 5 * HOUR, now)).toBe('processing')
  })

  it('short-circuits to processing when a transcript has landed', () => {
    // hasTxt wins even for wildly stale audio — a ready meeting is never failed.
    expect(deriveEngineStatus(true, false, now - 24 * HOUR, now)).toBe('processing')
  })
})

describe('listEngineFailedMeetings', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'timbre-failed-'))
    await fs.mkdir(join(root, 'protocols'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function writeSidecar(prefix: string, body: Record<string, unknown>): Promise<void> {
    await fs.writeFile(join(root, 'protocols', `${prefix}.error.json`), JSON.stringify(body))
  }

  it('maps an error sidecar to a failed row', async () => {
    await writeSidecar('20260712_0930_standup', {
      version: 1,
      title: 'Standup',
      error: 'Empty transcript',
      failedAt: '2026-07-12T09:30:00.000Z'
    })
    const rows = await listEngineFailedMeetings(root)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('engine:20260712_0930_standup')
    expect(rows[0].status).toBe('failed')
    expect(rows[0].title).toBe('Standup')
    expect(rows[0].errorMessage).toBe('Empty transcript')
    expect(rows[0].date).toBe('2026-07-12T09:30:00.000Z')
  })

  it('skips a sidecar whose transcript has since landed', async () => {
    await writeSidecar('20260712_1000_retried', { error: 'boom' })
    await fs.writeFile(join(root, 'protocols', '20260712_1000_retried.txt'), '[00:00:00] Me: hi')
    expect(await listEngineFailedMeetings(root)).toHaveLength(0)
  })

  it('falls back to a generic message when the sidecar omits the error', async () => {
    await writeSidecar('20260712_1100_meet', { title: 'Meet' })
    const rows = await listEngineFailedMeetings(root)
    expect(rows[0].errorMessage).toBe('Processing did not complete.')
  })

  it('returns nothing when the protocols dir is absent', async () => {
    await fs.rm(join(root, 'protocols'), { recursive: true, force: true })
    expect(await listEngineFailedMeetings(root)).toEqual([])
  })
})

describe('retryFailedMeeting', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'timbre-retry-'))
    await fs.mkdir(join(root, 'protocols'), { recursive: true })
    await fs.mkdir(join(root, 'recordings'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  // Unique prefix per call so the module-level in-flight guard (keyed by bare
  // prefix) can't leak state between tests that share this describe block.
  let sidecarSeq = 0
  async function writeSidecar(
    mixPath: string | undefined
  ): Promise<{ path: string; meetingId: string }> {
    const prefix = `20260712_0930_standup_${sidecarSeq++}`
    const path = join(root, 'protocols', `${prefix}.error.json`)
    await fs.writeFile(path, JSON.stringify(mixPath ? { mixPath } : {}))
    return { path, meetingId: `engine:${prefix}` }
  }

  it('errors cleanly and imports nothing when the source audio is gone', async () => {
    const { path: sidecar, meetingId } = await writeSidecar(
      join(root, 'recordings', 'missing_mix.wav')
    )
    let called = false
    const result = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async () => {
        called = true
        return { jobId: 'x', completion: Promise.resolve() }
      },
      root
    )
    expect(result).toEqual({ ok: false, error: 'Source audio no longer exists.' })
    expect(called).toBe(false)
    // The sidecar (and the failed row it backs) survives an unsuccessful retry.
    expect(await fileExists(sidecar)).toBe(true)
  })

  it('clears the sidecar only after the import completes, not at kickoff', async () => {
    const mixPath = join(root, 'recordings', 'mix.wav')
    await fs.writeFile(mixPath, 'RIFF')
    const { path: sidecar, meetingId } = await writeSidecar(mixPath)
    // A deferred completion lets the test drive kickoff and completion apart —
    // the previous mock conflated them (returned before the import "finished").
    let finishImport: () => void = () => {}
    const completion = new Promise<void>((resolve) => {
      finishImport = resolve
    })
    const seen: string[] = []
    const result = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async (mix) => {
        seen.push(mix)
        return { jobId: 'job-1', completion }
      },
      root
    )
    expect(result).toEqual({ ok: true, jobId: 'job-1' })
    expect(seen).toEqual([mixPath])
    // Kickoff returned but the import is still running: the sidecar MUST survive
    // so a crash / re-failure mid-import can't strand the meeting invisibly.
    expect(await fileExists(sidecar)).toBe(true)

    // The import succeeds → the sidecar is cleared so the failed row disappears.
    finishImport()
    await waitUntil(async () => !(await fileExists(sidecar)))
    expect(await fileExists(sidecar)).toBe(false)
  })

  it('keeps the sidecar and frees the guard when the re-import fails', async () => {
    const mixPath = join(root, 'recordings', 'mix.wav')
    await fs.writeFile(mixPath, 'RIFF')
    const { path: sidecar, meetingId } = await writeSidecar(mixPath)
    // Reject the completion AFTER kickoff so retryFailedMeeting's own handler is
    // already attached (no unhandled-rejection window).
    let failImport: (e: Error) => void = () => {}
    const completion = new Promise<void>((_, reject) => {
      failImport = reject
    })
    const result = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async () => ({ jobId: 'job-1', completion }),
      root
    )
    expect(result).toEqual({ ok: true, jobId: 'job-1' })

    failImport(new Error('batch died'))
    await flushAsync()
    // A failed re-import must leave the sidecar in place — it is the only record
    // of the failure (the Electron import path writes none of its own).
    expect(await fileExists(sidecar)).toBe(true)

    // The in-flight guard is released, so the user can retry again.
    let calledAgain = false
    const second = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async () => {
        calledAgain = true
        return { jobId: 'job-2', completion: Promise.resolve() }
      },
      root
    )
    expect(calledAgain).toBe(true)
    expect(second.ok).toBe(true)
  })

  it('rejects a duplicate retry while one is already in flight', async () => {
    const mixPath = join(root, 'recordings', 'mix.wav')
    await fs.writeFile(mixPath, 'RIFF')
    const { path: sidecar, meetingId } = await writeSidecar(mixPath)
    // First retry: leave the import pending so the prefix stays in flight.
    let finishFirst: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const first = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async () => ({ jobId: 'job-1', completion: pending }),
      root
    )
    expect(first.ok).toBe(true)

    // Second retry for the SAME meeting while the first import runs: rejected
    // without kicking off a duplicate batch into the same folder.
    let secondCalled = false
    const second = await retryFailedMeeting(
      meetingId,
      join(root, 'out'),
      async () => {
        secondCalled = true
        return { jobId: 'job-2', completion: Promise.resolve() }
      },
      root
    )
    expect(second.ok).toBe(false)
    expect(secondCalled).toBe(false)

    // Cleanup: finish the first import so the guard clears for later tests.
    finishFirst()
    await waitUntil(async () => !(await fileExists(sidecar)))
  })

  it('rejects a non-engine meeting id without importing', async () => {
    let called = false
    const result = await retryFailedMeeting(
      'imported:some-folder',
      join(root, 'out'),
      async () => {
        called = true
        return { jobId: 'x', completion: Promise.resolve() }
      },
      root
    )
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })
})

describe('isEngineSidecarOf', () => {
  const prefix = '20260712_0930_meet'

  it('matches every plain suffix in the closed set', () => {
    for (const suffix of [
      '_mix.wav',
      '_app.wav',
      '_mic.wav',
      '_screen.mp4',
      '_16k.wav',
      '_app_16k.wav',
      '_mic_16k.wav',
      '_segments.json',
      '_naming.json'
    ]) {
      expect(isEngineSidecarOf(prefix, `${prefix}${suffix}`)).toBe(true)
    }
  })

  it('matches suffixes carrying an 8-hex job short-id infix', () => {
    const id = 'ab12cd34'
    expect(isEngineSidecarOf(prefix, `${prefix}_${id}_mix.wav`)).toBe(true)
    expect(isEngineSidecarOf(prefix, `${prefix}_${id}_app_16k.wav`)).toBe(true)
    expect(isEngineSidecarOf(prefix, `${prefix}_${id}_segments.json`)).toBe(true)
    expect(isEngineSidecarOf(prefix, `${prefix}_${id}_naming.json`)).toBe(true)
  })

  it('never claims a sibling whose prefix merely starts with this one', () => {
    // The exact collision this guards: `A` strictly prefixes sibling `A_2`.
    const a = `${prefix}__abc`
    expect(isEngineSidecarOf(a, `${a}_2_mix.wav`)).toBe(false) // `_2` is not 8 hex
    expect(isEngineSidecarOf(prefix, `${prefix}ing_mix.wav`)).toBe(false) // meet -> meeting
    expect(isEngineSidecarOf(prefix, `${prefix}_sync_mix.wav`)).toBe(false) // meet -> meet_sync
  })

  it('rejects empty remainders, protocol exts, and files outside the closed set', () => {
    expect(isEngineSidecarOf(prefix, prefix)).toBe(false) // exact match, no suffix
    expect(isEngineSidecarOf(prefix, `${prefix}.txt`)).toBe(false) // protocols ext, not a recordings sidecar
    expect(isEngineSidecarOf(prefix, `${prefix}_meta.json`)).toBe(false) // record-only sidecar, not in the set
    expect(isEngineSidecarOf(prefix, `${prefix}_mix.wav.bak`)).toBe(false) // trailing junk
    expect(isEngineSidecarOf(prefix, `${prefix}_MIX.wav`)).toBe(false) // case-sensitive
  })

  it('rejects a wrong-length or non-hex short-id infix', () => {
    expect(isEngineSidecarOf(prefix, `${prefix}_ab12cd3_mix.wav`)).toBe(false) // 7 hex
    expect(isEngineSidecarOf(prefix, `${prefix}_ab12cd345_mix.wav`)).toBe(false) // 9 hex
    expect(isEngineSidecarOf(prefix, `${prefix}_ab12cd3g_mix.wav`)).toBe(false) // non-hex g
  })
})

describe('exportMeeting payloads', () => {
  let root: string
  const folderId = 'meeting-1'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'timbre-export-'))
    const folder = join(root, folderId)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(join(folder, 'audio.wav'), 'RIFFfakewavbytes')
    await fs.writeFile(join(folder, 'transcript.txt'), '[00:00:00] Me: hello world')
    await fs.writeFile(
      join(folder, 'transcript.json'),
      JSON.stringify({ segments: [{ speaker: 'Me', start: 0, end: 1, text: 'hello world' }] })
    )
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns a sourcePath and empty body for audio so the handler copies from disk', async () => {
    const payload = await exportMeeting(root, `imported:${folderId}`, 'audio', 'My Meeting')
    // The whole WAV must NOT be buffered — sourcePath points at the on-disk file.
    expect(payload.sourcePath).toBe(join(root, folderId, 'audio.wav'))
    expect(payload.body).toBe('')
    expect(payload.contentType).toBe('audio/wav')
  })

  it('still carries an inline string body (and no sourcePath) for text formats', async () => {
    const txt = await exportMeeting(root, `imported:${folderId}`, 'txt', 'My Meeting')
    expect(txt.sourcePath).toBeUndefined()
    expect(typeof txt.body).toBe('string')
    expect(txt.body).toContain('hello world')

    const json = await exportMeeting(root, `imported:${folderId}`, 'json', 'My Meeting')
    expect(json.sourcePath).toBeUndefined()
    expect(typeof json.body).toBe('string')

    const srt = await exportMeeting(root, `imported:${folderId}`, 'srt', 'My Meeting')
    expect(srt.sourcePath).toBeUndefined()
    expect(typeof srt.body).toBe('string')
  })
})
