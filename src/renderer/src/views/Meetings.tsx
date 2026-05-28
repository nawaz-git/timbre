import { useCallback, useEffect, useState } from 'react'
import { formatDate, formatDuration } from '../state/format'
import type { MeetingSummary, MeetingTranscript } from '../../../shared/types'

export function MeetingsView(): JSX.Element {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)

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

  const onSelect = useCallback(async (m: MeetingSummary) => {
    setSelectedId(m.id)
    setTranscriptLoading(true)
    try {
      // Click loads the transcript inline. Finder is one explicit click away
      // via the "Show in Finder" button — clicking a row should not open
      // additional windows behind the user's back.
      const t = await window.api.meetings.transcript(m.id)
      setTranscript(t)
    } catch (err) {
      console.error('Failed to read transcript', err)
      setTranscript({ meetingId: m.id, transcript: '', speakers: [] })
    } finally {
      setTranscriptLoading(false)
    }
  }, [])

  // Auto-refresh when a backend job reports done, so a freshly imported
  // file appears in the list without the user having to navigate away.
  useEffect(() => {
    const unsub = window.api.backend.onEvent((ev) => {
      if (ev.event === 'done') {
        void refresh()
      }
    })
    return unsub
  }, [refresh])

  const selectedMeeting = meetings.find((m) => m.id === selectedId) ?? null

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
              <button
                className="btn"
                onClick={() => {
                  void window.api.meetings.open(selectedMeeting.folderPath)
                }}
              >
                Show in Finder
              </button>
            </div>
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
