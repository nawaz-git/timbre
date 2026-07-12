/**
 * Pure IPC input-validation helpers. The renderer is untrusted — every string
 * it hands a privileged main-process handler (a path to open, a file to spawn a
 * job against, a meeting id) is validated here first. Kept pure + dependency-
 * free so the guards are exhaustively unit-testable.
 */
import { join } from 'path'

/**
 * A meeting id is safe to use in a filesystem path when it carries no traversal
 * characters. The engine/imported/live prefixes themselves contain none of
 * these, so testing the whole id (rather than the stripped folder portion) is
 * both simplest and correct — it mirrors the guard the meetings.ts writers use.
 */
export function isTraversalSafeMeetingId(meetingId: unknown): meetingId is string {
  return (
    typeof meetingId === 'string' &&
    meetingId.length > 0 &&
    !meetingId.includes('..') &&
    !meetingId.includes('/') &&
    !meetingId.includes('\\')
  )
}

/**
 * Resolve a meeting id to the folder to reveal in Finder, main-side. The
 * renderer used to pass a raw path straight to `shell.openPath` — opening an
 * arbitrary `.app` path launches it — so we now accept only an id and resolve
 * it against the app's own roots:
 *   - `engine:<prefix>` → the engine's `protocols/` dir (flat-file layout)
 *   - `imported:<folder>` / bare `<folder>` → `<outputFolder>/<folder>`
 *   - `live:` / malformed / traversal → null (nothing on disk to open)
 * Returns null when the id can't be safely resolved; the caller still confirms
 * the path exists before opening it.
 */
export function resolveMeetingOpenPath(
  meetingId: string,
  outputFolder: string,
  liveRoot: string
): string | null {
  if (!isTraversalSafeMeetingId(meetingId)) return null
  if (meetingId.startsWith('live:')) return null
  if (meetingId.startsWith('engine:')) {
    const prefix = meetingId.slice('engine:'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return null
    return join(liveRoot, 'protocols')
  }
  const folderId = meetingId.startsWith('imported:')
    ? meetingId.slice('imported:'.length)
    : meetingId
  if (folderId.includes('/') || folderId.includes('\\') || folderId.includes('..')) return null
  return join(outputFolder, folderId)
}

/**
 * A backend job may only be spawned against the file the user most recently
 * picked via the native import dialog — never an arbitrary renderer-supplied
 * path. `lastPicked` is null once consumed (a fresh pick is required per spawn).
 */
export function isSpawnPathAllowed(filePath: unknown, lastPicked: string | null): boolean {
  return typeof filePath === 'string' && filePath.length > 0 && filePath === lastPicked
}
