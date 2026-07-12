import type { SpeakerRecord, TranscriptSegment } from '../shared/types'

/**
 * Shared timestamped-speaker-line regex for the engine protocol `.txt`. MUST
 * stay byte-for-byte in sync with the renderer's flat-text fallback parser so
 * that the Nth match here is the same row the renderer addresses by index.
 * Capture groups:
 *   1 = `[MM:SS]` / `[H:MM:SS]` bracket, 2 = whitespace, 3 = name, 4 = `:rest`.
 */
export const ENGINE_TXT_LINE_RE = /^(\[(?:\d{1,2}:)?\d{1,2}:\d{1,2}\])(\s+)([^:\n]+?)(:.*)$/

/** Parse a `[MM:SS]` / `[H:MM:SS]` / `[HH:MM:SS]` bracket into start seconds. */
export function bracketToSeconds(bracket: string): number {
  const m = bracket.match(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\]/)
  if (!m) return 0
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  return h * 3600 + min * 60 + s
}

/**
 * Parse an engine protocol `.txt` into structured segments using the shared
 * line regex. Each `[MM:SS] Name: text` line becomes a segment whose end is the
 * next line's start (the last line ends at its own start). Used as the fallback
 * for meetings whose `_segments.json` predates diarized-label persistence (or
 * was reclaimed after naming) so the renderer still shows the speakers the
 * diarizer found in the `.txt`.
 */
export function parseEngineTxtSegments(txt: string): {
  segments: TranscriptSegment[]
  speakers: SpeakerRecord[]
} {
  const segments: TranscriptSegment[] = []
  for (const line of txt.split('\n')) {
    const m = line.match(ENGINE_TXT_LINE_RE)
    if (!m) continue
    const start = bracketToSeconds(m[1])
    const speaker = m[3].trim()
    const text = m[4].slice(1).trim() // m[4] is ":<rest>"
    segments.push({ speaker, start, end: start, text })
  }
  // end = next segment's start, keeping rows contiguous for click-to-seek.
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].end = segments[i + 1].start
  }
  const unique = Array.from(new Set(segments.map((s) => s.speaker)))
  const speakers: SpeakerRecord[] = unique.map((name) => ({ id: name, label: name }))
  return { segments, speakers }
}

/**
 * Whether a `_segments.json` speaker set looks like the engine's
 * PRE-diarization cache rather than real diarized output. That cache tags app
 * audio "Remote" and mic audio with the single mic label, and single-source
 * caches leave the speaker empty — none of which appear once the diarizer has
 * labeled the transcript. Returns true when the set has at most one distinct
 * "real" (non-Remote, non-empty) name, i.e. no genuine multi-speaker split.
 */
export function looksPreDiarizationSpeakers(speakers: Set<string>): boolean {
  if (speakers.size === 0) return false
  const real = [...speakers].filter((s) => s !== 'Remote' && s !== '')
  return real.length <= 1
}
