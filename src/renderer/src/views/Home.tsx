import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
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
import { useAppStatus } from '../state/appStatus'
import { useSettings } from '../state/settings'
import { useTags } from '../state/tags'
import { usePermissions, useChromeMeet, useCaptureWatchdog } from '../state/permissions'
import { formatDate, formatDuration } from '../state/format'
import type {
  ActivityKind,
  AppStatus,
  BackendEvent,
  MeetingSummary,
  ProcessingStage,
  SpeakerMatch
} from '../../../shared/types'

/** State label shown next to the hero icon, keyed by the underlying activity. */
const STATE_LABEL: Record<ActivityKind, string> = {
  paused: 'Paused',
  watching: 'Watching',
  'meet-detected': 'Meeting detected',
  recording: 'Recording',
  processing: 'Processing'
}

/** Human stage labels for a processing meeting (matches the meeting detail). */
const STAGE_LABEL: Record<ProcessingStage, string> = {
  transcribing: 'Transcribing speech',
  diarizing: 'Identifying speakers',
  summarizing: 'Writing summary',
  unknown: 'Working…'
}

/** One sentence per kind. */
function headlineFor(status: AppStatus): string {
  switch (status.activityKind) {
    case 'watching':
      return 'Watching for meetings.'
    case 'meet-detected':
      return 'Meet open — waiting for capture.'
    case 'recording':
      return 'Recording your meeting.'
    case 'processing': {
      const n = status.processingCount ?? 1
      return `Processing ${n === 1 ? 'your meeting' : `${n} meetings`}.`
    }
    case 'paused':
      return 'Not watching.'
  }
}

/** The hero state icon — danger triangle when something needs attention. */
function HeroIcon({ kind, attention }: { kind: ActivityKind; attention: boolean }): JSX.Element {
  if (attention) return <AlertTriangle size={16} aria-hidden="true" />
  switch (kind) {
    case 'recording':
      return <Mic size={16} aria-hidden="true" />
    case 'processing':
      return <Loader2 size={16} aria-hidden="true" className="home-status-icon--spin" />
    case 'meet-detected':
      return <Video size={16} aria-hidden="true" />
    case 'watching':
      return <Radio size={16} aria-hidden="true" />
    case 'paused':
      return <MicOff size={16} aria-hidden="true" />
  }
}

