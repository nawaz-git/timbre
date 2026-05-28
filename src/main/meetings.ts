import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type {
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  SpeakerRecord
} from '../shared/types'
import {
  enrollOrUpdateSpeaker,
  readMeetingSpeakers,
  runBatch,
  writeMeetingSpeakers,
  type BatchEvent
} from './backend'

/**
 * The Swift live-recording engine (`MeetingTranscriber.app`, bundled inside
 * the Electron app under Resources/) writes to its own default folder which
 * doesn't match the per-meeting-subfolder layout `mt-batch` produces. We
 * scan both formats here so the user sees every meeting in a single list,
 * regardless of which engine produced it.
 */
const ENGINE_DEFAULT_ROOT = join(homedir(), 'Downloads', 'MeetingTranscriber')

/** Pretty-print a folder name like `2026-05-28_team-sync` → `Team sync · 2026-05-28`. */
function titleFromFolderName(name: string): string {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})[_\- ]+(.+)$/)
  if (m) {
    const date = m[1]
    const rest = m[2].replace(/[_\-]+/g, ' ').trim()
    return `${rest.charAt(0).toUpperCase()}${rest.slice(1)} · ${date}`
  }
  return name.replace(/[_\-]+/g, ' ')
}

/**
 * Pretty-print an engine-format slug like `20260528_1400_team-sync` →
 * `Team sync · 2026-05-28 14:00`.
 */
function titleFromEnginePrefix(prefix: string): string {
  // Format: YYYYMMDD_HHmm_<slug>
  const m = prefix.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(.+)$/)
  if (!m) return prefix.replace(/[_\-]+/g, ' ')
  const [, yyyy, mm, dd, hh, min, slug] = m
  const niceSlug = slug.replace(/[_\-]+/g, ' ').trim()
  const cap = niceSlug.charAt(0).toUpperCase() + niceSlug.slice(1)
  return `${cap} · ${yyyy}-${mm}-${dd} ${hh}:${min}`
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

interface MetadataFile {
  durationSeconds?: number
  speakers?: SpeakerRecord[]
  speakerCount?: number
  /** User-set display title — overrides the folder-derived default. */
  title?: string
  /** Tag ids applied to this meeting. */
  tags?: string[]
}

interface TranscriptJSON {
  segments: Array<{ speaker: string; start: number; end: number; text: string }>
  duration?: number
  speakerCount?: number
}

/**
 * `mt-batch`-style: each meeting is its own subfolder containing
 * `transcript.txt` (+ json, speakers.json, audio.wav, optional metadata.json).
 */
async function listPerFolderMeetings(root: string): Promise<MeetingSummary[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const results: MeetingSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folderPath = join(root, entry.name)
    const transcriptPath = join(folderPath, 'transcript.txt')
    let stat: import('fs').Stats
    try {
      stat = await fs.stat(transcriptPath)
    } catch {
      continue
    }
    const metadata = await safeReadJson<MetadataFile>(join(folderPath, 'metadata.json'))
    const speakers = await safeReadJson<SpeakerRecord[]>(join(folderPath, 'speakers.json'))
    const transcriptJson = await safeReadJson<TranscriptJSON>(join(folderPath, 'transcript.json'))
    const hasAudio = await pathExists(join(folderPath, 'audio.wav'))
    results.push({
      id: `imported:${entry.name}`,
      title: metadata?.title?.trim() ? metadata.title : titleFromFolderName(entry.name),
      folderPath,
      date: stat.mtime.toISOString(),
      durationSeconds: transcriptJson?.duration ?? metadata?.durationSeconds ?? 0,
      speakerCount:
        transcriptJson?.speakerCount ?? speakers?.length ?? metadata?.speakerCount ?? 0,
      hasAudio,
      tagIds: Array.isArray(metadata?.tags) ? metadata.tags : []
    })
  }
  return results
}

/**
 * meeting-transcriber-style: `<root>/protocols/YYYYMMDD_HHmm_<slug>.{txt,md}`
 * plus `<root>/recordings/YYYYMMDD_HHmm_<slug>_app.wav` etc.
 */
