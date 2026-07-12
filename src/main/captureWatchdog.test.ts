import { describe, it, expect } from 'vitest'
import { watchRecursionSafe } from './captureWatchdog'

const HOME = '/Users/tester'

describe('watchRecursionSafe', () => {
  it('refuses the home directory itself', () => {
    expect(watchRecursionSafe(HOME, HOME)).toBe(false)
  })

  it('refuses the exact big top-level roots', () => {
    expect(watchRecursionSafe(`${HOME}/Documents`, HOME)).toBe(false)
    expect(watchRecursionSafe(`${HOME}/Desktop`, HOME)).toBe(false)
    expect(watchRecursionSafe(`${HOME}/Downloads`, HOME)).toBe(false)
  })

  it('normalises trailing slashes before comparing', () => {
    expect(watchRecursionSafe(`${HOME}/`, HOME)).toBe(false)
    expect(watchRecursionSafe(`${HOME}/Documents/`, HOME)).toBe(false)
  })

  it('allows a dedicated subfolder', () => {
    expect(watchRecursionSafe(`${HOME}/Meetings`, HOME)).toBe(true)
    expect(watchRecursionSafe(`${HOME}/timbre-out`, HOME)).toBe(true)
  })

  it('allows a folder nested under a big root (only the exact root is refused)', () => {
    expect(watchRecursionSafe(`${HOME}/Documents/Meetings`, HOME)).toBe(true)
    expect(watchRecursionSafe(`${HOME}/Desktop/rec`, HOME)).toBe(true)
  })

  it('allows a folder outside the home directory', () => {
    expect(watchRecursionSafe('/Volumes/External/Meetings', HOME)).toBe(true)
  })

  it('does not treat a sibling-prefixed home path as home', () => {
    // `/Users/tester2` starts with `/Users/tester` textually but is a
    // different directory — must stay recursive-safe.
    expect(watchRecursionSafe('/Users/tester2', HOME)).toBe(true)
  })
})
