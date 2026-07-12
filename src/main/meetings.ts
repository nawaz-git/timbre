import { shell } from 'electron'
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type {
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  SpeakerRecord,
  StorageUsage,
  TranscriptSearchHit
} from '../shared/types'
import {
  enrollOrUpdateSpeaker,
  isEngineProcessAlive,
  readMeetingSpeakers,
  runBatch,
  writeMeetingSpeakers,
  type BatchEvent
} from './backend'
import { getLivePlaceholder } from './captureWatchdog'
import {
  bracketToSeconds,
  ENGINE_TXT_LINE_RE,
  looksPreDiarizationSpeakers,
  parseEngineTxtSegments
} from './engineTranscript'
import { isRefineMarkerActive } from './engineRefineStatus'

/**
 * The Swift live-recording engine (`MeetingTranscriber.app`, bundled inside
 * the Electron app under Resources/) writes to its own default folder which
 * doesn't match the per-meeting-subfolder layout `mt-batch` produces. We
 * scan both formats here so the user sees every meeting in a single list,
 * regardless of which engine produced it.
 */
const ENGINE_DEFAULT_ROOT = join(homedir(), 'Downloads', 'MeetingTranscriber')

/**
 * Pretty-print a folder name like
 * `2026-05-28_10-41-22_2026-05-23-api-as-a-service-strategy`
 * → `API as a service strategy`.
 *
 * Folders produced by mt-batch encode the import timestamp first
 * (`YYYY-MM-DD_HH-MM-SS_`) followed by the source filename — which itself
 * often begins with its own `YYYY-MM-DD-` date prefix. We strip both, then
 * convert the human-readable slug to sentence case. The first word, if it's
 * a short all-lowercase token (≤4 chars, e.g. `api`, `eod`, `ml`), is
 * upper-cased on the assumption it's an acronym.
 */
function titleFromFolderName(name: string): string {
  let rest = name
  // 1. Strip the mt-batch import-timestamp prefix `YYYY-MM-DD_HH-MM-SS_`.
  const importPrefix = rest.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)$/)
  if (importPrefix) rest = importPrefix[1]
  // 2. Strip a leading source-filename date `YYYY-MM-DD-` (or `YYYY-MM-DD_`).
  rest = rest.replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')
  // 3. Replace separators with spaces and collapse whitespace.
  rest = rest.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!rest) return name
  // 4. Sentence-case: capitalize the first character; if the first word is a
  //    short all-lowercase token (2-3 letters) it's almost certainly an
  //    acronym (api, eod, ml, ai, ux …) so uppercase it instead. 4+ letter
  //    words like "team" or "just" fall through to plain capitalization.
  const parts = rest.split(' ')
  const first = parts[0]
  if (/^[a-z]{2,3}$/.test(first)) {
    parts[0] = first.toUpperCase()
  } else {
    parts[0] = first.charAt(0).toUpperCase() + first.slice(1)
  }
  return parts.join(' ')
}

/**
 * A raw Google Meet id slug like `meet__ifh-kkfh-dzg_` — opaque to a human,
 * so we surface a weekday + time instead of it (see `formatMeetTitle`).
 */
const MEET_ID_SLUG_RE = /^meet__?[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}_?$/

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * Human title for a meeting whose slug is just the opaque Google Meet id:
 * `Meet · Wed 2:00 PM`. The row meta already carries the full date, so the
 * title stays short. Deterministic (no locale lookup) so it renders the same
 * on every machine. `month` is 1-based. Pure — unit-testable.
 */
export function formatMeetTitle(
  year: number,
  month: number,
  day: number,
  hour24: number,
  minute: number
): string {
  const d = new Date(year, month - 1, day, hour24, minute)
  const weekday = WEEKDAY_ABBR[d.getDay()]
  const h12 = hour24 % 12 || 12
  const ampm = hour24 < 12 ? 'AM' : 'PM'
  return `Meet · ${weekday} ${h12}:${String(minute).padStart(2, '0')} ${ampm}`
}

/**
 * Extract the first Markdown H1 (`# `) heading from summary text, trimmed.
 * Returns null when there's no level-1 heading. Used to auto-title an engine
 * meeting from its LLM summary when the user hasn't set a title. Only `#`
 * (H1) counts — deeper headings are section titles, not the document title.
 * Pure — unit-testable.
 */
export function firstMarkdownHeading(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.match(/^#[ \t]+(.+?)[ \t]*$/)
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

/**
 * Pretty-print an engine-format slug like `20260528_1400_team-sync` →
 * `Team sync · 2026-05-28 14:00`. An opaque Meet-id slug instead becomes
 * `Meet · <Weekday> <h:mm a>`.
 */
function titleFromEnginePrefix(prefix: string): string {
  // Format: YYYYMMDD_HHmm_<slug>
  const m = prefix.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(.+)$/)
  if (!m) return prefix.replace(/[_\-]+/g, ' ')
  const [, yyyy, mm, dd, hh, min, slug] = m
  if (MEET_ID_SLUG_RE.test(slug)) {
    return formatMeetTitle(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min))
  }
  const niceSlug = slug.replace(/[_\-]+/g, ' ').trim()
  const cap = niceSlug.charAt(0).toUpperCase() + niceSlug.slice(1)
  return `${cap} · ${yyyy}-${mm}-${dd} ${hh}:${min}`
}

/**
 * Read the first `# ` heading from an engine meeting's `.md` summary, scanning
 * only the first 500 bytes. Used to derive a human title after the LLM protocol
 * lands, when the user hasn't set one. Returns null when the file or a heading
 * is absent.
 */
async function readEngineSummaryHeading(prefix: string): Promise<string | null> {
  const mdPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.md`)
  let handle: import('fs').promises.FileHandle
  try {
    handle = await fs.open(mdPath, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(500)
    const { bytesRead } = await handle.read(buf, 0, 500, 0)
    return firstMarkdownHeading(buf.toString('utf-8', 0, bytesRead))
  } catch {
    return null
  } finally {
    await handle.close()
  }
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

/** Distinct, trimmed, non-empty strings preserving first-seen order. */
function uniqueNonEmpty(names: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const v = (n ?? '').trim()
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

interface MetadataFile {
  durationSeconds?: number
  speakers?: SpeakerRecord[]
  speakerCount?: number
  /** User-set display title — overrides the folder-derived default. */
  title?: string
  /** Tag ids applied to this meeting. */
  tags?: string[]
  /**
   * Speakers the user explicitly added to this meeting (people who were
   * present but not auto-detected by diarization). Surfaced in the
   * per-segment reassignment picker.
   */
  additionalSpeakers?: string[]
}

interface TranscriptJSON {
  segments: Array<{ speaker: string; start: number; end: number; text: string }>
  duration?: number
  speakerCount?: number
}

/**
 * v0.17+: engine-format sidecar discovery.
 *
 * The bundled Swift engine writes its output across TWO subfolders:
 *
 *   <root>/protocols/<prefix>.txt                  ← human-readable transcript
 *   <root>/recordings/<prefix>_mix.wav             ← mixed audio (playback)
 *   <root>/recordings/<prefix>_app.wav             ← Meet tab audio only
 *   <root>/recordings/<prefix>_mic.wav             ← user mic only
 *   <root>/recordings/<prefix><runId>_segments.json ← diarized segments
 *
 * v0.12-v0.16 only looked at protocols/<prefix>.txt and hardcoded
 * durationSeconds=0, speakerCount=0, hasAudio=false. This helper pulls
 * the rich metadata so the Meetings list shows real duration / speaker
 * count, the transcript view shows structured + diarized segments, and
 * the audio player has a playable file.
 */
async function findEngineSidecars(
  root: string,
  prefix: string
): Promise<{ segmentsPath: string | null; audioPath: string | null; videoPath: string | null }> {
  const recordingsDir = join(root, 'recordings')
  let entries: string[]
  try {
    entries = await fs.readdir(recordingsDir)
  } catch {
    return { segmentsPath: null, audioPath: null, videoPath: null }
  }
  let segmentsPath: string | null = null
  let mixPath: string | null = null
  let appPath: string | null = null
  let micPath: string | null = null
  let videoPath: string | null = null
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue
    if (e.endsWith('_segments.json')) {
      segmentsPath = join(recordingsDir, e)
    } else if (e.endsWith('_mix.wav')) {
      mixPath = join(recordingsDir, e)
    } else if (e.endsWith('_app.wav')) {
      appPath = join(recordingsDir, e)
    } else if (e.endsWith('_mic.wav')) {
      micPath = join(recordingsDir, e)
    } else if (e.endsWith('_screen.mp4')) {
      videoPath = join(recordingsDir, e)
    }
  }
  // Prefer mixed audio (everyone), fall back to app (remote-only), then mic (local-only).
  return { segmentsPath, audioPath: mixPath ?? appPath ?? micPath, videoPath }
}

interface EngineSegmentJSON {
  text: string
  start: number
  end: number
  speaker: string
}

/**
 * Public helper for the mt-audio:// protocol handler to resolve an
 * engine-format meeting id to its audio file path. Same prefix-match
 * logic as findEngineSidecars but exposes just the audio path.
 */
export async function findEngineAudioForPrefix(prefix: string): Promise<string | null> {
  const { audioPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
  return audioPath
}

/**
 * Public helper for the mt-audio:// protocol handler to resolve an
 * engine-format meeting id to its whole-screen video file path. Same
 * prefix-match logic as findEngineSidecars but exposes just the video path.
 */
export async function findEngineVideoForPrefix(prefix: string): Promise<string | null> {
  const { videoPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
  return videoPath
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
    const hasVideo = await pathExists(join(folderPath, 'screen.mp4'))
    // Speaker names for search — from speakers.json labels, else segments.
    const speakerNames =
      speakers && speakers.length > 0
        ? uniqueNonEmpty(speakers.map((s) => s.label))
        : transcriptJson?.segments
          ? uniqueNonEmpty(transcriptJson.segments.map((s) => s.speaker))
          : []
    results.push({
      id: `imported:${entry.name}`,
      title: metadata?.title?.trim() ? metadata.title : titleFromFolderName(entry.name),
      folderPath,
      date: stat.mtime.toISOString(),
      durationSeconds: transcriptJson?.duration ?? metadata?.durationSeconds ?? 0,
      speakerCount:
        transcriptJson?.speakerCount ?? speakers?.length ?? metadata?.speakerCount ?? 0,
      hasAudio,
      hasVideo,
      tagIds: Array.isArray(metadata?.tags) ? metadata.tags : [],
      additionalSpeakers: Array.isArray(metadata?.additionalSpeakers)
        ? metadata.additionalSpeakers
        : [],
      speakerNames
    })
  }
  return results
}

/**
 * meeting-transcriber-style: `<root>/protocols/YYYYMMDD_HHmm_<slug>.{txt,md}`
 * plus `<root>/recordings/YYYYMMDD_HHmm_<slug>_app.wav` etc.
 */
/**
 * Sidecar that stores the user-set title + tags for an engine (live-recording)
 * meeting. Engine recordings are flat files (no per-meeting folder), so we keep
 * a `<prefix>.meta.json` next to the protocol `.txt`. Only `.txt` files are
 * treated as meetings by the lister, so this sidecar never shows up as a phantom
 * meeting. Mirrors the `metadata.json` mechanism used for imported folders.
 */
function engineMetaPath(prefix: string): string {
  return join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.meta.json`)
}

