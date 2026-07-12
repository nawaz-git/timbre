import { describe, it, expect } from 'vitest'
import { isProbeTickCurrent } from './chromeProbe'

describe('isProbeTickCurrent', () => {
  it('is current when the captured epoch still matches', () => {
    expect(isProbeTickCurrent(0, 0)).toBe(true)
    expect(isProbeTickCurrent(7, 7)).toBe(true)
  })

  it('is stale when a start/stop bumped the epoch mid-tick', () => {
    // stopChromeProbe() bumps generation while a tick is suspended in osascript:
    // the tick captured the old epoch, so on resume it must read as stale and bail.
    expect(isProbeTickCurrent(3, 4)).toBe(false)
    // stop→restart bumps twice — an even staler tick is still invalid.
    expect(isProbeTickCurrent(3, 5)).toBe(false)
  })

  it('treats any change as stale regardless of direction', () => {
    expect(isProbeTickCurrent(5, 4)).toBe(false)
  })
})
