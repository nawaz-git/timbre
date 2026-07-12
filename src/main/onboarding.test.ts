import { describe, it, expect } from 'vitest'
import { isVerdictLogFresh, parseVerdictJson, parseVerdictLog, resolveGrant } from './onboarding'

const NOW = 2_000_000_000_000
const TEN_MIN = 10 * 60_000

describe('parseVerdictJson', () => {
  it('parses a fresh verdict and collapses broken → denied', () => {
    const raw = JSON.stringify({
      screen: 'healthy',
      mic: 'denied',
      ax: 'broken',
      notifications: 'denied',
      updatedAt: NOW - 1000
    })
    const parsed = parseVerdictJson(raw, NOW)
    expect(parsed).not.toBeNull()
    expect(parsed?.verdict.screenRecording).toBe('granted')
    expect(parsed?.verdict.microphone).toBe('denied')
    expect(parsed?.verdict.accessibility).toBe('denied')
    expect(parsed?.notifications).toBe('denied')
  })

  it('normalises the engine notDetermined notification value', () => {
    const raw = JSON.stringify({
      screen: 'healthy',
      notifications: 'notDetermined',
      updatedAt: NOW
    })
    expect(parseVerdictJson(raw, NOW)?.notifications).toBe('not-determined')
  })

  it('ignores a stale verdict (older than the max age)', () => {
    const raw = JSON.stringify({ screen: 'healthy', updatedAt: NOW - 11 * 60_000 })
    expect(parseVerdictJson(raw, NOW)).toBeNull()
  })

  it('returns null when updatedAt is missing or the payload is malformed', () => {
    expect(parseVerdictJson(JSON.stringify({ screen: 'healthy' }), NOW)).toBeNull()
    expect(parseVerdictJson('not json', NOW)).toBeNull()
    expect(parseVerdictJson('42', NOW)).toBeNull()
  })
})

describe('resolveGrant precedence', () => {
  it('prefers JSON, then log, then tccd', () => {
    expect(resolveGrant('granted', 'denied', 'not-determined')).toBe('granted')
    expect(resolveGrant(null, 'denied', 'not-determined')).toBe('denied')
    expect(resolveGrant(null, null, 'not-determined')).toBe('not-determined')
  })

  it('fresh JSON beats the log; a stale JSON is ignored so the log wins', () => {
    const fresh = parseVerdictJson(JSON.stringify({ screen: 'healthy', updatedAt: NOW }), NOW)
    expect(resolveGrant(fresh?.verdict.screenRecording ?? null, 'denied', 'denied')).toBe('granted')

    const stale = parseVerdictJson(
      JSON.stringify({ screen: 'healthy', updatedAt: NOW - 20 * 60_000 }),
      NOW
    )
    expect(stale).toBeNull()
    expect(resolveGrant(stale?.verdict.screenRecording ?? null, 'denied', 'not-determined')).toBe(
      'denied'
    )
  })
})

describe('isVerdictLogFresh', () => {
  it('trusts a log written within the staleness window', () => {
    expect(isVerdictLogFresh(NOW, NOW)).toBe(true)
    expect(isVerdictLogFresh(NOW - TEN_MIN, NOW)).toBe(true)
    expect(isVerdictLogFresh(NOW - (TEN_MIN - 1), NOW)).toBe(true)
  })

  it('rejects a log older than the window so live tccd wins', () => {
    // A dead/idle engine's retained health log must NOT out-rank live tccd once
    // it ages out — otherwise a stale verdict self-latches in both directions.
    expect(isVerdictLogFresh(NOW - (TEN_MIN + 1), NOW)).toBe(false)
    expect(isVerdictLogFresh(NOW - 20 * 60_000, NOW)).toBe(false)
  })
})

describe('parseVerdictLog', () => {
  it('reads per-service verdict lines', () => {
    const log = [
      'checkScreenRecordingLive: systemAllowed=true → healthy',
      'checkMicrophoneLive: authStatus=denied → denied'
    ].join('\n')
    const v = parseVerdictLog(log)
    expect(v.screenRecording).toBe('granted')
    expect(v.microphone).toBe('denied')
    expect(v.accessibility).toBeNull()
  })
})
