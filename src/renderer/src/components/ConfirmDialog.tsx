import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ConfirmDialogProps {
  title: string
  body: string
  confirmLabel: string
  /** Render the confirm button in the danger style (destructive actions). */
  danger?: boolean
  /** May be async — while it's in flight both buttons disable (busy state). */
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/**
 * A native-feeling confirmation modal for destructive / irreversible actions.
 * Replaces `window.confirm`, which can't be styled, can't carry a danger
 * treatment, and reads as "web page in a frame" rather than a Mac app.
 *
 * Rendered through a portal to document.body so it escapes any transformed /
 * overflow-clipped ancestor. Accessibility: `role="alertdialog"` +
 * `aria-modal`, labelled/described by the title and body, focus starts on
 * Cancel (the safe default), Tab is trapped between the two buttons, Esc
 * cancels and Enter confirms.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial focus on Cancel — the non-destructive choice — and restore focus to
  // whatever was focused when the dialog opened (usually the trigger button) on
  // close, so keyboard users aren't dumped back to <body>.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => {
      previouslyFocused?.focus?.()
    }
  }, [])

  const handleConfirm = useCallback(() => {
    if (busy) return
    setBusy(true)
    Promise.resolve()
      .then(() => onConfirm())
      .catch(() => {
        // The caller surfaces any error (toast / banner); we only need to
        // release the busy lock so the dialog stays usable if it remains
        // mounted after a failure.
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false)
      })
  }, [busy, onConfirm])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busy) onCancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
        return
      }
      if (e.key === 'Tab') {
        const focusables =
          dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
        if (!focusables || focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel, handleConfirm])

  const dialog = (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        // A click on the backdrop (never the dialog itself) cancels.
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId} className="confirm-dialog__title">
          {title}
        </h2>
        <p id={bodyId} className="confirm-dialog__body">
          {body}
        </p>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={'btn' + (danger ? ' btn--danger' : ' btn--primary')}
            onClick={handleConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
