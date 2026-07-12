import { describe, it, expect } from 'vitest'
import { menuInputsChanged } from './tray'

// Mirror the private TrayMenuInputs shape the exported diff compares.
const base = {
  state: 'watching' as const,
  chromeMeetingId: null as string | null,
  screenRecording: 'granted' as const,
  microphone: 'granted' as const,
  automationChrome: 'granted' as const,
  watchdogFlag: false
}

describe('menuInputsChanged', () => {
  it('is false when nothing changed', () => {
    expect(menuInputsChanged(base, { ...base })).toBe(false)
  })

  it('detects a recording-state change', () => {
    expect(menuInputsChanged(base, { ...base, state: 'recording' })).toBe(true)
  })

  it('detects a chrome-meeting appearing, changing, and clearing', () => {
    expect(menuInputsChanged(base, { ...base, chromeMeetingId: 'abc-defg-hij' })).toBe(true)
    const withMeet = { ...base, chromeMeetingId: 'abc-defg-hij' }
    expect(menuInputsChanged(withMeet, { ...withMeet, chromeMeetingId: 'xyz-wxyz-uvw' })).toBe(true)
    expect(menuInputsChanged(withMeet, { ...withMeet, chromeMeetingId: null })).toBe(true)
  })

  it('detects each permission flag flipping', () => {
    expect(menuInputsChanged(base, { ...base, screenRecording: 'denied' })).toBe(true)
    expect(menuInputsChanged(base, { ...base, microphone: 'denied' })).toBe(true)
    expect(menuInputsChanged(base, { ...base, automationChrome: 'denied' })).toBe(true)
  })

  it('detects the watchdog flag flipping', () => {
    expect(menuInputsChanged(base, { ...base, watchdogFlag: true })).toBe(true)
  })
})