async function listEnginePrefixMeetings(root: string): Promise<MeetingSummary[]> {
  const protocolsDir = join(root, 'protocols')
  let entries: string[]
  try {
    entries = await fs.readdir(protocolsDir)
  } catch {
    return []
  }
  const results: MeetingSummary[] = []
  const seenPrefixes = new Set<string>()
  for (const filename of entries) {
    // Only treat `.txt` as the canonical transcript marker. `.md` is the
    // structured protocol that sits next to it.
    if (!filename.endsWith('.txt')) continue
    const prefix = filename.slice(0, -4)
    if (seenPrefixes.has(prefix)) continue
    seenPrefixes.add(prefix)
    const txtPath = join(protocolsDir, filename)
    let stat: import('fs').Stats
    try {
      stat = await fs.stat(txtPath)
    } catch {
      continue
    }
    // The "folder" we surface is the engine root; "Show in Finder" reveals
    // both protocols/ and recordings/. Storing the protocols dir gives the
    // most useful Finder context for a live recording.
    results.push({
      id: `engine:${prefix}`,
      title: titleFromEnginePrefix(prefix),
      folderPath: protocolsDir,
      date: stat.mtime.toISOString(),
      durationSeconds: 0, // engine doesn't write duration sidecar; left as 0
      speakerCount: 0, // engine doesn't write speakers sidecar; left as 0
      hasAudio: false, // engine recordings live in ../recordings/ with different naming
      tagIds: []
    })
  }
  return results
}

/**
 * List all meetings the user has — file-imports (`mt-batch` subfolder format)
 * plus live recordings (`MeetingTranscriber.app` flat-prefix format).
 * De-duped and sorted newest-first.
 */
