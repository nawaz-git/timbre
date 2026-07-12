import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bracketToSeconds,
  looksPreDiarizationSpeakers,
  parseEngineTxtSegments
} from '../engineTranscript'

test('bracketToSeconds parses MM:SS and H:MM:SS brackets', () => {
  assert.equal(bracketToSeconds('[00:00]'), 0)
  assert.equal(bracketToSeconds('[09:55]'), 595)
  assert.equal(bracketToSeconds('[1:02:03]'), 3723)
})

test('parseEngineTxtSegments splits speaker lines with contiguous ends', () => {
  const txt = ['[00:00] Roman: Morgen.', '[00:30] Lennart: Hallo', '[09:55] Me: Passt.'].join('\n')
  const { segments, speakers } = parseEngineTxtSegments(txt)

  assert.equal(segments.length, 3)
  assert.deepEqual(segments[0], { speaker: 'Roman', start: 0, end: 30, text: 'Morgen.' })
  assert.deepEqual(segments[1], { speaker: 'Lennart', start: 30, end: 595, text: 'Hallo' })
  // Last segment ends at its own start (no following line).
  assert.deepEqual(segments[2], { speaker: 'Me', start: 595, end: 595, text: 'Passt.' })
  assert.deepEqual(
    speakers.map((s) => s.label),
    ['Roman', 'Lennart', 'Me']
  )
})

test('parseEngineTxtSegments ignores lines without a timestamped speaker prefix', () => {
  const txt = ['# Meeting Protocol', '', '[00:05] Alice: Hi there', 'prose without a bracket'].join(
    '\n'
  )
  const { segments } = parseEngineTxtSegments(txt)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].speaker, 'Alice')
})

test('looksPreDiarizationSpeakers flags the Remote/mic and empty caches', () => {
  assert.equal(looksPreDiarizationSpeakers(new Set(['Remote', 'Me'])), true)
  assert.equal(looksPreDiarizationSpeakers(new Set(['Remote'])), true)
  assert.equal(looksPreDiarizationSpeakers(new Set([''])), true)
  assert.equal(looksPreDiarizationSpeakers(new Set(['Alice'])), true)
})

test('looksPreDiarizationSpeakers rejects real multi-speaker sets and empty input', () => {
  assert.equal(looksPreDiarizationSpeakers(new Set(['Alice', 'Bob'])), false)
  assert.equal(looksPreDiarizationSpeakers(new Set(['Remote', 'Alice', 'Bob'])), false)
  assert.equal(looksPreDiarizationSpeakers(new Set<string>()), false)
})

test('legacy Remote/Me JSON plus a rich .txt yields per-speaker segments', () => {
  // Mirrors the readTranscript fallback decision: a pre-diarization JSON set
  // combined with a `.txt` that names strictly more speakers switches the UI
  // over to the `.txt`-derived segments.
  const jsonSpeakers = new Set(['Remote', 'Me'])
  const txt = ['[00:00] Roman: A', '[00:10] Lennart: B', '[00:20] Diana: C', '[00:30] Me: D'].join(
    '\n'
  )
  const fromTxt = parseEngineTxtSegments(txt)
  const txtSpeakerCount = new Set(fromTxt.segments.map((s) => s.speaker)).size

  assert.equal(looksPreDiarizationSpeakers(jsonSpeakers), true)
  assert.ok(txtSpeakerCount > jsonSpeakers.size)
  assert.equal(txtSpeakerCount, 4)
})
