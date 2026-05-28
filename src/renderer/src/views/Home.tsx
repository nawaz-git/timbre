import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  FolderOpen,
  Inbox,
  Loader2,
  Mic,
  MicOff,
  Radio,
  RefreshCcw,
  Tag as TagIcon,
  Upload,
  UserCheck,
  Video
} from 'lucide-react'
import { useRecordingStatus } from '../state/recording'
import { useSettings } from '../state/settings'
import { useTags } from '../state/tags'
import {
  usePermissions,
  useChromeMeet,
  useCaptureWatchdog,
  useLiveCapture
} from '../state/permissions'
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

/**
 * The status glyph next to the state label. We swap the existing colored
 * dot for a lucide icon — it carries more semantic weight at the same size
 * and reads better against the all-monochrome status card. The Loader2
 * `animate-spin` class is replaced here with the inline `home-status-icon--spin`
 * class so we don't rely on Tailwind utility names.
 */
function StatusIcon({ state }: { state: RecordingState }): JSX.Element {
  if (state === 'recording') return <Mic size={16} aria-hidden="true" />
  if (state === 'watching') return <Radio size={16} aria-hidden="true" />
  if (state === 'transcribing')
    return <Loader2 size={16} aria-hidden="true" className="home-status-icon--spin" />
  return <MicOff size={16} aria-hidden="true" />
}