export async function listMeetings(outputFolder: string): Promise<MeetingSummary[]> {
  const [imported, engineDefault] = await Promise.all([
    listPerFolderMeetings(outputFolder),
    listEnginePrefixMeetings(ENGINE_DEFAULT_ROOT)
  ])
  // If the user happens to point the Electron output folder at the engine
  // default, we'd otherwise scan it twice; de-dupe by folderPath+id.
  const seen = new Set<string>()
  const merged: MeetingSummary[] = []
  for (const m of [...imported, ...engineDefault]) {
    const key = `${m.id}|${m.folderPath}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(m)
  }
  merged.sort((a, b) => (a.date < b.date ? 1 : -1))
  return merged
}

/**
 * Read a meeting's transcript. Routes to the right backing format based on
 * the id prefix this module assigns in `list*Meetings`.
 */
export async function readTranscript(
  outputFolder: string,
  meetingId: string
): Promise<MeetingTranscript> {
  if (meetingId.includes('..') || meetingId.includes('/') || meetingId.includes('\\')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }

  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    const txtPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.txt`)
    const mdPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.md`)
    let transcript = ''
    try {
      transcript = await fs.readFile(txtPath, 'utf-8')
    } catch {
      // Fall back to the .md protocol if the raw transcript is missing.
      try {
        transcript = await fs.readFile(mdPath, 'utf-8')
      } catch {
        transcript = ''
      }
    }
    return { meetingId, transcript, speakers: [] }
  }

  // Default (imported) path — strip optional `imported:` prefix for legacy compatibility.
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)
  let transcript = ''
  try {
    transcript = await fs.readFile(join(folder, 'transcript.txt'), 'utf-8')
  } catch {
    transcript = ''
  }
  const speakers = (await safeReadJson<SpeakerRecord[]>(join(folder, 'speakers.json'))) ?? []
  const tj = await safeReadJson<TranscriptJSON>(join(folder, 'transcript.json'))
  return {
    meetingId,
    transcript,
    speakers,
    segments: tj?.segments,
    durationSeconds: tj?.duration
  }
}

/**
 * For Settings UI: report whether the engine default folder exists so the UI
 * can show a "live recordings folder" link.
 */
export async function engineDefaultRootExists(): Promise<boolean> {
  return pathExists(ENGINE_DEFAULT_ROOT)
}

export const liveRecordingsRoot = ENGINE_DEFAULT_ROOT

// Re-export so the IPC layer can use it without an extra path import.
export { basename }

// ─── Mutations ───────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rename one speaker label inside a meeting's transcript files AND enrol
 * the corresponding voice in the global speakers DB. The next file import
 * (or re-analysis) will then auto-recognise the named voice.
 *
 * Throws if the meeting doesn't have a `speakers.json` (e.g. live-recording
 * format produced by MeetingTranscriber.app — those don't carry centroids
 * we can enrol from, only flat transcript text).
 */
export async function renameSpeakerInMeeting(
  outputFolder: string,
  meetingId: string,
  oldName: string,
  newName: string
): Promise<{ enrolled: boolean }> {
  if (oldName === newName) return { enrolled: false }
  if (!newName.trim()) throw new Error('New name must not be empty')
  if (meetingId.startsWith('engine:')) {
    throw new Error(
      'Live-recording meetings (from the menu-bar engine) cannot be renamed yet — only file imports carry the speaker embeddings needed for cross-meeting matching.'
    )
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)

  // 1. Pull the centroid from the per-meeting speakers.json so we can enrol it.
  const speakers = await readMeetingSpeakers(folder)
  const entry = speakers.find((s) => s.name === oldName)
  let enrolled = false
  if (entry) {
    await enrollOrUpdateSpeaker(
      newName,
      entry.centroid,
      entry.centroidSampleCount,
      entry.embeddings?.[0]
    )
    entry.name = newName
    enrolled = true
  }

  // 2. Rewrite the meeting's own speakers.json so subsequent navigations
  //    of THIS meeting also show the new name.
  if (entry) await writeMeetingSpeakers(folder, speakers)

  // 3. Patch transcript.txt — replace `oldName:` with `newName:` at line
  //    boundaries to avoid clobbering text containing the same string.
  const txtPath = join(folder, 'transcript.txt')
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const re = new RegExp('(\\[\\d\\d:\\d\\d:\\d\\d\\] )' + escapeRegex(oldName) + '(:)', 'g')
    const next = raw.replace(re, '$1' + newName + '$2')
    if (next !== raw) await fs.writeFile(txtPath, next, 'utf-8')
  } catch {
    // transcript.txt may not exist on partial outputs — non-fatal.
  }

  // 4. Patch transcript.json — update each segment's speaker field.
  const jsonPath = join(folder, 'transcript.json')
  try {
    const raw = await fs.readFile(jsonPath, 'utf-8')
    interface TJSON {
      segments?: Array<{ speaker?: string; [k: string]: unknown }>
      [k: string]: unknown
    }
    const parsed = JSON.parse(raw) as TJSON
    if (parsed.segments) {
      for (const seg of parsed.segments) {
        if (seg.speaker === oldName) seg.speaker = newName
      }
      await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8')
    }
  } catch {
    // transcript.json may not exist; non-fatal.
  }

  return { enrolled }
}

/**
 * Re-run the mt-batch pipeline on an existing meeting's `audio.wav` with a
 * fresh `--num-speakers` hint. Useful when the default diarization
 * collapsed to one speaker.
 */
export async function reanalyzeMeeting(opts: {
  outputFolder: string
  meetingId: string
  jobId: string
  numSpeakers?: number
  onEvent?: (ev: BatchEvent) => void
}): Promise<string> {
  if (opts.meetingId.startsWith('engine:')) {
    throw new Error(
      'Live-recording meetings cannot be re-analysed from the Electron UI yet — their audio lives next to the engine output and uses a different pipeline.'
    )
  }
  const folderId = opts.meetingId.startsWith('imported:')
    ? opts.meetingId.slice('imported:'.length)
    : opts.meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${opts.meetingId}`)
  }
  const folder = join(opts.outputFolder, folderId)
  const audio = join(folder, 'audio.wav')
  try {
    await fs.access(audio)
  } catch {
    throw new Error(`No audio.wav in ${folder} — cannot re-analyse without the source recording`)
  }
  return runBatch({
    jobId: opts.jobId,
    inputFile: audio,
    outputDir: folder,
    numSpeakers: opts.numSpeakers,
    onEvent: opts.onEvent ?? ((): void => {})
  })
}

/** Convenience: convert a NumSpeakersHint into the integer arg, or undefined. */
export function numSpeakersHintToInt(hint: NumSpeakersHint | undefined): number | undefined {
  if (typeof hint === 'number') return hint
  return undefined
}

/**
 * Update the tags applied to a meeting. The `tagIds` are user-managed
 * identifiers from the global tag list; we don't validate them against the
 * tag store here (the renderer-side picker only surfaces real ones, and
 * keeping a stale tag id is harmless — the list view filters out unknowns).
 */
export async function setMeetingTags(
  outputFolder: string,
  meetingId: string,
  tagIds: string[]
): Promise<{ tagIds: string[] }> {
  if (meetingId.startsWith('engine:')) {
    throw new Error('Live-recording meetings cannot be tagged from the Electron UI yet.')
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)
  const metaPath = join(folder, 'metadata.json')
  const existing = (await safeReadJson<MetadataFile>(metaPath)) ?? {}
  // De-dupe + reject empties.
  const clean = Array.from(new Set(tagIds.filter((t) => typeof t === 'string' && t.length > 0)))
  existing.tags = clean
  await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
  return { tagIds: clean }
}

