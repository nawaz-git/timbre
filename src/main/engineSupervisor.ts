/**
 * Engine supervisor — the ONLY component that restarts the live engine outside
 * an explicit user action.
 *
 * Every ~5 s it reads `engine_heartbeat.json` and decides, purely, whether the
 * engine is:
 *   - wedged       — `recording` but its heartbeat stopped refreshing;
 *   - audio-wedged — heartbeat fresh, but the app tap stopped delivering
 *                    (its `lastIOCallbackAt` went stale) inside a live engine;
 *   - died         — no heartbeat at all while the user still wants it watching.
 *
 * On a wedge/death it drives the SAME graceful stop + reuse-aware relaunch the
 * user-action start path uses (injected as `restartEngine`) — never a parallel
 * kill path. A 30 s backoff plus a 3-restarts/hour cap means a chronically
 * failing engine surfaces a persistent-failure notification instead of
 * storm-restarting.
 *
 * The pure `superviseDecision` is exported for unit coverage (no vitest harness
 * exists on this branch — it is a plain exported function); the driver keeps the
 * restart history + expected-active flag as module state.
 *
 * `startWatching` (recording.ts) consults this module via `noteUserWatchStart` /
 * `noteUserWatchStop`, so a manual start resets the storm guard + clears a prior
 * give-up, and a user pause stops the supervisor from relaunching a
 * deliberately-stopped engine.
 */
import { Notification } from 'electron'
import type { EngineHeartbeat } from '../shared/types'

// ─── Tunables (the TS-side counterpart to the Swift CaptureTuning enum) ──────

/** How often the supervisor evaluates the heartbeat. */
export const SUPERVISOR_TICK_MS = 5_000
/**
 * A `recording` engine whose `updatedAt` (or `lastIOCallbackAt`) is older than
 * this is treated as wedged. Comfortably above the engine's 2 s heartbeat
 * cadence so a slow-but-alive refresh isn't mistaken for a wedge.
 */
export const HEARTBEAT_STALE_MS = 15_000
/** Minimum gap between supervisor-driven restarts (backoff, no restart storm). */
export const RESTART_BACKOFF_MS = 30_000
/**
 * A freshly (re)started engine gets this long to boot and write its first
 * heartbeat before an absent file counts as "died" — prevents the supervisor
 * from killing a still-launching engine.
 */
export const STARTUP_GRACE_MS = 20_000
/** Rolling window + cap for the restart storm guard (max 3 restarts / hour). */
export const RESTART_WINDOW_MS = 3_600_000
export const MAX_RESTARTS_PER_WINDOW = 3
/**
 * How fresh the cached heartbeat must be for the Chrome-probe "is a recording
 * active?" gate to trust its `recording` state. Tolerates a couple of missed
 * supervisor reads; a staler heartbeat falls the probe back to its own
 * placeholder heuristic.
 */
export const HEARTBEAT_PROBE_FRESH_MS = 20_000

export type SuperviseReason = 'wedged' | 'audio-wedged' | 'died'

export type SuperviseAction =
  | { kind: 'none' }
  | { kind: 'restart'; reason: SuperviseReason; notify: boolean }
  | { kind: 'giveUp'; reason: SuperviseReason }

export interface SuperviseInput {
  heartbeat: EngineHeartbeat | null
  now: number
  /**
   * Electron believes the engine SHOULD be running (the user started watching
   * and hasn't stopped). Gates the "died → relaunch" branch so a user pause is
   * never undone by the supervisor.
   */
  expectedActive: boolean
  /**
   * epoch-ms of the most recent user-initiated start (launch / Start watching);
   * seeds the startup grace so a booting engine isn't mistaken for dead.
   */
  lastStartRequestedAt: number | null
  /** epoch-ms of supervisor-driven restarts within the rolling window. */
  recentRestarts: number[]
}

/**
 * Pure decision. Load-bearing invariants (charter: no infinite respawn):
 *  - never restart within `RESTART_BACKOFF_MS` of the last restart;
 *  - never exceed `MAX_RESTARTS_PER_WINDOW` — give up (surface a banner) instead;
 *  - only relaunch a dead engine when the user wants it active AND the startup
 *    grace has elapsed since the last start/restart (don't kill a booting one).
 */
export function superviseDecision(input: SuperviseInput): SuperviseAction {
  const { heartbeat, now, expectedActive, lastStartRequestedAt, recentRestarts } = input
  const restartsInWindow = recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS)
  const lastRestart = restartsInWindow.length ? restartsInWindow[restartsInWindow.length - 1] : null
  const capReached = restartsInWindow.length >= MAX_RESTARTS_PER_WINDOW
  const inBackoff = lastRestart !== null && now - lastRestart < RESTART_BACKOFF_MS

  const decideRestart = (reason: SuperviseReason, notify: boolean): SuperviseAction => {
    if (capReached) return { kind: 'giveUp', reason }
    if (inBackoff) return { kind: 'none' }
    return { kind: 'restart', reason, notify }
  }

  if (!heartbeat) {
    // No engine advertising itself — only our problem if the user wants it up.
    if (!expectedActive) return { kind: 'none' }
    // Give a freshly (re)started engine time to boot before calling it dead.
    const lastActivity = Math.max(lastStartRequestedAt ?? -Infinity, lastRestart ?? -Infinity)
    if (now - lastActivity < STARTUP_GRACE_MS) return { kind: 'none' }
    return decideRestart('died', false)
  }

  if (heartbeat.state === 'recording') {
    if (now - heartbeat.updatedAt > HEARTBEAT_STALE_MS) {
      // The heartbeat itself stopped refreshing → the engine (or its main
      // thread) is wedged.
      return decideRestart('wedged', true)
    }
    if (
      typeof heartbeat.lastIOCallbackAt === 'number' &&
      now - heartbeat.lastIOCallbackAt > HEARTBEAT_STALE_MS
    ) {
      // Heartbeat fresh but the app tap stopped delivering — the capture path is
      // wedged inside an otherwise-live engine.
      return decideRestart('audio-wedged', true)
    }
  }
  return { kind: 'none' }
}

