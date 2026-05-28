/**
 * Network — the people-and-meetings graph view.
 *
 * Mintr's USP-grade screenshot: an Obsidian-style force-directed graph
 * built entirely from on-device data. Each node is either a meeting
 * (circle, coloured by primary tag, sized by duration) or a named
 * person (pill with initials, sized by total talk-time). Edges connect
 * people to the meetings they attended, weighted by how long they
 * spoke. The whole picture re-renders whenever the user filters by
 * tag, time-range, or types into the search box.
 *
 * What this view does NOT do: it does not transcribe, summarise, or
 * call any external API. The graph is pure relational data the user
 * already had — Mintr just gives it shape.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Inbox,
  Network as NetworkIcon,
  Search,
  ShieldCheck,
  Tag as TagIcon,
  X
} from 'lucide-react'
import { useTags } from '../state/tags'
import {
  applyFilters,
  TIME_RANGE_LABELS,
  useNetworkGraph,
  type NetworkNode,
  type TimeRange
} from '../state/networkData'
import { MeetingGraph } from '../components/MeetingGraph'
import { formatDuration } from '../state/format'

interface NetworkViewProps {
  onOpenMeeting: (id: string) => void
}

/**
 * The active theme. We can't easily hook into Mintr's settings provider
 * from here without expanding scope, so we read `data-theme` straight
 * off the document element — same source the CSS variables key off.
 */