/**
 * Set or clear the user-set title for an imported meeting. Stored inside the
 * meeting folder as `metadata.json` so the title survives re-analysis and
 * re-installation of the Electron app.
 */
export async function renameMeetingTitle(
  outputFolder: string,
  meetingId: string,
  newTitle: string
): Promise<{ title: string }> {
  if (meetingId.startsWith('engine:')) {
    throw new Error('Live-recording meetings cannot be renamed from the Electron UI yet.')
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const trimmed = newTitle.trim()
  const folder = join(outputFolder, folderId)
  const metaPath = join(folder, 'metadata.json')
  const existing = (await safeReadJson<MetadataFile>(metaPath)) ?? {}
  if (trimmed) {
    existing.title = trimmed
  } else {
    delete existing.title
  }
  await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
  return {
    title: existing.title?.trim() ? existing.title : titleFromFolderName(folderId)
  }
}

// ─── Export helpers ─────────────────────────────────────────────────────

function formatTimestampHHMMSS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

function formatTimestampSRT(seconds: number): string {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const ms = Math.floor((total - Math.floor(total)) * 1000)
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  )
}

interface ExportPayload {
  /** Suggested filename (with extension). */
  filename: string
  /** Body bytes (UTF-8 string for text formats, raw bytes for audio). */
  body: string | Buffer
  /** MIME type — purely advisory; the renderer uses this to set the dialog filter. */
  contentType: string
}

/**
 * Build an export payload for a meeting in the requested format. Returns
 * the bytes ready to write to the user's chosen path; the renderer triggers
 * the Save dialog separately.
 */
export async function exportMeeting(
  outputFolder: string,
  meetingId: string,
  format: 'txt' | 'md' | 'json' | 'srt' | 'audio',
  title: string
): Promise<ExportPayload> {
  if (meetingId.startsWith('engine:')) {
    if (format !== 'txt' && format !== 'md') {
      throw new Error(`Live-recording meetings only support txt/md export, not ${format}.`)
    }
    const prefix = meetingId.slice('engine:'.length)
    const srcExt = format === 'md' ? 'md' : 'txt'
    const srcPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.${srcExt}`)
    const body = await fs.readFile(srcPath, 'utf-8')
    return {
      filename: `${prefix}.${srcExt}`,
      body,
      contentType: format === 'md' ? 'text/markdown' : 'text/plain'
    }
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)
  const safeTitle = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || folderId

  if (format === 'audio') {
    const body = await fs.readFile(join(folder, 'audio.wav'))
    return { filename: `${safeTitle}.wav`, body, contentType: 'audio/wav' }
  }
  if (format === 'txt') {
    const body = await fs.readFile(join(folder, 'transcript.txt'), 'utf-8')
    return { filename: `${safeTitle}.txt`, body, contentType: 'text/plain' }
  }
  if (format === 'json') {
    const body = await fs.readFile(join(folder, 'transcript.json'), 'utf-8')
    return { filename: `${safeTitle}.json`, body, contentType: 'application/json' }
  }

  // For md and srt we synthesise from transcript.json.
  const tjRaw = await fs.readFile(join(folder, 'transcript.json'), 'utf-8')
  const tj = JSON.parse(tjRaw) as TranscriptJSON
  const segments = tj.segments ?? []

  if (format === 'md') {
    const lines: string[] = [`# ${title}`, '']
    for (const seg of segments) {
      lines.push(
        `**${seg.speaker}** _(${formatTimestampHHMMSS(seg.start)})_`,
        '',
        seg.text.trim(),
        ''
      )
    }
    return { filename: `${safeTitle}.md`, body: lines.join('\n'), contentType: 'text/markdown' }
  }

  // SRT
  const srtLines: string[] = []
  segments.forEach((seg, i) => {
    srtLines.push(
      String(i + 1),
      `${formatTimestampSRT(seg.start)} --> ${formatTimestampSRT(seg.end)}`,
      `${seg.speaker}: ${seg.text.trim()}`,
      ''
    )
  })
  return {
    filename: `${safeTitle}.srt`,
    body: srtLines.join('\n'),
    contentType: 'application/x-subrip'
  }
}
