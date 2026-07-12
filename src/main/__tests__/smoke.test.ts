import { describe, expect, it } from 'vitest'
import { app } from 'electron'

// Seed test: proves the harness runs and that the `electron` alias resolves to
// the mock (src/main/__mocks__/electron.ts) instead of the real, process-bound
// module. Later work adds real coverage; this file guards the wiring itself.
describe('vitest harness', () => {
  it('runs a trivial assertion', () => {
    expect(1 + 1).toBe(2)
  })

  it('resolves the electron import to the test mock', () => {
    expect(app.isPackaged).toBe(false)
    expect(app.getPath('userData')).toBe('/tmp/timbre-test')
  })
})
