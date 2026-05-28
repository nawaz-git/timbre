import { useEffect, useRef, useState } from 'react'
import type { EnrolledSpeaker } from '../../../shared/types'

interface SpeakerPickerProps {
  /** Currently-assigned name for this cluster. */
  current: string
  /** Other speakers already used in this meeting (shown grouped). */
  inThisMeeting: string[]
  /** All globally enrolled speakers. Fetched on open. */
  enrolled: EnrolledSpeaker[]
  /**
   * Names within `inThisMeeting` that were user-added (not auto-detected).
   * Rendered with an "(added)" tag so the user can distinguish them from
   * names that came out of diarization. Optional — defaults to none.
   */
  addedSpeakers?: string[]
  /** Called when user picks an existing name. */
  onPick: (name: string) => Promise<void> | void
  /** Called on dismiss. */
  onClose: () => void
  /**
   * When true, hide the "Also in this meeting" group and the ✓ current-name
   * header row, change the title to "Add speaker", and open directly in
   * inline-add mode (the entire header becomes the input). Used by the
   * "+ Add speaker" flow on the Speakers tab — there's no current cluster,
   * and listing in-meeting speakers would be noise.
   */
  hideInMeetingGroup?: boolean
  /** Optional placeholder for the new-name input (defaults to "New name…"). */
  newNamePlaceholder?: string
}

// Mirror of `colorForSpeaker` in Meetings.tsx so the picker can render its
// own dots without taking a dependency on the parent module. Both functions
// share the same palette + hash so colours stay consistent across surfaces.
const SPEAKER_PALETTE = ['#8ab4f8', '#fdd663', '#a1e3a1', '#f28b82', '#c58af9', '#79d5ff']
function dotColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length]
}

/**
 * Speaker-assignment dropdown — Linear-grade redesign for v0.6.0.
 *
 * Anchored absolutely under its trigger (the parent must establish a
 * positioned context — both `.speaker-pill-wrap` and
 * `.segment-row__picker-anchor` do). The popup is fully opaque
 * (`--bg-elevated`) and floats above the transcript via z-index 1000 so
 * the text below NEVER bleeds through.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ Change speaker         [+ Add new]       │  header
 *   │ ✓ {current}                  (current)   │  (hidden in add-mode)
 *   │ ALSO IN THIS MEETING                     │  group label
 *   │ ● Pratik                                 │
 *   │ ● Bhaskar               (added)          │
 *   │ ENROLLED VOICES                          │
 *   │ ● Alice                       3×         │
 *   └──────────────────────────────────────────┘
 *
 * Clicking "+ Add new" morphs the header (only the header — list stays
 * intact) into an inline input with Save / × buttons. Enter commits,
 * Escape reverts to the title row. When `hideInMeetingGroup` is true
 * the picker opens directly in add-mode (there's no current to switch
 * away from).
 */
