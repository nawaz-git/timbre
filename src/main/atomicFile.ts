import { promises as fs } from 'fs'
import { dirname } from 'path'

/**
 * Write `data` to `path` atomically: stage it in a sibling temp file, then
 * `rename` it into place. A reader (the renderer, the engine, or a concurrent
 * mutation) therefore never observes a half-written meeting file — it sees
 * either the old bytes or the complete new bytes, never a truncated middle.
 *
 * Every in-place mutation in `meetings.ts` used a bare `fs.writeFile`, which
 * truncates-then-writes and leaves a corrupt zero/partial file if the process
 * is killed (quit, crash, OOM) mid-write. This helper removes that window.
 *
 * The temp name is keyed on the PID so two processes writing the same path use
 * distinct staging files; within one process, same-path writes are already
 * serialized by `withMeetingLock` (see `meetingLock.ts`), so they never race
 * for the temp name. On a failed `rename` we delete the temp file rather than
 * leave orphaned `.tmp-*` litter next to the real data.
 *
 * `chromeProbe.ts` keeps its own `writeJsonAtomic` — that one is hard-wired to
 * the engine IPC dir and serializes the active-meeting signal; this helper is
 * the general path-agnostic writer for on-disk meeting artefacts.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await fs.writeFile(tmp, data, 'utf-8')
  try {
    await fs.rename(tmp, path)
  } catch (err) {
    // The rename failed, so `path` still holds its prior contents. Clean up the
    // staged temp so a failure never leaves a partial file behind.
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
