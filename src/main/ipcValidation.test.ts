import { describe, it, expect } from 'vitest'
import {
  isSpawnPathAllowed,
  isTraversalSafeMeetingId,
  resolveMeetingOpenPath
} from './ipcValidation'

const OUT = '/Users/tester/timbre-out'
const LIVE = '/Users/tester/Library/Application Support/MeetingTranscriber/recordings'

describe('resolveMeetingOpenPath', () => {
  it('resolves an engine id to the protocols dir', () => {
    expect(resolveMeetingOpenPath('engine:20260528_1938_meet', OUT, LIVE)).toBe(`${LIVE}/protocols`)
  })

  it('resolves an imported id to the output folder', () => {
    expect(resolveMeetingOpenPath('imported:standup-2026', OUT, LIVE)).toBe(`${OUT}/standup-2026`)
  })

  it('resolves a bare folder id to the output folder', () => {
    expect(resolveMeetingOpenPath('standup-2026', OUT, LIVE)).toBe(`${OUT}/standup-2026`)
  })

  it('refuses a live id (nothing on disk yet)', () => {
    expect(resolveMeetingOpenPath('live:abc-defg-hij', OUT, LIVE)).toBeNull()
  })

  it('refuses traversal in any id form', () => {
    expect(resolveMeetingOpenPath('imported:../../etc', OUT, LIVE)).toBeNull()
    expect(resolveMeetingOpenPath('../secrets', OUT, LIVE)).toBeNull()
    expect(resolveMeetingOpenPath('/etc/passwd', OUT, LIVE)).toBeNull()
    expect(resolveMeetingOpenPath('a\\b', OUT, LIVE)).toBeNull()
  })

  it('refuses an engine prefix with disallowed characters', () => {
    expect(resolveMeetingOpenPath('engine:has space', OUT, LIVE)).toBeNull()
    expect(resolveMeetingOpenPath('engine:dots.here', OUT, LIVE)).toBeNull()
  })
})

describe('isSpawnPathAllowed', () => {
  it('allows exactly the last-picked path', () => {
    expect(isSpawnPathAllowed('/tmp/a.wav', '/tmp/a.wav')).toBe(true)
  })

  it('rejects a different path', () => {
    expect(isSpawnPathAllowed('/tmp/evil.app', '/tmp/a.wav')).toBe(false)
  })

  it('rejects when nothing was picked, and rejects empty/non-strings', () => {
    expect(isSpawnPathAllowed('/tmp/a.wav', null)).toBe(false)
    expect(isSpawnPathAllowed('', '')).toBe(false)
    expect(isSpawnPathAllowed(42, '/tmp/a.wav')).toBe(false)
  })
})

describe('isTraversalSafeMeetingId', () => {
  it('accepts the real id shapes', () => {
    expect(isTraversalSafeMeetingId('engine:20260528_1938_meet')).toBe(true)
    expect(isTraversalSafeMeetingId('imported:standup')).toBe(true)
    expect(isTraversalSafeMeetingId('standup-2026')).toBe(true)
  })

  it('rejects traversal characters, empty strings, and non-strings', () => {
    expect(isTraversalSafeMeetingId('../x')).toBe(false)
    expect(isTraversalSafeMeetingId('a/b')).toBe(false)
    expect(isTraversalSafeMeetingId('a\\b')).toBe(false)
    expect(isTraversalSafeMeetingId('')).toBe(false)
    expect(isTraversalSafeMeetingId(undefined)).toBe(false)
  })
})
