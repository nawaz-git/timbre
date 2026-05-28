import { useEffect, useRef, useState } from 'react'
import type { EnrolledSpeaker } from '../../../shared/types'

interface SpeakerPickerProps {
  /** Currently-assigned name for this cluster. */
  current: string
  /** Other speakers already used in this meeting (shown grouped). */
  inThisMeeting: string[]
  /** All globally enrolled speakers. Fetched on open. */
  enrolled: EnrolledSpeaker[]
  /** Called when user picks an existing name. */
  onPick: (name: string) => Promise<void> | void
  /** Called on dismiss. */
  onClose: () => void
  /**
   * When true, hide the "Also in this meeting" group and the ✓ current-name
   * header. Used by the "+ Add speaker" flow where neither makes sense
   * (there's no current cluster, and listing in-meeting speakers would
   * just be noise — the caller already filters them out of `enrolled`).
   */
  hideInMeetingGroup?: boolean
  /** Optional placeholder for the new-name input (defaults to "New name…"). */
  newNamePlaceholder?: string
}

/**
 * Otter-style dropdown for assigning a speaker name to a cluster.
 *
 * Layout:
 *   ✓ {current name}                  (header — read-only)
 *   ────────────────────────────────
 *   • In this meeting: A, B, …        (group; clicking one renames to that)
 *   • Enrolled (not in this meeting)  (group; clicking enrols + renames)
 *   ────────────────────────────────
 *   New name: [______________] Save
 */
export function SpeakerPicker(props: SpeakerPickerProps): JSX.Element {
  const {
    current,
    inThisMeeting,
    enrolled,
    onPick,
    onClose,
    hideInMeetingGroup,
    newNamePlaceholder
  } = props
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Dismiss on outside click or Escape.
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const handlePick = async (name: string): Promise<void> => {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      await onPick(name.trim())
    } finally {
      setBusy(false)
    }
  }

  // Speakers also-in-this-meeting, excluding the current one.
  const others = inThisMeeting.filter((n) => n !== current)
  // Enrolled speakers not already present in this meeting (avoid duplicates).
  const onlyEnrolled = enrolled
    .filter((s) => !inThisMeeting.includes(s.name))
    .sort((a, b) => b.useCount - a.useCount)

  return (
    <div ref={wrapRef} className="speaker-picker">
      {!hideInMeetingGroup && (
        <div className="speaker-picker__current">
          <span className="speaker-picker__current-dot">✓</span>
          <span>{current}</span>
        </div>
      )}

      {!hideInMeetingGroup && others.length > 0 && (
        <>
          <div className="speaker-picker__group-label">Also in this meeting</div>
          {others.map((name) => (
            <button
              key={name}
              className="speaker-picker__item"
              onClick={() => void handlePick(name)}
              disabled={busy}
            >
              {name}
            </button>
          ))}
        </>
      )}

      {onlyEnrolled.length > 0 && (
        <>
          <div className="speaker-picker__group-label">Enrolled voices</div>
          {onlyEnrolled.map((s) => (
            <button
              key={s.name}
              className="speaker-picker__item"
              onClick={() => void handlePick(s.name)}
              disabled={busy}
              title={`Used in ${s.useCount} meeting${s.useCount === 1 ? '' : 's'}`}
            >
              {s.name}
              <span className="speaker-picker__item-meta">{s.useCount}×</span>
            </button>
          ))}
        </>
      )}

      <div className="speaker-picker__new">
        <input
          autoFocus
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handlePick(newValue)
          }}
          placeholder={newNamePlaceholder ?? 'New name…'}
          disabled={busy}
          className="speaker-picker__input"
        />
        <button
          className="btn btn--primary btn--small"
          onClick={() => void handlePick(newValue)}
          disabled={busy || !newValue.trim()}
        >
          Save
        </button>
      </div>
    </div>
  )
}
