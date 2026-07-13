import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The engine (live-recording) export path reads its files from
// `~/Downloads/MeetingTranscriber`, resolved at module load from `os.homedir()`.
// Point homedir at a throwaway temp dir so we can exercise the REAL engine
// branch — the one the field bug hit — with controlled fixtures. tmpdir() is
// left untouched (partial mock) so the imported-meeting cases below still work.
const mockHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path')
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'timbre-enginehome-'))
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => mockHome }
})

import {
  buildMarkdownExport,
  buildPlainTextExport,
  exportMeeting,
  ExportUnavailableError,
  previewExportMeeting
} from './meetings'

const ENGINE_ROOT = join(mockHome, 'Downloads', 'MeetingTranscriber')

// Two distinct, real speaker names so readTranscript keeps our structured
// segments verbatim (a single-speaker set trips the pre-diarization .txt
// fallback, which we don't want to exercise here).
const SEGMENTS = [
  { speaker: 'Alice', start: 0, end: 4, text: 'Kickoff notes.' },
  { speaker: 'Bob', start: 4, end: 8, text: 'Sounds good.' }
]

describe('buildMarkdownExport (pure)', () => {
  it('renders speaker-bolded, timestamped segments under the title when no summary exists', () => {
    const md = buildMarkdownExport('Weekly Sync', SEGMENTS)
    expect(md).toContain('# Weekly Sync')
    expect(md).toContain('**Alice** _(00:00:00)_')
    expect(md).toContain('Kickoff notes.')
    expect(md).toContain('**Bob** _(00:00:04)_')
    // No summary → no summary section / rule.
    expect(md).not.toContain('---')
    expect(md).not.toContain('# Transcript')
  })

  it('prepends the LLM summary and separates it from the transcript when one exists', () => {
    const md = buildMarkdownExport('Weekly Sync', SEGMENTS, '# Summary\n\nWe agreed to ship.')
    expect(md.startsWith('# Summary')).toBe(true)
    expect(md).toContain('We agreed to ship.')
    expect(md).toContain('\n---\n')
    // With a leading summary the segment block is labelled Transcript.
    expect(md).toContain('# Transcript')
    expect(md).toContain('**Alice** _(00:00:00)_')
  })

  it('falls back to the raw transcript text when there are no structured segments', () => {
    const md = buildMarkdownExport('Notes', [], undefined, '[00:00:00] Alice: hi there')
    expect(md).toContain('# Notes')
    expect(md).toContain('[00:00:00] Alice: hi there')
  })

  it('never throws on a fully empty meeting — emits just the heading', () => {
    expect(buildMarkdownExport('Empty', [], undefined, undefined)).toBe('# Empty\n')
  })
})

describe('buildPlainTextExport (pure)', () => {
  it('renders flat [HH:MM:SS] Speaker: text lines', () => {
    const txt = buildPlainTextExport([{ speaker: 'Alice', start: 65, end: 70, text: 'hi there' }])
    expect(txt).toBe('[00:01:05] Alice: hi there')
  })
})