/**
 * Resolve the metadata-file path for a meeting id, abstracting over the two
 * backing stores: engine recordings → `protocols/<prefix>.meta.json`; imported
 * folders → `<outputFolder>/<folder>/metadata.json`. Throws for `live:` ids
 * (no file on disk yet) and malformed ids.
 */
function engineOrFolderMetaPath(outputFolder: string, meetingId: string): string {
  if (meetingId.startsWith('live:')) {
    throw new Error('A live recording in progress has not been saved yet — try again once it ends.')
  }
  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
      throw new Error(`Invalid engine prefix: ${prefix}`)
    }
    return engineMetaPath(prefix)
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  return join(outputFolder, folderId, 'metadata.json')
}

/** Filename-derived fallback title for a meeting id (when no user-set title). */
function fallbackTitleForId(meetingId: string): string {
  if (meetingId.startsWith('engine:')) {
    return titleFromEnginePrefix(meetingId.slice('engine:'.length))
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  return titleFromFolderName(folderId)
}

/**
 * Rewrite an engine meeting's protocol `.txt`, renaming every `oldName:`
 * speaker label. Handles the engine's `[MM:SS]` / `[H:MM:SS]` timestamps as
 * well as the `[HH:MM:SS]` form. Non-fatal if the file is absent.
 */
async function patchEngineTxtRename(
  prefix: string,
  oldName: string,
  newName: string
): Promise<void> {
  const txtPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.txt`)
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const re = new RegExp(
      '(\\[(?:\\d{1,2}:)?\\d{1,2}:\\d{1,2}\\]\\s+)' + escapeRegex(oldName) + '(:)',
      'g'
    )
    const next = raw.replace(re, `$1${newName}$2`)
    if (next !== raw) await fs.writeFile(txtPath, next, 'utf-8')
  } catch {
    // .txt may be absent on partial output — non-fatal.
  }
}

/**
 * Rewrite ONLY the Nth timestamped line of an engine meeting's `.txt`, matching
 * the segment ordering used by the structured `segments.json`. Lines without a
 * timestamped speaker prefix are passed through unchanged.
 */
async function patchEngineTxtByIndex(
  prefix: string,
  segmentIndex: number,
  newSpeaker: string
): Promise<void> {
  const txtPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.txt`)
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const lines = raw.split('\n')
    const lineRe = ENGINE_TXT_LINE_RE
    let matched = -1
    for (let i = 0; i < lines.length; i++) {
      if (lineRe.test(lines[i])) {
        matched++
        if (matched === segmentIndex) {
          lines[i] = lines[i].replace(lineRe, `$1$2${newSpeaker}$4`)
          break
        }
      }
    }
    if (matched >= segmentIndex) await fs.writeFile(txtPath, lines.join('\n'), 'utf-8')
  } catch {
    // non-fatal
  }
}

/**
 * Cluster rename inside an engine (live-recording) meeting: relabel every
 * matching segment in the structured `segments.json` and the protocol `.txt`.
 * Engine recordings carry no centroids, so there is nothing to enrol — the
 * rename is applied directly to the transcript and is therefore fully
 * propagated in one shot (no re-analysis needed).
 */