export function SpeakerPicker(props: SpeakerPickerProps): JSX.Element {
  const {
    current,
    inThisMeeting,
    enrolled,
    addedSpeakers,
    onPick,
    onClose,
    hideInMeetingGroup,
    newNamePlaceholder
  } = props

  // In `hideInMeetingGroup` (the "+ Add speaker" flow) we boot straight
  // into the inline-input mode — that flow has no other purpose.
  const [adding, setAdding] = useState<boolean>(!!hideInMeetingGroup)
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Dismiss on outside click or Escape (Escape only when NOT editing —
  // when editing, Escape reverts the header to its title state).
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (adding && !hideInMeetingGroup) {
        // Revert to title row, keep the picker open.
        setAdding(false)
        setNewValue('')
      } else {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, adding, hideInMeetingGroup])

  // Autofocus when we enter add-mode (whether initially or via user click).
  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const handlePick = async (name: string): Promise<void> => {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      await onPick(name.trim())
    } finally {
      setBusy(false)
    }
  }

  const handleStartAdd = (): void => {
    setNewValue('')
    setAdding(true)
  }

  const handleCancelAdd = (): void => {
    setAdding(false)
    setNewValue('')
  }

  // Build the two grouped lists.
  const addedSet = new Set(addedSpeakers ?? [])
  const others = inThisMeeting.filter((n) => n !== current)
  const onlyEnrolled = enrolled
    .filter((s) => !inThisMeeting.includes(s.name))
    .sort((a, b) => b.useCount - a.useCount)

  const showInMeetingGroup = !hideInMeetingGroup && others.length > 0
  const showEnrolledGroup = onlyEnrolled.length > 0
  const showEmptyState =
    !hideInMeetingGroup && !showInMeetingGroup && !showEnrolledGroup

  const title = hideInMeetingGroup ? 'Add speaker' : 'Change speaker'

  return (
    <div ref={wrapRef} className="speaker-picker" role="dialog" aria-label={title}>
      {/* ── Header row ─────────────────────────────────────────── */}
      <div className="speaker-picker__header">
        {adding ? (
          <>
            <input
              ref={inputRef}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handlePick(newValue)
                }
                // Escape handled in the document-level listener so it
                // also unwinds when the input is blurred via tabbing.
              }}
              placeholder={newNamePlaceholder ?? 'Type name here…'}
              disabled={busy}
              className="speaker-picker__input"
              aria-label="New speaker name"
            />
            <button
              className="speaker-picker__icon-btn speaker-picker__icon-btn--primary"
              onClick={() => void handlePick(newValue)}
              disabled={busy || !newValue.trim()}
              title="Save"
            >
              Save
            </button>
            {!hideInMeetingGroup && (
              <button
                className="speaker-picker__icon-btn"
                onClick={handleCancelAdd}
                disabled={busy}
                title="Cancel"
                aria-label="Cancel"
              >
                ×
              </button>
            )}
          </>
        ) : (
          <>
            <span className="speaker-picker__title">{title}</span>
            {!hideInMeetingGroup && (
              <button
                className="speaker-picker__add-btn"
                onClick={handleStartAdd}
                disabled={busy}
                title="Add a new name"
              >
                + Add new
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Current cluster row (✓ Nawaz   (current)) ─────────── */}
      {!hideInMeetingGroup && current && (
        <>
          <div className="speaker-picker__divider" />
          <div
            className="speaker-picker__item speaker-picker__item--current"
            aria-current="true"
          >
            <span className="speaker-picker__check" aria-hidden="true">
              ✓
            </span>
            <span className="speaker-picker__name">{current}</span>
            <span className="speaker-picker__meta">(current)</span>
          </div>
        </>
      )}

      {/* ── Also in this meeting ─────────────────────────────── */}
      {showInMeetingGroup && (
        <>
          <div className="speaker-picker__divider" />
          <div className="speaker-picker__group-label">Also in this meeting</div>
          {others.map((name) => (
            <button
              key={`m-${name}`}
              className="speaker-picker__item"
              onClick={() => void handlePick(name)}
              disabled={busy}
            >
              <span
                className="speaker-picker__dot"
                style={{ background: dotColor(name) }}
                aria-hidden="true"
              />
              <span className="speaker-picker__name">{name}</span>
              {addedSet.has(name) && (
                <span className="speaker-picker__meta">(added)</span>
              )}
            </button>
          ))}
        </>
      )}

      {/* ── Enrolled voices ──────────────────────────────────── */}
      {showEnrolledGroup && (
        <>
          <div className="speaker-picker__divider" />
          <div className="speaker-picker__group-label">Enrolled voices</div>
          {onlyEnrolled.map((s) => (
            <button
              key={`e-${s.name}`}
              className="speaker-picker__item"
              onClick={() => void handlePick(s.name)}
              disabled={busy}
              title={`Used in ${s.useCount} meeting${s.useCount === 1 ? '' : 's'}`}
            >
              <span
                className="speaker-picker__dot"
                style={{ background: dotColor(s.name) }}
                aria-hidden="true"
              />
              <span className="speaker-picker__name">{s.name}</span>
              <span className="speaker-picker__meta">{s.useCount}×</span>
            </button>
          ))}
        </>
      )}

      {/* ── Empty state (no other speakers anywhere) ─────────── */}
      {showEmptyState && (
        <>
          <div className="speaker-picker__divider" />
          <div className="speaker-picker__empty">
            No other speakers yet — add a new name above
          </div>
        </>
      )}
    </div>
  )
}
