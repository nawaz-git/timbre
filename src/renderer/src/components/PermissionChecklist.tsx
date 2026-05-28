import { useCallback, useState } from 'react'
import {
  Accessibility as AccessibilityIcon,
  CheckCircle2,
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  Mic as MicIcon,
  MonitorPlay,
  RefreshCw
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  GrantStatus,
  HelperPermissionSnapshot,
  OnboardingService
} from '../../../shared/types'
import {
  MINTR_ENGINE_PATH,
  allGranted,
  useHelperPermissions
} from '../state/onboarding'

interface ServiceMeta {
  service: OnboardingService
  key: keyof Pick<
    HelperPermissionSnapshot,
    'screenRecording' | 'microphone' | 'accessibility'
  >
  name: string
  Icon: LucideIcon
  /** Human pane name for the "Open <pane>" button + copy. */
  paneLabel: string
  /** True for + / − services (Screen Rec + Accessibility); false for Mic. */
  hasPlusButton: boolean
}

// Order matters: Screen Recording is the primary Meet-detection trigger, so
// it leads. Mic is prompt-only on every macOS version (qa-version-001) —
// it never shows the "+ → ⌘⇧G → paste" flow.
const SERVICES: ServiceMeta[] = [
  {
    service: 'screen-recording',
    key: 'screenRecording',
    name: 'Screen Recording',
    Icon: MonitorPlay,
    paneLabel: 'Screen Recording settings',
    hasPlusButton: true
  },
  {
    service: 'microphone',
    key: 'microphone',
    name: 'Microphone',
    Icon: MicIcon,
    paneLabel: 'Microphone settings',
    hasPlusButton: false
  },
  {
    service: 'accessibility',
    key: 'accessibility',
    name: 'Accessibility',
    Icon: AccessibilityIcon,
    paneLabel: 'Accessibility settings',
    hasPlusButton: true
  }
]

const STATUS_LABEL: Record<GrantStatus, string> = {
  granted: 'Granted',
  denied: 'Denied',
  'not-determined': 'Not set',
  unknown: 'Checking…'
}

/** Maps a grant status to a chip modifier reusing the existing status tokens. */
function chipModifier(status: GrantStatus): string {
  if (status === 'granted') return 'status-chip--granted'
  if (status === 'denied') return 'status-chip--denied'
  return 'status-chip--pending'
}

