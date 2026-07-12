/**
 * Per-meeting mutation serializer.
 *
 * Every meeting mutation IPC handler is a read-modify-write against the same
 * on-disk files (`meta.json`, `transcript.json`, `transcript.txt`,
 * `<prefix>_segments.json`). Two handlers running concurrently for the same
 * meeting can interleave — both read the old bytes, both compute a patch, and
 * the second write clobbers the first (lost update). Wrapping each mutation in
 * `withMeetingLock(meetingId, …)` chains them so, per meeting, only one runs at
 * a time; different meetings still run in parallel.
 *
 * Scope + limits: this guards races WITHIN the main process only. The Swift
 * engine can still write the same files out-of-band (e.g. a late
 * `reapplySpeakerNames` after diarization finishes). That cross-process race is
 * intentionally out of scope — the engine is the source of truth and wins if it
 * writes last; a filesystem lockfile protocol between the two processes is a
 * larger change than this hardening pass. The atomic writer (`atomicFile.ts`)
 * still guarantees neither side ever sees a torn file, so the worst case is a
 * lost label edit, never a corrupt file.
 */

/**
 * Tail of the in-flight mutation chain per meeting id. The stored promise is
 * always "swallowed" (never rejects), so the next caller can chain off it
 * without inheriting a prior mutation's failure. The entry is deleted once its
 * chain drains, keeping the map bounded by the number of *actively* mutating
 * meetings rather than every meeting ever touched.
 */
const chains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` after any mutation already queued for `meetingId` has settled, and
 * before any queued after it. Returns `fn`'s result (or rejection) to THIS
 * caller unchanged; a rejection never blocks or poisons the next caller.
 */
export function withMeetingLock<T>(meetingId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(meetingId) ?? Promise.resolve()
  // Chain regardless of whether `prior` fulfilled or rejected — the lock is
  // about ordering, not success. `fn` ignores the settled value.
  const result = prior.then(fn, fn)
  const tail: Promise<unknown> = result.then(
    () => undefined,
    () => undefined
  )
  chains.set(meetingId, tail)
  void tail.then(() => {
    // Only drop the entry if nobody chained behind us in the meantime, so a
    // live chain is never orphaned.
    if (chains.get(meetingId) === tail) chains.delete(meetingId)
  })
  return result
}
