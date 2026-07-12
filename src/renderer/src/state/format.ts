import type { ProcessingStage } from '../../../shared/types'

/**
 * Human, honest-progress labels for a processing meeting's stage. One
 * shared map so the Home hero and the Meetings list/detail render identical
 * copy (formerly duplicated verbatim in both views).
 */
export const PROCESSING_STAGE_LABEL: Record<ProcessingStage, string> = {
  transcribing: 'Transcribing speech',
  diarizing: 'Identifying speakers',
  summarizing: 'Writing summary',
  unknown: 'Working…'
}

/** Format a number of seconds as `mm:ss` or `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Format an ISO timestamp into a friendly local string. */
export function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Compact, scannable date for meeting rows + recent cards:
 *   - today            → `Today 14:05`
 *   - within 6 days    → `Thu 14:05`
 *   - otherwise        → `May 28, 14:05`
 * The detail pane keeps the full `formatDate`. `now` is injectable for tests.
 */
export function formatDateRelative(iso: string, now: Date = new Date()): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const dayDiff = Math.round((startOfDayMs(now) - startOfDayMs(d)) / 86_400_000)
    if (dayDiff <= 0) return `Today ${time}`
    if (dayDiff <= 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
  } catch {
    return iso
  }
}
