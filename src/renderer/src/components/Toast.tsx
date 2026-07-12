import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ToastItem } from '../state/toast'

/**
 * The visual half of the toast system (see `state/toast.tsx` for the provider).
 * A bottom-centre stack, portalled to document.body so it escapes any
 * transformed / overflow-clipped ancestor. Each toast announces itself
 * (`role="status"`, or `role="alert"` for errors); animations are disabled
 * under `prefers-reduced-motion` in app.css.
 */
export function ToastViewport({
  toasts,
  onDismiss
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}): JSX.Element | null {
  if (toasts.length === 0) return null
  return createPortal(
    <div className="toast-viewport">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}${t.kind === 'error' ? ' notice--danger' : ''}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast__text">{t.text}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                t.onAction?.()
                onDismiss(t.id)
              }}
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            className="toast__close"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
