import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastViewport } from '../components/Toast'

/**
 * App-wide toast system. Replaces the ad-hoc `statusBanner` string slot with a
 * typed, auto-dismissing, bottom-centre stack. Mounted once in `App.tsx`; any
 * view calls `useToast().toast(text, opts)`. The knowledge-graph stream reuses
 * this same provider for its own confirmations.
 */
export type ToastKind = 'info' | 'success' | 'error'

export interface ToastOptions {
  kind?: ToastKind
  /** Optional inline action (e.g. "Reveal in Finder"). Dismisses on click. */
  actionLabel?: string
  onAction?: () => void
}

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
  actionLabel?: string
  onAction?: () => void
}

interface ToastContextValue {
  toast: (text: string, opts?: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const MAX_TOASTS = 3
const DISMISS_MS = 4000
const DISMISS_ERROR_MS = 8000

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const handle = timers.current.get(id)
    if (handle !== undefined) {
      window.clearTimeout(handle)
      timers.current.delete(id)
    }
  }, [])

  const toast = useCallback(
    (text: string, opts?: ToastOptions) => {
      const kind = opts?.kind ?? 'info'
      const id = nextId.current++
      const item: ToastItem = {
        id,
        text,
        kind,
        actionLabel: opts?.actionLabel,
        onAction: opts?.onAction
      }
      // Cap the stack at MAX_TOASTS, dropping the oldest (and its timer).
      setToasts((prev) => {
        const next = [...prev, item]
        while (next.length > MAX_TOASTS) {
          const dropped = next.shift()
          if (dropped) {
            const h = timers.current.get(dropped.id)
            if (h !== undefined) {
              window.clearTimeout(h)
              timers.current.delete(dropped.id)
            }
          }
        }
        return next
      })
      const ttl = kind === 'error' ? DISMISS_ERROR_MS : DISMISS_MS
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), ttl)
      )
    },
    [dismiss]
  )

  const value = useMemo<ToastContextValue>(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// The provider + its hook live together (one import surface for consumers,
// incl. the knowledge-graph stream), which the fast-refresh rule dislikes —
// same accepted pattern as the other context modules (tags, settings).
// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
