import { describe, expect, it } from 'vitest'
import { formatErrorLogLine, shouldRenotify } from './globalErrorHandlers'

// globalErrorHandlers.ts imports electron (app, Notification) at module scope;
// the vitest `electron` alias resolves it. Only the pure formatter is exercised
// here — installGlobalErrorHandlers has process-level side effects.

describe('formatErrorLogLine', () => {
  const when = new Date('2026-07-12T09:30:00.000Z')

  it('uses the error stack when present', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at somewhere'
    const line = formatErrorLogLine(when, 'uncaughtException', err)
    expect(line).toBe('2026-07-12T09:30:00.000Z uncaughtException Error: boom\n    at somewhere')
  })

  it('falls back to name: message when an Error has no stack', () => {
    const err = new Error('no stack here')
    err.stack = undefined
    expect(formatErrorLogLine(when, 'uncaughtException', err)).toBe(
      '2026-07-12T09:30:00.000Z uncaughtException Error: no stack here'
    )
  })

  it('stringifies a non-Error rejection reason', () => {
    expect(formatErrorLogLine(when, 'unhandledRejection', 'plain string reason')).toBe(
      '2026-07-12T09:30:00.000Z unhandledRejection plain string reason'
    )
  })

  it('tags the incident kind', () => {
    const err = new Error('x')
    err.stack = 'Error: x'
    expect(formatErrorLogLine(when, 'unhandledRejection', err)).toContain(' unhandledRejection ')
  })
})

describe('shouldRenotify', () => {
  const COOLDOWN = 5 * 60_000

  it('always notifies the first time (lastNotifiedAt 0)', () => {
    // Real Date.now() epochs dwarf the cooldown, so a never-notified handler
    // (lastNotifiedAt 0) always surfaces the first incident.
    expect(shouldRenotify(1_700_000_000_000, 0, COOLDOWN)).toBe(true)
  })

  it('suppresses a second notification within the cooldown window', () => {
    const last = 1_000_000
    expect(shouldRenotify(last + 1, last, COOLDOWN)).toBe(false)
    expect(shouldRenotify(last + COOLDOWN - 1, last, COOLDOWN)).toBe(false)
  })

  it('re-notifies once the cooldown elapses so a fault storm resurfaces', () => {
    const last = 1_000_000
    expect(shouldRenotify(last + COOLDOWN, last, COOLDOWN)).toBe(true)
    expect(shouldRenotify(last + 2 * COOLDOWN, last, COOLDOWN)).toBe(true)
  })
})
