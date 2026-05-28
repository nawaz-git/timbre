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
 * Capture-watchdog signal from the main process. Flips to
 * `helperPermissionLikely: true` after 25s of Chrome-detected Meet with
 * no engine file writes — almost certainly the bundled MeetingTranscriber
 * helper missing Screen Recording permission (it has a separate TCC
 * bundle id from Mintr's, `com.meetingtranscriber.app`).
 */
export interface CaptureWatchdogSignal {
  helperPermissionLikely: boolean
  meetingId?: string
  firedAt?: number
}

export function useCaptureWatchdog(): CaptureWatchdogSignal {
  const [signal, setSignal] = useState<CaptureWatchdogSignal>({
    helperPermissionLikely: false
  })

  useEffect(() => {
    const unsub = window.api.system.onWatchdogUpdate((next) => setSignal(next))
    return unsub
  }, [])

  return signal
}

/**
 * Tracks whether the engine helper is ACTIVELY capturing (i.e. it has
 * written at least one file in the last ~6 seconds). This is the
 * derived signal that gates the live-capture card on Home — Mintr says
 * "Watching" the whole time the user has watch-mode on, but capture
 * only happens during a meeting, and we want to surface the difference.
 *
 * Implementation: subscribe to the `meetings:changed` push channel.
 * Every change bumps `lastWriteAt`. A 1Hz tick checks whether the most
 * recent write is fresh (within `LIVE_WINDOW_MS`) — if yes we're live,
 * if no we're back to dormant. `meetingId` is sourced from the Chrome
 * probe so the card has context.
 */
const LIVE_WINDOW_MS = 6500

export interface LiveCaptureSignal {
  /** True iff the engine has written within LIVE_WINDOW_MS. */
  active: boolean
  /** Wall-clock ms when this capture session started. */
  startedAt: number | null
  /** Chrome-detected meeting id (when available) used as the card title. */
  meetingId: string | null
}

export function useLiveCapture(meetingIdHint: string | null): LiveCaptureSignal {
  const [active, setActive] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  useEffect(() => {
    let lastWriteAt = 0
    let sessionStart: number | null = null

    const unsub = window.api.system.onMeetingsChanged(() => {
      const now = Date.now()
      lastWriteAt = now
      if (!sessionStart) {
        sessionStart = now
        setStartedAt(now)
      }
      setActive(true)
    })

    const tick = setInterval(() => {
      const now = Date.now()
      if (now - lastWriteAt > LIVE_WINDOW_MS) {
        if (sessionStart) {
          sessionStart = null
          setStartedAt(null)
        }
        setActive(false)
      }
    }, 1000)

    return () => {
      unsub()
      clearInterval(tick)
    }
  }, [])

  return { active, startedAt, meetingId: meetingIdHint }
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
