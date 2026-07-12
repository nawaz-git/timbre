import { describe, expect, it } from 'vitest'
import { formatErrorLogLine } from './globalErrorHandlers'

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
