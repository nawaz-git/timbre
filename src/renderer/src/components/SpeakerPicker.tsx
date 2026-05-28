import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
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
  /**
   * The trigger element — used to anchor the popover. The popover positions
   * itself with `position: fixed` against this element's
   * `getBoundingClientRect()`, then re-measures on scroll/resize.
   *
   * Why this matters: prior versions used `position: absolute` inside the
   * trigger's wrapper, which trapped the popover inside the trigger's
   * stacking context. Combined with a `transform`-based entrance animation,
   * Chromium would promote the popover to its own composited layer, and
   * `backdrop-filter` would silently no-op against that layer — making the
   * popup appear translucent over high-contrast colored text (a recurring
   * "the popup is transparent!" bug across v0.6 → v0.9). Rendering via
   * portal to `document.body` and using viewport-anchored `position: fixed`
   * sidesteps the whole problem class.
   */
  anchorEl: HTMLElement | null
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

const POPUP_WIDTH = 300
const POPUP_MARGIN_FROM_EDGE = 8
const GAP_BELOW_ANCHOR = 4

/**
 * Speaker-assignment dropdown — Portal-mounted, solid surface, viewport-fixed.
 *
 * Rendered via `createPortal(..., document.body)` so the popover lives as a
 * direct child of `<body>`. Positioned with `position: fixed` against the
 * `anchorEl`'s bounding rect — no ancestor stacking context can clip,
 * defocus, or composite around it.
 *
 * Background is the solid `--surface-overlay` token (theme-aware: white in
 * light, near-black in dark) with no `backdrop-filter` and no `transform`-
 * based entrance animation. Entrance is opacity-only so the popover never
 * gets promoted to its own composited layer mid-frame.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ Change speaker         [+ Add new]       │
 *   │ ✓ {current}                  (current)   │
 *   │ ALSO IN THIS MEETING                     │
 *   │ ● Pratik                                 │
 *   │ ● Bhaskar               (added)          │
 *   │ ENROLLED VOICES                          │
 *   │ ● Alice                       3×         │
 *   └──────────────────────────────────────────┘
 *
 * Clicking "+ Add new" morphs the header (only the header — list stays
 * intact) into an inline input with Save + lucide-X buttons. Enter
 * commits, Escape reverts to the title row. When `hideInMeetingGroup`
 * is true the picker opens directly in add-mode.
 */
export function SpeakerPicker(props: SpeakerPickerProps): JSX.Element | null {
  const {
    current,
    inThisMeeting,
    enrolled,
    addedSpeakers,
    anchorEl,
    onPick,
    onClose,
    hideInMeetingGroup,
    newNamePlaceholder
  } = props

  const [adding, setAdding] = useState<boolean>(!!hideInMeetingGroup)
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Viewport-coord position. We anchor the popover to bottom-left of the
  // trigger and clamp against the right edge of the window so it never
  // hangs off-screen on narrow widths.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    function measure(): void {
      if (!anchorEl) return
      const r = anchorEl.getBoundingClientRect()
      const left = Math.min(
        Math.max(POPUP_MARGIN_FROM_EDGE, r.left),
        window.innerWidth - POPUP_WIDTH - POPUP_MARGIN_FROM_EDGE
      )
      setPos({ top: r.bottom + GAP_BELOW_ANCHOR, left })
    }
    measure()
    // Re-measure on any scroll in any ancestor (capture phase catches
    // bubbling from inner scrollers like `.transcript-list`).
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchorEl])

  // Dismiss on outside click or Escape. Escape during inline-edit only
  // reverts the header (unless we booted in add-mode, where there's
  // nowhere to revert to).
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      if (anchorEl?.contains(target)) return
      onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (adding && !hideInMeetingGroup) {
        setAdding(false)
        setNewValue('')
      } else {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, adding, hideInMeetingGroup, anchorEl])

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

  if (!anchorEl) return null

  const popover = (
    <div
      ref={wrapRef}
      className="speaker-picker"
      role="dialog"
      aria-label={title}
      style={{ top: pos.top, left: pos.left, width: POPUP_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
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
                <X size={14} strokeWidth={2} aria-hidden="true" />
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
              <Check size={14} strokeWidth={2.5} />
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

  return createPortal(popover, document.body)
}