function StatusChip({ status }: { status: GrantStatus }): JSX.Element {
  return (
    <span className={`status-chip ${chipModifier(status)}`} role="status">
      <span className="status-chip__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}

/** The static 4-step + flow diagram for Screen Recording / Accessibility. */
function StepDiagram(): JSX.Element {
  const steps = [
    { n: 1, label: 'Click +', detail: 'in the pane' },
    { n: 2, label: '⌘⇧G', detail: 'open Go-to-folder' },
    { n: 3, label: 'Paste path', detail: 'then Enter' },
    { n: 4, label: 'Open', detail: 'toggle it on' }
  ]
  return (
    <ol className="perm-steps" aria-label="Granting steps">
      {steps.map((s, i) => (
        <li key={s.n} className="perm-steps__step">
          <span className="perm-steps__num" aria-hidden="true">
            {s.n}
          </span>
          <span className="perm-steps__body">
            <span className="perm-steps__label">{s.label}</span>
            <span className="perm-steps__detail">{s.detail}</span>
          </span>
          {i < steps.length - 1 && (
            <span className="perm-steps__arrow" aria-hidden="true">
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

/** Copyable monospace path with a copy-to-clipboard affordance. */
function PathField(): JSX.Element {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(MINTR_ENGINE_PATH).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }, [])
  return (
    <div className="perm-path">
      <code className="perm-path__value">{MINTR_ENGINE_PATH}</code>
      <button
        type="button"
        className="btn btn--sm perm-path__copy"
        onClick={onCopy}
        aria-label="Copy MintrEngine path"
      >
        <Copy size={13} aria-hidden="true" />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}

function PlusServiceActions({
  meta,
  status,
  onOpenPane,
  onReveal
}: {
  meta: ServiceMeta
  status: GrantStatus
  onOpenPane: (s: OnboardingService) => void
  onReveal: () => void
}): JSX.Element {
  return (
    <div className="perm-row__actions">
      <p className="perm-row__copy">
        Open {meta.paneLabel}, click <strong>+</strong>, press{' '}
        <kbd className="perm-kbd">⌘⇧G</kbd>, paste the MintrEngine path, click{' '}
        <strong>Open</strong>, then turn it <strong>on</strong>.
        {meta.service === 'screen-recording' && (
          <>
            {' '}
            macOS will ask you to <strong>Quit &amp; Reopen</strong> — relaunch
            when prompted.
          </>
        )}
      </p>
      <PathField />
      <StepDiagram />
      <div className="perm-row__buttons">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onOpenPane(meta.service)}
        >
          <ExternalLink size={13} aria-hidden="true" />
          <span>Open {meta.name === 'Screen Recording' ? 'pane' : meta.paneLabel.replace(' settings', '')}</span>
        </button>
        <button type="button" className="btn btn--sm" onClick={onReveal}>
          <FolderOpen size={13} aria-hidden="true" />
          <span>Reveal MintrEngine in Finder</span>
        </button>
      </div>
      {status === 'granted' && (
        <p className="perm-row__copy perm-row__copy--ok">
          Granted — no further action needed.
        </p>
      )}
    </div>
  )
}

function MicServiceActions({
  status,
  onOpenPane,
  onRestart
}: {
  status: GrantStatus
  onOpenPane: (s: OnboardingService) => void
  onRestart: () => void
}): JSX.Element {
  // Mic is prompt-only on ALL macOS versions — there is NO "+" button. When
  // not-determined we (re)fire the prompt by restarting the engine. When
  // denied, the prompt won't reappear, so we deep-link the pane and tell the
  // user to flip the existing MintrEngine toggle on (per qa-version-001).
  return (
    <div className="perm-row__actions">
      {status === 'denied' ? (
        <>
          <p className="perm-row__copy">
            Open Microphone settings and turn the <strong>MintrEngine</strong>{' '}
            toggle <strong>on</strong>. You denied access before, so no new
            prompt will appear — flip the existing switch.
          </p>
          <div className="perm-row__buttons">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onOpenPane('microphone')}
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>Open Microphone settings</span>
            </button>
          </div>
        </>
      ) : status === 'granted' ? (
        <p className="perm-row__copy perm-row__copy--ok">
          Granted — no further action needed.
        </p>
      ) : (
        <>
          <p className="perm-row__copy">
            Click <strong>Allow</strong> on the macOS prompt. If you don&apos;t
            see one, restart the engine to re-trigger it — there is no
            &quot;+&quot; button for the microphone.
          </p>
          <div className="perm-row__buttons">
            <button type="button" className="btn btn--sm" onClick={onRestart}>
              <MicIcon size={13} aria-hidden="true" />
              <span>Request microphone access</span>
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onOpenPane('microphone')}
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>Open Microphone settings</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Shared permission checklist used by both the first-run wizard (`mode:
 * 'wizard'`) and Settings (`mode: 'settings'`). Renders the three TCC rows
 * with live status chips polled every 2s, per-row granting actions, and —
 * once all three are granted — a "Restart engine & verify" button that
 * confirms the helper's watch-loop is running.
 */
export function PermissionChecklist({
  mode
}: {
  mode: 'wizard' | 'settings'
}): JSX.Element {
  const { snapshot, refresh } = useHelperPermissions()
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<'idle' | 'ok' | 'fail'>('idle')

  const onOpenPane = useCallback(
    (service: OnboardingService) => {
      void window.api.onboarding.openPane(service)
      // Re-poll shortly after so chips refresh when the user returns.
      setTimeout(() => void refresh(), 1500)
    },
    [refresh]
  )

  const onReveal = useCallback(() => {
    void window.api.onboarding.revealHelper()
  }, [])

  const onRestart = useCallback(() => {
    void window.api.onboarding.restartEngine().then(() => {
      setTimeout(() => void refresh(), 1500)
    })
  }, [refresh])

  const onRestartAndVerify = useCallback(() => {
    setVerifying(true)
    setVerifyResult('idle')
    void (async () => {
      try {
        await window.api.onboarding.restartEngine()
        const { watchLoopRunning } = await window.api.onboarding.verifyEngine()
        setVerifyResult(watchLoopRunning ? 'ok' : 'fail')
        await refresh()
      } catch (err) {
        console.error('restart & verify failed', err)
        setVerifyResult('fail')
      } finally {
        setVerifying(false)
      }
    })()
  }, [refresh])

  const everythingGranted = allGranted(snapshot)
  const verified = everythingGranted && (verifyResult === 'ok' || snapshot.watchLoopRunning)

  return (
    <div className={`perm-checklist perm-checklist--${mode}`}>
      <ol className="perm-checklist__rows">
        {SERVICES.map((meta) => {
          const status = snapshot[meta.key]
          const { Icon } = meta
          return (
            <li
              key={meta.service}
              className={
                'perm-row' + (status === 'granted' ? ' perm-row--granted' : '')
              }
            >
              <div className="perm-row__head">
                <span className="perm-row__icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <span className="perm-row__name">{meta.name}</span>
                <StatusChip status={status} />
              </div>
              {meta.hasPlusButton ? (
                <PlusServiceActions
                  meta={meta}
                  status={status}
                  onOpenPane={onOpenPane}
                  onReveal={onReveal}
                />
              ) : (
                <MicServiceActions
                  status={status}
                  onOpenPane={onOpenPane}
                  onRestart={onRestart}
                />
              )}
            </li>
          )
        })}
      </ol>

      <div className="perm-checklist__verify">
        {everythingGranted ? (
          verified ? (
            <p className="perm-verify__ok">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>
                All permissions granted and the engine is capturing. You&apos;re
                all set.
              </span>
            </p>
          ) : (
            <>
              <p className="perm-row__copy">
                All three permissions are granted. Restart the engine so the
                new permissions take effect, then we&apos;ll verify it&apos;s
                capturing.
              </p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRestartAndVerify}
                disabled={verifying}
              >
                {verifying ? (
                  <Loader2
                    size={14}
                    aria-hidden="true"
                    className="home-status-icon--spin"
                  />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                <span>{verifying ? 'Verifying…' : 'Restart engine & verify'}</span>
              </button>
              {verifyResult === 'fail' && (
                <p className="perm-row__copy perm-row__copy--warn">
                  The engine restarted but its capture loop isn&apos;t running
                  yet. Give it a moment and try again.
                </p>
              )}
            </>
          )
        ) : (
          <p className="perm-row__copy perm-row__copy--muted">
            Grant all three permissions above to enable the engine.
          </p>
        )}
      </div>
    </div>
  )
}
