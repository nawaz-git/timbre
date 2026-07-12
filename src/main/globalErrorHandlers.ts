import { app, Notification } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'

/**
 * Format one crash-log line: ISO timestamp, the incident kind, and the error's
 * stack (or its stringified value when there's no stack — an unhandled
 * rejection can reject with a non-Error). Pure, so it is unit-tested directly.
 */
export function formatErrorLogLine(now: Date, kind: string, err: unknown): string {
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)
  return `${now.toISOString()} ${kind} ${detail}`
}

/**
 * Re-notify at most once per this window. A single notification per process
 * lifetime went silent after the first incident, so a recurring fault storm
 * left the app wedged-but-alive with no further signal; a cooldown resurfaces
 * the problem periodically without spamming a notification per throw.
 */
const NOTIFY_COOLDOWN_MS = 5 * 60_000

/**
 * Whether enough time has elapsed since the last crash notification to show
 * another. Pure so the throttle is unit-tested directly. `lastNotifiedAtMs` of
 * 0 (never notified) always passes.
 */
export function shouldRenotify(
  nowMs: number,
  lastNotifiedAtMs: number,
  cooldownMs = NOTIFY_COOLDOWN_MS
): boolean {
  return nowMs - lastNotifiedAtMs >= cooldownMs
}

let handlersInstalled = false
let lastNotifiedAtMs = 0

/**
 * Install process-level guards so a stray throw or a rejected promise in the
 * main process doesn't take the app down (or wedge it) silently. Every incident
 * is appended to `<userData>/main-errors.log` and logged to the console, and a
 * notification is shown at most once per `NOTIFY_COOLDOWN_MS` — a menu-bar app
 * that quietly dies leaves the user with no trace, so we keep running and leave
 * a breadcrumb, but a recurring fault re-surfaces on the cooldown instead of
 * going silent forever after the first one. Never calls `process.exit`.
 * Idempotent.
 */
export function installGlobalErrorHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true

  const handle = (kind: string, err: unknown): void => {
    const line = formatErrorLogLine(new Date(), kind, err)
    try {
      // Resolve the path lazily (userData is stable once the app boots) and
      // append synchronously — the handler may fire while the event loop is
      // already unwinding, so a fire-and-forget async write could be lost.
      appendFileSync(join(app.getPath('userData'), 'main-errors.log'), line + '\n')
    } catch {
      // A log we cannot write must never itself crash the handler.
    }
    console.error(line)
    const now = Date.now()
    if (shouldRenotify(now, lastNotifiedAtMs)) {
      lastNotifiedAtMs = now
      try {
        new Notification({
          title: 'Timbre hit an internal error',
          body: 'It keeps running; details are in the log.'
        }).show()
      } catch {
        // Notification can throw if the platform surface isn't ready — ignore.
      }
    }
  }

  process.on('uncaughtException', (err) => handle('uncaughtException', err))
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason))
}
