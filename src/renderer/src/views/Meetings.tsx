import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  Check,
  ChevronDown,
  FileAudio,
  FileCode,
  FileText,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Subtitles
} from 'lucide-react'
import { formatDate, formatDuration } from '../state/format'
import { useTags } from '../state/tags'
import { PencilIcon } from '../components/PencilIcon'
import { SpeakerPicker } from '../components/SpeakerPicker'
import type {
  EnrolledSpeaker,
  ExportFormat,
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  TranscriptSegment
} from '../../../shared/types'

type TabKey = 'transcript' | 'speakers' | 'export' | 'tags'

const NUM_SPEAKERS_OPTIONS: NumSpeakersHint[] = ['auto', 2, 3, 4, 5, 6]

type ExportFormatMeta = {
  value: ExportFormat
  label: string
  hint: string
  Icon: typeof FileText
}
const EXPORT_FORMATS: ExportFormatMeta[] = [
  { value: 'txt', label: 'Plain text', hint: 'Speaker-tagged lines (.txt)', Icon: FileText },
  { value: 'md', label: 'Markdown', hint: 'Speakers bolded with timestamps (.md)', Icon: FileCode },
  { value: 'json', label: 'JSON', hint: 'Structured timeline (.json)', Icon: Braces },
  { value: 'srt', label: 'Subtitles', hint: 'SubRip format (.srt)', Icon: Subtitles },
  { value: 'audio', label: 'Audio', hint: 'Original WAV recording (.wav)', Icon: FileAudio }
]

const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: 'transcript', label: 'Transcript' },
  { key: 'speakers', label: 'Speakers' },
  { key: 'export', label: 'Export' },
  { key: 'tags', label: 'Tags' }
]

const SPEAKER_PALETTE = ['#8ab4f8', '#fdd663', '#a1e3a1', '#f28b82', '#c58af9', '#79d5ff']

function colorForSpeaker(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length]
}

function formatHHMMSS(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function labelForNumSpeakers(v: NumSpeakersHint): string {
  return v === 'auto' ? 'Auto' : `${v} speakers`
}

function parseLegacyTranscript(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  const re = /^\[(\d\d):(\d\d):(\d\d)\]\s+([^:]+):\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const [, h, mi, s, speaker, text] = m
    const start = Number(h) * 3600 + Number(mi) * 60 + Number(s)
    segments.push({ speaker: speaker.trim(), start, end: start, text: text.trim() })
  }
  for (let i = 0; i < segments.length - 1; i++) segments[i].end = segments[i + 1].start
  if (segments.length > 0) segments[segments.length - 1].end =
    segments[segments.length - 1].start + 30
  return segments
}

function uniqueSpeakers(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>()
  for (const s of segments) seen.add(s.speaker)
  return Array.from(seen)
}

interface MeetingsViewProps {
  initialMeetingId: string | null
  onInitialMeetingConsumed: () => void
}