// The exact field bug: a live (engine) meeting whose pipeline skipped LLM
// summary generation has NO protocols/<prefix>.md. The Markdown export/preview
// must build from the segments sidecar instead of ENOENT-ing on the summary.
describe('engine Markdown export with NO protocols/<prefix>.md (field bug)', () => {
  const prefix = '20260713_1505_okj-wtmg-dez'
  const meetingId = `engine:${prefix}`

  beforeEach(async () => {
    await fs.mkdir(join(ENGINE_ROOT, 'protocols'), { recursive: true })
    await fs.mkdir(join(ENGINE_ROOT, 'recordings'), { recursive: true })
    await fs.writeFile(
      join(ENGINE_ROOT, 'protocols', `${prefix}.txt`),
      '[00:00:00] Alice: Kickoff notes.\n[00:00:04] Bob: Sounds good.'
    )
    await fs.writeFile(
      join(ENGINE_ROOT, 'recordings', `${prefix}_segments.json`),
      JSON.stringify(SEGMENTS)
    )
    // Deliberately DO NOT write protocols/<prefix>.md — this is the bug's state.
  })

  afterEach(async () => {
    await fs.rm(join(ENGINE_ROOT, 'protocols'), { recursive: true, force: true })
    await fs.rm(join(ENGINE_ROOT, 'recordings'), { recursive: true, force: true })
  })

  it('exportMeeting("md") succeeds and builds Markdown from the segments', async () => {
    const payload = await exportMeeting(ENGINE_ROOT, meetingId, 'md', 'Standup')
    expect(payload.contentType).toBe('text/markdown')
    expect(typeof payload.body).toBe('string')
    expect(payload.body).toContain('**Alice** _(00:00:00)_')
    expect(payload.body).toContain('Kickoff notes.')
    expect(payload.body).toContain('**Bob** _(00:00:04)_')
  })

  it('previewExportMeeting("md") returns a ready body, NOT an ENOENT error', async () => {
    const preview = await previewExportMeeting(ENGINE_ROOT, meetingId, 'md', 'Standup')
    expect(preview.unavailable).toBeFalsy()
    expect(preview.body).toContain('**Alice** _(00:00:00)_')
    expect(preview.body).not.toMatch(/ENOENT/)
  })

  it('includes the summary section once protocols/<prefix>.md is present', async () => {
    await fs.writeFile(
      join(ENGINE_ROOT, 'protocols', `${prefix}.md`),
      '# Summary\n\nDecisions were made.'
    )
    const payload = await exportMeeting(ENGINE_ROOT, meetingId, 'md', 'Standup')
    expect(String(payload.body).startsWith('# Summary')).toBe(true)
    expect(payload.body).toContain('Decisions were made.')
    expect(payload.body).toContain('# Transcript')
  })

  it('degrades to a neutral unavailable preview for a meeting with no screen video', async () => {
    const preview = await previewExportMeeting(ENGINE_ROOT, meetingId, 'video', 'Standup')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/no screen video/i)
    expect(preview.body).toBe('')
  })

  it('degrades to a neutral unavailable preview for a meeting with no audio file', async () => {
    const preview = await previewExportMeeting(ENGINE_ROOT, meetingId, 'audio', 'Standup')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/no audio/i)
  })
})

// Imported meetings take a parameterised output folder, so no os mock is
// needed to hit this branch — it shares the exact same text-format code path.
describe('imported meeting export fallbacks', () => {
  let root: string
  const folderId = 'meeting-x'
  const meetingId = `imported:${folderId}`

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'timbre-export-fallback-'))
    await fs.mkdir(join(root, folderId), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('builds Markdown from segments when NO summary.md exists (no throw)', async () => {
    await fs.writeFile(
      join(root, folderId, 'transcript.json'),
      JSON.stringify({ segments: SEGMENTS, duration: 8 })
    )
    const payload = await exportMeeting(root, meetingId, 'md', 'Design Review')
    expect(payload.body).toContain('# Design Review')
    expect(payload.body).toContain('**Alice** _(00:00:00)_')
    expect(payload.body).not.toContain('---')
  })

  it('prepends summary.md into the Markdown export when present', async () => {
    await fs.writeFile(
      join(root, folderId, 'transcript.json'),
      JSON.stringify({ segments: SEGMENTS, duration: 8 })
    )
    await fs.writeFile(join(root, folderId, 'summary.md'), '# Summary\n\nAll good.')
    const payload = await exportMeeting(root, meetingId, 'md', 'Design Review')
    expect(String(payload.body).startsWith('# Summary')).toBe(true)
    expect(payload.body).toContain('# Transcript')
  })

  it('returns a neutral unavailable preview for JSON when there are no segments', async () => {
    await fs.writeFile(join(root, folderId, 'transcript.json'), JSON.stringify({ segments: [] }))
    const preview = await previewExportMeeting(root, meetingId, 'json', 'Design Review')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/structured transcript/i)
  })

  it('returns a neutral unavailable preview for subtitles when there are no segments', async () => {
    await fs.writeFile(join(root, folderId, 'transcript.json'), JSON.stringify({ segments: [] }))
    const preview = await previewExportMeeting(root, meetingId, 'srt', 'Design Review')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/subtitles/i)
  })

  it('returns a neutral unavailable preview for audio when the WAV is absent', async () => {
    const preview = await previewExportMeeting(root, meetingId, 'audio', 'Design Review')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/no audio/i)
  })

  it('returns a neutral unavailable preview for video (imported meetings have none)', async () => {
    const preview = await previewExportMeeting(root, meetingId, 'video', 'Design Review')
    expect(preview.unavailable).toBe(true)
    expect(preview.message).toMatch(/no screen video/i)
  })

  it('exportMeeting throws a typed ExportUnavailableError for a missing asset', async () => {
    await fs.writeFile(join(root, folderId, 'transcript.json'), JSON.stringify({ segments: [] }))
    await expect(exportMeeting(root, meetingId, 'json', 'Design Review')).rejects.toBeInstanceOf(
      ExportUnavailableError
    )
  })
})