// ─── Driver (impure shell) ───────────────────────────────────────────────────

export interface SupervisorDeps {
  /** Read + parse the current engine heartbeat (null when absent/malformed). */
  readHeartbeat: () => Promise<EngineHeartbeat | null>
  /**
   * Graceful stop (with the distinct reason for logging) + reuse-aware relaunch.
   * Wired in `index.ts` to `stopEngineGracefully` → `startLiveRecorder` so the
   * supervisor never opens a parallel kill path.
   */
  restartEngine: (reason: SuperviseReason) => Promise<void>
}

interface SupervisorState {
  timer: NodeJS.Timeout | null
  /** True while a tick's async restart is in flight — never overlap ticks. */
  ticking: boolean
  expectedActive: boolean
  lastStartRequestedAt: number | null
  recentRestarts: number[]
  gaveUp: boolean
  /** Last heartbeat read, cached for the synchronous Chrome-probe provider. */
  lastHeartbeat: EngineHeartbeat | null
}

const state: SupervisorState = {
  timer: null,
  ticking: false,
  expectedActive: false,
  lastStartRequestedAt: null,
  recentRestarts: [],
  gaveUp: false,
  lastHeartbeat: null
}

/**
 * Fresh user intent to watch: the engine should be up, and the storm guard
 * resets so a manual (re)start always gets a clean slate — and clears a prior
 * give-up so a user-driven recovery isn't stuck behind the failure state. This
 * is the "startWatching consults the supervisor" seam.
 */
export function noteUserWatchStart(now: number = Date.now()): void {
  state.expectedActive = true
  state.lastStartRequestedAt = now
  state.recentRestarts = []
  state.gaveUp = false
}

/** User paused watching — the supervisor must not relaunch a stopped engine. */
export function noteUserWatchStop(): void {
  state.expectedActive = false
}

/**
 * The last-read heartbeat if fresh enough for the Chrome-probe "is a recording
 * active?" gate, else null (the probe then falls back to its own placeholder
 * heuristic). Synchronous: the supervisor is the single async heartbeat reader;
 * the probe reads this cache. Exported for `index.ts`'s recording-active
 * provider (the recording-active seam).
 */
export function getRecordingHeartbeat(now: number = Date.now()): EngineHeartbeat | null {
  const hb = state.lastHeartbeat
  if (!hb) return null
  const age = now - hb.updatedAt
  if (!(age >= 0) || age > HEARTBEAT_PROBE_FRESH_MS) return null
  return hb
}

/** Diagnostic snapshot of supervisor state (for a future renderer banner / logs). */
export function getEngineSupervisorState(): {
  expectedActive: boolean
  restartsInWindow: number
  gaveUp: boolean
} {
  const now = Date.now()
  return {
    expectedActive: state.expectedActive,
    restartsInWindow: state.recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS).length,
    gaveUp: state.gaveUp
  }
}

export function startEngineSupervisor(deps: SupervisorDeps): void {
  if (state.timer) return
  state.timer = setInterval(() => void tick(deps), SUPERVISOR_TICK_MS)
}

export function stopEngineSupervisor(): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

async function tick(deps: SupervisorDeps): Promise<void> {
  if (state.ticking) return // never overlap a slow restart with the next tick
  state.ticking = true
  try {
    const heartbeat = await deps.readHeartbeat()
    state.lastHeartbeat = heartbeat
    // Prune the restart log so the window stays bounded and getEngineSupervisorState
    // stays cheap.
    const now = Date.now()
    state.recentRestarts = state.recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS)

    const action = superviseDecision({
      heartbeat,
      now,
      expectedActive: state.expectedActive,
      lastStartRequestedAt: state.lastStartRequestedAt,
      recentRestarts: state.recentRestarts
    })

    switch (action.kind) {
      case 'none':
        // A healthy, fresh heartbeat clears a prior give-up so a recovered
        // engine isn't stuck behind the failure surface.
        if (state.gaveUp && heartbeat && now - heartbeat.updatedAt < HEARTBEAT_STALE_MS) {
          state.gaveUp = false
        }
        break
      case 'restart':
        state.recentRestarts.push(now)
        console.warn(`[supervisor] restarting engine (reason=${action.reason})`)
        if (action.notify) showRestartNotification()
        await deps.restartEngine(action.reason)
        break
      case 'giveUp':
        if (!state.gaveUp) {
          state.gaveUp = true
          console.error(
            `[supervisor] engine restart cap reached (reason=${action.reason}) — giving up`
          )
          showGiveUpNotification()
        }
        break
    }
  } catch (err) {
    console.warn('[supervisor] tick failed', err)
  } finally {
    state.ticking = false
  }
}

function showRestartNotification(): void {
  try {
    new Notification({
      title: 'Timbre',
      body: 'Recording engine restarted — the meeting audio may have a gap.',
      silent: false
    }).show()
  } catch (err) {
    console.warn('[supervisor] restart notification failed', err)
  }
}

function showGiveUpNotification(): void {
  try {
    new Notification({
      title: 'Timbre',
      body: 'The recording engine keeps failing to start. Recordings may be missing — reopen Timbre or check its permissions.',
      silent: false
    }).show()
  } catch (err) {
    console.warn('[supervisor] give-up notification failed', err)
  }
}
