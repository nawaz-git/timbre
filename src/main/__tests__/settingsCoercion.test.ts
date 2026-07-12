import assert from 'node:assert/strict'
import { test } from 'vitest'
import { coerceAsrLanguage, coerceProcessingMode } from '../settingsCoercion'

test('coerceProcessingMode keeps max and defaults everything else to fast', () => {
  assert.equal(coerceProcessingMode('max'), 'max')
  assert.equal(coerceProcessingMode('fast'), 'fast')
  assert.equal(coerceProcessingMode('turbo'), 'fast')
  assert.equal(coerceProcessingMode(undefined), 'fast')
  assert.equal(coerceProcessingMode(42), 'fast')
})

test('coerceAsrLanguage accepts known ISO codes and the empty sentinel', () => {
  assert.equal(coerceAsrLanguage(''), '')
  assert.equal(coerceAsrLanguage('en'), 'en')
  assert.equal(coerceAsrLanguage('de'), 'de')
})

test('coerceAsrLanguage rejects unknown/garbage values back to auto-detect', () => {
  assert.equal(coerceAsrLanguage('klingon'), '')
  assert.equal(coerceAsrLanguage('EN'), '', 'case-sensitive: only lowercase ISO codes')
  assert.equal(coerceAsrLanguage(undefined), '')
  assert.equal(coerceAsrLanguage(123), '')
})
