import { useCallback, useEffect, useState } from 'react'
import type { ChromeMeetSnapshot, PermissionStatus } from '../../../shared/types'

/**
 * Subscribes to the macOS TCC permission state surfaced by the main
 * process. Polls every 5s — TCC has no push channel from the OS, so a
 * gentle poll is the only way to notice when a user grants/revokes a
 * permission via System Settings while Mintr is running.
 */
export function usePermissions(): {
  status: PermissionStatus
  refresh: () => Promise<void>
  openPane: (
    pane: 'screen-recording' | 'microphone' | 'automation' | 'accessibility'
  ) => Promise<void>
} {
  const [status, setStatus] = useState<PermissionStatus>({
    screenRecording: 'unknown',
    microphone: 'unknown',
    automationChrome: 'unknown'
  })

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.system.permissions()
      setStatus(next)
    } catch (err) {
      console.error('Failed to read permission status', err)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [refresh])

  const openPane = useCallback(
    async (pane: 'screen-recording' | 'microphone' | 'automation' | 'accessibility') => {
      await window.api.system.openSettings(pane)
      // Re-poll a moment after opening — gives the user time to flip
      // the toggle and come back to Mintr.
      setTimeout(() => void refresh(), 1500)
    },
    [refresh]
  )

  return { status, refresh, openPane }
}

/**
 * Live snapshot of the Chrome AppleScript probe. Subscribes to the push
 * channel for instant updates AND pulls the initial state on mount so
 * the card renders without waiting for the first poll cycle.
 */
export function useChromeMeet(): ChromeMeetSnapshot {
  const [snapshot, setSnapshot] = useState<ChromeMeetSnapshot>({
    available: false,
    tab: null
  })

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const initial = await window.api.system.chromeMeet()
        if (mounted) setSnapshot(initial)
      } catch (err) {
        console.error('Failed to read initial chrome-meet snapshot', err)
      }
    })()
    const unsub = window.api.system.onChromeMeetUpdate((next) => {
      if (mounted) setSnapshot(next)
    })
    return () => {
      mounted = false
      unsub()
    }
  }, [])

  return snapshot
}