async function renameEngineSpeaker(
  prefix: string,
  oldName: string,
  newName: string
): Promise<void> {
  const { segmentsPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
  if (segmentsPath) {
    const segs = await safeReadJson<EngineSegmentJSON[]>(segmentsPath)
    if (Array.isArray(segs)) {
      let changed = false
      for (const s of segs) {
        if (s.speaker === oldName) {
          s.speaker = newName
          changed = true
        }
      }
      if (changed) await fs.writeFile(segmentsPath, JSON.stringify(segs, null, 2), 'utf-8')
    }
  }
  await patchEngineTxtRename(prefix, oldName, newName)
}

/**
 * Count distinct speaker names in an engine meeting's flat protocol `.txt`,
 * using the SAME line regex as `patchEngineTxtByIndex`. Used as the fallback
 * speaker count for `.txt`-only meetings (no `segments.json`). Returns 0 when
 * the file is absent or has no timestamped speaker lines.
 */
async function countTxtSpeakers(prefix: string): Promise<number> {
  const txtPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.txt`)
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const names = new Set<string>()
    for (const line of raw.split('\n')) {
      const m = line.match(ENGINE_TXT_LINE_RE)
      if (m) {
        const name = m[3].trim()
        if (name) names.add(name)
      }
    }
    return names.size
  } catch {
    return 0
  }
}

/**
 * Per-segment reassignment inside an engine meeting. Patches the structured
 * `segments.json` at `segmentIndex` and the matching `.txt` line. Returns the
 * new distinct speaker count.
 *
 * When the meeting has NO `segments.json` (a `.txt`-only live recording surfaced
 * via the renderer's flat-text fallback parser), this degrades gracefully —
 * mirroring `renameEngineSpeaker` — patching only the protocol `.txt` line by
 * index and deriving the speaker count from the `.txt` instead of throwing.
 */
async function reassignEngineSegment(
  prefix: string,
  segmentIndex: number,
  newSpeaker: string
): Promise<number> {
  const { segmentsPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
  if (!segmentsPath) {
    // .txt-only fallback: no structured segments to write, but the renderer's
    // flat-text row index lines up 1:1 with patchEngineTxtByIndex's Nth match.
    await patchEngineTxtByIndex(prefix, segmentIndex, newSpeaker)
    return countTxtSpeakers(prefix)
  }
  const segs = await safeReadJson<EngineSegmentJSON[]>(segmentsPath)
  if (!Array.isArray(segs) || segmentIndex >= segs.length) {
    throw new Error(`Segment index ${segmentIndex} out of range`)
  }
  segs[segmentIndex].speaker = newSpeaker
  await fs.writeFile(segmentsPath, JSON.stringify(segs, null, 2), 'utf-8')
  await patchEngineTxtByIndex(prefix, segmentIndex, newSpeaker)
  return new Set(segs.map((s) => s.speaker).filter((v) => v && v.length > 0)).size
}

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
  // Engine-alive is only consulted when a fresh `.refining` marker exists
  // (rare), so probe for the helper process lazily and at most once per call.
  let engineAliveMemo: boolean | undefined
  const engineAlive = (): boolean => {
    if (engineAliveMemo === undefined) engineAliveMemo = isEngineProcessAlive()
    return engineAliveMemo
  }
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
    // v0.17+: read the engine's sidecar files to surface real duration,
    // speaker count, and audio availability instead of hardcoded zeroes.
    const { segmentsPath, audioPath, videoPath } = await findEngineSidecars(root, prefix)
    let durationSeconds = 0
    let speakerCount = 0
    let speakerNames: string[] = []
    if (segmentsPath) {
      const segs = await safeReadJson<EngineSegmentJSON[]>(segmentsPath)
      if (Array.isArray(segs) && segs.length > 0) {
        durationSeconds = Math.ceil(Math.max(...segs.map((s) => s.end ?? 0)))
        speakerNames = uniqueNonEmpty(segs.map((s) => s.speaker))
        speakerCount = speakerNames.length
      }
    } else {
      // .txt-only meeting (no structured segments.json): derive stats from the
      // flat protocol transcript so the header never reads "0:00 · 0 speakers".
      // Speaker count = distinct timestamped-line names; duration = the LAST
      // timestamp's start seconds (approximate — under-reports true audio length
      // but satisfies the "never show 0:00" requirement without extra I/O).
      try {
        const raw = await fs.readFile(txtPath, 'utf-8')
        const names: string[] = []
        let lastStart = 0
        for (const line of raw.split('\n')) {
          const m = line.match(ENGINE_TXT_LINE_RE)
          if (!m) continue
          const name = m[3].trim()
          if (name) names.push(name)
          lastStart = bracketToSeconds(m[1])
        }
        speakerNames = uniqueNonEmpty(names)
        speakerCount = speakerNames.length
        durationSeconds = lastStart
      } catch {
        // .txt unreadable — leave both at 0.
      }
    }

    // User-set title/tags live in the sidecar (written by renameMeetingTitle /
    // setMeetingTags). Fall back to the LLM summary's first heading when it
    // exists (a far better default than the raw slug), then to the
    // filename-derived title. Never overwrites a user-set `meta.title`.
    const meta = await safeReadJson<MetadataFile>(engineMetaPath(prefix))
    // MAX-tier refine in flight: the FAST transcript already landed (this row
    // exists), but the engine is re-writing it. A `<prefix>.refining` marker
    // signals that; the engine removes it on completion. A crash/quit/kill
    // mid-refine can orphan the marker, so it only counts as `refining` while
    // it is fresh AND a helper process is alive to finish the job — otherwise
    // the meeting falls back to `ready` (the FAST transcript is usable).
    let refining = false
    try {
      const marker = await fs.stat(join(protocolsDir, `${prefix}.refining`))
      refining = isRefineMarkerActive({
        markerMtimeMs: marker.mtimeMs,
        nowMs: Date.now(),
        engineAlive: engineAlive()
      })
    } catch {
      // No marker (or unreadable) — not refining.
    }
    // User-set title wins; otherwise prefer the LLM summary's first heading,
    // then the filename-derived (human Meet) title over the raw slug.
    const autoTitle = meta?.title?.trim()
      ? meta.title
      : ((await readEngineSummaryHeading(prefix)) ?? titleFromEnginePrefix(prefix))
    results.push({
      id: `engine:${prefix}`,
      title: autoTitle,
      folderPath: protocolsDir,
      date: stat.mtime.toISOString(),
      durationSeconds,
      speakerCount,
      hasAudio: audioPath !== null,
      hasVideo: videoPath !== null,
      tagIds: Array.isArray(meta?.tags) ? meta.tags : [],
      additionalSpeakers: Array.isArray(meta?.additionalSpeakers)
        ? meta.additionalSpeakers
        : [],
      speakerNames,
      // A landed protocols/<prefix>.txt means the engine's FAST pipeline
      // finished (ready) — unless a refine marker says a MAX upgrade is
      // rewriting it right now.
      status: refining ? 'refining' : 'ready'
    })
  }
  return results
}

/**
 * Distinct raw-recording suffixes the engine writes the instant a meeting
 * stops (BEFORE its transcribe → diarize → protocol pipeline runs). Presence
 * of one of these with NO `protocols/<prefix>.txt` yet is the cleanest
 * Electron-only "this meeting is still processing" signal.
 */
const RAW_AUDIO_SUFFIXES = ['_mix.wav', '_app.wav', '_mic.wav'] as const

/**
 * Surface meetings that have FINISHED recording but whose engine pipeline
 * hasn't produced a transcript yet. The engine writes the raw audio
 * (`recordings/<prefix>_{mix,app,mic}.wav`, optional `<prefix>_screen.mp4`)
 * immediately when recording stops, then runs transcribe → diarize →
 * protocol which lands `protocols/<prefix>.txt` LATER. During that window the
 * `.txt`-only lister (`listEnginePrefixMeetings`) shows nothing, so the just-
 * ended meeting is invisible in Recent / Meetings — the core complaint.
 *
 * This scanner does ONE `readdir` of `recordings/`, collects the distinct
 * prefixes that have a raw audio file, and emits a `status: 'processing'`
 * `MeetingSummary` for each prefix whose `protocols/<prefix>.txt` does NOT
 * exist yet (so once the `.txt` lands, the ready row from
 * `listEnginePrefixMeetings` supersedes this one — no transient duplicate).
 *
 * `folderPath` is the protocols dir so it matches the ready row's
 * `folderPath`, letting `listMeetings`' `id|folderPath` de-dupe key collapse
 * the two if they ever briefly coexist. Takes `root` as a parameter so it is
 * testable without the module-level `ENGINE_DEFAULT_ROOT` const.
 */
async function listEngineProcessingMeetings(root: string): Promise<MeetingSummary[]> {
  const recordingsDir = join(root, 'recordings')
  let entries: string[]
  try {
    entries = await fs.readdir(recordingsDir)
  } catch {
    return []
  }
  // First pass: collect distinct prefixes that have a raw audio file, and note
  // per-prefix which sidecars exist — all from the single readdir above.
  const prefixes = new Set<string>()
  const hasScreen = new Set<string>()
  for (const e of entries) {
    const rawSuffix = RAW_AUDIO_SUFFIXES.find((s) => e.endsWith(s))
    if (rawSuffix) {
      prefixes.add(e.slice(0, -rawSuffix.length))
      continue
    }
    if (e.endsWith('_screen.mp4')) {
      hasScreen.add(e.slice(0, -'_screen.mp4'.length))
    }
  }
  if (prefixes.size === 0) return []

  const protocolsDir = join(root, 'protocols')
  const results: MeetingSummary[] = []
  for (const prefix of prefixes) {
    // Defence in depth: prefixes come from filenames the engine controls
    // (YYYYMMDD_HHmm_<slug>) — skip anything that isn't safe ASCII so a
    // surprise filename can't leak through.
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) continue
    // Skip prefixes whose transcript has already landed — those are handled
    // (as `status: 'ready'`) by listEnginePrefixMeetings. Guarding here avoids
    // a transient double-row at the moment the .txt is written.
    if (await pathExists(join(protocolsDir, `${prefix}.txt`))) continue

    // Date from the raw audio mtime so the row sorts correctly (newest-first).
    // Reuse findEngineSidecars for audio resolution — its startsWith(prefix)
    // match tolerates the `_<runId>_segments.json` infix, and gives the same
    // audioPath the mt-audio:// route resolves, so the card can play now.
    const { audioPath } = await findEngineSidecars(root, prefix)
    let dateIso = new Date().toISOString()
    if (audioPath) {
      try {
        const st = await fs.stat(audioPath)
        dateIso = st.mtime.toISOString()
      } catch {
        // fall back to now
      }
    }
    const meta = await safeReadJson<MetadataFile>(engineMetaPath(prefix))
    results.push({
      id: `engine:${prefix}`,
      title: meta?.title?.trim() ? meta.title : titleFromEnginePrefix(prefix),
      folderPath: protocolsDir,
      date: dateIso,
      durationSeconds: 0,
      speakerCount: 0,
      hasAudio: audioPath !== null,
      hasVideo: hasScreen.has(prefix),
      tagIds: Array.isArray(meta?.tags) ? meta.tags : [],
      additionalSpeakers: Array.isArray(meta?.additionalSpeakers)
        ? meta.additionalSpeakers
        : [],
      // No transcript yet — speakers unknown until the pipeline finishes.
      speakerNames: [],
      status: 'processing'
    })
  }
  return results
}

/**
 * Rich per-prefix scan of engine meetings that are still processing (raw audio
 * present, no `protocols/<prefix>.txt` yet). Feeds the processing-lifecycle
 * tracker in `status.ts`, which infers stage and detects stalls from these
 * fields. Kept separate from `listEngineProcessingMeetings` (which builds
 * `MeetingSummary` rows for the list) so neither has to reshape the other, but
 * they share the same discovery rule. Takes `root` as a parameter so it's
 * testable without the module-level default. `excludePrefix` drops the meeting
 * currently being RECORDED (a growing `_mic.wav` with no transcript yet) so it
 * isn't double-counted as "processing" — recording outranks processing, and the
 * live meeting only enters this scan once capture actually stops.
 */
export interface ProcessingScanEntry {
  /** Bare engine prefix (`YYYYMMDD_HHmm_<slug>`). */
  prefix: string
  title: string
  /** Epoch ms recording ended / processing began (mix-WAV mtime, best-effort). */
  startedAt: number
  /** Recorded length estimate in seconds from the WAV size, when derivable. */
  estDurationSec?: number
  /** True once `<prefix>*_segments.json` exists (diarization produced output). */
  hasSegments: boolean
  /** Newest mtime among all `<prefix>*` files in `recordings/` (activity clock). */
  lastChangeMs: number
}

export async function scanProcessingPrefixes(
  root: string,
  excludePrefix?: string | null
): Promise<ProcessingScanEntry[]> {
  const recordingsDir = join(root, 'recordings')
  let entries: string[]
  try {
    entries = await fs.readdir(recordingsDir)
  } catch {
    return []
  }
  const prefixes = new Set<string>()
  for (const e of entries) {
    const rawSuffix = RAW_AUDIO_SUFFIXES.find((s) => e.endsWith(s))
    if (rawSuffix) prefixes.add(e.slice(0, -rawSuffix.length))
  }
  if (prefixes.size === 0) return []

  const protocolsDir = join(root, 'protocols')
  const results: ProcessingScanEntry[] = []
  for (const prefix of prefixes) {
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) continue
    // The meeting being recorded right now is not "processing" — skip it so the
    // status ladder shows recording, not a phantom concurrent transcribe.
    if (excludePrefix && prefix === excludePrefix) continue
    // A landed transcript means the meeting is READY, not processing.
    if (await pathExists(join(protocolsDir, `${prefix}.txt`))) continue

    let lastChangeMs = 0
    let hasSegments = false
    let startedAt = 0
    let mixPath: string | null = null
    for (const e of entries) {
      if (!e.startsWith(prefix)) continue
      let st: import('fs').Stats
      try {
        st = await fs.stat(join(recordingsDir, e))
      } catch {
        continue
      }
      if (st.mtimeMs > lastChangeMs) lastChangeMs = st.mtimeMs
      if (e.endsWith('_segments.json')) hasSegments = true
      if (e.endsWith('_mix.wav')) {
        startedAt = st.mtimeMs
        mixPath = join(recordingsDir, e)
      }
    }
    const { audioPath } = await findEngineSidecars(root, prefix)
    if (startedAt === 0 && audioPath) {
      try {
        startedAt = (await fs.stat(audioPath)).mtimeMs
      } catch {
        // fall through to the lastChange fallback
      }
    }
    if (startedAt === 0) startedAt = lastChangeMs || Date.now()

    const durationPath = mixPath ?? audioPath
    const estDurationSec = durationPath
      ? ((await estimateWavDurationSec(durationPath)) ?? undefined)
      : undefined

    const meta = await safeReadJson<MetadataFile>(engineMetaPath(prefix))
    results.push({
      prefix,
      title: meta?.title?.trim() ? meta.title : titleFromEnginePrefix(prefix),
      startedAt,
      estDurationSec,
      hasSegments,
      lastChangeMs: lastChangeMs || startedAt
    })
  }
  return results
}

/**
 * Estimate a WAV's recorded seconds from its size and header byteRate (uint32
 * LE at offset 28). Returns null when the file is unreadable or doesn't look
 * like a RIFF/WAVE header — we report "unknown" rather than guess a sample rate.
 * Kept local (rather than importing the capture-signal helper) to avoid a
 * meetings ⇆ captureSignal import cycle.
 */
async function estimateWavDurationSec(path: string): Promise<number | null> {
  let handle: import('fs').promises.FileHandle
  try {
    handle = await fs.open(path, 'r')
  } catch {
    return null
  }
  try {
    const header = Buffer.alloc(44)
    await handle.read(header, 0, 44, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF') return null
    if (header.toString('ascii', 8, 12) !== 'WAVE') return null
    const byteRate = header.readUInt32LE(28)
    if (byteRate <= 0) return null
    const { size } = await handle.stat()
    if (size <= 44) return 0
    return (size - 44) / byteRate
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * List all meetings the user has — file-imports (`mt-batch` subfolder format)
 * plus live recordings (`MeetingTranscriber.app` flat-prefix format).
 * De-duped and sorted newest-first.
 */
export async function listMeetings(outputFolder: string): Promise<MeetingSummary[]> {
  const [imported, engineDefault, engineProcessing] = await Promise.all([
    listPerFolderMeetings(outputFolder),
    listEnginePrefixMeetings(ENGINE_DEFAULT_ROOT),
    listEngineProcessingMeetings(ENGINE_DEFAULT_ROOT)
  ])
  // If the user happens to point the Electron output folder at the engine
  // default, we'd otherwise scan it twice; de-dupe by folderPath+id. The
  // processing rows go LAST so that if a ready row (from listEnginePrefix)
  // and a processing row ever share `id|folderPath` for the same prefix, the
  // ready row is seen first and the processing duplicate is dropped.
  const seen = new Set<string>()
  const merged: MeetingSummary[] = []
  for (const m of [...imported, ...engineDefault, ...engineProcessing]) {
    const key = `${m.id}|${m.folderPath}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(m)
  }

  // TICKET-001: if the watchdog is holding a live placeholder for a
  // Meet that hasn't been written to disk yet, prepend it. We drop the
  // placeholder if any merged entry's id already contains the
  // placeholder's chrome meeting id as a substring — that means the
  // engine has produced the real file (e.g. `engine:20260528_1938_meet__ifh-kkfh-dzg_`
  // contains `ifh-kkfh-dzg`) and the placeholder would otherwise
  // double-show. Matching rule: `engineMeetingId.includes(placeholderMeetingId)`.
  const placeholder = getLivePlaceholder()
  if (placeholder) {
    const alreadyOnDisk = merged.some((m) => m.id.includes(placeholder.meetingId))
    if (!alreadyOnDisk) {
      merged.push({
        id: `live:${placeholder.meetingId}`,
        title: placeholder.title,
        folderPath: ENGINE_DEFAULT_ROOT,
        date: new Date(placeholder.startedAt).toISOString(),
        durationSeconds: 0,
        speakerCount: 0,
        hasAudio: false,
        hasVideo: false,
        tagIds: [],
        additionalSpeakers: [],
        speakerNames: [],
        isLive: true
      })
    }
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
    // engine: prefixes are derived from filenames the engine controls —
    // YYYYMMDD_HHmm_<slug> — so they're always safe ASCII. Defence in depth.
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
      throw new Error(`Invalid engine prefix: ${prefix}`)
    }
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

    // The `.md` protocol is the LLM summary — surfaced in the Summary tab,
    // independent of the raw transcript above. Absent for meetings whose
    // pipeline skipped protocol generation.
    let summaryMarkdown: string | undefined
    try {
      const md = await fs.readFile(mdPath, 'utf-8')
      if (md.trim()) summaryMarkdown = md
    } catch {
      // No summary — the tab stays hidden.
    }

    // v0.17+: parse the structured segments.json sidecar so the renderer
    // can render diarized rows, click-to-seek, and a speaker list — instead
    // of relying on parseLegacyTranscript regex matching on the .txt
    // (which is fragile and was failing for the engine's MM:SS format).
    const { segmentsPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
    let segments: Array<{ speaker: string; start: number; end: number; text: string }> | undefined
    let durationSeconds: number | undefined
    let speakers: SpeakerRecord[] = []
    if (segmentsPath) {
      const segs = await safeReadJson<EngineSegmentJSON[]>(segmentsPath)
      if (Array.isArray(segs) && segs.length > 0) {
        segments = segs.map((s) => ({
          speaker: s.speaker,
          start: s.start,
          end: s.end,
          text: s.text
        }))
        durationSeconds = Math.ceil(Math.max(...segs.map((s) => s.end ?? 0)))
        // Build a SpeakerRecord list from the unique speakers in segments.
        const unique = Array.from(new Set(segs.map((s) => s.speaker)))
        speakers = unique.map((name) => ({ id: name, label: name }))
      }
    }

    // Fallback for meetings recorded before diarized labels were persisted to
    // `_segments.json`: those sidecars only carry the pre-diarization
    // "Remote"/mic cache, while the `.txt` already has the real per-speaker
    // lines. When the JSON looks pre-diarization AND the `.txt` names strictly
    // more speakers, derive segments from the `.txt` so the renderer shows the
    // speakers the diarizer actually found.
    const jsonSpeakers = new Set((segments ?? []).map((s) => s.speaker))
    if (looksPreDiarizationSpeakers(jsonSpeakers)) {
      const fromTxt = parseEngineTxtSegments(transcript)
      const txtSpeakerCount = new Set(fromTxt.segments.map((s) => s.speaker)).size
      if (fromTxt.segments.length > 0 && txtSpeakerCount > jsonSpeakers.size) {
        segments = fromTxt.segments
        speakers = fromTxt.speakers
        durationSeconds = Math.ceil(Math.max(...fromTxt.segments.map((s) => s.end)))
      }
    }
    return { meetingId, transcript, speakers, segments, durationSeconds, summaryMarkdown }
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
  // Imports don't write a summary today, but read one if present so the
  // Summary tab lights up for any future import that does.
  let summaryMarkdown: string | undefined
  try {
    const md = await fs.readFile(join(folder, 'summary.md'), 'utf-8')
    if (md.trim()) summaryMarkdown = md
  } catch {
    // No summary.
  }
  return {
    meetingId,
    transcript,
    speakers,
    segments: tj?.segments,
    durationSeconds: tj?.duration,
    summaryMarkdown
  }
}

/** Per-file read cap for full-text search — big transcripts stay responsive. */
const MAX_SEARCH_BYTES = 2 * 1024 * 1024

/**
 * First ±`radius`-char excerpt around a case-insensitive match of `query` in
 * `text`, whitespace-collapsed with `…` ellipses when clipped. Returns null
 * when there's no match. Pure — unit-testable.
 */
export function firstMatchSnippet(text: string, query: string, radius = 60): string | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + query.length + radius)
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet
}

