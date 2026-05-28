import { useCallback, useEffect, useState } from 'react'
import { useRecordingStatus } from '../state/recording'
import { useSettings } from '../state/settings'
import { formatDuration } from '../state/format'
import type { BackendEvent, RecordingState } from '../../../shared/types'

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
}

export function HomeView(): JSX.Element {
  const { settings } = useSettings()
  const { status, start, stop } = useRecordingStatus()
  const [banner, setBanner] = useState<JobBanner | null>(null)

  // Subscribe to backend events for the duration of this view's lifecycle.
  useEffect(() => {
    const unsub = window.api.backend.onEvent((ev: BackendEvent) => {
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
          case 'done':
            return {
              ...current,
              phase: 'done',
              message: 'Done. Saved to ' + ev.outputDir,
              progress: 100
            }
          case 'error':
            return { ...current, phase: 'error', message: ev.message }
        }
      })
    })
    return unsub
  }, [])

  const onToggleWatch = useCallback(async () => {
    if (status.state === 'idle') {
      await start()
    } else {
      await stop()
    }
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
      message: 'Queued for transcription…'
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

  // While the backend job is mid-flight, prefer its progress over the polled
  // recording status for the progress bar (recording status only repolls 1 Hz).
  const progressPercent =
    banner && (banner.phase === 'transcribing' || banner.phase === 'done')
      ? banner.progress
      : status.progressPercent

  const showProgress =
    progressPercent !== undefined &&
    (status.state === 'transcribing' ||
      (banner !== null && banner.phase !== 'done' && banner.phase !== 'error'))

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
          <div
            className="progress-bar"
            aria-label={`Transcription ${progressPercent}%`}
          >
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
          </div>
        )}
      </div>
    </div>
  )
}
