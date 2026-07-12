import { useCallback, useState } from 'react'
import { CheckCircle2, ShieldCheck } from 'lucide-react'
import timbreMark from '../assets/timbre-mark.png'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PermissionChecklist } from '../components/PermissionChecklist'
import {
  allGranted,
  useHelperPermissions,
  useOnboardingComplete
} from '../state/onboarding'

/**
 * Full-pane first-run wizard, mounted by App.tsx in place of the normal
 * shell when `settings.onboardingCompletedAt` is unset. Three movements on
 * one scroll: Welcome → the shared PermissionChecklist (which collapses the
 * "grant each permission" steps into live rows) → finish.
 *
 * The finish gate is real: "Finish setup" is disabled until all three
 * permissions are granted (Timbre genuinely can't record without them), so a
 * user can't silently complete an unusable setup. "Skip for now" still
 * exists as an explicit, confirmed escape hatch. Once the engine is verified
 * watching, a final reassurance block appears.
 */
export function Onboarding({ onDone }: { onDone?: () => void }): JSX.Element {
  const { markComplete } = useOnboardingComplete()
  const { snapshot } = useHelperPermissions()
  const everythingGranted = allGranted(snapshot)
  const ready = everythingGranted && snapshot.watchLoopRunning
  // Drives the "Skip setup?" confirmation dialog.
  const [skipPending, setSkipPending] = useState(false)

  const finish = useCallback(async () => {
    await markComplete()
    onDone?.()
  }, [markComplete, onDone])

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        <header className="onboarding__welcome">
          <span className="onboarding__mark" aria-hidden="true">
            <img src={timbreMark} alt="" width={48} height={48} draggable={false} />
          </span>
          <h1 className="onboarding__title">Welcome to Timbre</h1>
          <p className="onboarding__lede">
            Timbre transcribes your meetings entirely on your Mac — audio never
            leaves the device. To capture meetings, the bundled engine needs a
            few macOS permissions. Grant them below; no terminal required.
          </p>
        </header>

        <section className="onboarding__step" aria-label="Permissions">
          <div className="onboarding__step-head">
            <ShieldCheck size={16} aria-hidden="true" />
            <h2 className="onboarding__step-title">Grant engine permissions</h2>
          </div>
          <PermissionChecklist mode="wizard" />
        </section>

        {ready && (
          <div className="onboarding__verified" role="status">
            <p className="onboarding__verified-title">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>Setup verified — the engine is watching.</span>
            </p>
            <p className="onboarding__verified-tip">
              Tip: join any Google Meet for a few seconds; a recording appears in Meetings
              automatically.
            </p>
          </div>
        )}

        <footer className="onboarding__footer">
          <button type="button" className="onboarding__skip" onClick={() => setSkipPending(true)}>
            Skip for now
          </button>
          <div className="onboarding__finish">
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={() => {
                void finish()
              }}
              disabled={!everythingGranted}
            >
              Finish setup
            </button>
            {!everythingGranted && (
              <p className="onboarding__finish-hint">
                Grant the three permissions to finish. Timbre can&apos;t record without them.
              </p>
            )}
          </div>
        </footer>
      </div>

      {skipPending && (
        <ConfirmDialog
          title="Skip setup?"
          body="Without these permissions Timbre will not record your meetings. You can finish setup anytime in Settings → Setup & Permissions."
          confirmLabel="Skip anyway"
          onConfirm={async () => {
            setSkipPending(false)
            await finish()
          }}
          onCancel={() => setSkipPending(false)}
        />
      )}
    </div>
  )
}