/** Read up to `MAX_SEARCH_BYTES` of a UTF-8 file; null if unreadable. */
async function readCappedText(path: string): Promise<string | null> {
  let handle: import('fs').promises.FileHandle
  try {
    handle = await fs.open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const len = Math.min(size, MAX_SEARCH_BYTES)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, 0)
    return buf.toString('utf-8')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Full-text search across every meeting's transcript. Scans engine protocols
 * (`protocols/<prefix>.txt`) and imported folders (`<folder>/transcript.txt`),
 * reading at most 2 MB/file, and returns the first-match snippet per meeting.
 * Empty query → no hits (the renderer keeps showing the normal list). The
 * returned ids match `listMeetings` ids so the renderer can resolve rows.
 */
export async function searchTranscripts(
  outputFolder: string,
  query: string
): Promise<TranscriptSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const hits: TranscriptSearchHit[] = []

  const protocolsDir = join(ENGINE_DEFAULT_ROOT, 'protocols')
  try {
    for (const filename of await fs.readdir(protocolsDir)) {
      if (!filename.endsWith('.txt')) continue
      const text = await readCappedText(join(protocolsDir, filename))
      if (text === null) continue
      const snippet = firstMatchSnippet(text, q)
      if (snippet) hits.push({ id: `engine:${filename.slice(0, -4)}`, snippet })
    }
  } catch {
    // No protocols dir — nothing to search there.
  }

  try {
    for (const entry of await fs.readdir(outputFolder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const text = await readCappedText(join(outputFolder, entry.name, 'transcript.txt'))
      if (text === null) continue
      const snippet = firstMatchSnippet(text, q)
      if (snippet) hits.push({ id: `imported:${entry.name}`, snippet })
    }
  } catch {
    // No output folder — nothing to search there.
  }

  return hits
}

/**
 * For Settings UI: report whether the engine default folder exists so the UI
 * can show a "live recordings folder" link.
 */
export async function engineDefaultRootExists(): Promise<boolean> {
  return pathExists(ENGINE_DEFAULT_ROOT)
}

export const liveRecordingsRoot = ENGINE_DEFAULT_ROOT

// ─── Storage usage (Settings → Storage) ────────────────────────────────────

/** 10s cache — a recursive du over the whole library isn't free to repeat. */
let storageUsageCache: { at: number; value: StorageUsage } | null = null
const STORAGE_USAGE_TTL_MS = 10_000

/** Recursive byte total under `dir`. Missing/unreadable dirs count as 0. */
async function duBytes(dir: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await duBytes(full)
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size
      } catch {
        // Vanished mid-walk (e.g. a file cleaned up between readdir and stat).
      }
    }
  }
  return total
}

