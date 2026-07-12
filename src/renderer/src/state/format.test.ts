import { describe, expect, it } from 'vitest'
import { formatDuration } from './format'

// A pure renderer helper (no DOM) — proves the harness also discovers and runs
// tests co-located under src/renderer/src/** in the default node environment.

describe('formatDuration', () => {
  it('formats sub-hour durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(600)).toBe('10:00')
  })

  it('formats hour-plus durations as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661)).toBe('1:01:01')
  })

  it('floors fractional seconds', () => {
    expect(formatDuration(9.9)).toBe('0:09')
  })

  it('clamps non-positive and non-finite input to 0:00', () => {
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
