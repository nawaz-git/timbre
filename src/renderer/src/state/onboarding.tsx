import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api } from '../../../preload'
import type {
  HelperPermissionSnapshot,
  OnboardingService
} from '../../../shared/types'
import { useSettings } from './settings'

// ════════════════════════════════════════════════════════════════════════
// IPC contract shim — from TICKET-IPC-002 (`window.api.onboarding.*`).
//
// The preload `Api` type that owns this surface is built in the parallel
// IPC lane. We declare a minimal ambient augmentation here so the renderer
// lane (TICKET-UI-003) typechecks standalone. REMOVE THIS BLOCK AFTER MERGE
// if the real preload definition already covers `window.api.onboarding`
// (duplicate-but-compatible structural shapes won't conflict at runtime,
// but the ambient merge would be redundant).
// ════════════════════════════════════════════════════════════════════════
interface OnboardingApi {
  /** Current helper permission snapshot (polled by the wizard every 2s). */
  probe: () => Promise<HelperPermissionSnapshot>
  /** Deep-link to a System Settings privacy pane for the given service. */
  openPane: (service: OnboardingService) => Promise<void>
  /** Reveal MintrEngine.app in Finder for the drag-to-"+" flow. */
  revealHelper: () => Promise<{ revealed: boolean; path?: string }>
  /** Kill + relaunch the helper so freshly granted TCC takes effect. */
  restartEngine: () => Promise<{ ok: boolean; message?: string }>
  /** Confirm the helper's capture watch-loop came back up after restart. */
  verifyEngine: () => Promise<{ watchLoopRunning: boolean }>
  /** Mark onboarding complete (stamps Settings.onboardingCompletedAt). */
  complete: () => Promise<void>
  /** Clear onboarding completion so the wizard shows again. */
  reset: () => Promise<void>
}

declare global {
  interface Window {
    // Intersect the real preload `Api` (owned by index.d.ts) with the
    // not-yet-merged onboarding surface so this lane typechecks alone.
    api: Api & { onboarding: OnboardingApi }
  }
}
// ════════════════════════════════════════════════════════════════════════
// end IPC contract shim
// ════════════════════════════════════════════════════════════════════════

/** Canonical macOS path of the bundled helper, shown copyable in the UI. */
export const MINTR_ENGINE_PATH =
  '/Applications/Timbre.app/Contents/Resources/MintrEngine.app'

const POLL_INTERVAL_MS = 2000

const EMPTY_SNAPSHOT: HelperPermissionSnapshot = {
  screenRecording: 'unknown',
  microphone: 'unknown',
  accessibility: 'unknown',
  watchLoopRunning: false
}

/**
 * Polls `onboarding.probe()` every 2s while mounted and returns the latest
 * helper permission snapshot. `refresh()` forces an immediate re-poll (used
 * right after the user opens a pane or restarts the engine so the chips
 * update without waiting for the next tick). `loading` is true only until
 * the first probe resolves.
 */
export function useHelperPermissions(): {
  snapshot: HelperPermissionSnapshot
  loading: boolean
  refresh: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<HelperPermissionSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  // Keep a stable ref so the interval callback never goes stale.
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.onboarding.probe()
      if (mounted.current) setSnapshot(next)
    } catch (err) {
      console.error('Failed to probe helper permissions', err)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      clearInterval(id)
    }
  }, [refresh])

  return { snapshot, loading, refresh }
}

/** True once every one of the three services reports `granted`. */
export function allGranted(snapshot: HelperPermissionSnapshot): boolean {
  return (
    snapshot.screenRecording === 'granted' &&
    snapshot.microphone === 'granted' &&
    snapshot.accessibility === 'granted'
  )
}

/**
 * Completion helpers backed by Settings. `completed` reads
 * `Settings.onboardingCompletedAt`; `markComplete` stamps it (via the IPC
 * `complete()` and re-reads settings so the App gate flips); `reset` clears
 * it so the wizard reappears. Both mutate through the SettingsProvider so
 * the rest of the app re-renders off the same source of truth.
 */
export function useOnboardingComplete(): {
  completed: boolean
  markComplete: () => Promise<void>
  reset: () => Promise<void>
} {
  const { settings, setSettings } = useSettings()
  const completed = Boolean(settings?.onboardingCompletedAt)

  const markComplete = useCallback(async () => {
    try {
      await window.api.onboarding.complete()
    } catch (err) {
      console.error('onboarding.complete() failed', err)
    }
    // Re-stamp locally too so the gate flips even if the IPC handler chose
    // not to mutate Settings itself — idempotent either way.
    await setSettings({ onboardingCompletedAt: Date.now() })
  }, [setSettings])

  const reset = useCallback(async () => {
    try {
      await window.api.onboarding.reset()
    } catch (err) {
      console.error('onboarding.reset() failed', err)
    }
    await setSettings({ onboardingCompletedAt: undefined })
  }, [setSettings])

  return { completed, markComplete, reset }
}
