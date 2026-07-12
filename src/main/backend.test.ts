import { describe, expect, it } from 'vitest'
import { numSpeakersToArg, timestampedFolderName } from './backend'

// Importing backend.ts pulls in its top-level `import { app } from 'electron'`,
// so this suite also exercises the electron mock alias on a real main-process
// module (not just the seed smoke test).

describe('numSpeakersToArg', () => {
  it('passes a concrete speaker count straight through', () => {
    expect(numSpeakersToArg(2)).toBe(2)
    expect(numSpeakersToArg(6)).toBe(6)
  })

  it('maps the auto hint to undefined (let the engine decide)', () => {
    expect(numSpeakersToArg('auto')).toBeUndefined()
  })

  it('maps a missing hint to undefined', () => {
    expect(numSpeakersToArg(undefined)).toBeUndefined()
  })
})

describe('timestampedFolderName', () => {
  const when = new Date(2026, 6, 12, 9, 5, 3) // 2026-07-12 09:05:03 local

  it('prefixes a zero-padded local timestamp', () => {
    expect(timestampedFolderName('Standup', when)).toBe('2026-07-12_09-05-03_Standup')
  })

  it('drops a trailing file extension from the slug', () => {
    expect(timestampedFolderName('recording.wav', when)).toBe('2026-07-12_09-05-03_recording')
  })

  it('replaces unsafe characters with single dashes', () => {
    expect(timestampedFolderName('Team / Sync: Q3', when)).toBe('2026-07-12_09-05-03_Team-Sync-Q3')
  })

  it('falls back to "untitled" when nothing safe survives', () => {
    expect(timestampedFolderName('***', when)).toBe('2026-07-12_09-05-03_untitled')
    expect(timestampedFolderName('', when)).toBe('2026-07-12_09-05-03_untitled')
  })

  it('caps the slug at 60 characters', () => {
    const slug = 'a'.repeat(200)
    const result = timestampedFolderName(slug, when)
    expect(result).toBe(`2026-07-12_09-05-03_${'a'.repeat(60)}`)
  })
})
