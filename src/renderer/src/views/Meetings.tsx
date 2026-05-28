import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDate, formatDuration } from '../state/format'
import type {
  ExportFormat,
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  TranscriptSegment
} from '../../../shared/types'

const NUM_SPEAKERS_OPTIONS: NumSpeakersHint[] = ['auto', 2, 3, 4, 5, 6]
const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'txt', label: 'Plain text (.txt)' },
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'srt', label: 'Subtitles (.srt)' },
  { value: 'audio', label: 'Audio (.wav)' }
]

const SPEAKER_PALETTE = [
  '#8ab4f8', // soft blue
  '#fdd663', // amber
  '#a1e3a1', // green
  '#f28b82', // coral
  '#c58af9', // lavender
  '#79d5ff'  // cyan
]

function colorForSpeaker(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length]
}

function formatHHMMSS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function labelForNumSpeakers(v: NumSpeakersHint): string {
  return v === 'auto' ? 'Auto' : `${v} speakers`
}

/** Pull a fallback structured-segment list from the raw transcript.txt when
 *  transcript.json is missing (legacy meetings). */
function parseLegacyTranscript(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  const re = /^\[(\d\d):(\d\d):(\d\d)\]\s+([^:]+):\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const [, h, mi, s, speaker, text] = m
    const start = Number(h) * 3600 + Number(mi) * 60 + Number(s)
    segments.push({ speaker: speaker.trim(), start, end: start, text: text.trim() })
  }
  // Patch end times so each segment ends at the next one's start.
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].end = segments[i + 1].start
  }
  if (segments.length > 0) {
    segments[segments.length - 1].end = segments[segments.length - 1].start + 30
  }
  return segments
}

function uniqueSpeakers(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>()
  for (const s of segments) seen.add(s.speaker)
  return Array.from(seen)
}

