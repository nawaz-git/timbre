import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRovingFocus } from './useRovingFocus'

export interface RowMenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  danger?: boolean
  onSelect: () => void
}

interface RowMenuProps {
  /** The trigger button — used to anchor the popover. */
  anchorEl: HTMLElement | null
  items: RowMenuItem[]
  onClose: () => void
}

/**
 * Compact overflow (⋮) menu anchored under a meeting row's kebab button.
 * Reuses TagPicker's positioning contract: `position: fixed` against the
 * anchor's `getBoundingClientRect()` so it escapes the scrolling list's clip,
 * re-measured on scroll/resize, dismissed on outside-click or Escape.
 */
export function RowMenu({ anchorEl, items, onClose }: RowMenuProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })

  // Arrow/Home/End rove through the menuitems; focus opens on the first
  // item and returns to the kebab on close.
  useRovingFocus(wrapRef, '.row-menu__item', anchorEl)

  useLayoutEffect(() => {
    function measure(): void {
      if (!anchorEl) return
      const r = anchorEl.getBoundingClientRect()
      setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
    }
    measure()
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
      className="row-menu"
      role="menu"
      aria-label="Meeting actions"
      onClick={(e) => e.stopPropagation()}
      style={{ top: pos.top, right: pos.right }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={'row-menu__item' + (item.danger ? ' row-menu__item--danger' : '')}
          onClick={(e) => {
            e.stopPropagation()
            item.onSelect()
          }}
        >
          {item.icon && (
            <span className="row-menu__icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
