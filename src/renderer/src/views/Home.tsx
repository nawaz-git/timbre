import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRecordingStatus } from '../state/recording'
import { useSettings } from '../state/settings'
import { useTags } from '../state/tags'
import { formatDate, formatDuration } from '../state/format'
import type {
  BackendEvent,
  MeetingSummary,
  RecordingState,
  SpeakerMatch
} from '../../../shared/types'

const STATE_LABEL: Record<RecordingState, string> = {
  idle: 'Idle',
  watching: 'Watching',
  recording: 'Recording',
  transcribing: 'Transcribing'
}

const HEADLINE: Record<RecordingState, string> = {
  idle: 'Ready when you are.',
  watching: 'Listening for meetings.',
  recording: 'Capturing audio.',
  transcribing: 'Transcribing audio.'
}

interface JobBanner {
  jobId: string
  filePath: string
  phase: 'queued' | 'loading' | 'transcribing' | 'diarizing' | 'merging' | 'done' | 'error'
  progress?: number
  message?: string
  matches?: SpeakerMatch[]
}

interface HomeViewProps {
  onOpenMeeting: (id: string) => void
}

export function HomeView({ onOpenMeeting }: HomeViewProps): JSX.Element {
  const { settings } = useSettings()
  const { byId: tagById } = useTags()
  const { status, start, stop } = useRecordingStatus()
  const [banner, setBanner] = useState<JobBanner | null>(null)
  const [recent, setRecent] = useState<MeetingSummary[]>([])

  const loadRecent = useCallback(async () => {
    try {
      const list = await window.api.meetings.list()
      setRecent(list.slice(0, 5))
    } catch (err) {
      console.error('Failed to load recent meetings', err)
    }
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  useEffect(() => {
    const unsub = window.api.backend.onEvent((ev: BackendEvent) => {
      if (ev.event === 'done') {
        void loadRecent()
      }
      setBanner((current) => {
        if (!current || current.jobId !== ev.jobId) return current
        switch (ev.event) {
          case 'loading_audio':
            return { ...current, phase: 'loading', message: 'Loading audio…' }
          case 'loading_models':
            return { ...current, phase: 'loading', message: 'Loading transcription models…' }
          case 'transcribing':
            return {
              ...current,
              phase: 'transcribing',
              progress: Math.round(ev.progress * 100),
              message: undefined
            }
          case 'diarizing':
            return { ...current, phase: 'diarizing', message: 'Separating speakers…' }
          case 'merging':
            return { ...current, phase: 'merging', message: 'Building transcript…' }
          case 'matched_speakers':
            return { ...current, matches: ev.matches }
          case 'done':
            return {
              ...current,
              phase: 'done',
              message: 'Done. Saved to ' + ev.outputDir,
              progress: 100
            }
          case 'error':
            return { ...current, phase: 'error', message: ev.message }
          default:
            return current
        }
      })
    })
    return unsub
  }, [loadRecent])

  const onToggleWatch = useCallback(async () => {
    if (status.state === 'idle') await start()
    else await stop()
  }, [status.state, start, stop])

  const onImport = useCallback(async () => {
    setBanner(null)
    const result = await window.api.file.import()
    if (!result.filePath) return
    if (!settings) {
      setBanner({
        jobId: 'no-settings',
        filePath: '',
        phase: 'error',
        message: 'Settings not loaded yet — try again in a moment.'
      })
      return
    }
    const job = await window.api.backend.spawn(result.filePath, settings.outputFolder)
    setBanner({
      jobId: job.jobId,
      filePath: result.filePath,
      phase: 'queued',
      message: 'Queued for transcription. Speaker count is auto-detected — if the result looks wrong, open the meeting and use "Re-analyse…" with an explicit count.'
    })
  }, [settings])

  const dotClass =
    status.state === 'recording'
      ? 'status-dot status-dot--recording'
      : status.state === 'watching'
        ? 'status-dot status-dot--watching'
        : status.state === 'transcribing'
          ? 'status-dot status-dot--transcribing'
          : 'status-dot'

  const progressPercent =
    banner && (banner.phase === 'transcribing' || banner.phase === 'done')
      ? banner.progress
      : status.progressPercent

  const showProgress =
    progressPercent !== undefined &&
    (status.state === 'transcribing' ||
      (banner !== null && banner.phase !== 'done' && banner.phase !== 'error'))

  const recognised = useMemo(
    () => banner?.matches?.filter((m) => m.enrolled) ?? [],
    [banner]
  )

  return (
    <div className="home">
      <div className="status-card">
        <div className="status-indicator">
          <span className={dotClass} />
          <span>{STATE_LABEL[status.state]}</span>
        </div>
        <div className="status-headline">{HEADLINE[status.state]}</div>

        {status.title && (
          <div className="status-detail">
            <strong style={{ color: 'var(--fg)', fontWeight: 500 }}>{status.title}</strong>
            {typeof status.elapsedSeconds === 'number' && (
              <> · {formatDuration(status.elapsedSeconds)}</>
            )}
          </div>
        )}

        {showProgress && (
          <div className="progress-bar" aria-label={`Transcription ${progressPercent}%`}>
            <div
              className="progress-bar__fill"
              style={{ width: `${Math.min(100, Math.max(0, progressPercent ?? 0))}%` }}
            />
          </div>
        )}

        <div className="actions-row">
          <button
            className={status.state === 'idle' ? 'btn btn--primary' : 'btn btn--danger'}
            onClick={() => {
              void onToggleWatch()
            }}
          >
            {status.state === 'idle' ? 'Start Watching' : 'Stop Watching'}
          </button>
          <button
            className="btn"
            onClick={() => {
              void onImport()
            }}
          >
            Import audio file…
          </button>
        </div>

        {banner && (
          <div
            className="status-detail"
            style={{
              marginTop: 16,
              color: banner.phase === 'error' ? 'var(--danger, #ef4444)' : undefined
            }}
          >
            {banner.message ??
              `Job ${banner.jobId.slice(0, 8)} — ${banner.phase}${
                banner.progress !== undefined ? ` (${banner.progress}%)` : ''
              }`}
            {recognised.length > 0 && (
              <div style={{ marginTop: 6 }}>
                Recognised:{' '}
                {recognised
                  .map((m) => `${m.enrolled} (${Math.round(m.similarity * 100)}%)`)
                  .join(', ')}
              </div>
            )}
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="recent-meetings">
          <h3 className="recent-meetings__heading">Recent meetings</h3>
          <div className="recent-meetings__grid">
            {recent.map((m) => (
              <button
                key={m.id}
                className="recent-card"
                onClick={() => onOpenMeeting(m.id)}
                title={m.title}
              >
                <div className="recent-card__title">{m.title}</div>
                <div className="recent-card__meta">
                  <span>{formatDate(m.date)}</span>
                  <span>·</span>
                  <span>{formatDuration(m.durationSeconds)}</span>
                  <span>·</span>
                  <span>
                    {m.speakerCount} {m.speakerCount === 1 ? 'speaker' : 'speakers'}
                  </span>
                </div>
                {m.tagIds.length > 0 && (
                  <div className="recent-card__tags">
                    {m.tagIds.map((id) => {
                      const t = tagById(id)
                      if (!t) return null
                      return (
                        <span
                          key={id}
                          className="recent-card__tag"
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
      )}
    </div>
  )
}