/** mm:ss elapsed since an epoch-ms start (ticks via the hero's 1s re-render). */
function formatElapsedMMSS(startedAt: number | undefined): string {
  if (!startedAt) return '0:00'
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "2:00 PM" clock label from an epoch-ms start. */
function formatClockTime(startedAt: number | undefined): string {
  if (!startedAt) return 'just now'
  return new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Coarse "3 min" elapsed for processing rows. */
function formatMinutesElapsed(startedAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return 'under a minute'
  const min = Math.floor(sec / 60)
  return `${min} min`
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
  /** Switch to the Meetings view (hero "Open Meetings" / "View in Meetings"). */
  onViewAll: () => void
}

export function HomeView({ onOpenMeeting, onViewAll }: HomeViewProps): JSX.Element {
  const { settings } = useSettings()
  const { byId: tagById } = useTags()
  // The single source of truth for what Timbre is doing. Recording is shown
  // only when the main process's capture heartbeat confirms audio on disk.
  const status = useAppStatus()
  // These hooks remain ONLY for actions + attention detail, never for the
  // headline status (that is `status` above).
  const { start, stop } = useRecordingStatus()
  const { status: permState, openPane } = usePermissions()
  const chromeMeet = useChromeMeet()
  const watchdog = useCaptureWatchdog()

  const [restartingHelper, setRestartingHelper] = useState(false)
  const [restartResult, setRestartResult] = useState<string | null>(null)
  // Transient "Verifying capture…" banner shown after a successful Restart
  // engine, while we wait to see if the freshly-respawned engine captures.
  const [verifyingCapture, setVerifyingCapture] = useState<{ startedAt: number } | null>(null)

  // Re-render once a second while recording/processing so elapsed values tick
  // (the status push only fires on structural changes, not every second).
  const [, forceTick] = useState(0)
  useEffect(() => {
    const active = status.activityKind === 'recording' || status.activityKind === 'processing'
    if (!active) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [status.activityKind])

  // Close the verifying window after 30s. Clearing state inside the timeout
  // callback (not synchronously in the effect body) keeps this off the
  // set-state-in-effect path; the other exits — capture confirmed, Meet gone —
  // are handled by the derived `showVerifying` below.
  useEffect(() => {
    if (!verifyingCapture) return
    const remaining = Math.max(0, 30_000 - (Date.now() - verifyingCapture.startedAt))
    const id = setTimeout(() => setVerifyingCapture(null), remaining)
    return () => clearTimeout(id)
  }, [verifyingCapture])

  const handleRestartHelper = useCallback(async () => {
    setRestartingHelper(true)
    setRestartResult(null)
    try {
      const result = await window.api.system.restartHelper()
      if (result.ok) {
        setVerifyingCapture({ startedAt: Date.now() })
      } else {
        setRestartResult(`Engine restart failed: ${result.message ?? 'unknown error'}`)
      }
    } catch (err) {
      setRestartResult(`Engine restart failed: ${err instanceof Error ? err.message : String(err)}`)
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
      : undefined
  const showProgress = progressPercent !== undefined && banner !== null && banner.phase !== 'error'

  const recognised = useMemo(() => banner?.matches?.filter((m) => m.enrolled) ?? [], [banner])

  const kind = status.activityKind
  const isWatchingActivity = kind === 'watching' || kind === 'meet-detected'
  const meetTab =
    status.meetTab ??
    (chromeMeet.tab ? { meetingId: chromeMeet.tab.meetingId, url: chromeMeet.tab.url } : null)
  // Derived: the transient "Verifying capture…" banner shows until capture is
  // confirmed (recording) or the Meet goes away; the 30s cap is enforced by the
  // timeout that clears `verifyingCapture`.
  const showVerifying = verifyingCapture !== null && chromeMeet.tab !== null && kind !== 'recording'

  return (
    <div className="home">
      <section className="hero" data-kind={kind} role="status" aria-live="polite">
        <div className="hero__state">
          <span
            className={
              'hero__state-icon' + (status.attention ? ' hero__state-icon--attention' : '')
            }
            aria-hidden="true"
          >
            <HeroIcon kind={kind} attention={!!status.attention} />
          </span>
          <span>{STATE_LABEL[kind]}</span>
        </div>
        <div className="hero__headline">{headlineFor(status)}</div>

        <div className="hero__detail">
          {kind === 'watching' && (
            <p className="hero__hint">
              Join a Google Meet in Chrome and recording starts automatically.
            </p>
          )}

          {kind === 'meet-detected' && (
            <>
              {meetTab && (
                <div className="hero__meta">
                  <span className="hero__meet-id">{meetTab.meetingId}</span>
                  <span aria-hidden="true">·</span>
                  <span className="hero__meet-url">{meetTab.url}</span>
                </div>
              )}
              <p className="hero__hint">Recording starts when the meeting begins.</p>
            </>
          )}

          {kind === 'recording' && (
            <>
              <div className="hero__recording">
                <span className="hero__dot" aria-hidden="true" />
                <span className="hero__timer" aria-hidden="true">
                  {formatElapsedMMSS(status.recordingStartedAt)}
                </span>
                <span className="hero__recording-meta">
                  Started {formatClockTime(status.recordingStartedAt)} · saving audio locally
                </span>
              </div>
              <p className="hero__hint">Transcript arrives after the meeting ends.</p>
            </>
          )}

          {kind === 'processing' && (
            <div className="hero__processing">
              {(status.processing ?? []).map((p) => (
                <div key={p.id} className="hero__processing-row">
                  <Loader2 size={12} aria-hidden="true" className="home-status-icon--spin" />
                  <span className="hero__processing-title">{p.title}</span>
                  <span className="hero__processing-stage">
                    {STAGE_LABEL[p.stage]} · {formatMinutesElapsed(p.startedAt)} elapsed
                  </span>
                </div>
              ))}
              {(status.processing ?? []).length === 0 && (
                <p className="hero__hint">Working on your transcript…</p>
              )}
            </div>
          )}

          {kind === 'paused' && (
            <p className="hero__hint">Meetings you join won&apos;t be recorded while paused.</p>
          )}
        </div>

        <div className="hero__actions">
          {isWatchingActivity && (
            <>
              <button className="btn" onClick={() => void stop()}>
                <Radio size={16} aria-hidden="true" />
                <span>Pause watching</span>
              </button>
              <button className="btn" onClick={() => void onImport()}>
                <Upload size={16} aria-hidden="true" />
                <span>Import audio file…</span>
              </button>
            </>
          )}
          {kind === 'recording' && (
            <>
              <button className="btn btn--danger" onClick={() => void stop()}>
                <span>Stop recording…</span>
              </button>
              <button className="btn" onClick={onViewAll}>
                <span>Open Meetings</span>
              </button>
            </>
          )}
          {kind === 'processing' && (
            <button
              className="btn"
              onClick={() => {
                const first = status.processing?.[0]
                if (first) onOpenMeeting(first.id)
                else onViewAll()
              }}
            >
              <span>View in Meetings</span>
            </button>
          )}
          {kind === 'paused' && (
            <button className="btn btn--primary" onClick={() => void start()}>
              <Radio size={16} aria-hidden="true" />
              <span>Start watching</span>
            </button>
          )}
        </div>
      </section>

      <AttentionSlot
        status={status}
        watchdog={watchdog}
        automationDenied={permState.automationChrome === 'denied'}
        verifying={showVerifying}
        restarting={restartingHelper}
        restartResult={restartResult}
        onOpenPane={openPane}
        onRestart={handleRestartHelper}
        onOpenMeeting={onOpenMeeting}
      />

      <section className="import-card">
        <div className="import-card__head">
          <div className="import-card__title">Import an audio file</div>
          <div className="import-card__desc">
            Transcribe a recording you already have — audio never leaves your Mac.
          </div>
        </div>
        <button className="btn" onClick={() => void onImport()}>
          <Upload size={16} aria-hidden="true" />
          <span>Import audio file…</span>
        </button>

        {banner && (
          <div
            className={
              'import-card__banner' +
              (banner.phase === 'error' ? ' import-card__banner--error' : '')
            }
          >
            {banner.message ??
              `Job ${banner.jobId.slice(0, 8)} — ${banner.phase}${
                banner.progress !== undefined ? ` (${banner.progress}%)` : ''
              }`}
            {showProgress && (
              <div className="progress-bar" aria-label={`Transcription ${progressPercent}%`}>
                <div
                  className="progress-bar__fill"
                  style={{ width: `${Math.min(100, Math.max(0, progressPercent ?? 0))}%` }}
                />
              </div>
            )}
          </div>
        )}

        {recognised.length > 0 && (
          <div className="recognised-banner" role="status">
            <UserCheck size={14} aria-hidden="true" className="recognised-banner__icon" />
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
      </section>

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
                className={
                  'recent-card' +
                  (m.isLive ? ' recent-card--live' : '') +
                  (m.status === 'processing' ? ' recent-card--processing' : '')
                }
                onClick={() => onOpenMeeting(m.id)}
                title={m.title}
              >
                <div className="recent-card__title">
                  <span className="recent-card__title-text">{m.title}</span>
                  {m.isLive && (
                    <span className="recent-card__live-badge" aria-label="Recording in progress">
                      <span className="recent-card__live-dot" aria-hidden="true" />
                      <span>LIVE</span>
                    </span>
                  )}
                  {!m.isLive && m.status === 'processing' && (
                    <span className="recent-card__processing-badge" aria-label="Processing">
                      <Loader2
                        size={10}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="home-status-icon--spin"
                      />
                      <span>PROCESSING</span>
                    </span>
                  )}
                  {!m.isLive && m.status === 'refining' && (
                    <span className="recent-card__processing-badge" aria-label="Refining">
                      <Loader2
                        size={10}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="home-status-icon--spin"
                      />
                      <span>REFINING</span>
                    </span>
                  )}
                </div>
                {m.isLive ? (
                  <div className="recent-card__meta recent-card__meta--live">
                    Recording in progress — full transcript will appear when meeting ends.
                  </div>
                ) : m.status === 'processing' ? (
                  <div className="recent-card__meta recent-card__meta--processing">
                    Processing — audio ready, transcript coming.
                  </div>
                ) : (
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
                )}
                {m.tagIds.length > 0 && (
                  <div className="recent-card__tags">
                    {m.tagIds.map((id) => {
                      const t = tagById(id)
                      if (!t) return null
                      return (
                        <span key={id} className="recent-card__tag" style={{ background: t.color }}>
                          <TagIcon size={10} aria-hidden="true" className="recent-card__tag-icon" />
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

// ─── Attention slot ───────────────────────────────────────────────────────

interface AttentionSlotProps {
  status: AppStatus
  watchdog: ReturnType<typeof useCaptureWatchdog>
  automationDenied: boolean
  verifying: boolean
  restarting: boolean
  restartResult: string | null
  onOpenPane: (pane: 'screen-recording' | 'microphone' | 'automation' | 'accessibility') => void
  onRestart: () => void
  onOpenMeeting: (id: string) => void
}

/**
 * Renders EXACTLY ONE banner, in resolved priority order: the main-process
 * attention (permission / engine-missing / capture-failed / processing-stuck),
 * then automation (the app's own Chrome grant, tracked separately), then the
 * transient "Verifying capture…" state. All framed with the shared
 * permission-banner markup.
 */
function AttentionSlot({
  status,
  watchdog,
  automationDenied,
  verifying,
  restarting,
  restartResult,
  onOpenPane,
  onRestart,
  onOpenMeeting
}: AttentionSlotProps): JSX.Element | null {
  const code = status.attention?.code

  if (code === 'permission') {
    return (
      <div className="permission-banner" role="alert">
        <span className="permission-banner__icon" aria-hidden="true">
          <AlertTriangle size={16} strokeWidth={2} />
        </span>
        <div className="permission-banner__body">
          <div className="permission-banner__title">Screen Recording permission needed</div>
          <div className="permission-banner__desc">
            Timbre reads the active window title to detect when you join a Google Meet or other
            call. Without this permission, meetings start without being captured. The screen pixels
            are never recorded — only the window title.
          </div>
        </div>
        <button
          className="btn btn--primary btn--small"
          onClick={() => onOpenPane('screen-recording')}
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span>Open System Settings</span>
        </button>
      </div>
    )
  }

  if (code === 'engine-missing') {
    return (
      <div className="permission-banner permission-banner--danger" role="alert">
        <span className="permission-banner__icon" aria-hidden="true">
          <AlertTriangle size={16} strokeWidth={2} />
        </span>
        <div className="permission-banner__body">
          <div className="permission-banner__title">Recording engine unavailable</div>
          <div className="permission-banner__desc">
            The bundled recording engine couldn&apos;t be found, so meetings can&apos;t be captured.
            Reinstall Timbre to restore it.
          </div>
        </div>
      </div>
    )
  }

  if (code === 'capture-failed') {
    return (
      <CaptureFailedBanner
        hint={watchdog.hint}
        restarting={restarting}
        restartResult={restartResult}
        onOpenPane={onOpenPane}
        onRestart={onRestart}
      />
    )
  }

  if (code === 'processing-stuck') {
    const meetingId = status.attention?.meetingId
    return (
      <div className="permission-banner permission-banner--danger" role="alert">
        <span className="permission-banner__icon" aria-hidden="true">
          <AlertTriangle size={16} strokeWidth={2} />
        </span>
        <div className="permission-banner__body">
          <div className="permission-banner__title">Processing didn&apos;t finish</div>
          <div className="permission-banner__desc">
            A recording is safe on disk but its transcript never arrived. Open the meeting to
            process it now with the built-in pipeline.
          </div>
        </div>
        {meetingId && (
          <button className="btn btn--primary btn--small" onClick={() => onOpenMeeting(meetingId)}>
            <span>Open meeting</span>
          </button>
        )}
      </div>
    )
  }

  if (automationDenied) {
    return (
      <div className="permission-banner" role="alert">
        <span className="permission-banner__icon" aria-hidden="true">
          <AlertTriangle size={16} strokeWidth={2} />
        </span>
        <div className="permission-banner__body">
          <div className="permission-banner__title">Allow Timbre to control Chrome</div>
          <div className="permission-banner__desc">
            Timbre detects Google Meet calls in any Chrome tab by reading the tab title via
            Automation. Without this, meetings in background tabs start without being captured.
            Re-enable Timbre under System Settings → Privacy &amp; Security → Automation → Google
            Chrome.
          </div>
        </div>
        <button className="btn btn--primary btn--small" onClick={() => onOpenPane('automation')}>
          <ExternalLink size={14} aria-hidden="true" />
          <span>Open Automation Settings</span>
        </button>
      </div>
    )
  }

  if (verifying) {
    return (
      <div className="permission-banner permission-banner--verifying" role="status">
        <span className="permission-banner__icon" aria-hidden="true">
          <Loader2 size={16} className="home-status-icon--spin" />
        </span>
        <div className="permission-banner__body">
          <div className="permission-banner__title">Verifying capture (30s)…</div>
          <div className="permission-banner__desc">
            Timbre Engine restarted. Waiting to see if it can capture your meeting.
          </div>
        </div>
      </div>
    )
  }

  return null
}

/**
 * The capture-failed banner. Reuses the per-hint copy naming the specific TCC
 * service most likely missing (accessibility / microphone / screen recording),
 * with a generic fallback + a Restart engine action (the correct recovery when
 * the engine died with permissions already granted).
 */
function CaptureFailedBanner({
  hint,
  restarting,
  restartResult,
  onOpenPane,
  onRestart
}: {
  hint: ReturnType<typeof useCaptureWatchdog>['hint']
  restarting: boolean
  restartResult: string | null
  onOpenPane: (pane: 'screen-recording' | 'microphone' | 'automation' | 'accessibility') => void
  onRestart: () => void
}): JSX.Element {
  let title: string
  let body: JSX.Element
  let primaryLabel: string
  let primaryPane: 'screen-recording' | 'microphone' | 'accessibility'
  if (hint === 'accessibility') {
    title = 'Timbre Engine needs Accessibility permission'
    primaryLabel = 'Open Accessibility'
    primaryPane = 'accessibility'
    body = (
      <>
        macOS doesn&apos;t prompt for this automatically. Click <em>Open Accessibility</em>, then
        drag <code className="inline-code">Timbre Engine</code> from the Finder window onto the
        Accessibility list. Then click <em>Restart engine</em> — macOS only picks up newly-granted
        permissions when the process restarts.
      </>
    )
  } else if (hint === 'microphone') {
    title = 'Timbre Engine needs Microphone access'
    primaryLabel = 'Open Microphone'
    primaryPane = 'microphone'
    body = (
      <>
        The bundled capture engine couldn&apos;t open the system microphone. Click{' '}
        <em>Open Microphone</em>, toggle <code className="inline-code">Timbre Engine</code> on, then
        click <em>Restart engine</em> below.
      </>
    )
  } else if (hint === 'screenRecording') {
    title = 'Timbre Engine needs Screen Recording'
    primaryLabel = 'Open Screen Recording'
    primaryPane = 'screen-recording'
    body = (
      <>
        The engine reads the active window title to detect Meet calls. Click{' '}
        <em>Open Screen Recording</em>, toggle <code className="inline-code">Timbre Engine</code>{' '}
        on, then click <em>Restart engine</em>.
      </>
    )
  } else {
    title = "Engine isn't capturing this meeting"
    primaryLabel = 'Open Screen Recording'
    primaryPane = 'screen-recording'
    body = (
      <>
        Timbre detected your Meet, but the bundled capture engine (
        <code className="inline-code">Timbre Engine</code>) hasn&apos;t recorded any audio yet.
        <br />
        <strong>Two-step fix:</strong> (1) Make sure{' '}
        <code className="inline-code">Timbre Engine</code> is enabled under Screen Recording. (2)
        Click <em>Restart engine</em> — macOS doesn&apos;t refresh permission for a running process,
        so a fix only takes effect after the engine restarts.
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
        {restartResult && <div className="permission-banner__result">{restartResult}</div>}
      </div>
      <div className="permission-banner__actions">
        <button className="btn btn--primary btn--small" onClick={() => onOpenPane(primaryPane)}>
          <ExternalLink size={14} aria-hidden="true" />
          <span>{primaryLabel}</span>
        </button>
        <button
          className="btn btn--small"
          onClick={() => void window.api.system.revealHelper()}
          title="Reveal Timbre Engine in Finder so you can drag it onto the privacy pane"
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>Reveal engine in Finder</span>
        </button>
        <button className="btn btn--small" onClick={onRestart} disabled={restarting}>
          <RefreshCcw
            size={14}
            aria-hidden="true"
            className={restarting ? 'home-status-icon--spin' : undefined}
          />
          <span>{restarting ? 'Restarting…' : 'Restart engine'}</span>
        </button>
      </div>
    </div>
  )
}
