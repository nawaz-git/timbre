import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Roving keyboard navigation for a popover list (menu / listbox / picker).
 *
 * - Arrow Up/Down move focus between the enabled items matching
 *   `itemSelector` (wrapping at the ends); Home/End jump to first/last.
 * - When `autoFocusFirst` (default), focus lands on the first item as the
 *   popover opens, so a keyboard user is dropped straight into the list.
 * - On unmount — i.e. every close path — focus returns to `anchorEl`
 *   instead of falling back to the top of the document.
 *
 * Arrow keys are ignored while a text field inside the popover is focused
 * (the caret owns them), so inline add/rename inputs keep working. Escape
 * stays each component's concern (they differ: some revert an inline edit
 * before closing).
 */
export function useRovingFocus(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  anchorEl: HTMLElement | null,
  opts?: { autoFocusFirst?: boolean }
): void {
  const autoFocusFirst = opts?.autoFocusFirst ?? true

  // Focus the first item on open, and return focus to the anchor on close.
  // Both run once for the popover's lifetime; the anchor is stable while
  // the popover is mounted.
  useEffect(() => {
    if (autoFocusFirst) {
      const first = containerRef.current?.querySelector<HTMLElement>(itemSelector)
      first?.focus()
    }
    return () => {
      anchorEl?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')
        return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      const items = Array.from(el!.querySelectorAll<HTMLElement>(itemSelector)).filter(
        (n) => !n.hasAttribute('disabled')
      )
      if (items.length === 0) return
      e.preventDefault()
      const idx = active ? items.indexOf(active) : -1
      let next: number
      if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = items.length - 1
      else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length
      else next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length
      items[next]?.focus()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [containerRef, itemSelector])
}
