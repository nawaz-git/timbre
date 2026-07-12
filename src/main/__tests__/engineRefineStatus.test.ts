import assert from 'node:assert/strict'
import { test } from 'vitest'
import { isRefineMarkerActive, REFINE_MARKER_STALE_MS } from '../engineRefineStatus'

const now = 1_800_000_000_000

test('fresh marker with a live engine is active', () => {
  assert.equal(
    isRefineMarkerActive({ markerMtimeMs: now - 60_000, nowMs: now, engineAlive: true }),
    true
  )
})

test('marker just under the staleness cap is still active', () => {
  assert.equal(
    isRefineMarkerActive({
      markerMtimeMs: now - (REFINE_MARKER_STALE_MS - 1),
      nowMs: now,
      engineAlive: true
    }),
    true
  )
})

test('marker exactly at the cap is still active (boundary is inclusive)', () => {
  assert.equal(
    isRefineMarkerActive({
      markerMtimeMs: now - REFINE_MARKER_STALE_MS,
      nowMs: now,
      engineAlive: true
    }),
    true
  )
})

test('marker older than the cap is orphaned even with a live engine', () => {
  assert.equal(
    isRefineMarkerActive({
      markerMtimeMs: now - (REFINE_MARKER_STALE_MS + 1),
      nowMs: now,
      engineAlive: true
    }),
    false
  )
})

test('fresh marker with a dead engine is orphaned', () => {
  assert.equal(
    isRefineMarkerActive({ markerMtimeMs: now - 60_000, nowMs: now, engineAlive: false }),
    false
  )
})

test('stale marker with a dead engine is orphaned', () => {
  assert.equal(
    isRefineMarkerActive({
      markerMtimeMs: now - 10 * REFINE_MARKER_STALE_MS,
      nowMs: now,
      engineAlive: false
    }),
    false
  )
})

test('a custom staleCapMs overrides the default', () => {
  // 60s cap: a 90s-old marker is stale even though it is well under the default.
  assert.equal(
    isRefineMarkerActive({
      markerMtimeMs: now - 90_000,
      nowMs: now,
      engineAlive: true,
      staleCapMs: 60_000
    }),
    false
  )
})

test('a future-dated mtime (clock skew) is treated as fresh, not stale', () => {
  assert.equal(
    isRefineMarkerActive({ markerMtimeMs: now + 5_000, nowMs: now, engineAlive: true }),
    true
  )
})