export function MeetingsView(props: MeetingsViewProps): JSX.Element {
  const { initialMeetingId, onInitialMeetingConsumed } = props
  const { tags: allTags, byId: tagById } = useTags()

  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [tab, setTab] = useState<TabKey>('transcript')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  // Title editing
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleValue, setTitleValue] = useState('')

  // Inline list-row rename — separate from the detail-pane title editor.
  const [rowEditingId, setRowEditingId] = useState<string | null>(null)
  const [rowEditingValue, setRowEditingValue] = useState('')

  // Speaker picker — which cluster name is open?
  const [pickerForCluster, setPickerForCluster] = useState<string | null>(null)
  // Per-segment reassignment dropdown — segment index, or null when closed.
  const [pickerForSegment, setPickerForSegment] = useState<number | null>(null)
  // "+ Add speaker" dropdown anchored to its button on the Speakers tab.
  const [addSpeakerOpen, setAddSpeakerOpen] = useState(false)
  const [enrolledSpeakers, setEnrolledSpeakers] = useState<EnrolledSpeaker[]>([])

  // Re-analyse
  const [reanalyzePending, setReanalyzePending] = useState(false)
  const [reanalyzeSpeakers, setReanalyzeSpeakers] = useState<NumSpeakersHint>('auto')
  const [reanalyzeJobId, setReanalyzeJobId] = useState<string | null>(null)

  // Export
  const [exportBusy, setExportBusy] = useState(false)

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  // Seek bar hover tooltip
  const seekWrapRef = useRef<HTMLDivElement | null>(null)
  const [seekHover, setSeekHover] = useState<{ x: number; time: number } | null>(null)

  // Transient flash on a speaker pill when its segment is clicked
  const [flashedSpeaker, setFlashedSpeaker] = useState<string | null>(null)
  const flashTimeoutRef = useRef<number | null>(null)

  // Status banner
  const [statusBanner, setStatusBanner] = useState<string | null>(null)

  // Animated tab indicator. We measure the currently-active tab button's
  // offsetLeft + offsetWidth and slide a single underline pseudo-element to
  // its position via a CSS transform. Re-measures on tab change, layout
  // change (window resize), and when a meeting is selected (since the strip
  // mounts at that point).
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabBtnRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [tabIndicator, setTabIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0
  })

  // Cascade banner — non-blocking nudge shown after a successful rename or
  // per-segment reassign. Tracks the LAST speaker the user just touched so
  // a second reassign within the same visit updates (not stacks) the banner.
  // Cleared on meeting switch, after a re-analyse completes, or when the
  // user clicks "Later". Holding only a string keeps this state cheap and
  // tied to the meeting-session lifecycle.
  const [lastReassignedSpeaker, setLastReassignedSpeaker] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.meetings.list()
      setMeetings(list)
    } catch (err) {
      console.error('Failed to list meetings', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadTranscript = useCallback(async (meetingId: string) => {
    setTranscriptLoading(true)
    try {
      const t = await window.api.meetings.transcript(meetingId)
      setTranscript(t)
    } catch (err) {
      console.error('Failed to read transcript', err)
      setTranscript({ meetingId, transcript: '', speakers: [] })
    } finally {
      setTranscriptLoading(false)
    }
  }, [])

  const loadEnrolled = useCallback(async () => {
    try {
      const list = await window.api.speakers.list()
      setEnrolledSpeakers(list)
    } catch (err) {
      console.error('Failed to load enrolled speakers', err)
      setEnrolledSpeakers([])
    }
  }, [])

  const onSelect = useCallback(
    async (m: MeetingSummary) => {
      setSelectedId(m.id)
      setStatusBanner(null)
      setLastReassignedSpeaker(null)
      setTitleEditing(false)
      setPickerForCluster(null)
      setPickerForSegment(null)
      setAddSpeakerOpen(false)
      setCurrentTime(0)
      setIsPlaying(false)
      setTab('transcript')
      await loadTranscript(m.id)
      await loadEnrolled()
    },
    [loadTranscript, loadEnrolled]
  )

  // If App nav handed us a pre-selected meeting id, open it once.
  useEffect(() => {
    if (!initialMeetingId) return
    const m = meetings.find((x) => x.id === initialMeetingId)
    if (m) {
      void onSelect(m)
      onInitialMeetingConsumed()
    }
  }, [initialMeetingId, meetings, onSelect, onInitialMeetingConsumed])

  // Auto-refresh on backend events
  useEffect(() => {
    const unsub = window.api.backend.onEvent((ev) => {
      if (ev.event === 'done') {
        void refresh()
        if (reanalyzeJobId && ev.jobId === reanalyzeJobId) {
          setReanalyzeJobId(null)
          setStatusBanner('Re-analysis complete.')
          // The cascade just ran — any other clusters that were really the
          // renamed speaker will have been picked up by the global-DB match.
          // The banner has done its job; clear it.
          setLastReassignedSpeaker(null)
          if (selectedId) void loadTranscript(selectedId)
        }
      } else if (ev.event === 'error' && reanalyzeJobId && ev.jobId === reanalyzeJobId) {
        setReanalyzeJobId(null)
        setStatusBanner(`Re-analysis failed: ${ev.message}`)
      } else if (
        ev.event === 'transcribing' &&
        reanalyzeJobId &&
        ev.jobId === reanalyzeJobId
      ) {
        setStatusBanner(`Re-analysing… ${Math.round(ev.progress * 100)}%`)
      }
    })
    return unsub
  }, [refresh, reanalyzeJobId, selectedId, loadTranscript])

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId]
  )

  const segments: TranscriptSegment[] = useMemo(() => {
    if (!transcript) return []
    if (transcript.segments && transcript.segments.length > 0) return transcript.segments
    return parseLegacyTranscript(transcript.transcript)
  }, [transcript])

  const speakersInTranscript = useMemo(() => uniqueSpeakers(segments), [segments])

  /**
   * Detected speakers + user-added "additional" speakers (the latter come
   * from `metadata.json → additionalSpeakers` and represent people who
   * were present but missed by diarization). Both sets are offered in the
   * per-segment reassignment dropdown so the user can re-tag a misheard
   * segment to anyone in the meeting.
   */
  const allSpeakersForPicker = useMemo(() => {
    const seen = new Set<string>()
    const merged: string[] = []
    for (const n of [...speakersInTranscript, ...(selectedMeeting?.additionalSpeakers ?? [])]) {
      if (!n || seen.has(n)) continue
      seen.add(n)
      merged.push(n)
    }
    return merged
  }, [speakersInTranscript, selectedMeeting])

  const audioSrc = useMemo(() => {
    if (!selectedMeeting?.hasAudio) return null
    const id = selectedMeeting.id.startsWith('imported:')
      ? selectedMeeting.id.slice('imported:'.length)
      : selectedMeeting.id
    return `mt-audio://meeting/${encodeURIComponent(id)}/audio.wav`
  }, [selectedMeeting])

  // Keyboard shortcuts
  useEffect(() => {
    if (!selectedMeeting) return
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (titleEditing || pickerForCluster || pickerForSegment !== null || addSpeakerOpen) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (audioRef.current) {
          if (audioRef.current.paused) void audioRef.current.play()
          else audioRef.current.pause()
        }
      } else if (e.code === 'ArrowLeft') {
        if (audioRef.current) {
          audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5)
        }
      } else if (e.code === 'ArrowRight') {
        if (audioRef.current) {
          audioRef.current.currentTime = Math.min(
            audioRef.current.duration || 0,
            audioRef.current.currentTime + 5
          )
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedMeeting, titleEditing, pickerForCluster, pickerForSegment, addSpeakerOpen])

  const activeSegmentIndex = useMemo(() => {
    if (segments.length === 0) return -1
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (currentTime >= s.start && currentTime < s.end) return i
    }
    if (currentTime >= segments[segments.length - 1].end) return segments.length - 1
    return -1
  }, [segments, currentTime])

  // Measure + reposition the tab-strip's sliding indicator whenever the
  // active tab, the strip's existence, or window size changes. useLayoutEffect
  // so the indicator is positioned in the same paint as the new active tab.
  useLayoutEffect(() => {
    const idx = TAB_DEFS.findIndex((t) => t.key === tab)
    const btn = tabBtnRefs.current[idx]
    if (!btn) {
      // Tab strip not mounted (no meeting selected) — keep indicator hidden.
      setTabIndicator({ left: 0, width: 0 })
      return
    }
    setTabIndicator({ left: btn.offsetLeft, width: btn.offsetWidth })
  }, [tab, selectedId])

  // Re-measure on window resize so the indicator follows reflow.
  useEffect(() => {
    function onResize(): void {
      const idx = TAB_DEFS.findIndex((t) => t.key === tab)
      const btn = tabBtnRefs.current[idx]
      if (!btn) return
      setTabIndicator({ left: btn.offsetLeft, width: btn.offsetWidth })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [tab])

  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!isPlaying || activeSegmentIndex < 0) return
    const container = transcriptListRef.current
    if (!container) return
    const row = container.querySelector<HTMLElement>(
      `[data-segment-index="${activeSegmentIndex}"]`
    )
    if (row) {
      const cRect = container.getBoundingClientRect()
      const rRect = row.getBoundingClientRect()
      if (rRect.top < cRect.top || rRect.bottom > cRect.bottom) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
  }, [activeSegmentIndex, isPlaying])

  // ─── Actions ──────────────────────────────────────────────────────────

  const seekTo = useCallback((t: number, play = true) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = t
    setCurrentTime(t)
    if (play) void audioRef.current.play()
  }, [])

  const flashPillFor = useCallback((speaker: string) => {
    setFlashedSpeaker(speaker)
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current)
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashedSpeaker(null)
      flashTimeoutRef.current = null
    }, 1000)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current)
      }
    }
  }, [])

  // Seek-bar hover: derive time from cursor X over the input's bounding rect.
  const onSeekMouseMove = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      if (!duration || duration <= 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      setSeekHover({ x: e.clientX - rect.left, time: ratio * duration })
    },
    [duration]
  )

  const onSeekMouseLeave = useCallback(() => {
    setSeekHover(null)
  }, [])

  const hoverSpeaker = useMemo(() => {
    if (!seekHover) return null
    const t = seekHover.time
    for (const s of segments) {
      if (t >= s.start && t < s.end) return s.speaker
    }
    return null
  }, [seekHover, segments])

  // Active-speaker name (used for pulsing pills during playback)
  const activeSpeaker = useMemo(() => {
    if (!isPlaying) return null
    if (activeSegmentIndex < 0) return null
    return segments[activeSegmentIndex]?.speaker ?? null
  }, [isPlaying, activeSegmentIndex, segments])

  const beginTitleEdit = useCallback(() => {
    if (!selectedMeeting) return
    setTitleEditing(true)
    setTitleValue(selectedMeeting.title)
  }, [selectedMeeting])

  const commitTitle = useCallback(async () => {
    if (!selectedMeeting) return
    const next = titleValue.trim()
    if (!next || next === selectedMeeting.title) {
      setTitleEditing(false)
      return
    }
    try {
      await window.api.meetings.renameTitle(selectedMeeting.id, next)
      setTitleEditing(false)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusBanner(`Rename failed: ${msg}`)
      setTitleEditing(false)
    }
  }, [selectedMeeting, titleValue, refresh])

  const beginRowRename = useCallback((m: MeetingSummary) => {
    setRowEditingId(m.id)
    setRowEditingValue(m.title)
  }, [])

  const cancelRowRename = useCallback(() => {
    setRowEditingId(null)
    setRowEditingValue('')
  }, [])

  const commitRowRename = useCallback(async () => {
    const id = rowEditingId
    if (!id) return
    const original = meetings.find((m) => m.id === id)
    const next = rowEditingValue.trim()
    setRowEditingId(null)
    setRowEditingValue('')
    if (!original || !next || next === original.title) return
    try {
      await window.api.meetings.renameTitle(id, next)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusBanner(`Rename failed: ${msg}`)
    }
  }, [rowEditingId, rowEditingValue, meetings, refresh])

  const onPickSpeaker = useCallback(
    async (clusterName: string, newName: string) => {
      if (!selectedId) return
      try {
        const result = await window.api.meetings.renameSpeaker(
          selectedId,
          clusterName,
          newName
        )
        setStatusBanner(
          result.enrolled
            ? `Assigned "${newName}" — enrolled their voice for next time.`
            : `Renamed to "${newName}".`
        )
        // Show (or update) the cascade banner for this meeting-session.
        setLastReassignedSpeaker(newName)
        setPickerForCluster(null)
        await loadTranscript(selectedId)
        await loadEnrolled()
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Rename failed: ${msg}`)
      }
    },
    [selectedId, loadTranscript, loadEnrolled, refresh]
  )

  /**
   * Reassign a SINGLE segment's speaker (not the cluster). Other segments
   * sharing the old name are untouched. Backed by `meetings:reassignSegment`.
   */
  const onReassignSegment = useCallback(
    async (segmentIndex: number, newName: string) => {
      if (!selectedId) return
      try {
        await window.api.meetings.reassignSegment(selectedId, segmentIndex, newName)
        setPickerForSegment(null)
        setStatusBanner(`Segment ${segmentIndex + 1} → "${newName}".`)
        // Per-segment reassign also benefits from a re-analyse: the user's
        // mental model is "I just told the app this voice is Bob, propagate it".
        // Setting the banner to the new name (replacing, not stacking) keeps
        // one banner per meeting-session even after multiple reassigns.
        setLastReassignedSpeaker(newName)
        await loadTranscript(selectedId)
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Reassign failed: ${msg}`)
      }
    },
    [selectedId, loadTranscript, refresh]
  )

  /**
   * Append a name to this meeting's `additionalSpeakers`. The picker
   * passes either an enrolled name (from the dropdown) or a freshly-typed
   * name. The list refresh propagates the new name into the per-segment
   * picker via `selectedMeeting.additionalSpeakers`.
   */
  const onAddSpeaker = useCallback(
    async (name: string) => {
      if (!selectedId) return
      try {
        await window.api.meetings.addSpeaker(selectedId, name)
        setAddSpeakerOpen(false)
        setStatusBanner(`Added "${name}" to this meeting.`)
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Add speaker failed: ${msg}`)
      }
    },
    [selectedId, refresh]
  )

  const onReanalyze = useCallback(async () => {
    if (!selectedId) return
    const hint: number | undefined =
      reanalyzeSpeakers === 'auto' ? undefined : reanalyzeSpeakers
    setStatusBanner('Re-analysing — keep this window open…')
    try {
      const job = await window.api.meetings.reanalyze(selectedId, hint)
      setReanalyzeJobId(job.jobId)
      setReanalyzePending(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusBanner(`Re-analyse failed: ${msg}`)
    }
  }, [selectedId, reanalyzeSpeakers])

  /**
   * One-click cascade from the banner: re-run mt-batch with the meeting's
   * existing speaker count as the hint so the diarizer keeps the same
   * cluster count, but with the updated global-DB centroid now in play.
   * Any cluster matching the renamed speaker's voice will pick up the name
   * automatically. Falls back to "auto" if speakerCount is unknown.
   */
  const onCascadeReanalyze = useCallback(async () => {
    if (!selectedId || !selectedMeeting) return
    const hint: number | undefined =
      selectedMeeting.speakerCount > 0 ? selectedMeeting.speakerCount : undefined
    setStatusBanner('Re-analysing — keep this window open…')
    try {
      const job = await window.api.meetings.reanalyze(selectedId, hint)
      setReanalyzeJobId(job.jobId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusBanner(`Re-analyse failed: ${msg}`)
    }
  }, [selectedId, selectedMeeting])

  const onExport = useCallback(
    async (format: ExportFormat) => {
      if (!selectedId || !selectedMeeting) return
      setExportBusy(true)
      try {
        const result = await window.api.meetings.export(
          selectedId,
          format,
          selectedMeeting.title
        )
        if (result.savedTo) setStatusBanner(`Saved to ${result.savedTo}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Export failed: ${msg}`)
      } finally {
        setExportBusy(false)
      }
    },
    [selectedId, selectedMeeting]
  )

  const onToggleTag = useCallback(
    async (tagId: string) => {
      if (!selectedMeeting) return
      const current = new Set(selectedMeeting.tagIds)
      if (current.has(tagId)) current.delete(tagId)
      else current.add(tagId)
      try {
        await window.api.meetings.setTags(selectedMeeting.id, Array.from(current))
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Tag update failed: ${msg}`)
      }
    },
    [selectedMeeting, refresh]
  )

  // ─── Render ───────────────────────────────────────────────────────────

  const filteredMeetings = useMemo(() => {
    if (!tagFilter) return meetings
    return meetings.filter((m) => m.tagIds.includes(tagFilter))
  }, [meetings, tagFilter])

  return (
    <div className="meetings">
      <div className="meetings__list-wrap">
        {/* Tag filter chips */}
        <div className="tag-filter-row">
          <button
            className={'tag-chip' + (tagFilter === null ? ' tag-chip--active' : '')}
            onClick={() => setTagFilter(null)}
          >
            All
          </button>
          {allTags.map((tag) => {
            const active = tagFilter === tag.id
            return (
              <button
                key={tag.id}
                className={'tag-chip' + (active ? ' tag-chip--active' : '')}
                style={
                  {
                    borderColor: tag.color,
                    ['--chip-color' as string]: tag.color
                  } as React.CSSProperties
                }
                onClick={() => setTagFilter(tag.id)}
              >
                <span className="tag-chip__dot" style={{ background: tag.color }} />
                {tag.name}
                {active && <span className="tag-chip__check">✓</span>}
              </button>
            )
          })}
        </div>

        <div className="meetings__list">
          {loading && <div className="empty">Loading…</div>}
          {!loading && filteredMeetings.length === 0 && (
            <div className="empty">
              {tagFilter ? 'No meetings with this tag.' : 'No meetings yet. Import audio to create one.'}
            </div>
          )}
          {!loading &&
            filteredMeetings.map((m) => {
              const isEditing = rowEditingId === m.id
              const canRename = !m.id.startsWith('engine:')
              return (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  className={
                    'meetings__row' +
                    (m.id === selectedId ? ' meetings__row--active' : '') +
                    (isEditing ? ' meetings__row--editing' : '')
                  }
                  onClick={() => {
                    if (isEditing) return
                    void onSelect(m)
                  }}
                  onKeyDown={(e) => {
                    if (isEditing) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void onSelect(m)
                    }
                  }}
                >
                  <div className="meetings__row-main">
                    {isEditing ? (
                      <input
                        autoFocus
                        className="meetings__row-input"
                        value={rowEditingValue}
                        onChange={(e) => setRowEditingValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRowRename()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelRowRename()
                          }
                        }}
                        onBlur={() => void commitRowRename()}
                      />
                    ) : (
                      <div className="meetings__row-title">{m.title}</div>
                    )}
                    {!isEditing && canRename && (
                      <button
                        type="button"
                        className="meetings__row-edit"
                        aria-label="Rename meeting"
                        title="Rename meeting"
                        onClick={(e) => {
                          e.stopPropagation()
                          beginRowRename(m)
                        }}
                        onKeyDown={(e) => {
                          // Stop bubbling so the row's keydown handler
                          // doesn't also fire "open meeting" on Enter/Space.
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation()
                          }
                        }}
                      >
                        <PencilIcon size={14} />
                      </button>
                    )}
                  </div>
                  <div className="meetings__row-meta">
                    <span>{formatDate(m.date)}</span>
                    <span>·</span>
                    <span>{formatDuration(m.durationSeconds)}</span>
                    <span>·</span>
                    <span>
                      {m.speakerCount} {m.speakerCount === 1 ? 'speaker' : 'speakers'}
                    </span>
                  </div>
                  {m.tagIds.length > 0 && (
                    <div className="meetings__row-tags">
                      {m.tagIds.map((id) => {
                        const t = tagById(id)
                        if (!t) return null
                        return (
                          <span
                            key={id}
                            className="meetings__row-tag-pill"
                            style={{ background: t.color }}
                          >
                            {t.name}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      </div>

      <div className="meetings__detail">
        {!selectedMeeting && <div className="empty">Select a meeting to view its transcript.</div>}
        {selectedMeeting && (
          <>
            {/* ── Title row ────────────────────────────────────────────── */}
            <div className="detail-header">
              <div className="detail-title-wrap">
                {titleEditing ? (
                  <input
                    autoFocus
                    className="detail-title-input"
                    value={titleValue}
                    onChange={(e) => setTitleValue(e.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitTitle()
                      if (e.key === 'Escape') setTitleEditing(false)
                    }}
                  />
                ) : (
                  <h2 className="detail-title" onClick={beginTitleEdit} title="Click to rename">
                    {selectedMeeting.title}
                  </h2>
                )}
                <div className="detail-meta">
                  <span>{formatDate(selectedMeeting.date)}</span>
                  <span>·</span>
                  <span>{formatDuration(selectedMeeting.durationSeconds)}</span>
                  <span>·</span>
                  <span>{selectedMeeting.speakerCount} speakers</span>
                </div>
              </div>
              <div className="detail-actions">
                <button
                  className="btn"
                  onClick={() => setReanalyzePending((v) => !v)}
                >
                  Re-analyse…
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void window.api.meetings.open(selectedMeeting.folderPath)
                  }}
                >
                  Show in Finder
                </button>
              </div>
            </div>

            {reanalyzePending && (
              <div className="reanalyze-bar">
                <span className="reanalyze-bar__label">Speakers</span>
                <select
                  value={String(reanalyzeSpeakers)}
                  onChange={(e) => {
                    const raw = e.target.value
                    setReanalyzeSpeakers(
                      raw === 'auto' ? 'auto' : (Number(raw) as NumSpeakersHint)
                    )
                  }}
                  className="select"
                >
                  {NUM_SPEAKERS_OPTIONS.map((opt) => (
                    <option key={String(opt)} value={String(opt)}>
                      {labelForNumSpeakers(opt)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn--primary"
                  onClick={() => void onReanalyze()}
                  disabled={reanalyzeJobId !== null}
                >
                  Run
                </button>
                <button className="btn" onClick={() => setReanalyzePending(false)}>
                  Cancel
                </button>
              </div>
            )}

            {/* ── Speaker pills with picker ────────────────────────────── */}
            {speakersInTranscript.length > 0 && (
              <div className="speaker-row">
                <span className="speaker-row__label">Speakers</span>
                {speakersInTranscript.map((name) => {
                  const pulsing = activeSpeaker === name
                  const flashing = flashedSpeaker === name
                  const color = colorForSpeaker(name)
                  return (
                    <div key={name} className="speaker-pill-wrap">
                      <button
                        className={
                          'speaker-pill' +
                          (pulsing ? ' speaker-pill--pulse' : '') +
                          (flashing ? ' speaker-pill--flash' : '')
                        }
                        style={
                          {
                            ['--pill-color' as string]: color
                          } as React.CSSProperties
                        }
                        onClick={() => setPickerForCluster(name)}
                        title="Click to rename or assign an enrolled voice"
                      >
                        <span className="speaker-pill__dot" />
                        <span className="speaker-pill__name">{name}</span>
                        <ChevronDown
                          className="speaker-pill__edit"
                          size={12}
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      </button>
                      {pickerForCluster === name && (
                        <SpeakerPicker
                          current={name}
                          inThisMeeting={speakersInTranscript}
                          enrolled={enrolledSpeakers}
                          onPick={(newName) => onPickSpeaker(name, newName)}
                          onClose={() => setPickerForCluster(null)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* ── Audio player ─────────────────────────────────────────── */}
            {audioSrc && (
              <div className="player-bar">
                <audio
                  ref={audioRef}
                  src={audioSrc}
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration
                    setDuration(isFinite(d) ? d : 0)
                  }}
                  onDurationChange={(e) => {
                    const d = e.currentTarget.duration
                    if (isFinite(d) && d > 0) setDuration(d)
                  }}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
                <button
                  className="player-bar__btn"
                  onClick={() => {
                    if (!audioRef.current) return
                    if (audioRef.current.paused) void audioRef.current.play()
                    else audioRef.current.pause()
                  }}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause size={18} strokeWidth={2.25} aria-hidden="true" />
                  ) : (
                    <Play
                      size={18}
                      strokeWidth={2.25}
                      aria-hidden="true"
                      style={{ marginLeft: 2 }}
                    />
                  )}
                </button>
                <button
                  className="player-bar__btn-small"
                  onClick={() => {
                    if (audioRef.current) {
                      audioRef.current.currentTime = Math.max(
                        0,
                        audioRef.current.currentTime - 5
                      )
                    }
                  }}
                  aria-label="Back 5 seconds"
                  title="Back 5 seconds"
                >
                  <SkipBack size={16} strokeWidth={2} aria-hidden="true" />
                  <span className="player-bar__btn-small-label">5s</span>
                </button>
                <button
                  className="player-bar__btn-small"
                  onClick={() => {
                    if (audioRef.current) {
                      audioRef.current.currentTime = Math.min(
                        audioRef.current.duration || 0,
                        audioRef.current.currentTime + 5
                      )
                    }
                  }}
                  aria-label="Forward 5 seconds"
                  title="Forward 5 seconds"
                >
                  <span className="player-bar__btn-small-label">5s</span>
                  <SkipForward size={16} strokeWidth={2} aria-hidden="true" />
                </button>
                <span className="player-bar__time">{formatHHMMSS(currentTime)}</span>
                <div className="player-bar__seek-wrap" ref={seekWrapRef}>
                  <div
                    className="player-bar__seek-progress"
                    aria-hidden="true"
                    style={{
                      width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%'
                    }}
                  />
                  <input
                    className="player-bar__seek"
                    type="range"
                    min={0}
                    max={duration || 1}
                    step={0.1}
                    value={currentTime}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      if (audioRef.current) audioRef.current.currentTime = t
                      setCurrentTime(t)
                    }}
                    onMouseMove={onSeekMouseMove}
                    onMouseLeave={onSeekMouseLeave}
                    aria-label="Seek"
                  />
                  {seekHover && (
                    <div
                      className="audio-tooltip"
                      style={{ left: seekHover.x }}
                      role="tooltip"
                    >
                      {hoverSpeaker && (
                        <span className="audio-tooltip__speaker">{hoverSpeaker}</span>
                      )}
                      <span className="audio-tooltip__time">
                        {formatHHMMSS(seekHover.time)}
                      </span>
                    </div>
                  )}
                </div>
                <span className="player-bar__time">
                  {duration > 0 ? formatHHMMSS(duration) : '—'}
                </span>
              </div>
            )}

            {/* ── Cascade banner ──────────────────────────────────────────
                Shown after a successful cluster rename or per-segment reassign
                on the currently-selected meeting. One banner per meeting visit:
                a second reassign updates the speaker name in place rather than
                stacking. Auto-dismisses on the next successful re-analyse. */}
            {lastReassignedSpeaker && (
              <div
                className="cascade-banner"
                style={{ borderLeftColor: colorForSpeaker(lastReassignedSpeaker) }}
                role="status"
              >
                <span className="cascade-banner__icon" aria-hidden="true">
                  <RefreshCw size={14} strokeWidth={2} />
                </span>
                <div className="cascade-banner__body">
                  <div className="cascade-banner__line">
                    Updated <strong>&ldquo;{lastReassignedSpeaker}&rdquo;</strong>&apos;s voice
                    in your enrolled list.
                  </div>
                  <div className="cascade-banner__line cascade-banner__line--dim">
                    Re-analyse this meeting to apply{' '}
                    <strong>&ldquo;{lastReassignedSpeaker}&rdquo;</strong> everywhere their
                    voice appears.
                  </div>
                </div>
                <div className="cascade-banner__actions">
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    onClick={() => void onCascadeReanalyze()}
                    disabled={reanalyzeJobId !== null}
                  >
                    {reanalyzeJobId !== null ? 'Re-analysing…' : 'Re-analyse now'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setLastReassignedSpeaker(null)}
                    disabled={reanalyzeJobId !== null}
                  >
                    Later
                  </button>
                </div>
              </div>
            )}

            {/* ── Tab strip with animated indicator ─────────────────────── */}
            <div className="tab-strip" ref={tabStripRef} role="tablist">
              {TAB_DEFS.map((t, i) => (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabBtnRefs.current[i] = el
                  }}
                  role="tab"
                  aria-selected={tab === t.key}
                  className={'tab-strip__btn' + (tab === t.key ? ' tab-strip__btn--active' : '')}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
              <span
                className="tab-strip__indicator"
                aria-hidden="true"
                style={{
                  width: tabIndicator.width,
                  transform: `translateX(${tabIndicator.left}px)`,
                  opacity: tabIndicator.width === 0 ? 0 : 1
                }}
              />
            </div>

            {statusBanner && (
              <div
                className="status-detail"
                style={{
                  color:
                    statusBanner.startsWith('Re-analyse failed') ||
                    statusBanner.startsWith('Rename failed') ||
                    statusBanner.startsWith('Export failed') ||
                    statusBanner.startsWith('Tag update failed') ||
                    statusBanner.startsWith('Reassign failed') ||
                    statusBanner.startsWith('Add speaker failed')
                      ? 'var(--danger, #ef4444)'
                      : undefined
                }}
              >
                {statusBanner}
              </div>
            )}

            {/* ── Tab content ───────────────────────────────────────────── */}
            {tab === 'transcript' && (
              <>
                {transcriptLoading && <div className="empty">Loading transcript…</div>}
                {!transcriptLoading && segments.length === 0 && (
                  <div className="empty">(No transcript text yet.)</div>
                )}
                {!transcriptLoading && segments.length > 0 && (
                  <div className="transcript-list" ref={transcriptListRef}>
                    {segments.map((seg, i) => (
                      <div
                        key={i}
                        data-segment-index={i}
                        className={
                          'segment-row' + (i === activeSegmentIndex ? ' segment-row--active' : '')
                        }
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          seekTo(seg.start, true)
                          flashPillFor(seg.speaker)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            seekTo(seg.start, true)
                            flashPillFor(seg.speaker)
                          }
                        }}
                        title="Click to jump to this point"
                      >
                        <span className="segment-row__time">{formatHHMMSS(seg.start)}</span>
                        <span className="segment-row__speaker-wrap">
                          <button
                            type="button"
                            className="segment-row__speaker"
                            style={{ color: colorForSpeaker(seg.speaker) }}
                            onClick={(e) => {
                              // Don't trigger the seek action on the parent row.
                              e.stopPropagation()
                              setPickerForSegment((cur) => (cur === i ? null : i))
                            }}
                            title="Click to reassign this segment's speaker"
                          >
                            {seg.speaker}
                          </button>
                          {pickerForSegment === i && (
                            <div
                              className="segment-row__picker-anchor"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <SpeakerPicker
                                current={seg.speaker}
                                inThisMeeting={allSpeakersForPicker}
                                addedSpeakers={selectedMeeting.additionalSpeakers ?? []}
                                enrolled={enrolledSpeakers}
                                onPick={(newName) => onReassignSegment(i, newName)}
                                onClose={() => setPickerForSegment(null)}
                              />
                            </div>
                          )}
                        </span>
                        <span className="segment-row__text">{seg.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'speakers' && (
              <div className="tab-pane">
                <p className="tab-pane__intro">
                  Speakers detected in this meeting. Click a name to rename it or assign an
                  already-enrolled voice. Enrolled voices are matched automatically in future
                  imports.
                </p>
                <div className="speakers-tab__pills">
                  {speakersInTranscript.length === 0 &&
                    (selectedMeeting.additionalSpeakers ?? []).length === 0 && (
                      <div className="empty">No speakers detected yet.</div>
                    )}
                  {speakersInTranscript.map((name) => {
                    const pulsing = activeSpeaker === name
                    const flashing = flashedSpeaker === name
                    const color = colorForSpeaker(name)
                    return (
                      <div key={name} className="speaker-pill-wrap">
                        <button
                          className={
                            'speaker-pill' +
                            (pulsing ? ' speaker-pill--pulse' : '') +
                            (flashing ? ' speaker-pill--flash' : '')
                          }
                          style={
                            {
                              ['--pill-color' as string]: color
                            } as React.CSSProperties
                          }
                          onClick={() => setPickerForCluster(name)}
                        >
                          <span className="speaker-pill__dot" />
                          <span className="speaker-pill__name">{name}</span>
                          <ChevronDown
                            className="speaker-pill__edit"
                            size={12}
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        </button>
                        {pickerForCluster === name && (
                          <SpeakerPicker
                            current={name}
                            inThisMeeting={allSpeakersForPicker}
                            addedSpeakers={selectedMeeting.additionalSpeakers ?? []}
                            enrolled={enrolledSpeakers}
                            onPick={(newName) => onPickSpeaker(name, newName)}
                            onClose={() => setPickerForCluster(null)}
                          />
                        )}
                      </div>
                    )
                  })}
                  {(selectedMeeting.additionalSpeakers ?? [])
                    .filter((n) => !speakersInTranscript.includes(n))
                    .map((name) => {
                      const color = colorForSpeaker(name)
                      return (
                        <span
                          key={`add-${name}`}
                          className="speaker-pill speaker-pill--added"
                          style={
                            {
                              ['--pill-color' as string]: color
                            } as React.CSSProperties
                          }
                          title="Added manually — assign segments to this person from the Transcript tab."
                        >
                          <span className="speaker-pill__dot" />
                          <span className="speaker-pill__name">{name}</span>
                        </span>
                      )
                    })}
                  <div className="speaker-pill-wrap">
                    <button
                      className="add-speaker-btn"
                      onClick={() => setAddSpeakerOpen((v) => !v)}
                      title="Add a person who was present but not auto-detected"
                    >
                      + Add speaker
                    </button>
                    {addSpeakerOpen && (
                      <SpeakerPicker
                        current=""
                        inThisMeeting={allSpeakersForPicker}
                        enrolled={enrolledSpeakers}
                        onPick={(newName) => onAddSpeaker(newName)}
                        onClose={() => setAddSpeakerOpen(false)}
                        hideInMeetingGroup
                        newNamePlaceholder="Type a new name…"
                      />
                    )}
                  </div>
                </div>
                {enrolledSpeakers.length > 0 && (
                  <>
                    <h4 className="enrolled-list__heading">All enrolled voices</h4>
                    <div className="enrolled-list">
                      {enrolledSpeakers
                        .slice()
                        .sort((a, b) => b.useCount - a.useCount)
                        .map((s) => (
                          <div key={s.name} className="enrolled-list__row">
                            <span
                              className="enrolled-list__dot"
                              style={{ background: colorForSpeaker(s.name) }}
                              aria-hidden="true"
                            />
                            <span className="enrolled-list__name">{s.name}</span>
                            <span className="enrolled-list__count">
                              {s.useCount} meeting{s.useCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === 'export' && (
              <div className="tab-pane">
                <p className="tab-pane__intro">
                  Export this meeting in different formats. Audio export is the original WAV.
                </p>
                <div className="export-grid">
                  {EXPORT_FORMATS.map((f) => {
                    const Icon = f.Icon
                    return (
                      <button
                        key={f.value}
                        className="export-card"
                        onClick={() => void onExport(f.value)}
                        disabled={
                          exportBusy ||
                          (f.value === 'audio' && !selectedMeeting.hasAudio) ||
                          selectedMeeting.id.startsWith('engine:')
                        }
                      >
                        <span className="export-card__icon" aria-hidden="true">
                          <Icon size={18} strokeWidth={1.75} />
                        </span>
                        <div className="export-card__text">
                          <div className="export-card__label">{f.label}</div>
                          <div className="export-card__hint">{f.hint}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {tab === 'tags' && (
              <div className="tab-pane">
                <p className="tab-pane__intro">
                  Apply tags so you can filter meetings by project or type. Manage the tag list in
                  Settings.
                </p>
                {allTags.length === 0 ? (
                  <div className="empty">
                    No tags defined yet. Open Settings → Tags to create some.
                  </div>
                ) : (
                  <div className="tag-chip-row">
                    {allTags.map((tag) => {
                      const active = selectedMeeting.tagIds.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          className={'tag-chip' + (active ? ' tag-chip--active' : '')}
                          style={
                            {
                              borderColor: tag.color,
                              ['--chip-color' as string]: tag.color
                            } as React.CSSProperties
                          }
                          onClick={() => void onToggleTag(tag.id)}
                        >
                          <span className="tag-chip__dot" style={{ background: tag.color }} />
                          {tag.name}
                          {active && (
                            <span className="tag-chip__check" aria-hidden="true">
                              <Check size={12} strokeWidth={2.5} />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
