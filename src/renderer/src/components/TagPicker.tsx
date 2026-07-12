import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Tag as TagIcon } from 'lucide-react'
import type { TagDef } from '../../../shared/types'
import { useRovingFocus } from './useRovingFocus'

interface TagPickerProps {
  /** All globally defined tags. */
  allTags: TagDef[]
  /** Currently-active tag ids on this meeting (rendered with a check). */
  activeTagIds: string[]
  /** The trigger button — used to anchor the popover. */
  anchorEl: HTMLElement | null
  /** Toggle a tag on or off for this meeting. */
  onToggle: (tagId: string) => void | Promise<void>
  /** Dismiss the popover. */
  onClose: () => void
}

/**
 * Compact tag-assignment popover anchored under the meeting row's tag
 * affordance. Mirrors the structural language of `SpeakerPicker` (header
 * row + grouped item list) but uses a solid `--surface-overlay` background
 * rather than the frosted glass — this popover floats over the sidebar
 * list, not over dense transcript text, so a flat surface reads cleaner
 * and the colour dots have higher contrast.
 *
 * Positioned with `position: fixed` against the anchor button's
 * `getBoundingClientRect()` so it escapes the scrolling meeting list's
 * `overflow: hidden` clip. Re-measures on window resize and on parent
 * scroll so it follows the anchor while open.
 *
 * Outside-click + Escape both dismiss. Clicks on an item toggle the tag
 * in place; the popover stays open so the user can toggle multiple tags
 * in one gesture, mirroring how Linear's label menu works.
 */
export function TagPicker(props: TagPickerProps): JSX.Element {
  const { allTags, activeTagIds, anchorEl, onToggle, onClose } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const activeSet = new Set(activeTagIds)

  // Arrow/Home/End rove through the tag options; focus opens on the first
  // option and returns to the anchor on close.
  useRovingFocus(wrapRef, '.tag-picker__item', anchorEl)

  // Popover position in viewport coords. We anchor top-right of the
  // popover to bottom-right of the icon so the popover grows away from
  // the row's right edge (won't clip the rest of the row content).
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })

  // Measure once on mount + on any scroll/resize. useLayoutEffect on
  // mount so the popover lands in the correct spot in the same paint.
  useLayoutEffect(() => {
    function measure(): void {
      if (!anchorEl) return
      const r = anchorEl.getBoundingClientRect()
      setPos({
        top: r.bottom + 4,
        right: Math.max(8, window.innerWidth - r.right)
      })
    }
    measure()
    // Re-measure on any scroll in any ancestor (capture phase catches
    // bubbling from inner scrollers like `.meetings__list`).
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchorEl])

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      if (anchorEl?.contains(target)) return
      onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorEl])

  return (
    <div
      ref={wrapRef}
      className="tag-picker"
      role="dialog"
      aria-label="Apply tags"
      onClick={(e) => e.stopPropagation()}
      style={{ top: pos.top, right: pos.right }}
    >
      <div className="tag-picker__header">
        <TagIcon size={12} strokeWidth={2.25} aria-hidden="true" />
        <span className="tag-picker__title">Apply tags</span>
      </div>
      <div className="tag-picker__divider" />
      {allTags.length === 0 ? (
        <div className="tag-picker__empty">
          No tags yet. Open Settings &rarr; Tags to create some.
        </div>
      ) : (
        <div className="tag-picker__list" role="listbox" aria-multiselectable="true">
          {allTags.map((tag) => {
            const active = activeSet.has(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                role="option"
                aria-selected={active}
                className={'tag-picker__item' + (active ? ' tag-picker__item--active' : '')}
                onClick={(e) => {
                  e.stopPropagation()
                  void onToggle(tag.id)
                }}
              >
                <span
                  className="tag-picker__dot"
                  style={{ background: tag.color }}
                  aria-hidden="true"
                />
                <span className="tag-picker__name">{tag.name}</span>
                {active && (
                  <span className="tag-picker__check" aria-hidden="true">
                    <Check size={13} strokeWidth={2.5} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
