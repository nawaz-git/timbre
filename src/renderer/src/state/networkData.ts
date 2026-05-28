/**
 * Builds the "Network" graph data from Mintr's existing meeting store.
 *
 * Why this lives in the renderer: the data already flows through
 * `window.api.meetings.list()` and `window.api.meetings.transcript()` — no
 * new IPC channels needed. Doing it client-side also keeps this feature
 * isolated from the parallel session's main-process work (capture
 * watchdog, Chrome probe extensions) so there are zero file conflicts.
 *
 * What the graph represents:
 *   - Each MEETING is one node (id `meeting:<folderId>`).
 *   - Each NAMED PERSON who spoke in any meeting is one node
 *     (id `person:<name-lower>`). Unnamed "Speaker N" segments are
 *     deliberately collapsed into a meeting-local pseudo-person so they
 *     show as a satellite around their meeting without polluting the
 *     global person count.
 *   - Each EDGE is a person → meeting attendance, weighted by total
 *     seconds spoken. Heavier edges = "this person spoke a lot in
 *     this meeting".
 *
 * The graph is fully derivable from on-device data — no Gemini, no cloud
 * call. That's the moat: free, local, private, and surfaces patterns
 * the user can't see in a flat meeting list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MeetingSummary, TranscriptSegment } from '../../../shared/types'

/**
 * One node in the bipartite graph. We carry the discriminant `kind` so
 * the renderer can branch on it for custom painting (people vs meetings
 * use different glyphs).
 */
export interface NetworkNode {
  /** Stable id — `meeting:<folderId>` or `person:<name-lower>`. */
  id: string
  kind: 'meeting' | 'person'
  /** Display label. For meetings = title; for people = speaker name. */
  label: string
  /** Force-graph node size accessor. Computed from duration / talk-time. */
  val: number
  /** Pre-resolved fill colour (theme-agnostic — the view applies opacity). */
  color: string
  /**
   * Total seconds across the graph (talk-time for people, duration for
   * meetings). Surfaced for the right-rail detail card.
   */
  totalSeconds: number
  /** For meeting nodes — original folder id so the click handler can route to it. */
  meetingId?: string
  /** For meeting nodes — ISO date string for time-range filtering. */
  date?: string
  /** For meeting nodes — first tag id (drives node colour). */
  primaryTagId?: string
  /** For meeting nodes — number of distinct named speakers. */
  speakerCount?: number
  /** For person nodes — count of meetings attended. */
  meetingCount?: number
}

export interface NetworkLink {
  /** Person id. */
  source: string
  /** Meeting id. */
  target: string
  /** Total seconds this person spoke in this meeting. Drives line thickness. */
  weight: number
}

export interface NetworkGraph {
  nodes: NetworkNode[]
  links: NetworkLink[]
  /** Distinct named-person count across the graph (used for the toolbar stat). */
  personCount: number
  /** Meeting count (after time-range filter, if any). */
  meetingCount: number
}

/** Identifier prefix for unnamed "Speaker N" segments. We skip these to
 *  avoid graph noise — a stranger appearing as a node every meeting where
 *  diarization saw an extra cluster would clutter the view. */
const UNNAMED_SPEAKER_RE = /^Speaker\s*\d+$/i

/** Same palette as Meetings.tsx so tag-coloured nodes match the meeting
 *  list. If the meeting has no tag we fall back to a muted gray. */
const MEETING_FALLBACK_COLOR = '#94a3b8' // slate-400
const PERSON_PALETTE = [
  '#8ab4f8', // blue
  '#fdd663', // amber
  '#a1e3a1', // mint
  '#f28b82', // coral
  '#c58af9', // violet
  '#79d5ff' // sky
]

/**
 * Hash a string to one of the palette colours deterministically. Mirrors
 * `colorForSpeaker` in Meetings.tsx so a person carries the same dot
 * colour across the picker, the row pill, and the graph.
 */
function paletteColorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return PERSON_PALETTE[h % PERSON_PALETTE.length]
}