/** mm:ss since the live-capture card became active. Used by the timer chip. */
function formatLiveDuration(startedAt: number | null): string {
  if (!startedAt) return '0:00'
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "Started 7:13 PM" type label — uses the user's locale via toLocaleTimeString. */
function formatStartTime(startedAt: number | null): string {
  if (!startedAt) return 'just now'
  return new Date(startedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
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
  const { status: perms, openPane } = usePermissions()
  const chromeMeet = useChromeMeet()
  const watchdog = useCaptureWatchdog()
  const liveCapture = useLiveCapture(chromeMeet.tab?.meetingId ?? null)
  const [restartingHelper, setRestartingHelper] = useState(false)
  const [restartResult, setRestartResult] = useState<string | null>(null)

  // mm:ss timer for the live capture card. We derive it from
  // liveCapture.startedAt and re-render once per second to keep it
  // ticking. The 1s interval also lets the card animate the pulsing
  // dot in sync with the timer text.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!liveCapture.active) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [liveCapture.active])

  const handleRestartHelper = useCallback(async () => {
    setRestartingHelper(true)
    setRestartResult(null)
    try {
      const result = await window.api.system.restartHelper()
      setRestartResult(
        result.ok
          ? 'Helper restarted — it should now pick up the granted permission.'
          : `Helper restart failed: ${result.message ?? 'unknown error'}`
      )
    } catch (err) {
      setRestartResult(`Helper restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestartingHelper(false)
    }
  }, [])
  const [banner, setBanner] = useState<JobBanner | null>(null)
  const [recent, setRecent] = useState<MeetingSummary[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  const loadRecent = useCallback(async () => {
    try {
      const list = await window.api.meetings.list()
      setRecent(list.slice(0, 5))
    } catch (err) {
      console.error('Failed to load recent meetings', err)
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  // v0.13+: subscribe to the main process's push channel that fires
  // whenever new files land in liveRecordingsRoot OR the user's import
  // folder. Without this the user had to manually leave + re-enter the
  // Home tab to see a freshly-captured meeting.
  useEffect(() => {
    const unsub = window.api.system.onMeetingsChanged(() => {
      void loadRecent()
    })
    return unsub
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
      message:
        'Queued for transcription. Speaker count is auto-detected — if the result looks wrong, open the meeting and use "Re-analyse…" with an explicit count.'
    })
  }, [settings])

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

  const isWatching = status.state !== 'idle'

  // Screen Recording is the one permission whose absence silently breaks
  // window-title-based Meet detection. Microphone failure is loud (the
  // engine surfaces it) so it doesn't need the same prominent banner.
  // 'not-determined' is treated as denied for surface purposes — until the
  // user has explicitly allowed, we should warn them.
  const screenPermissionMissing =
    perms.screenRecording === 'denied' || perms.screenRecording === 'not-determined'

  return (
    <div className="home">
      {screenPermissionMissing && (
        <div className="permission-banner" role="alert">
          <span className="permission-banner__icon" aria-hidden="true">
            <AlertTriangle size={16} strokeWidth={2} />
          </span>
          <div className="permission-banner__body">
            <div className="permission-banner__title">
              Screen Recording permission needed
            </div>
            <div className="permission-banner__desc">
              Mintr reads the active window title to detect when you join a Google
              Meet or other call. Without this permission, meetings start without
              being captured. The screen pixels are never recorded — only the
              window title.
            </div>
          </div>
          <button
            className="btn btn--primary btn--small"
            onClick={() => void openPane('screen-recording')}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span>Open System Settings</span>
          </button>
        </div>
      )}

      {/*
        Helper-permission banner (v0.13+). Mintr bundles a separate Swift
        helper app, MintrEngine.app, which has its OWN TCC bundle id
        (`ai.nawaz.mintr-engine`). Granting any TCC permission to Mintr
        does NOT grant it to the engine. The capture watchdog fires when
        Chrome reports a live Meet but the engine hasn't written any
        files — that's the smoking-gun pattern for "engine needs its own
        permission". TICKET-002 adds a `hint` field classifying WHICH
        permission is most likely missing (via a unified-log grep on the
        main side); we switch on it here to name the right TCC entry
        explicitly so the user can find it in the list.

        For `accessibility`: macOS does NOT auto-prompt — the user must
        manually drag MintrEngine.app onto the Accessibility list,
        which is why this needs its own dedicated copy.
        For `microphone` / `screenRecording`: explicit copy too.
        For `unknown` (and undefined, e.g. while we're still classifying):
        fall back to the original Screen Recording copy since that was
        the original watchdog assumption.
      */}
      {watchdog.helperPermissionLikely && (() => {
        const hint = watchdog.hint
        // Per-hint banner content. `accessibility` is the canonical
        // case TICKET-002 was built for (the engine's PermissionHealthCheck
        // fails specifically on Accessibility). The other hints share
        // the same structure but name a different TCC service.
        let title: string
        let body: JSX.Element
        let primaryLabel: string
        let primaryPane: 'screen-recording' | 'microphone' | 'accessibility'
        if (hint === 'accessibility') {
          title = 'Mintr Engine needs Accessibility permission'
          primaryLabel = 'Open Accessibility'
          primaryPane = 'accessibility'
          body = (
            <>
              macOS doesn&apos;t prompt for this automatically. Click{' '}
              <em>Open Accessibility</em>, then drag{' '}
              <code className="inline-code">MintrEngine.app</code> from the
              Finder window onto the Accessibility list. Then click{' '}
              <em>Restart engine</em> — macOS only picks up newly-granted
              permissions when the process restarts.
            </>
          )
        } else if (hint === 'microphone') {
          title = 'Mintr Engine needs Microphone access'
          primaryLabel = 'Open Microphone'
          primaryPane = 'microphone'
          body = (
            <>
              The bundled capture engine couldn&apos;t open the system
              microphone. Click <em>Open Microphone</em>, toggle{' '}
              <code className="inline-code">Mintr Engine</code> on, then
              click <em>Restart engine</em> below.
            </>
          )
        } else if (hint === 'screenRecording') {
          title = 'Mintr Engine needs Screen Recording'
          primaryLabel = 'Open Screen Recording'
          primaryPane = 'screen-recording'
          body = (
            <>
              The engine reads the active window title to detect Meet
              calls. Click <em>Open Screen Recording</em>, toggle{' '}
              <code className="inline-code">Mintr Engine</code> on, then
              click <em>Restart engine</em>.
            </>
          )
        } else {
          // 'unknown' or undefined (still classifying). Fall back to the
          // pre-T002 generic copy, biased toward Screen Recording since
          // that's the historical watchdog assumption.
          title = "Engine helper isn't capturing this meeting"
          primaryLabel = 'Open Screen Recording'
          primaryPane = 'screen-recording'
          body = (
            <>
              Mintr detected your Meet, but the bundled capture engine
              (<code className="inline-code">Mintr Engine</code>) hasn&apos;t
              recorded any audio yet. The engine has its own permission
              entries in System Settings, separate from Mintr&apos;s.
              <br />
              <strong>Two-step fix:</strong> (1) Look for{' '}
              <code className="inline-code">Mintr Engine</code> in the
              Screen Recording list and toggle it on. (2) Click{' '}
              <em>Restart engine</em> below — macOS doesn&apos;t refresh
              permission for a running process, so a granted permission only
              takes effect after the engine restarts.
            </>
          )
        }
        return (
          <div className="permission-banner permission-banner--danger" role="alert">
            <span className="permission-banner__icon" aria-hidden="true">
              <AlertTriangle size={16} strokeWidth={2} />
            </span>
            <div className="permission-banner__body">
              <div className="permission-banner__title">{title}</div>
              <div className="permission-banner__desc">{body}</div>
              {restartResult && (
                <div className="permission-banner__result">{restartResult}</div>
              )}
            </div>
            <div className="permission-banner__actions">
              <button
                className="btn btn--primary btn--small"
                onClick={() => void openPane(primaryPane)}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{primaryLabel}</span>
              </button>
              <button
                className="btn btn--small"
                onClick={() => void window.api.system.revealHelper()}
                title="Reveal MintrEngine.app in Finder so you can drag it onto the privacy pane"
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span>Reveal engine in Finder</span>
              </button>
              <button
                className="btn btn--small"
                onClick={() => void handleRestartHelper()}
                disabled={restartingHelper}
              >
                <RefreshCcw
                  size={14}
                  aria-hidden="true"
                  className={restartingHelper ? 'home-status-icon--spin' : undefined}
                />
                <span>{restartingHelper ? 'Restarting…' : 'Restart engine'}</span>
              </button>
            </div>
          </div>
        )
      })()}

      {chromeMeet.tab && !liveCapture.active && (
        <div className="meet-live-card" role="status">
          <span className="meet-live-card__dot" aria-hidden="true" />
          <div className="meet-live-card__body">
            <div className="meet-live-card__title">
              <Video size={14} aria-hidden="true" /> Google Meet detected in Chrome
            </div>
            <div className="meet-live-card__meta">
              <span className="meet-live-card__id">{chromeMeet.tab.meetingId}</span>
              <span aria-hidden="true">·</span>
              <span className="meet-live-card__url">{chromeMeet.tab.url}</span>
            </div>
            {!screenPermissionMissing && status.state === 'watching' && (
              <div className="meet-live-card__hint">
                Mintr is watching — capture will start automatically once Meet
                begins playing audio.
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        Live-capture card (v0.14+). Distinct from the "Meet detected"
        card above: this one appears once the bundled engine has
        actually started writing files (confirmed via fs.watch on
        liveRecordingsRoot). It shows the meeting title (sourced from
        the Chrome probe when available), a 0:00 mm:ss elapsed counter
        that ticks every second, and an honest hint that the full
        transcript appears here when the meeting ends. Closes the loop
        on "the right side of the Home screen is empty during a meeting".
      */}
      {liveCapture.active && (
        <div className="capture-live-card" role="status">
          <div className="capture-live-card__header">
            <span className="capture-live-card__dot" aria-hidden="true" />
            <span className="capture-live-card__label">Recording</span>
            <span className="capture-live-card__timer">
              <Clock size={12} aria-hidden="true" />
              {formatLiveDuration(liveCapture.startedAt)}
            </span>
          </div>
          <div className="capture-live-card__title">
            {liveCapture.meetingId
              ? `Google Meet · ${liveCapture.meetingId}`
              : 'Live meeting'}
          </div>
          <div className="capture-live-card__started">
            Started {formatStartTime(liveCapture.startedAt)} ·{' '}
            <span className="capture-live-card__path-hint">
              audio + transcript saving locally
            </span>
          </div>
          <div className="capture-live-card__transcript-placeholder">
            <Loader2
              size={14}
              aria-hidden="true"
              className="home-status-icon--spin"
            />
            <span>
              The engine writes the full transcript when the meeting ends — it
              will appear in the Meetings tab and update here automatically.
            </span>
          </div>
        </div>
      )}

      <div className="status-card">
        <div className="status-indicator">
          <span
            className={'home-status-icon home-status-icon--' + status.state}
            aria-hidden="true"
          >
            <StatusIcon state={status.state} />
          </span>
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
            className={isWatching ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => {
              void onToggleWatch()
            }}
          >
            <Radio size={16} aria-hidden="true" />
            <span>{isWatching ? 'Stop Watching' : 'Start Watching'}</span>
          </button>
          <button
            className="btn"
            onClick={() => {
              void onImport()
            }}
          >
            <Upload size={16} aria-hidden="true" />
            <span>Import audio file…</span>
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

        {recognised.length > 0 && (
          <div className="recognised-banner" role="status">
            <UserCheck
              size={14}
              aria-hidden="true"
              className="recognised-banner__icon"
            />
            <div className="recognised-banner__body">
              <span className="recognised-banner__label">Recognised:</span>{' '}
              <span className="recognised-banner__names">
                {recognised
                  .map((m) => `${m.enrolled} (${Math.round(m.similarity * 100)}%)`)
                  .join(', ')}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="recent-meetings">
        <h3 className="recent-meetings__heading">Recent meetings</h3>
        {recentLoading && (
          <div className="recent-meetings__grid" aria-hidden="true">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        )}
        {!recentLoading && recent.length === 0 && (
          <div className="empty-state">
            <Inbox size={32} aria-hidden="true" className="empty-state__icon" />
            <div className="empty-state__title">No meetings yet</div>
            <div className="empty-state__hint">
              Import an audio file or start watching to create your first meeting.
            </div>
          </div>
        )}
        {!recentLoading && recent.length > 0 && (
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
                  <span aria-hidden="true">·</span>
                  <span className="recent-card__meta-duration">
                    {formatDuration(m.durationSeconds)}
                  </span>
                  <span aria-hidden="true">·</span>
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
                          <TagIcon
                            size={10}
                            aria-hidden="true"
                            className="recent-card__tag-icon"
                          />
                          <span className="recent-card__tag-name">{t.name}</span>
                        </span>
                      )
                    })}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
