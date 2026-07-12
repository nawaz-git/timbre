/**
 * Pure library-retrieval helpers for the Meetings view: client-side filtering
 * (title + speaker names + tag names) and Today/Yesterday/This week/Earlier
 * date grouping. No React, no IPC — unit-testable, and reusable across
 * views. Full-text transcript search is a separate main-side
 * IPC (`meetings:searchTranscripts`); this module handles the metadata that's
 * already loaded in the list.
 */
import type { MeetingSummary } from '../../../shared/types'

export type DateGroupKey = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

export const DATE_GROUP_LABEL: Record<DateGroupKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  earlier: 'Earlier'
}

const DATE_GROUP_ORDER: DateGroupKey[] = ['today', 'yesterday', 'thisWeek', 'earlier']

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Which date bucket an ISO timestamp falls in, relative to `now`. */
export function dateGroupOf(iso: string, now: Date = new Date()): DateGroupKey {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'earlier'
  const diff = Math.round((startOfDayMs(now) - startOfDayMs(d)) / 86_400_000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff <= 6) return 'thisWeek'
  return 'earlier'
}

export interface MeetingGroup {
  key: DateGroupKey
  label: string
  meetings: MeetingSummary[]
}

/**
 * Group meetings (already newest-first) into ordered date buckets, dropping
 * empties. Live placeholders always sort into Today. Pure — unit-testable.
 */
export function groupMeetingsByDate(
  meetings: MeetingSummary[],
  now: Date = new Date()
): MeetingGroup[] {
  const buckets = new Map<DateGroupKey, MeetingSummary[]>()
  for (const m of meetings) {
    const key: DateGroupKey = m.isLive ? 'today' : dateGroupOf(m.date, now)
    const arr = buckets.get(key)
    if (arr) arr.push(m)
    else buckets.set(key, [m])
  }
  const groups: MeetingGroup[] = []
  for (const key of DATE_GROUP_ORDER) {
    const list = buckets.get(key)
    if (list && list.length > 0) {
      groups.push({ key, label: DATE_GROUP_LABEL[key], meetings: list })
    }
  }
  return groups
}

/**
 * Case-insensitive filter over a meeting's title, speaker names, and resolved
 * tag names. Empty query returns the input unchanged. `tagNamesFor` resolves a
 * meeting's tag ids to their display names (injected so this stays pure).
 */
export function filterMeetingsByQuery(
  meetings: MeetingSummary[],
  query: string,
  tagNamesFor: (m: MeetingSummary) => string[]
): MeetingSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return meetings
  return meetings.filter(
    (m) =>
      m.title.toLowerCase().includes(q) ||
      m.speakerNames.some((n) => n.toLowerCase().includes(q)) ||
      tagNamesFor(m).some((n) => n.toLowerCase().includes(q))
  )
}

/**
 * True when a speaker label is still an auto-generated placeholder the user
 * hasn't named — `Speaker`, `Speaker 2`, `Speaker_2`, or a raw diarization
 * prefix (`R_…` / `M_…`). Drives the "Who was in this meeting?" naming panel.
 * Exported so any view can gate the same panel as a deep-link
 * target. Pure — unit-testable.
 */
export function isUnnamedSpeaker(name: string): boolean {
  const n = name.trim()
  return /^speaker( \d+|_\d+)?$/i.test(n) || /^R_|^M_/.test(n)
}

/** True when at least one speaker in the list is still unnamed. */
export function hasUnnamedSpeakers(names: string[]): boolean {
  return names.some(isUnnamedSpeaker)
}

/**
 * Split a snippet around case-insensitive matches of `query` into text/mark
 * parts, so the renderer can wrap matches in `<mark>` without dangerouslySet
 * HTML. Pure — unit-testable.
 */
export function highlightParts(
  snippet: string,
  query: string
): Array<{ text: string; mark: boolean }> {
  const q = query.trim()
  if (!q) return [{ text: snippet, mark: false }]
  const parts: Array<{ text: string; mark: boolean }> = []
  const lower = snippet.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  while (i < snippet.length) {
    const hit = lower.indexOf(needle, i)
    if (hit < 0) {
      parts.push({ text: snippet.slice(i), mark: false })
      break
    }
    if (hit > i) parts.push({ text: snippet.slice(i, hit), mark: false })
    parts.push({ text: snippet.slice(hit, hit + needle.length), mark: true })
    i = hit + needle.length
  }
  return parts
}
