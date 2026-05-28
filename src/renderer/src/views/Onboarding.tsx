import { useCallback } from 'react'
import { ShieldCheck } from 'lucide-react'
import mintrMark from '../assets/mintr-mark.png'
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
 * "grant each permission" steps into live rows) → Done. "Skip for now"
 * dismisses without granting; the primary "Done" CTA enables once the engine
 * is verified, but the user can always finish manually.
 */
export function Onboarding({ onDone }: { onDone?: () => void }): JSX.Element {
  const { markComplete } = useOnboardingComplete()
  const { snapshot } = useHelperPermissions()
  const ready = allGranted(snapshot) && snapshot.watchLoopRunning

  const finish = useCallback(async () => {
    await markComplete()
    onDone?.()
  }, [markComplete, onDone])

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        <header className="onboarding__welcome">
          <span className="onboarding__mark" aria-hidden="true">
            <img src={mintrMark} alt="" width={48} height={48} draggable={false} />
          </span>
          <h1 className="onboarding__title">Welcome to Mintr</h1>
          <p className="onboarding__lede">
            Mintr transcribes your meetings entirely on your Mac — audio never
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

        <footer className="onboarding__footer">
          <button
            type="button"
            className="onboarding__skip"
            onClick={() => {
              void finish()
            }}
          >
            Skip for now
          </button>
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={() => {
              void finish()
            }}
          >
            {ready ? 'Done — start using Mintr' : 'Finish setup'}
          </button>
        </footer>
      </div>
    </div>
  )
}