/**
 * Strip the known engine-file suffixes to recover a meeting's `<prefix>`.
 * `recordings/` holds `<prefix>_{mix,app,mic}.wav` + `<prefix>_screen.{mp4,mov}`;
 * `protocols/` holds `<prefix>.{txt,md}`, `<prefix>.meta.json`,
 * `<prefix>_segments.json`. Returns null for anything unrecognised.
 */
function meetingPrefixFromFile(dir: 'recordings' | 'protocols', name: string): string | null {
  if (dir === 'recordings') {
    const wav = name.match(/^(.+?)_(?:mix|app|mic)\.wav$/)
    if (wav) return wav[1]
    const vid = name.match(/^(.+?)_screen\.(?:mp4|mov)$/)
    return vid ? vid[1] : null
  }
  const seg = name.match(/^(.+?)_segments\.json$/)
  if (seg) return seg[1]
  const meta = name.match(/^(.+?)\.meta\.json$/)
  if (meta) return meta[1]
  const doc = name.match(/^(.+?)\.(?:txt|md)$/)
  return doc ? doc[1] : null
}

/** Distinct recorded-meeting prefixes across the recordings + protocols dirs. */
async function collectMeetingPrefixes(root: string): Promise<Set<string>> {
  const prefixes = new Set<string>()
  for (const sub of ['recordings', 'protocols'] as const) {
    let names: string[]
    try {
      names = await fs.readdir(join(root, sub))
    } catch {
      continue
    }
    for (const name of names) {
      const prefix = meetingPrefixFromFile(sub, name)
      if (prefix) prefixes.add(prefix)
    }
  }
  return prefixes
}

/**
 * Disk footprint of the live-recordings library: total bytes (recursive du)
 * plus the count of distinct recorded meetings. Best-effort — an absent or
 * unreadable root reports zero rather than throwing. Cached 10s so repeated
 * Settings reads don't re-walk the tree.
 */
export async function computeStorageUsage(
  root: string = liveRecordingsRoot
): Promise<StorageUsage> {
  const now = Date.now()
  if (storageUsageCache && now - storageUsageCache.at < STORAGE_USAGE_TTL_MS) {
    return storageUsageCache.value
  }
  const [bytes, prefixes] = await Promise.all([duBytes(root), collectMeetingPrefixes(root)])
  const value: StorageUsage = { bytes, meetings: prefixes.size }
  storageUsageCache = { at: now, value }
  return value
}

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
  // When the rename is a merge (oldName disappears into newName), drop oldName
  // from additionalSpeakers so it doesn't linger as a read-only "added" pill.
  const pruneOldFromAdditionalSpeakers = async (): Promise<void> => {
    try {
      const metaPath = engineOrFolderMetaPath(outputFolder, meetingId)
      const existing = await safeReadJson<MetadataFile>(metaPath)
      if (!existing || !Array.isArray(existing.additionalSpeakers)) return
      const filtered = existing.additionalSpeakers.filter(
        (n) => typeof n === 'string' && n.trim() !== oldName
      )
      if (filtered.length === existing.additionalSpeakers.length) return
      existing.additionalSpeakers = filtered
      await fs.mkdir(dirname(metaPath), { recursive: true })
      await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
    } catch {
      // Pruning is best-effort; never fail the rename over it.
    }
  }
  if (meetingId.startsWith('engine:')) {
    // Live recordings have no speakers.json centroids to enrol, but we CAN
    // relabel the transcript directly — patch segments.json + the protocol
    // .txt so every segment of `oldName` becomes `newName`.
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) throw new Error(`Invalid engine prefix: ${prefix}`)
    await renameEngineSpeaker(prefix, oldName, newName)
    await pruneOldFromAdditionalSpeakers()
    return { enrolled: false }
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

  await pruneOldFromAdditionalSpeakers()
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
  language?: string
  mode?: 'fast' | 'max'
  onEvent?: (ev: BatchEvent) => void
}): Promise<string> {
  if (opts.meetingId.startsWith('engine:')) {
    const prefix = opts.meetingId.slice('engine:'.length)
    if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
      throw new Error(`Invalid meeting id: ${opts.meetingId}`)
    }
    return reanalyzeEngineMeeting({
      prefix,
      jobId: opts.jobId,
      numSpeakers: opts.numSpeakers,
      language: opts.language,
      mode: opts.mode,
      onEvent: opts.onEvent
    })
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
    language: opts.language,
    onEvent: opts.onEvent ?? ((): void => {})
  })
}

