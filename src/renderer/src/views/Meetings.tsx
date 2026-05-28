import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDate, formatDuration } from '../state/format'
import type { MeetingSummary, MeetingTranscript, NumSpeakersHint } from '../../../shared/types'

const NUM_SPEAKERS_OPTIONS: NumSpeakersHint[] = ['auto', 2, 3, 4, 5, 6]

function labelForNumSpeakers(v: NumSpeakersHint): string {
  return v === 'auto' ? 'Auto' : `${v} speakers`
}

/** Extract the unique speaker labels appearing in a transcript.txt body. */
function extractSpeakers(transcript: string): string[] {
  const seen = new Set<string>()
  const re = /^\[\d\d:\d\d:\d\d\]\s+([^:]+):/gm
  for (const m of transcript.matchAll(re)) {
    const name = m[1].trim()
    if (name) seen.add(name)
  }
  return Array.from(seen)
}

export function MeetingsView(): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [reanalyzePending, setReanalyzePending] = useState(false)
  const [reanalyzeSpeakers, setReanalyzeSpeakers] = useState<NumSpeakersHint>(2)
  const [reanalyzeJobId, setReanalyzeJobId] = useState<string | null>(null)
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
      await loadTranscript(m.id)
    },
    [loadTranscript]
  )

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
      } else if (ev.event === 'transcribing' && reanalyzeJobId && ev.jobId === reanalyzeJobId) {
        setStatusBanner(`Re-analysing… ${Math.round(ev.progress * 100)}%`)
      }
    })
    return unsub
  }, [refresh, reanalyzeJobId, selectedId, loadTranscript])

  const selectedMeeting = meetings.find((m) => m.id === selectedId) ?? null
  const speakersInTranscript = useMemo(
    () => (transcript ? extractSpeakers(transcript.transcript) : []),
    [transcript]
  )

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
          : `Renamed "${renameTarget}" → "${next}" in this meeting. No centroid found to enrol.`
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
            <div className="meetings__detail-header">
              <div className="meetings__detail-title">{selectedMeeting.title}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    setReanalyzePending((v) => !v)
                    setStatusBanner(null)
                  }}
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '8px 0',
                  padding: 10,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--divider)',
                  borderRadius: 6
                }}
              >
                <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>Speakers:</span>
                <select
                  value={String(reanalyzeSpeakers)}
                  onChange={(e) => {
                    const raw = e.target.value
                    setReanalyzeSpeakers(
                      raw === 'auto' ? 'auto' : (Number(raw) as NumSpeakersHint)
                    )
                  }}
                  style={{
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    border: '1px solid var(--divider)',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 13
                  }}
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

            {speakersInTranscript.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  margin: '8px 0 12px',
                  alignItems: 'center'
                }}
              >
                <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>Speakers in this meeting:</span>
                {speakersInTranscript.map((name) =>
                  renameTarget === name ? (
                    <span key={name} style={{ display: 'inline-flex', gap: 6 }}>
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
                        style={{
                          background: 'var(--bg-elevated)',
                          color: 'var(--fg)',
                          border: '1px solid var(--divider)',
                          borderRadius: 6,
                          padding: '2px 8px',
                          fontSize: 13,
                          minWidth: 120
                        }}
                      />
                      <button
                        className="btn btn--primary"
                        disabled={renameBusy || !renameValue.trim()}
                        onClick={() => {
                          void commitRename()
                        }}
                      >
                        Save
                      </button>
                      <button className="btn" onClick={cancelRename} disabled={renameBusy}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      key={name}
                      className="btn"
                      style={{ fontSize: 13, padding: '2px 10px' }}
                      onClick={() => beginRename(name)}
                      title={`Rename "${name}" and enrol their voice for future meetings`}
                    >
                      {name} ✎
                    </button>
                  )
                )}
              </div>
            )}

            {statusBanner && (
              <div
                className="status-detail"
                style={{
                  marginBottom: 12,
                  color: statusBanner.startsWith('Re-analyse failed') ||
                    statusBanner.startsWith('Rename failed')
                    ? 'var(--danger, #ef4444)'
                    : undefined
                }}
              >
                {statusBanner}
              </div>
            )}

            {transcriptLoading && <div className="empty">Loading transcript…</div>}
            {!transcriptLoading && transcript && (
              <pre className="transcript">
                {transcript.transcript.trim().length > 0
                  ? transcript.transcript
                  : '(No transcript text yet.)'}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}
