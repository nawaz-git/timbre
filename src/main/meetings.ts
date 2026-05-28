import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { MeetingSummary, MeetingTranscript, SpeakerRecord } from '../shared/types'

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
    results.push({
      id: `imported:${entry.name}`,
      title: titleFromFolderName(entry.name),
      folderPath,
      date: stat.mtime.toISOString(),
      durationSeconds: metadata?.durationSeconds ?? 0,
      speakerCount: speakers?.length ?? metadata?.speakerCount ?? 0
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
      speakerCount: 0 // engine doesn't write speakers sidecar; left as 0
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
  return { meetingId, transcript, speakers }
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