/**
 * Re-analyse a live-recording ("engine:") meeting in place. Resolves the
 * durable dual-source tracks (`<prefix>_app.wav` + `<prefix>_mic.wav`) and
 * re-runs mt-batch on the pair — restoring the dual-track prior the live
 * pipeline had — or on the mixed audio when the pair is absent. The engine
 * owns these filenames, so overwriting the meeting's `_segments.json` +
 * protocol `.txt` in place keeps the meeting id stable; the prior versions are
 * kept as `.bak`.
 *
 * mt-batch writes into a temp dir first, so a failed run never truncates the
 * live sidecars — only a completed run replaces them.
 */
async function reanalyzeEngineMeeting(opts: {
  prefix: string
  jobId: string
  numSpeakers?: number
  language?: string
  mode?: 'fast' | 'max'
  onEvent?: (ev: BatchEvent) => void
}): Promise<string> {
  const root = ENGINE_DEFAULT_ROOT
  const recordingsDir = join(root, 'recordings')
  // A prior refine may have left a `.refining` marker behind (including an
  // orphaned one from a crash). Re-analysis overwrites the meeting's outputs
  // itself and surfaces its own progress, so clear any marker up front —
  // otherwise the row could stay stuck showing "Refining…" afterwards.
  await fs.rm(join(root, 'protocols', `${opts.prefix}.refining`), { force: true })
  const files = await findEngineReanalysisFiles(recordingsDir, opts.prefix)
  const hasPair = Boolean(files.appPath && files.micPath)
  const singleInput = files.mixPath ?? files.appPath ?? files.micPath
  if (!hasPair && !singleInput) {
    throw new Error(
      `No engine audio found for ${opts.prefix} — cannot re-analyse without the source recording`
    )
  }

  const onEvent = opts.onEvent ?? ((): void => {})
  const workDir = await fs.mkdtemp(join(tmpdir(), 'mt-reanalyze-'))
  try {
    await runBatch({
      jobId: opts.jobId,
      outputDir: workDir,
      numSpeakers: opts.numSpeakers,
      language: opts.language,
      mode: opts.mode,
      // Dual-source when both tracks survive; otherwise the mixed audio.
      // 'Me' matches the engine's default local-speaker label.
      ...(hasPair
        ? { inputApp: files.appPath as string, inputMic: files.micPath as string, micName: 'Me' }
        : { inputFile: singleInput as string }),
      onEvent
    })
    await applyEngineReanalysis(root, opts.prefix, workDir, files.segmentsPath)
    return root
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Scan `recordings/` for a prefix's durable audio tracks and its existing
 * segments sidecar. `_segments.json` can carry a `_<runId>` infix, so we
 * return the actual matched path rather than reconstructing the name.
 */
async function findEngineReanalysisFiles(
  recordingsDir: string,
  prefix: string
): Promise<{
  appPath: string | null
  micPath: string | null
  mixPath: string | null
  segmentsPath: string | null
}> {
  let entries: string[]
  try {
    entries = await fs.readdir(recordingsDir)
  } catch {
    return { appPath: null, micPath: null, mixPath: null, segmentsPath: null }
  }
  let appPath: string | null = null
  let micPath: string | null = null
  let mixPath: string | null = null
  let segmentsPath: string | null = null
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue
    if (e.endsWith('_app.wav')) appPath = join(recordingsDir, e)
    else if (e.endsWith('_mic.wav')) micPath = join(recordingsDir, e)
    else if (e.endsWith('_mix.wav')) mixPath = join(recordingsDir, e)
    else if (e.endsWith('_segments.json')) segmentsPath = join(recordingsDir, e)
  }
  return { appPath, micPath, mixPath, segmentsPath }
}

/**
 * Copy an mt-batch run's outputs onto the engine meeting's sidecars. The engine
 * `_segments.json` is the bare segment array, which is exactly
 * mt-batch's `transcript.json.segments`; the protocol `.txt` is mt-batch's
 * `transcript.txt` verbatim (its `[HH:MM:SS] Speaker: text` lines already match
 * the renderer's fallback parser). Prior versions are backed up as `.bak`.
 */
async function applyEngineReanalysis(
  root: string,
  prefix: string,
  workDir: string,
  existingSegmentsPath: string | null
): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(join(workDir, 'transcript.json'), 'utf-8')) as {
    segments?: EngineSegmentJSON[]
  }
  const segments = Array.isArray(parsed.segments) ? parsed.segments : []
  const segDest = existingSegmentsPath ?? join(root, 'recordings', `${prefix}_segments.json`)
  await backupThenReplace(segDest, JSON.stringify(segments))

  const txt = await fs.readFile(join(workDir, 'transcript.txt'), 'utf-8').catch(() => null)
  if (txt !== null) {
    await backupThenReplace(join(root, 'protocols', `${prefix}.txt`), txt)
  }
}

/**
 * Rename an existing file to `<path>.bak` (overwriting any prior backup) before
 * writing new content, so a re-analysis keeps the previous result recoverable.
 * A missing source is a first write — no backup needed.
 */
async function backupThenReplace(path: string, content: string): Promise<void> {
  try {
    await fs.rename(path, `${path}.bak`)
  } catch {
    // No existing file to back up.
  }
  await fs.writeFile(path, content, 'utf-8')
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
  // De-dupe + reject empties.
  const clean = Array.from(new Set(tagIds.filter((t) => typeof t === 'string' && t.length > 0)))
  const metaPath = engineOrFolderMetaPath(outputFolder, meetingId)
  const existing = (await safeReadJson<MetadataFile>(metaPath)) ?? {}
  existing.tags = clean
  await fs.mkdir(dirname(metaPath), { recursive: true })
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
  const trimmed = newTitle.trim()
  const metaPath = engineOrFolderMetaPath(outputFolder, meetingId)
  const existing = (await safeReadJson<MetadataFile>(metaPath)) ?? {}
  if (trimmed) {
    existing.title = trimmed
  } else {
    delete existing.title
  }
  await fs.mkdir(dirname(metaPath), { recursive: true })
  await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
  return {
    title: existing.title?.trim() ? existing.title : fallbackTitleForId(meetingId)
  }
}

/**
 * Permanently delete a meeting and all its on-disk files.
 *   - `engine:<prefix>` → removes `protocols/<prefix>.{txt,md,meta.json}` and
 *     every `recordings/<prefix>*` sidecar (mix/mic/app WAVs, 16k, segments,
 *     naming).
 *   - `imported:<folder>` → removes the whole meeting folder.
 *   - `live:*` → refused (stop the recording first).
 * Idempotent: missing files are ignored (`force: true`).
 */
/**
 * Move a path to the macOS Trash if it exists. Idempotent: a missing path
 * is a no-op (mirrors the old `fs.rm(..., { force: true })` tolerance) so a
 * protocol-only meeting with no audio, or a double-delete, never throws.
 * Recoverability is the point — deletion goes through the Trash, not an
 * irreversible unlink.
 *
 * Fallback: some volumes have no Trash (network mounts, FAT/exFAT), so
 * `shell.trashItem` rejects on them. Rather than hard-fail — which would strip
 * the user's ability to delete at all — fall back to a permanent recursive
 * remove. That path IS irreversible (there's no Trash to recover from), but a
 * delete the user explicitly asked for still succeeds.
 */
async function trashIfExists(absPath: string): Promise<void> {
  try {
    await fs.access(absPath)
  } catch {
    return
  }
  try {
    await shell.trashItem(absPath)
  } catch (err) {
    console.warn('[meetings] trashItem failed; removing permanently', absPath, err)
    await fs.rm(absPath, { recursive: true, force: true })
  }
}