export function MeetingsView(): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)

  // Title editing
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleValue, setTitleValue] = useState('')

  // Speaker rename
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  // Re-analyse
  const [reanalyzePending, setReanalyzePending] = useState(false)
  const [reanalyzeSpeakers, setReanalyzeSpeakers] = useState<NumSpeakersHint>(2)
  const [reanalyzeJobId, setReanalyzeJobId] = useState<string | null>(null)

  // Export menu
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

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

  const onSelect = useCallback(
    async (m: MeetingSummary) => {
      setSelectedId(m.id)
      setRenameTarget(null)
      setRenameValue('')
      setStatusBanner(null)
      setTitleEditing(false)
      setExportOpen(false)
      setCurrentTime(0)
      setIsPlaying(false)
      await loadTranscript(m.id)
    },
    [loadTranscript]
  )

  // Auto-refresh on backend job 'done' + re-analyse progress + completion.
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

  // Structured segments — prefer transcript.json, fall back to parsed plain text.
  const segments: TranscriptSegment[] = useMemo(() => {
    if (!transcript) return []
    if (transcript.segments && transcript.segments.length > 0) return transcript.segments
    return parseLegacyTranscript(transcript.transcript)
  }, [transcript])

  const speakersInTranscript = useMemo(() => uniqueSpeakers(segments), [segments])

  // ─── Audio src ─────────────────────────────────────────────────────────
  // Pull the folder id out of the meeting id and use it as the source for
  // the registered `mt-audio://` protocol. Audio only available for
  // imported meetings (engine meetings have a different audio layout).
  const audioSrc = useMemo(() => {
    if (!selectedMeeting?.hasAudio) return null
    const id = selectedMeeting.id.startsWith('imported:')
      ? selectedMeeting.id.slice('imported:'.length)
      : selectedMeeting.id
    return `mt-audio://meeting/${encodeURIComponent(id)}/audio.wav`
  }, [selectedMeeting])

  // Keyboard shortcuts (Space play/pause, ←/→ ±5s) — only when transcript
  // panel is focused and not editing.
  useEffect(() => {
    if (!selectedMeeting) return
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (titleEditing || renameTarget) return
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
  }, [selectedMeeting, titleEditing, renameTarget])

  const activeSegmentIndex = useMemo(() => {
    if (segments.length === 0) return -1
    // Linear scan is fine for ~hundreds of segments; switch to binary search
    // if we ever see meetings with thousands.
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (currentTime >= s.start && currentTime < s.end) return i
    }
    if (currentTime >= segments[segments.length - 1].end) return segments.length - 1
    return -1
  }, [segments, currentTime])

  // Scroll the active segment into view as audio plays.
  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!isPlaying || activeSegmentIndex < 0) return
    const container = transcriptListRef.current
    if (!container) return
    const row = container.querySelector<HTMLElement>(
      `[data-segment-index="${activeSegmentIndex}"]`
    )
    if (row) {
      const containerRect = container.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      if (rowRect.top < containerRect.top || rowRect.bottom > containerRect.bottom) {
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

  const beginRename = useCallback((name: string) => {
    setRenameTarget(name)
    setRenameValue(name)
    setStatusBanner(null)
  }, [])

  const cancelRename = useCallback(() => {
    setRenameTarget(null)
    setRenameValue('')
  }, [])

  const commitRename = useCallback(async () => {
    if (!selectedId || !renameTarget) return
    const next = renameValue.trim()
    if (!next || next === renameTarget) {
      cancelRename()
      return
    }
    setRenameBusy(true)
    try {
      const result = await window.api.meetings.renameSpeaker(selectedId, renameTarget, next)
      setStatusBanner(
        result.enrolled
          ? `Renamed "${renameTarget}" → "${next}" and enrolled their voice for future meetings.`
          : `Renamed "${renameTarget}" → "${next}" in this meeting.`
      )
      cancelRename()
      await loadTranscript(selectedId)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusBanner(`Rename failed: ${msg}`)
    } finally {
      setRenameBusy(false)
    }
  }, [selectedId, renameTarget, renameValue, cancelRename, loadTranscript, refresh])

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
      setExportOpen(false)
      try {
        const result = await window.api.meetings.export(
          selectedId,
          format,
          selectedMeeting.title
        )
        if (result.savedTo) {
          setStatusBanner(`Saved to ${result.savedTo}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatusBanner(`Export failed: ${msg}`)
      } finally {
        setExportBusy(false)
      }
    },
    [selectedId, selectedMeeting]
  )

  return (
    <div className="meetings">
      <div className="meetings__list">
        {loading && <div className="empty">Loading…</div>}
        {!loading && meetings.length === 0 && (
          <div className="empty">
            No meetings yet.
            <br />
            Start watching or import audio to create one.
          </div>
        )}
        {!loading &&
          meetings.map((m) => (
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
            </button>
          ))}
      </div>

      <div className="meetings__detail">
        {!selectedMeeting && <div className="empty">Select a meeting to view its transcript.</div>}
        {selectedMeeting && (
          <>
            {/* ── Title bar ────────────────────────────────────────────── */}
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
                  <h2
                    className="detail-title"
                    onClick={beginTitleEdit}
                    title="Click to rename"
                  >
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
                  onClick={() => {
                    setReanalyzePending((v) => !v)
                    setExportOpen(false)
                  }}
                >
                  Re-analyse…
                </button>
                <div className="export-menu-wrap">
                  <button
                    className="btn"
                    onClick={() => {
                      setExportOpen((v) => !v)
                      setReanalyzePending(false)
                    }}
                    disabled={exportBusy}
                  >
                    Export ▾
                  </button>
                  {exportOpen && (
                    <div className="export-menu">
                      {EXPORT_FORMATS.map((f) => (
                        <button
                          key={f.value}
                          className="export-menu__item"
                          onClick={() => {
                            void onExport(f.value)
                          }}
                          disabled={
                            (f.value === 'audio' && !selectedMeeting.hasAudio) ||
                            selectedMeeting.id.startsWith('engine:')
                          }
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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

            {/* ── Re-analyse picker ────────────────────────────────────── */}
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
                  onClick={() => {
                    void onReanalyze()
                  }}
                  disabled={reanalyzeJobId !== null}
                >
                  Run
                </button>
                <button className="btn" onClick={() => setReanalyzePending(false)}>
                  Cancel
                </button>
              </div>
            )}

            {/* ── Speaker pills ────────────────────────────────────────── */}
            {speakersInTranscript.length > 0 && (
              <div className="speaker-row">
                <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>Speakers:</span>
                {speakersInTranscript.map((name) =>
                  renameTarget === name ? (
                    <span key={name} className="speaker-rename-group">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') cancelRename()
                        }}
                        disabled={renameBusy}
                        placeholder="Real name…"
                        className="speaker-rename-input"
                      />
                      <button
                        className="btn btn--primary btn--small"
                        disabled={renameBusy || !renameValue.trim()}
                        onClick={() => {
                          void commitRename()
                        }}
                      >
                        Save
                      </button>
                      <button
                        className="btn btn--small"
                        onClick={cancelRename}
                        disabled={renameBusy}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      key={name}
                      className="speaker-pill"
                      style={{ borderColor: colorForSpeaker(name) }}
                      onClick={() => beginRename(name)}
                      title={`Rename "${name}" and enrol their voice for future meetings`}
                    >
                      <span
                        className="speaker-pill__dot"
                        style={{ background: colorForSpeaker(name) }}
                      />
                      {name}
                      <span className="speaker-pill__edit">✎</span>
                    </button>
                  )
                )}
              </div>
            )}

            {/* ── Audio player ────────────────────────────────────────── */}
            {audioSrc && (
              <div className="player-bar">
                <audio
                  ref={audioRef}
                  src={audioSrc}
                  preload="metadata"
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
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
                  aria-label="Back 5 seconds"
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
                  aria-label="Forward 5 seconds"
                >
                  +5s
                </button>
                <span className="player-bar__time">{formatHHMMSS(currentTime)}</span>
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
                />
                <span className="player-bar__time">{formatHHMMSS(duration)}</span>
              </div>
            )}

            {/* ── Status banner ───────────────────────────────────────── */}
            {statusBanner && (
              <div
                className="status-detail"
                style={{
                  color:
                    statusBanner.startsWith('Re-analyse failed') ||
                    statusBanner.startsWith('Rename failed') ||
                    statusBanner.startsWith('Export failed')
                      ? 'var(--danger, #ef4444)'
                      : undefined
                }}
              >
                {statusBanner}
              </div>
            )}

            {/* ── Structured transcript ───────────────────────────────── */}
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
                    onClick={() => seekTo(seg.start, true)}
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
      </div>
    </div>
  )
}
