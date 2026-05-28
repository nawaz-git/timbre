import { useCallback, useEffect, useState } from 'react'
import type { RecordingStatus } from '../../../shared/types'

/** Polls the main process for recording status every second. */
export function useRecordingStatus(): {
  status: RecordingStatus
  start: () => Promise<void>
  stop: () => Promise<void>
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<RecordingStatus>({ state: 'idle' })

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.recording.status()
      setStatus(next)
    } catch (err) {
      console.error('Failed to read recording status', err)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => {
      void refresh()
    }, 1000)
    return () => clearInterval(id)
  }, [refresh])

  const start = useCallback(async () => {
    const next = await window.api.recording.start()
    setStatus(next)
  }, [])

  const stop = useCallback(async () => {
    const next = await window.api.recording.stop()
    setStatus(next)
  }, [])

  return { status, start, stop, refresh }
}
