import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Settings } from '../../shared/types'
import { buildEngineConfigPayload } from '../engineConfigPayload'

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    outputFolder: '/tmp/out',
    theme: 'auto',
    numSpeakers: 'auto',
    sidebarCollapsed: false,
    screenCaptureScope: 'chromeWindow',
    disableAppAudioTap: false,
    autoStartWatching: true,
    processingMode: 'fast',
    asrLanguage: '',
    ...overrides
  }
}

test('buildEngineConfigPayload carries every bridge field', () => {
  const payload = buildEngineConfigPayload(
    makeSettings({
      screenCaptureScope: 'entireScreen',
      processingMode: 'max',
      asrLanguage: 'en',
      numSpeakers: 3
    }),
    '/Users/x/global-speakers.json'
  )
  assert.deepEqual(payload, {
    screenCaptureScope: 'entireScreen',
    disableAppAudioTap: false,
    processingMode: 'max',
    asrLanguage: 'en',
    numSpeakersHint: 3,
    globalSpeakersDBPath: '/Users/x/global-speakers.json'
  })
})

test('auto num-speakers maps to the 0 hint (engine auto-detects)', () => {
  const payload = buildEngineConfigPayload(makeSettings({ numSpeakers: 'auto' }), '/db.json')
  assert.equal(payload.numSpeakersHint, 0)
})

test('defaults are fast + auto-detect (no forced language)', () => {
  const payload = buildEngineConfigPayload(makeSettings(), '/db.json')
  assert.equal(payload.processingMode, 'fast')
  assert.equal(payload.asrLanguage, '')
})

test('payload does not carry updatedAt (added by the writer)', () => {
  const payload = buildEngineConfigPayload(makeSettings(), '/db.json')
  assert.equal('updatedAt' in payload, false)
})

test('the engine override + llm-repair keys are omitted (engine defaults them)', () => {
  const payload = buildEngineConfigPayload(makeSettings(), '/db.json')
  assert.equal('transcriptionEngine' in payload, false)
  assert.equal('llmRepair' in payload, false)
})