export async function deleteMeeting(outputFolder: string, meetingId: string): Promise<void> {
  if (meetingId.startsWith('live:')) {
    throw new Error('Stop the live recording before deleting it.')
  }
  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
      throw new Error(`Invalid engine prefix: ${prefix}`)
    }
    const protocolsDir = join(ENGINE_DEFAULT_ROOT, 'protocols')
    await Promise.all(
      ['txt', 'md', 'meta.json', 'refining'].map((ext) =>
        trashIfExists(join(protocolsDir, `${prefix}.${ext}`))
      )
    )
    const recordingsDir = join(ENGINE_DEFAULT_ROOT, 'recordings')
    try {
      const files = await fs.readdir(recordingsDir)
      await Promise.all(
        files
          .filter((f) => f.startsWith(prefix))
          .map((f) => trashIfExists(join(recordingsDir, f)))
      )
    } catch {
      // recordings dir may not exist (e.g. protocol-only meeting) — nothing to do.
    }
    return
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  await trashIfExists(join(outputFolder, folderId))
}

/**
 * Reassign the speaker of a SINGLE transcript segment — used by the
 * per-segment dropdown in the Transcript tab. Unlike
 * `renameSpeakerInMeeting`, this does NOT touch the cluster: other
 * segments sharing the old speaker name stay as they were. Useful for
 * fixing one-off diarization misses where a single utterance was tagged
 * to the wrong speaker.
 *
 * The `transcript.txt` patch is identified by zero-based index over the
 * `[HH:MM:SS] {anyName}:` line matches, NOT by global regex replacement
 * — speaker names can repeat in transcript bodies and we MUST only
 * rewrite the target line's name.
 */
export async function reassignSegmentSpeaker(
  outputFolder: string,
  meetingId: string,
  segmentIndex: number,
  newSpeaker: string
): Promise<{ speakerCount: number; newSpeaker: string }> {
  const trimmed = newSpeaker.trim()
  if (!trimmed) throw new Error('New speaker name must not be empty')
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    throw new Error(`Invalid segment index: ${segmentIndex}`)
  }
  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) throw new Error(`Invalid engine prefix: ${prefix}`)
    const speakerCount = await reassignEngineSegment(prefix, segmentIndex, trimmed)
    return { speakerCount, newSpeaker: trimmed }
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)

  // 1. Patch transcript.json — flip just this one segment's speaker.
  const jsonPath = join(folder, 'transcript.json')
  interface TJSON {
    segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>
    speakerCount?: number
    [k: string]: unknown
  }
  let parsed: TJSON
  try {
    const raw = await fs.readFile(jsonPath, 'utf-8')
    parsed = JSON.parse(raw) as TJSON
  } catch {
    throw new Error(`transcript.json missing for meeting ${meetingId}`)
  }
  if (!parsed.segments || segmentIndex >= parsed.segments.length) {
    throw new Error(
      `Segment index ${segmentIndex} out of range (transcript has ${parsed.segments?.length ?? 0} segments)`
    )
  }
  parsed.segments[segmentIndex].speaker = trimmed
  // Recompute distinct speaker count so the list view stays accurate.
  const distinct = new Set<string>()
  for (const seg of parsed.segments) {
    if (typeof seg.speaker === 'string' && seg.speaker.length > 0) distinct.add(seg.speaker)
  }
  parsed.speakerCount = distinct.size
  await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8')

  // 2. Patch transcript.txt by line index — find the Nth `[HH:MM:SS] X:`
  //    line and replace ONLY its speaker name. Lines without that prefix
  //    (blank lines, wrapped text, etc.) are passed through unchanged.
  const txtPath = join(folder, 'transcript.txt')
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const lines = raw.split('\n')
    // Capture: 1=timestamp bracket, 2=space, 3=name (lazy up to colon), 4=rest
    const lineRe = /^(\[\d\d:\d\d:\d\d\])(\s+)([^:\n]+?)(:.*)$/
    let matched = -1
    for (let i = 0; i < lines.length; i++) {
      if (lineRe.test(lines[i])) {
        matched++
        if (matched === segmentIndex) {
          lines[i] = lines[i].replace(lineRe, `$1$2${trimmed}$4`)
          break
        }
      }
    }
    if (matched >= segmentIndex) {
      await fs.writeFile(txtPath, lines.join('\n'), 'utf-8')
    }
    // If matched < segmentIndex the .txt is out of sync with the .json
    // (e.g. legacy partial output) — the .json patch above is the source
    // of truth for the UI, so we silently skip.
  } catch {
    // transcript.txt may not exist on partial outputs — non-fatal.
  }

  return { speakerCount: distinct.size, newSpeaker: trimmed }
}

/**
 * Append a user-added speaker to a meeting's `metadata.json →
 * additionalSpeakers`. De-duped, trimmed, empty-rejecting. These names
 * surface in the per-segment reassignment picker so users can tag people
 * who were present but missed by auto-diarization.
 */
export async function addSpeakerToMeeting(
  outputFolder: string,
  meetingId: string,
  speakerName: string
): Promise<{ additionalSpeakers: string[] }> {
  const trimmed = speakerName.trim()
  if (!trimmed) throw new Error('Speaker name must not be empty')
  // Engine meetings store additionalSpeakers in the protocols sidecar; imported
  // meetings in the folder's metadata.json. Resolve the right path either way.
  const metaPath = engineOrFolderMetaPath(outputFolder, meetingId)
  const existing = (await safeReadJson<MetadataFile>(metaPath)) ?? {}
  const current = Array.isArray(existing.additionalSpeakers) ? existing.additionalSpeakers : []
  // De-dupe while preserving original order; trim each entry.
  const seen = new Set<string>()
  const merged: string[] = []
  for (const n of [...current, trimmed]) {
    const v = typeof n === 'string' ? n.trim() : ''
    if (!v || seen.has(v)) continue
    seen.add(v)
    merged.push(v)
  }
  existing.additionalSpeakers = merged
  await fs.mkdir(dirname(metaPath), { recursive: true })
  await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
  return { additionalSpeakers: merged }
}

/**
 * Remove a speaker's LABEL from a meeting without reassigning its lines to
 * another named person — every utterance currently tagged `speakerName` is
 * relabelled to a neutral placeholder. This is the "remove the label only"
 * branch of speaker deletion; the "delete and reassign to X" (a merge) is
 * served by the existing `renameSpeakerInMeeting(…, speakerName, X)` path,
 * which already degrades to `.txt`-only for engine meetings.
 *
 * The placeholder is the literal `"Speaker"` — a deliberately generic,
 * monochrome-friendly token. If a `"Speaker"` cluster already exists, the
 * removed lines merge into it; that is acceptable "remove label" semantics.
 *
 * Also prunes `speakerName` from `metadata → additionalSpeakers` so a deleted
 * name cannot linger as a read-only "added" pill.
 *
 * Returns the recomputed distinct speaker count so the caller can refresh the
 * header stats, mirroring `reassignSegmentSpeaker`'s convention.
 */