function useThemeMode(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

const TIME_RANGES: TimeRange[] = ['all', 'year', 'days90', 'days30', 'week']

export function NetworkView({ onOpenMeeting }: NetworkViewProps): JSX.Element {
  const { graph, isLoading, error, refresh } = useNetworkGraph()
  const { tags, byId: tagById } = useTags()
  const theme = useThemeMode()

  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [tagIds, setTagIds] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)

  // Size the canvas from its parent — ForceGraph2D won't auto-fit, so
  // we measure with ResizeObserver and pass explicit width/height.
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 600
  })
  useEffect(() => {
    const el = canvasWrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setCanvasSize({
        width: Math.max(200, Math.floor(width)),
        height: Math.max(200, Math.floor(height))
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Apply toolbar filters to the graph. Memo so the underlying ForceGraph
  // only sees a new `data` reference when filters actually change.
  const filteredGraph = useMemo(
    () => applyFilters(graph, { timeRange, tagIds, search }),
    [graph, timeRange, tagIds, search]
  )

  const resolveMeetingColor = useCallback(
    (node: NetworkNode) => {
      if (node.kind !== 'meeting') return node.color
      if (!node.primaryTagId) return node.color
      const tag = tagById(node.primaryTagId)
      return tag?.color ?? node.color
    },
    [tagById]
  )

  const onToggleTag = useCallback((id: string) => {
    setTagIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const onResetFilters = useCallback(() => {
    setTimeRange('all')
    setTagIds(new Set())
    setSearch('')
    setSelectedNodeId(null)
  }, [])

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null
    return filteredGraph.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [filteredGraph.nodes, selectedNodeId])

  const onNodeClick = useCallback(
    (node: NetworkNode) => {
      setSelectedNodeId(node.id)
    },
    []
  )

  const onNodeHover = useCallback(
    (node: NetworkNode | null) => setHoveredNodeId(node?.id ?? null),
    []
  )

  // For the right rail — list of meetings the selected person attended.
  const selectedPersonMeetings = useMemo(() => {
    if (!selectedNode || selectedNode.kind !== 'person') return []
    const ids = new Set<string>()
    for (const l of filteredGraph.links) {
      if (typeof l.source === 'string' && l.source === selectedNode.id) {
        ids.add(typeof l.target === 'string' ? l.target : '')
      }
    }
    return filteredGraph.nodes.filter((n) => n.kind === 'meeting' && ids.has(n.id))
  }, [filteredGraph, selectedNode])

  // For the right rail — speaker breakdown when a meeting is selected.
  const selectedMeetingSpeakers = useMemo(() => {
    if (!selectedNode || selectedNode.kind !== 'meeting') return []
    const matches: Array<{ id: string; label: string; color: string; seconds: number }> = []
    for (const l of filteredGraph.links) {
      const targetId = typeof l.target === 'string' ? l.target : ''
      const sourceId = typeof l.source === 'string' ? l.source : ''
      if (targetId !== selectedNode.id) continue
      const personNode = filteredGraph.nodes.find((n) => n.id === sourceId)
      if (!personNode) continue
      matches.push({
        id: personNode.id,
        label: personNode.label,
        color: personNode.color,
        seconds: l.weight
      })
    }
    matches.sort((a, b) => b.seconds - a.seconds)
    return matches
  }, [filteredGraph, selectedNode])

  const showEmptyState = !isLoading && graph.meetingCount < 2

  return (
    <div className="network">
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className="network__toolbar">
        <div className="network__title">
          <NetworkIcon size={16} aria-hidden="true" />
          <span>Network</span>
          <span className="network__stat">
            {filteredGraph.meetingCount}{' '}
            {filteredGraph.meetingCount === 1 ? 'meeting' : 'meetings'} ·{' '}
            {filteredGraph.personCount}{' '}
            {filteredGraph.personCount === 1 ? 'person' : 'people'}
          </span>
        </div>

        <div className="network__time-range" role="group" aria-label="Time range">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr}
              type="button"
              className={
                'network__chip' +
                (timeRange === tr ? ' network__chip--active' : '')
              }
              onClick={() => setTimeRange(tr)}
            >
              {TIME_RANGE_LABELS[tr]}
            </button>
          ))}
        </div>

        {tags.length > 0 && (
          <div className="network__tag-filter" role="group" aria-label="Filter by tag">
            {tags.map((t) => {
              const active = tagIds.has(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  className={
                    'network__chip network__chip--tag' +
                    (active ? ' network__chip--active' : '')
                  }
                  style={active ? { background: t.color, borderColor: t.color } : undefined}
                  onClick={() => onToggleTag(t.id)}
                >
                  <span
                    className="network__chip-dot"
                    aria-hidden="true"
                    style={{ background: t.color }}
                  />
                  {t.name}
                </button>
              )
            })}
          </div>
        )}

        <div className="network__search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search nodes"
          />
          {search && (
            <button
              type="button"
              className="network__search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        {(timeRange !== 'all' || tagIds.size > 0 || search) && (
          <button
            type="button"
            className="network__reset"
            onClick={onResetFilters}
          >
            Reset
          </button>
        )}
      </div>

      {/* ── Body — canvas + optional right rail ──────────────────── */}
      <div className="network__body">
        <div className="network__canvas" ref={canvasWrapRef}>
          {isLoading && (
            <div className="network__loading">Loading meetings…</div>
          )}
          {error && (
            <div className="network__error" role="alert">
              Couldn&apos;t load the network: {error}{' '}
              <button className="link-btn" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {!isLoading && !error && showEmptyState && (
            <div className="network__empty">
              <Inbox size={32} aria-hidden="true" />
              <div className="network__empty-title">Your network will appear here</div>
              <div className="network__empty-hint">
                Capture or import 2 or more meetings and Mintr will start mapping who you
                talk to, how often, and which projects bring them together — all derived
                locally from your transcripts.
              </div>
            </div>
          )}
          {!isLoading && !error && !showEmptyState && (
            <MeetingGraph
              data={filteredGraph}
              selectedNodeId={selectedNodeId}
              hoveredNodeId={hoveredNodeId}
              resolveMeetingColor={resolveMeetingColor}
              width={canvasSize.width}
              height={canvasSize.height}
              theme={theme}
              searchLower={search.trim().toLowerCase()}
              onNodeClick={onNodeClick}
              onNodeHover={onNodeHover}
            />
          )}

          {/* Privacy reassurance — sits in the bottom-left so the
              user always sees the "this is local" claim while they're
              looking at their relationship graph. */}
          {!showEmptyState && (
            <div className="network__privacy">
              <ShieldCheck size={12} aria-hidden="true" />
              <span>
                Built from your local meetings. Nothing is uploaded.
              </span>
            </div>
          )}
        </div>

        {selectedNode && (
          <aside className="network__detail" aria-label="Selected node details">
            <button
              type="button"
              className="network__detail-close"
              onClick={() => setSelectedNodeId(null)}
              aria-label="Close detail"
            >
              <X size={14} aria-hidden="true" />
            </button>

            {selectedNode.kind === 'meeting' ? (
              <>
                <div className="network__detail-kind">Meeting</div>
                <div className="network__detail-title">{selectedNode.label}</div>
                <div className="network__detail-meta">
                  {formatDuration(selectedNode.totalSeconds)} ·{' '}
                  {selectedNode.speakerCount ?? 0}{' '}
                  {selectedNode.speakerCount === 1 ? 'speaker' : 'speakers'}
                </div>

                {selectedNode.primaryTagId && tagById(selectedNode.primaryTagId) && (
                  <div className="network__detail-tags">
                    <span
                      className="network__detail-tag"
                      style={{
                        background: tagById(selectedNode.primaryTagId)!.color
                      }}
                    >
                      <TagIcon size={10} aria-hidden="true" />
                      {tagById(selectedNode.primaryTagId)!.name}
                    </span>
                  </div>
                )}

                <div className="network__detail-section">Speaker breakdown</div>
                <ul className="network__speakers">
                  {selectedMeetingSpeakers.length === 0 && (
                    <li className="network__speakers-empty">
                      No named speakers — every voice still shows as Speaker 1 / 2 / …
                      Rename them in the meeting view to start populating the graph.
                    </li>
                  )}
                  {selectedMeetingSpeakers.map((s) => (
                    <li key={s.id} className="network__speakers-row">
                      <span
                        className="network__speakers-dot"
                        style={{ background: s.color }}
                        aria-hidden="true"
                      />
                      <span className="network__speakers-name">{s.label}</span>
                      <span className="network__speakers-time">
                        {formatDuration(s.seconds)}
                      </span>
                    </li>
                  ))}
                </ul>

                {selectedNode.meetingId && (
                  <button
                    type="button"
                    className="btn btn--primary network__detail-cta"
                    onClick={() => onOpenMeeting(selectedNode.meetingId!)}
                  >
                    Open meeting
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="network__detail-kind">Person</div>
                <div className="network__detail-title">{selectedNode.label}</div>
                <div className="network__detail-meta">
                  {selectedNode.meetingCount ?? 0}{' '}
                  {selectedNode.meetingCount === 1 ? 'meeting' : 'meetings'} ·{' '}
                  {formatDuration(selectedNode.totalSeconds)} total talk-time
                </div>

                <div className="network__detail-section">Meetings together</div>
                <ul className="network__person-meetings">
                  {selectedPersonMeetings.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="network__person-meeting"
                        onClick={() => {
                          if (m.meetingId) onOpenMeeting(m.meetingId)
                        }}
                      >
                        <span
                          className="network__person-meeting-dot"
                          style={{ background: resolveMeetingColor(m) }}
                          aria-hidden="true"
                        />
                        <span className="network__person-meeting-title">{m.label}</span>
                        <span className="network__person-meeting-meta">
                          {formatDuration(m.totalSeconds)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