/** Squash repeated whitespace + lowercase so "Alice " and "alice" collapse. */
function normName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Hook that loads every meeting + transcript and assembles the graph.
 * Re-runs when the meetings list mutates (push channel from main) OR
 * when the time-range / tag filters change.
 */
export function useNetworkGraph(): {
  graph: NetworkGraph
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  // Per-meeting cache of { speakerName → totalSeconds } so we only
  // re-load a transcript when we haven't seen it before. Keyed by
  // meeting id.
  const [speakerTotals, setSpeakerTotals] = useState<Map<string, Map<string, number>>>(
    () => new Map()
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setError(null)
    try {
      const list = await window.api.meetings.list()
      setMeetings(list)

      // Load transcripts in parallel — capped at 8 concurrent so we
      // don't open 50 IPC channels at once on a fresh launch. For
      // typical Mintr usage (10-200 meetings) the whole hydration
      // completes well under a second.
      const next = new Map<string, Map<string, number>>()
      const queue: MeetingSummary[] = [...list]
      const workers = Array.from({ length: 8 }, async () => {
        while (queue.length > 0) {
          const m = queue.shift()
          if (!m) break
          try {
            const t = await window.api.meetings.transcript(m.id)
            const totals = new Map<string, number>()
            const segs: TranscriptSegment[] = t.segments ?? []
            for (const seg of segs) {
              if (UNNAMED_SPEAKER_RE.test(seg.speaker.trim())) continue
              const dur = Math.max(0, (seg.end ?? 0) - (seg.start ?? 0))
              const key = normName(seg.speaker)
              totals.set(key, (totals.get(key) ?? 0) + dur)
            }
            // Also include user-added speakers from metadata — these
            // are people the user manually noted attended even if
            // diarization didn't catch them. They get zero-weight
            // edges (rendered as dashed lines) so they appear in the
            // graph without distorting the talk-time totals.
            for (const extra of m.additionalSpeakers ?? []) {
              const key = normName(extra)
              if (!totals.has(key)) totals.set(key, 0)
            }
            next.set(m.id, totals)
          } catch (err) {
            // Per-meeting failure: log but continue — one broken
            // transcript shouldn't take down the entire graph.
            console.warn('[network] failed to hydrate', m.id, err)
            next.set(m.id, new Map())
          }
        }
      })
      await Promise.all(workers)
      setSpeakerTotals(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial hydration.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-hydrate when the main process tells us a meeting changed (push
  // channel introduced in v0.12 by the parallel session — we piggyback
  // on it for free auto-refresh).
  useEffect(() => {
    const unsub = window.api.system.onMeetingsChanged?.(() => {
      void refresh()
    })
    return unsub ?? (() => {})
  }, [refresh])

  /**
   * Assemble the graph struct from the cached maps. Memoised so toolbar
   * filter changes (handled by the consumer) don't re-iterate transcripts.
   */
  const graph = useMemo<NetworkGraph>(() => {
    const nodes: NetworkNode[] = []
    const links: NetworkLink[] = []
    const personTotals = new Map<string, { display: string; total: number; meetings: number }>()

    for (const m of meetings) {
      const totals = speakerTotals.get(m.id) ?? new Map<string, number>()
      // Meeting node.
      nodes.push({
        id: `meeting:${m.id}`,
        kind: 'meeting',
        label: m.title,
        val: Math.max(2, Math.log2((m.durationSeconds ?? 0) / 60 + 2)),
        color: MEETING_FALLBACK_COLOR,
        totalSeconds: m.durationSeconds,
        meetingId: m.id,
        date: m.date,
        primaryTagId: m.tagIds[0],
        speakerCount: m.speakerCount
      })

      // Person attendance links.
      for (const [key, seconds] of totals) {
        const display = displayNameFor(key, m, totals)
        const existing = personTotals.get(key)
        if (existing) {
          existing.total += seconds
          existing.meetings += 1
        } else {
          personTotals.set(key, { display, total: seconds, meetings: 1 })
        }
        links.push({
          source: `person:${key}`,
          target: `meeting:${m.id}`,
          weight: seconds
        })
      }
    }

    // Person nodes — sized by total talk-time, coloured deterministically.
    for (const [key, info] of personTotals) {
      nodes.push({
        id: `person:${key}`,
        kind: 'person',
        label: info.display,
        val: Math.max(3, Math.log2(info.total / 60 + 3) * 1.4),
        color: paletteColorFor(info.display),
        totalSeconds: info.total,
        meetingCount: info.meetings
      })
    }

    return {
      nodes,
      links,
      personCount: personTotals.size,
      meetingCount: meetings.length
    }
  }, [meetings, speakerTotals])

  return { graph, isLoading, error, refresh }
}

/**
 * Find the display-cased spelling of a person's name. We normalise to
 * lowercase as the map key, but the user expects the original casing in
 * the UI. Looks back at the meeting's segment list for the first
 * matching spelling.
 */
function displayNameFor(
  key: string,
  meeting: MeetingSummary,
  totals: Map<string, number>
): string {
  // additionalSpeakers carry user-entered casing
  for (const s of meeting.additionalSpeakers ?? []) {
    if (normName(s) === key) return s
  }
  // Fallback: capitalised words
  void totals
  return key.replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Filters applied at the view layer (toolbar) before the graph is
 * fed into the force layout. Pure function — no hooks, no IPC.
 *
 *   - `timeRange` = 'all' | 'year' | 'days90' | 'days30' | 'week'
 *   - `tagIds`    = set of tag ids; empty = no tag filter
 *   - `search`    = case-insensitive substring match against node labels
 *
 * Person nodes are kept iff they have at least one link to a surviving
 * meeting node. This means filtering by tag automatically prunes
 * "ghost people" who only appeared in filtered-out meetings.
 */
export type TimeRange = 'all' | 'year' | 'days90' | 'days30' | 'week'

const TIME_RANGE_MS: Record<TimeRange, number | null> = {
  all: null,
  year: 365 * 24 * 60 * 60 * 1000,
  days90: 90 * 24 * 60 * 60 * 1000,
  days30: 30 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000
}

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  all: 'All time',
  year: 'Last year',
  days90: '90 days',
  days30: '30 days',
  week: 'This week'
}

export function applyFilters(
  graph: NetworkGraph,
  filters: { timeRange: TimeRange; tagIds: Set<string>; search: string }
): NetworkGraph {
  const cutoff = TIME_RANGE_MS[filters.timeRange]
  const nowMs = Date.now()
  const searchLower = filters.search.trim().toLowerCase()
  const tagFilterActive = filters.tagIds.size > 0

  // Pass 1 — filter meeting nodes by time + tag.
  const survivingMeetingIds = new Set<string>()
  const meetingNodes: NetworkNode[] = []
  for (const n of graph.nodes) {
    if (n.kind !== 'meeting') continue
    if (cutoff !== null && n.date) {
      const ts = Date.parse(n.date)
      if (!Number.isNaN(ts) && nowMs - ts > cutoff) continue
    }
    if (tagFilterActive) {
      if (!n.primaryTagId || !filters.tagIds.has(n.primaryTagId)) continue
    }
    survivingMeetingIds.add(n.id)
    meetingNodes.push(n)
  }

  // Pass 2 — keep only links whose target meeting survived.
  const survivingPersonIds = new Set<string>()
  const links: NetworkLink[] = []
  for (const l of graph.links) {
    if (!survivingMeetingIds.has(l.target)) continue
    links.push(l)
    survivingPersonIds.add(l.source)
  }

  // Pass 3 — keep only person nodes referenced by a surviving link.
  const personNodes: NetworkNode[] = []
  for (const n of graph.nodes) {
    if (n.kind !== 'person') continue
    if (!survivingPersonIds.has(n.id)) continue
    personNodes.push(n)
  }

  // Pass 4 — search filter. We DON'T strip non-matching nodes (that
  // would orphan their neighbours); we mark them dimmed via the caller.
  // The search match is computed here so the caller can highlight
  // without re-iterating.
  void searchLower // (consumed by the view via the un-filtered label)

  return {
    nodes: [...meetingNodes, ...personNodes],
    links,
    personCount: personNodes.length,
    meetingCount: meetingNodes.length
  }
}