export async function removeSpeakerLabelInMeeting(
  outputFolder: string,
  meetingId: string,
  speakerName: string
): Promise<{ speakerCount: number }> {
  const target = speakerName.trim()
  if (!target) throw new Error('Speaker name must not be empty')
  const PLACEHOLDER = 'Speaker'

  // Prune the removed name from additionalSpeakers (engine sidecar or imported
  // metadata.json) so it doesn't reappear as an added pill.
  const pruneAdditionalSpeakers = async (): Promise<void> => {
    const metaPath = engineOrFolderMetaPath(outputFolder, meetingId)
    const existing = await safeReadJson<MetadataFile>(metaPath)
    if (!existing || !Array.isArray(existing.additionalSpeakers)) return
    const filtered = existing.additionalSpeakers.filter(
      (n) => typeof n === 'string' && n.trim() !== target
    )
    if (filtered.length === existing.additionalSpeakers.length) return
    existing.additionalSpeakers = filtered
    await fs.mkdir(dirname(metaPath), { recursive: true })
    await fs.writeFile(metaPath, JSON.stringify(existing, null, 2), 'utf-8')
  }

  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) throw new Error(`Invalid engine prefix: ${prefix}`)
    // Relabel the whole cluster to the placeholder (reuses the segments.json +
    // .txt degrade path).
    await renameEngineSpeaker(prefix, target, PLACEHOLDER)
    await pruneAdditionalSpeakers()
    const { segmentsPath } = await findEngineSidecars(ENGINE_DEFAULT_ROOT, prefix)
    if (segmentsPath) {
      const segs = await safeReadJson<EngineSegmentJSON[]>(segmentsPath)
      if (Array.isArray(segs)) {
        return {
          speakerCount: new Set(segs.map((s) => s.speaker).filter((v) => v && v.length > 0)).size
        }
      }
    }
    return { speakerCount: await countTxtSpeakers(prefix) }
  }

  // Imported meeting: relabel matching segments in transcript.json + .txt.
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
    throw new Error(`Invalid meeting id: ${meetingId}`)
  }
  const folder = join(outputFolder, folderId)

  // 1. transcript.json — relabel each matching segment, recompute distinct count.
  const jsonPath = join(folder, 'transcript.json')
  interface TJSON {
    segments?: Array<{ speaker?: string; [k: string]: unknown }>
    speakerCount?: number
    [k: string]: unknown
  }
  let distinctSize = 0
  try {
    const raw = await fs.readFile(jsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as TJSON
    if (parsed.segments) {
      for (const seg of parsed.segments) {
        if (seg.speaker === target) seg.speaker = PLACEHOLDER
      }
      const distinct = new Set<string>()
      for (const seg of parsed.segments) {
        if (typeof seg.speaker === 'string' && seg.speaker.length > 0) distinct.add(seg.speaker)
      }
      distinctSize = distinct.size
      parsed.speakerCount = distinctSize
      await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8')
    }
  } catch {
    // transcript.json may be absent on partial outputs — non-fatal.
  }

  // 2. transcript.txt — anchored cluster relabel (same regex used by rename).
  const txtPath = join(folder, 'transcript.txt')
  try {
    const raw = await fs.readFile(txtPath, 'utf-8')
    const re = new RegExp('(\\[\\d\\d:\\d\\d:\\d\\d\\] )' + escapeRegex(target) + '(:)', 'g')
    const next = raw.replace(re, '$1' + PLACEHOLDER + '$2')
    if (next !== raw) await fs.writeFile(txtPath, next, 'utf-8')
  } catch {
    // transcript.txt may not exist on partial outputs — non-fatal.
  }

  await pruneAdditionalSpeakers()
  return { speakerCount: distinctSize }
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

/**
 * Build an SRT subtitle body from diarized segments. Shared by the imported
 * and engine export paths so both produce byte-identical `.srt` output.
 */
function buildSRT(
  segments: Array<{ speaker: string; start: number; end: number; text: string }>
): string {
  const lines: string[] = []
  segments.forEach((seg, i) => {
    lines.push(
      String(i + 1),
      `${formatTimestampSRT(seg.start)} --> ${formatTimestampSRT(seg.end)}`,
      `${seg.speaker}: ${seg.text.trim()}`,
      ''
    )
  })
  return lines.join('\n')
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
  format: 'txt' | 'md' | 'json' | 'srt' | 'audio' | 'video',
  title: string
): Promise<ExportPayload> {
  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
      throw new Error(`Invalid engine prefix: ${prefix}`)
    }
    const safeTitle = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || prefix
    if (format === 'video') {
      const videoPath = await findEngineVideoForPrefix(prefix)
      if (!videoPath) throw new Error('This recording has no screen video.')
      const body = await fs.readFile(videoPath)
      return { filename: `${safeTitle}.mp4`, body, contentType: 'video/mp4' }
    }
    if (format === 'audio') {
      const audioPath = await findEngineAudioForPrefix(prefix)
      if (!audioPath) throw new Error('This meeting has no audio file.')
      const body = await fs.readFile(audioPath)
      return { filename: `${safeTitle}.wav`, body, contentType: 'audio/wav' }
    }
    if (format === 'json' || format === 'srt') {
      // Reuse the canonical segment loader so engine json/srt match the shape
      // the renderer already reads (start/end/speaker/text).
      const t = await readTranscript(outputFolder, meetingId)
      const segs = t.segments ?? []
      if (segs.length === 0) {
        throw new Error('This meeting has no structured transcript.')
      }
      if (format === 'srt') {
        return {
          filename: `${safeTitle}.srt`,
          body: buildSRT(segs),
          contentType: 'application/x-subrip'
        }
      }
      const speakerCount = new Set(segs.map((s) => s.speaker)).size
      const jsonBody = JSON.stringify(
        { segments: segs, duration: t.durationSeconds, speakerCount },
        null,
        2
      )
      return { filename: `${safeTitle}.json`, body: jsonBody, contentType: 'application/json' }
    }
    // txt / md — the engine's protocol file.
    const srcExt = format === 'md' ? 'md' : 'txt'
    const srcPath = join(ENGINE_DEFAULT_ROOT, 'protocols', `${prefix}.${srcExt}`)
    const body = await fs.readFile(srcPath, 'utf-8')
    return {
      filename: `${prefix}.${srcExt}`,
      body,
      contentType: format === 'md' ? 'text/markdown' : 'text/plain'
    }
  }
  // Imported meetings carry no whole-screen video today — reject cleanly.
  if (format === 'video') {
    throw new Error('No screen video available for this meeting.')
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
  return {
    filename: `${safeTitle}.srt`,
    body: buildSRT(segments),
    contentType: 'application/x-subrip'
  }
}

/** Renderer-facing preview payload returned by `previewExportMeeting`. */
export interface ExportPreview {
  /** Suggested filename (with extension). */
  filename: string
  /** UTF-8 string body for text formats. EMPTY for binary (audio). */
  body: string
  /** MIME type. */
  contentType: string
  /** True if the payload is binary and intentionally omitted from `body`. */
  isBinary?: boolean
  /** File size in bytes — only set for binary formats so the renderer
   *  can show a human-readable summary without serialising the bytes. */
  sizeBytes?: number
}

/**
 * Build an in-memory preview payload for the Export tab. Mirrors
 * `exportMeeting()` for text formats so what you see in the preview is
 * byte-identical to what the Save dialog flow writes. For `audio`, we
 * deliberately skip reading the WAV body — the renderer only needs the
 * filename + size to render a "binary file, X MB" placeholder card.
 */
export async function previewExportMeeting(
  outputFolder: string,
  meetingId: string,
  format: 'txt' | 'md' | 'json' | 'srt' | 'audio' | 'video',
  title: string
): Promise<ExportPreview> {
  if (format === 'video') {
    if (!meetingId.startsWith('engine:')) {
      throw new Error('No screen video for this meeting.')
    }
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
      throw new Error(`Invalid engine prefix: ${prefix}`)
    }
    const videoPath = await findEngineVideoForPrefix(prefix)
    if (!videoPath) throw new Error('This recording has no screen video.')
    const stat = await fs.stat(videoPath)
    const safeTitle = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || prefix
    return {
      filename: `${safeTitle}.mp4`,
      body: '',
      contentType: 'video/mp4',
      isBinary: true,
      sizeBytes: stat.size
    }
  }
  if (format === 'audio') {
    // Resolve the audio path WITHOUT reading the file. The `audio` branch
    // of `exportMeeting` would otherwise load the entire WAV into memory
    // and then serialise it across IPC — wasteful for preview, since the
    // pane shows only a size/filename card.
    if (meetingId.startsWith('engine:')) {
      // Engine meetings resolve their audio by prefix; mirror the imported
      // branch (stat only, no body) so the preview shows a size card.
      const prefix = meetingId.slice('engine:'.length)
      if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
        throw new Error(`Invalid engine prefix: ${prefix}`)
      }
      const audioPath = await findEngineAudioForPrefix(prefix)
      if (!audioPath) throw new Error('This meeting has no audio file.')
      const stat = await fs.stat(audioPath)
      const safeTitle = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || prefix
      return {
        filename: `${safeTitle}.wav`,
        body: '',
        contentType: 'audio/wav',
        isBinary: true,
        sizeBytes: stat.size
      }
    }
    const folderId = meetingId.startsWith('imported:')
      ? meetingId.slice('imported:'.length)
      : meetingId
    if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) {
      throw new Error(`Invalid meeting id: ${meetingId}`)
    }
    const safeTitle = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || folderId
    const audioPath = join(outputFolder, folderId, 'audio.wav')
    const stat = await fs.stat(audioPath)
    return {
      filename: `${safeTitle}.wav`,
      body: '',
      contentType: 'audio/wav',
      isBinary: true,
      sizeBytes: stat.size
    }
  }
  // Text formats: reuse the canonical export helper. Its body is always a
  // string for txt/md/json/srt (Buffer only for audio, handled above).
  const payload = await exportMeeting(outputFolder, meetingId, format, title)
  const body = typeof payload.body === 'string' ? payload.body : payload.body.toString('utf-8')
  return {
    filename: payload.filename,
    body,
    contentType: payload.contentType
  }
}
