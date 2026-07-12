/**
 * Pure logic for deciding whether a `<prefix>.refining` marker file should
 * surface an engine meeting as `refining` (a MAX-tier background upgrade in
 * flight) or be treated as an orphan and ignored.
 *
 * The engine writes the marker at refine start and removes it on completion.
 * But a crash / app-quit / `pkill` mid-refine leaves the marker behind, and
 * the discarded snapshot job on the engine side can no longer clean it up
 * (see `PipelineQueue.loadSnapshot`, which now also removes it on relaunch).
 * Between the crash and the next engine relaunch, Timbre must not pin the
 * meeting to a perpetual "Refining…" state — the FAST transcript is already on
 * disk and the meeting is fully usable, so an orphaned marker falls back to
 * `ready`.
 *
 * Kept free of `fs`/`electron` imports so it is unit-testable in isolation.
 */

/**
 * How long a `.refining` marker is trusted as an in-progress signal before it
 * is treated as orphaned. The MAX refine budget is 30 min (the engine's
 * `RefineBudget.default`); this cap sits comfortably above it so a slow but
 * genuinely-live refine is never mistaken for a stale marker, while a marker
 * left by a crash still ages out on its own even if the engine never relaunches
 * to clean it up.
 */
export const REFINE_MARKER_STALE_MS = 45 * 60 * 1000

/**
 * Decide whether a `.refining` marker counts as an active refine.
 *
 * A marker only counts while it is BOTH:
 *   - fresh — its mtime is within the staleness cap, and
 *   - backed by a live engine — the helper process that would remove the
 *     marker on completion is still running.
 *
 * If either fails the marker is an orphan: the caller should fall back to
 * `ready` (the FAST transcript is on disk and usable).
 */
export function isRefineMarkerActive(opts: {
  markerMtimeMs: number
  nowMs: number
  engineAlive: boolean
  staleCapMs?: number
}): boolean {
  if (!opts.engineAlive) return false
  const cap = opts.staleCapMs ?? REFINE_MARKER_STALE_MS
  const ageMs = opts.nowMs - opts.markerMtimeMs
  // A future-dated mtime (clock skew) is still "fresh"; only an age beyond the
  // cap ages the marker out.
  return ageMs <= cap
}
