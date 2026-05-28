import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDate, formatDuration } from '../state/format'
import { useTags } from '../state/tags'
import { SpeakerPicker } from '../components/SpeakerPicker'
import type {
  EnrolledSpeaker,
  ExportFormat,
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  TranscriptSegment
} from '../../../shared/types'

const NUM_SPEAKERS_OPTIONS: NumSpeakersHint[] = ['auto', 2, 3, 4, 5, 6]
const EXPORT_FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'txt', label: 'Plain text', hint: 'Speaker-tagged lines (.txt)' },
  { value: 'md', label: 'Markdown', hint: 'Speakers bolded with timestamps (.md)' },
  { value: 'json', label: 'JSON', hint: 'Structured timeline (.json)' },
  { value: 'srt', label: 'Subtitles', hint: 'SubRip format (.srt)' },
  { value: 'audio', label: 'Audio', hint: 'Original WAV recording (.wav)' }
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

type TabKey = 'transcript' | 'speakers' | 'export' | 'tags'

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

  // Speaker picker — which cluster name is open?
  const [pickerForCluster, setPickerForCluster] = useState<string | null>(null)
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
      setTitleEditing(false)
      setPickerForCluster(null)
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
      if (titleEditing || pickerForCluster) return
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
  }, [selectedMeeting, titleEditing, pickerForCluster])

  const activeSegmentIndex = useMemo(() => {
    if (segments.length === 0) return -1
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (currentTime >= s.start && currentTime < s.end) return i
    }
    if (currentTime >= segments[segments.length - 1].end) return segments.length - 1
    return -1
  }, [segments, currentTime])

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
            filteredMeetings.map((m) => (
              <button
                key={m.id}
                className={
                  'meetings__row' + (m.id === selectedId ? ' meetings__row--active' : '')
                }
                onClick={() => {
                  void onSelect(m)
                }}
              >
                <div className="meetings__row-title">{m.title}</div>
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
              </button>
            ))}
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
                <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>Speakers:</span>
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
                <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>Speakers:</span>
                {speakersInTranscript.map((name) => {
                  const pulsing = activeSpeaker === name
                  const flashing = flashedSpeaker === name
                  return (
                    <div key={name} className="speaker-pill-wrap">
                      <button
                        className={
                          'speaker-pill' +
                          (pulsing ? ' speaker-pill--pulse' : '') +
                          (flashing ? ' speaker-pill--flash' : '')
                        }
                        style={{ borderColor: colorForSpeaker(name) }}
                        onClick={() => setPickerForCluster(name)}
                        title="Click to rename or assign an enrolled voice"
                      >
                        <span
                          className="speaker-pill__dot"
                          style={{ background: colorForSpeaker(name) }}
                        />
                        {name}
                        <span className="speaker-pill__edit">▾</span>
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
                  {isPlaying ? '❚❚' : '▶'}
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
                >
                  −5s
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
                >
                  +5s
                </button>
                <span className="player-bar__time">{formatHHMMSS(currentTime)}</span>
                <div className="player-bar__seek-wrap" ref={seekWrapRef}>
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

            {/* ── Tab strip ────────────────────────────────────────────── */}
            <div className="tab-strip">
              {(
                [
                  ['transcript', 'Transcript'],
                  ['speakers', 'Speakers'],
                  ['export', 'Export'],
                  ['tags', 'Tags']
                ] as [TabKey, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={'tab-strip__btn' + (tab === k ? ' tab-strip__btn--active' : '')}
                  onClick={() => setTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>

            {statusBanner && (
              <div
                className="status-detail"
                style={{
                  color:
                    statusBanner.startsWith('Re-analyse failed') ||
                    statusBanner.startsWith('Rename failed') ||
                    statusBanner.startsWith('Export failed') ||
                    statusBanner.startsWith('Tag update failed')
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
                      <button
                        key={i}
                        data-segment-index={i}
                        className={
                          'segment-row' + (i === activeSegmentIndex ? ' segment-row--active' : '')
                        }
                        onClick={() => {
                          seekTo(seg.start, true)
                          flashPillFor(seg.speaker)
                        }}
                        title="Click to jump to this point"
                      >
                        <span className="segment-row__time">{formatHHMMSS(seg.start)}</span>
                        <span
                          className="segment-row__speaker"
                          style={{ color: colorForSpeaker(seg.speaker) }}
                        >
                          {seg.speaker}
                        </span>
                        <span className="segment-row__text">{seg.text}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'speakers' && (
              <div className="tab-pane">
                <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
                  Speakers detected in this meeting. Click a name to rename it or assign an
                  already-enrolled voice. Enrolled voices are matched automatically in future
                  imports.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {speakersInTranscript.length === 0 && (
                    <div className="empty">No speakers detected yet.</div>
                  )}
                  {speakersInTranscript.map((name) => {
                    const pulsing = activeSpeaker === name
                    const flashing = flashedSpeaker === name
                    return (
                      <div key={name} className="speaker-pill-wrap">
                        <button
                          className={
                            'speaker-pill' +
                            (pulsing ? ' speaker-pill--pulse' : '') +
                            (flashing ? ' speaker-pill--flash' : '')
                          }
                          style={{ borderColor: colorForSpeaker(name) }}
                          onClick={() => setPickerForCluster(name)}
                        >
                          <span
                            className="speaker-pill__dot"
                            style={{ background: colorForSpeaker(name) }}
                          />
                          {name}
                          <span className="speaker-pill__edit">▾</span>
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
                {enrolledSpeakers.length > 0 && (
                  <>
                    <h4 style={{ marginTop: 24, marginBottom: 8 }}>All enrolled voices</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {enrolledSpeakers
                        .slice()
                        .sort((a, b) => b.useCount - a.useCount)
                        .map((s) => (
                          <div
                            key={s.name}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '6px 0',
                              fontSize: 13
                            }}
                          >
                            <span
                              className="speaker-pill__dot"
                              style={{ background: colorForSpeaker(s.name) }}
                            />
                            <span style={{ flex: 1 }}>{s.name}</span>
                            <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
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
                <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
                  Export this meeting in different formats. Audio export is the original WAV.
                </p>
                <div className="export-grid">
                  {EXPORT_FORMATS.map((f) => (
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
                      <div className="export-card__label">{f.label}</div>
                      <div className="export-card__hint">{f.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === 'tags' && (
              <div className="tab-pane">
                <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
                  Apply tags so you can filter meetings by project or type. Manage the tag list in
                  Settings.
                </p>
                {allTags.length === 0 ? (
                  <div className="empty">
                    No tags defined yet. Open Settings → Tags to create some.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
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
                          {active && <span className="tag-chip__check">✓</span>}
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
