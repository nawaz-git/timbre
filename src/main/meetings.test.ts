import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deriveEngineStatus, listEngineFailedMeetings, retryFailedMeeting } from './meetings'

// meetings.ts transitively imports electron via ./backend + ./captureWatchdog;
// the vitest `electron` alias handles that (no per-test mock needed).

const HOUR = 60 * 60 * 1000

async function fileExists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
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

  async function writeSidecar(mixPath: string | undefined): Promise<string> {
    const path = join(root, 'protocols', '20260712_0930_standup.error.json')
    await fs.writeFile(path, JSON.stringify(mixPath ? { mixPath } : {}))
    return path
  }

  it('errors cleanly and imports nothing when the source audio is gone', async () => {
    const sidecar = await writeSidecar(join(root, 'recordings', 'missing_mix.wav'))
    let called = false
    const result = await retryFailedMeeting(
      'engine:20260712_0930_standup',
      join(root, 'out'),
      async () => {
        called = true
        return { jobId: 'x' }
      },
      root
    )
    expect(result).toEqual({ ok: false, error: 'Source audio no longer exists.' })
    expect(called).toBe(false)
    // The sidecar (and the failed row it backs) survives an unsuccessful retry.
    expect(await fileExists(sidecar)).toBe(true)
  })

  it('re-imports the mix and clears the sidecar on success', async () => {
    const mixPath = join(root, 'recordings', 'mix.wav')
    await fs.writeFile(mixPath, 'RIFF')
    const sidecar = await writeSidecar(mixPath)
    const seen: string[] = []
    const result = await retryFailedMeeting(
      'engine:20260712_0930_standup',
      join(root, 'out'),
      async (mix) => {
        seen.push(mix)
        return { jobId: 'job-1' }
      },
      root
    )
    expect(result).toEqual({ ok: true, jobId: 'job-1' })
    expect(seen).toEqual([mixPath])
    expect(await fileExists(sidecar)).toBe(false)
  })

  it('rejects a non-engine meeting id without importing', async () => {
    let called = false
    const result = await retryFailedMeeting(
      'imported:some-folder',
      join(root, 'out'),
      async () => {
        called = true
        return { jobId: 'x' }
      },
      root
    )
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })
})
