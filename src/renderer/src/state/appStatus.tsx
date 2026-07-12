import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'

/**
 * The single source of truth for what Timbre is doing, surfaced from the main
 * process. Subscribes to the `app-status:update` push for instant updates AND
 * pulls the current value on mount so the first paint is correct without
 * waiting for the next structural change.
 *
 * This REPLACES the ad-hoc status inference the Home view used to do
 * (`useRecordingStatus` + `useChromeMeet` + `useLiveCapture` + watchdog for
 * *display*). Those hooks remain for actions and permission detail, but the
 * headline recording/processing/attention state is read from here alone —
 * "Recording" is shown only when the main process's capture heartbeat confirms
 * audio is being written, never because a Meet tab exists.
 */
const INITIAL: AppStatus = { kind: 'paused', activityKind: 'paused', meetTab: null }

export function useAppStatus(): AppStatus {
  const [status, setStatus] = useState<AppStatus>(INITIAL)

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const initial = await window.api.system.appStatus()
        if (mounted) setStatus(initial)
      } catch (err) {
        console.error('Failed to read initial app status', err)
      }
    })()
    const unsub = window.api.system.onAppStatus((next) => {
      if (mounted) setStatus(next)
    })
    return () => {
      mounted = false
      unsub()
    }
  }, [])

  return status
}
