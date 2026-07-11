import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app, type WebContents } from 'electron'
import type { EnrolledSpeaker, NumSpeakersHint } from '../shared/types'
import { globalSpeakersDBPath } from './settings'
import { ENGINE_IPC_DIR } from './chromeProbe'

/**
 * Resolve the path to the bundled `mt-batch` Swift CLI.
 *
 * In dev: `meeting-transcriber/tools/mt-batch/.build/release/mt-batch`
 *   relative to the electron project root (engine is vendored in-repo, monorepo).
 * In packaged app: `<Resources>/bin/mt-batch` — placed there by
 *   electron-builder via `extraResources` in `electron-builder.yml`.
 */
export function resolveBatchBinary(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'mt-batch')
  }
  return join(
    app.getAppPath(),
    'meeting-transcriber',
    'tools',
    'mt-batch',
    '.build',
    'release',
    'mt-batch'
  )
}

/**
 * Resolve the path to the bundled engine helper.
 *
 * v0.19+: the packaged helper is renamed to `MintrEngine.app` by the
 * electron-builder afterPack hook so it can carry its own Mintr-aligned
 * bundle id (`ai.nawaz.mintr-engine`), separate from the upstream
 * MeetingTranscriber project. We probe the new name first, then fall
 * back to the legacy `MeetingTranscriber.app` so:
 *
 *   - `electron-vite dev` (where afterPack doesn't run) still works
 *   - users on v0.18 or earlier installs continue running until they
 *     reinstall the rebranded v0.19+ DMG
 *
 * Returns `null` when neither bundle is present.
 */
export function resolveLiveRecorderApp(): string | null {
  const candidates = app.isPackaged
    ? [
        // v0.19+ packaged location (rebranded by afterPack)
        join(process.resourcesPath, 'MintrEngine.app'),
        // Legacy packaged location (pre-rebrand, kept for forward-compat
        // during dev rebuilds where afterPack may not have run)
        join(process.resourcesPath, 'MeetingTranscriber.app')
      ]
    : [
        // Release bundle from `./scripts/build_release.sh --no-notarize`
        join(
          app.getAppPath(),
          'meeting-transcriber',
          '.build',
          'release',
          'MeetingTranscriber.app'
        ),
        // Dev bundle from `./scripts/run_app.sh --build-only`
        join(
          app.getAppPath(),
          'meeting-transcriber',
          'app',
          'MeetingTranscriber',
          '.build',
          'MeetingTranscriber-Dev.app'
        )
      ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export interface BatchMatch {
  detected: string
  enrolled: string | null
  similarity: number
}

export type BatchEvent =
  | { event: 'loading_audio' }
  | { event: 'loading_models' }
  | { event: 'transcribing'; progress: number }
  | { event: 'diarizing' }
  | { event: 'merging' }
  | { event: 'matched_speakers'; matches: BatchMatch[] }
  | { event: 'done'; outputDir: string }
  | { event: 'error'; message: string }

export interface BatchJob {
  jobId: string
  filePath: string
  outputDir: string
  startedAt: number
}

interface RunBatchOptions {
  jobId: string
  inputFile: string
  /** Already-resolved per-meeting subfolder (caller created the timestamped dir). */
  outputDir: string
  /** Optional speaker hint forwarded as `--num-speakers`. */
  numSpeakers?: number
  /** Optional global speakers DB path forwarded as `--global-db`. Defaults to the user's global DB. */
  globalDB?: string
  /** Called for each parsed event. Errors during processing are reported via the `error` event. */
  onEvent: (ev: BatchEvent) => void
}

/**
 * Resolve the numSpeakers setting (auto | 2-6) into an integer arg for mt-batch,
 * or undefined when 'auto' (let the diarizer decide).
 */
export function numSpeakersToArg(hint: NumSpeakersHint | undefined): number | undefined {
  if (typeof hint === 'number') return hint
  return undefined
}

/**
 * Spawn mt-batch and parse its JSONL stdout. Returns a promise that resolves
 * with the final output directory on success, or rejects with an Error on
 * failure (non-zero exit, missing binary, etc.).
 */
export function runBatch(opts: RunBatchOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveBatchBinary()
    if (!existsSync(bin)) {
      const msg = `mt-batch binary not found at ${bin}. Build it via \`swift build -c release\` in the meeting-transcriber repo.`
      opts.onEvent({ event: 'error', message: msg })
      reject(new Error(msg))
      return
    }

    const args = ['--input', opts.inputFile, '--output-dir', opts.outputDir]
    if (typeof opts.numSpeakers === 'number') {
      args.push('--num-speakers', String(opts.numSpeakers))
    }
    // Pass --global-db so the run can auto-recognise enrolled voices.
    // mt-batch tolerates a non-existent file (treats as empty list).
    const globalDB = opts.globalDB ?? globalSpeakersDBPath()
    args.push('--global-db', globalDB)

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdoutBuf = ''
    let lastError: string | null = null

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8')
      let nl: number
      // eslint-disable-next-line no-cond-assign
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as BatchEvent
          opts.onEvent(parsed)
          if (parsed.event === 'error') lastError = parsed.message
        } catch {
          // Non-JSON lines are diagnostics from FluidAudio/etc. — ignore for the event stream.
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      // Forward stderr to main log for debugging — not surfaced to the UI.
      console.warn('[mt-batch:stderr]', chunk.toString('utf-8').trim())
    })

    child.on('error', (err) => {
      opts.onEvent({ event: 'error', message: err.message })
      reject(err)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(opts.outputDir)
      } else {
        const msg = lastError ?? `mt-batch exited with code ${code ?? 'unknown'}`
        reject(new Error(msg))
      }
    })
  })
}

/**
 * Build a filesystem-safe timestamped subfolder name.
 * Format: `YYYY-MM-DD_HH-MM-SS_<slug>`.
 */
export function timestampedFolderName(slug: string, when: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  const safeSlug = slug
    .replace(/\.[^.]+$/, '') // drop extension if any
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'
  return `${ts}_${safeSlug}`
}

/**
 * Create the per-meeting output folder under the configured root.
 * Returns the absolute path.
 */
export async function createMeetingFolder(
  rootFolder: string,
  sourceName: string
): Promise<string> {
  await fs.mkdir(rootFolder, { recursive: true })
  const folderName = timestampedFolderName(sourceName)
  const folder = join(rootFolder, folderName)
  await fs.mkdir(folder, { recursive: true })
  return folder
}

/**
 * Active state of the live recorder subprocess (when launched).
 * Only one live recorder runs at a time.
 */
let liveProcess: ChildProcess | null = null

/**
 * In-flight graceful-stop escalation, if any. `startLiveRecorder` serialises
 * behind it so a stop-then-immediately-start sequence never reuses or
 * relaunches over an engine that is still shutting down. Set by
 * `stopLiveRecorder`, cleared when its escalation resolves.
 */
let pendingStop: Promise<void> | null = null

export function isLiveActive(): boolean {
  return liveProcess !== null && !liveProcess.killed
}

/**
 * Binary-path patterns matching every engine helper we might have to signal:
 * the v0.19+ rebranded `MintrEngine` and any pre-v0.19 `MeetingTranscriber`
 * helper still alive from an older install (including a standalone
 * `/Applications` copy). Shared by `forceKillEngine` (pkill) and
 * `isEngineAlive` (pgrep) so the two can't target different process sets.
 */
const ENGINE_PROCESS_PATTERNS = [
  'MintrEngine.app/Contents/MacOS/MintrEngine',
  'MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber'
] as const

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * True if any engine helper is currently running. Uses `pgrep -f` against the
 * same binary-path patterns `forceKillEngine` targets, so "is it alive?" and
 * "kill it" always agree on what "it" is.
 */
export function isEngineAlive(): boolean {
  for (const pattern of ENGINE_PROCESS_PATTERNS) {
    try {
      const result = spawnSync('/usr/bin/pgrep', ['-f', pattern], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      // pgrep exits 0 when at least one process matched.
      if (result.status === 0) return true
    } catch (err) {
      console.warn(`[live-recorder] pgrep ${pattern} failed`, err)
    }
  }
  return false
}

export type EngineSignal = 'SIGTERM' | 'SIGKILL'

/**
 * Force-signal every engine helper on the system (renamed from the old
 * `killLiveRecorderSync`).
 *
 * Parameterised by signal so one function serves both rungs of
 * `stopEngineGracefully`: SIGTERM (graceful — the engine's own SIGTERM handler
 * finalizes the in-flight recording, see the Swift side) and SIGKILL (last
 * resort). The default SIGTERM preserves the historic kill-then-relaunch
 * behaviour of the onboarding / restart-helper callers.
 *
 * Critical for fresh TCC state. macOS caches Screen Recording / Mic
 * permission at process launch — granting the permission *afterwards*
 * doesn't refresh a running process. v0.12 → v0.13 shipped without this
 * step and we saw a 4-hour-old helper sitting on stale "denied" TCC even
 * after the user granted permission in System Settings, writing zero
 * audio for the whole window.
 *
 * v0.15+: signals ANY MeetingTranscriber Mach-O the user has running, not
 * just the bundled one. With LaunchServices dedup, v0.12-v0.14 sometimes
 * left a *standalone* /Applications/MeetingTranscriber.app helper running
 * with stale TCC. We're the only thing on the system that should be
 * launching this binary, so killing siblings is safe and prevents a
 * surprise zombie process from grabbing audio output.
 */
export function forceKillEngine(signal: EngineSignal = 'SIGTERM'): { killed: number } {
  let killed = 0
  // First: signal anything we own a handle to (the cheap path).
  if (liveProcess && liveProcess.pid && !liveProcess.killed) {
    try {
      liveProcess.kill(signal)
      killed += 1
    } catch (err) {
      console.warn('[live-recorder] direct kill failed', err)
    }
  }
  // Second: belt-and-suspenders pkill of every helper binary path on the
  // system (rebranded + legacy). pkill takes the signal name without the
  // "SIG" prefix, e.g. -TERM / -KILL.
  const pkillFlag = `-${signal.replace(/^SIG/, '')}`
  for (const pattern of ENGINE_PROCESS_PATTERNS) {
    try {
      const result = spawnSync('/usr/bin/pkill', [pkillFlag, '-f', pattern], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (result.status === 0) killed += 1
    } catch (err) {
      console.warn(`[live-recorder] pkill ${pattern} failed`, err)
    }
  }
  liveProcess = null
  return { killed }
}

/** Milliseconds the engine gets to self-exit via its SIGTERM handler before we SIGKILL. */
const ENGINE_TERM_GRACE_MS = 8000
/** Poll cadence while waiting for the engine to exit. */
const ENGINE_POLL_MS = 500

export type EscalationAction = 'sigterm' | 'wait' | 'sigkill' | 'done'

/**
 * Pure escalation policy for a graceful engine stop. Given the time elapsed
 * since the stop began and whether any engine helper is still alive, decide the
 * next action. The driver acts once on each transition ('sigterm' at t=0,
 * 'sigkill' at the grace boundary) and merely 'wait's in between:
 *
 *   t = 0            → 'sigterm'  (engine's SIGTERM handler finalizes + exits)
 *   0 < t < GRACE    → 'wait'     (give the graceful teardown time)
 *   t >= GRACE       → 'sigkill'  (last resort)
 *   engine gone      → 'done'
 */
export function nextEscalationStep(elapsedMs: number, alive: boolean): EscalationAction {
  if (!alive) return 'done'
  if (elapsedMs <= 0) return 'sigterm'
  if (elapsedMs < ENGINE_TERM_GRACE_MS) return 'wait'
  return 'sigkill'
}

/**
 * Stop the engine gracefully with kill escalation, replacing the old fixed
 * 250 ms fuse. Sends SIGTERM (the engine finalizes its recording via the Swift
 * SIGTERM handler), polls for exit up to ENGINE_TERM_GRACE_MS, then SIGKILL as
 * a last resort. Resolves once the engine is gone (or SIGKILL was issued).
 *
 * We deliberately lead with SIGTERM rather than an AppleScript `quit`: quit
 * routes through AppKit's default terminate, which the engine does NOT
 * intercept to finalize a recording, so it could fast-exit and drop an
 * in-flight one — the very case this path exists to protect. SIGTERM is what
 * triggers the engine's graceful finalize, and `pkill -f` reaches the helper by
 * path with no PID needed (the same reach the AppleScript-by-name quit had).
 */
export async function stopEngineGracefully(
  reason: string
): Promise<{ ok: true; finalAction: EscalationAction }> {
  console.log(`[live-recorder] graceful stop (reason=${reason})`)
  const started = Date.now()
  let termSent = false

  for (;;) {
    const alive = isEngineAlive()
    const action = nextEscalationStep(Date.now() - started, alive)

    if (action === 'done') {
      console.log(`[live-recorder] engine exited gracefully (reason=${reason})`)
      return { ok: true, finalAction: 'done' }
    }
    if (action === 'sigterm') {
      if (!termSent) {
        termSent = true
        console.log('[live-recorder] escalation: SIGTERM')
        forceKillEngine('SIGTERM')
      }
    } else if (action === 'sigkill') {
      console.warn(
        `[live-recorder] escalation: SIGKILL after ${ENGINE_TERM_GRACE_MS} ms (reason=${reason})`
      )
      forceKillEngine('SIGKILL')
      await delay(ENGINE_POLL_MS)
      return { ok: true, finalAction: 'sigkill' }
    }
    await delay(ENGINE_POLL_MS)
  }
}

/**
 * Engine liveness heartbeat, written by the engine to the shared IPC dir every
 * couple of seconds and read here to decide whether a running engine can be
 * reused instead of killed + relaunched. `updatedAt` is epoch **milliseconds**,
 * matching `active_meeting.json` / `engine_config.json`, and `version` is the
 * engine's build version (compared against `app.getVersion()`; the monorepo
 * keeps the two in lockstep). Extra liveness fields are read opportunistically.
 *
 * NOTE: the engine-side writer of this file does not exist yet, so
 * `readEngineHeartbeat()` returns null and reuse is simply skipped — every
 * launch falls through to the safe kill + relaunch until the writer lands.
 */
export interface EngineHeartbeat {
  pid: number
  version: string
  state: 'watching' | 'recording' | 'processing' | 'idle'
  startedAt: number
  lastIOCallbackAt?: number
  lastSCKFrameAt?: number
  tapPIDCount?: number
  updatedAt: number
}

const ENGINE_HEARTBEAT_FILE = join(ENGINE_IPC_DIR, 'engine_heartbeat.json')

/** How fresh the heartbeat must be for us to trust a running engine (ms). */
const HEARTBEAT_FRESH_MS = 6000

/**
 * Read + parse the engine heartbeat. Returns null when absent (engine not
 * running / writer not yet shipped) or malformed — callers treat null as
 * "can't reuse".
 */
export async function readEngineHeartbeat(): Promise<EngineHeartbeat | null> {
  try {
    const raw = await fs.readFile(ENGINE_HEARTBEAT_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<EngineHeartbeat>
    if (typeof parsed.updatedAt !== 'number' || typeof parsed.version !== 'string') {
      return null
    }
    return parsed as EngineHeartbeat
  } catch {
    return null
  }
}

export interface EngineReuseVerdict {
  reuse: boolean
  reason: string
}

/**
 * Pure decision: can a running engine be reused instead of killed + relaunched?
 * Reuse only when the heartbeat is present, fresh (< HEARTBEAT_FRESH_MS old),
 * and its embedded version matches the version this Timbre build expects. Any
 * doubt — no heartbeat, stale, clock-skewed, or version mismatch — declines, so
 * the caller falls back to the always-safe graceful stop + relaunch.
 */
export function evaluateEngineReuse(
  heartbeat: EngineHeartbeat | null,
  expectedVersion: string,
  nowMs: number
): EngineReuseVerdict {
  if (!heartbeat) return { reuse: false, reason: 'no-heartbeat' }
  const age = nowMs - heartbeat.updatedAt
  if (!(age >= 0) || age > HEARTBEAT_FRESH_MS) {
    return { reuse: false, reason: `stale-heartbeat(age=${Math.round(age)}ms)` }
  }
  if (heartbeat.version !== expectedVersion) {
    return {
      reuse: false,
      reason: `version-mismatch(${heartbeat.version}!=${expectedVersion})`
    }
  }
  return { reuse: true, reason: 'healthy' }
}

/**
 * Spawn the bundled MintrEngine helper.
 *
 * **v0.21 critical change — back to `/usr/bin/open`.** TCC log diff
 * proved that Mintr-spawned helpers (v0.15-v0.20 direct `spawn` with
 * `detached: true`) ran with `responsible=Electron` in tccd's view —
 * which means the user's per-helper TCC grants (Screen Recording,
 * Accessibility, Microphone for `ai.nawaz.mintr-engine`) were
 * IGNORED because tccd resolved against the responsible-process bundle
 * id (Electron / Mintr), not the requesting one. PermissionHealthCheck
 * failed → WatchLoop never started → no capture.
 *
 * Launching via `/usr/bin/open` makes launchd (PID 1) the parent and
 * tccd records `Resp:{ai.nawaz.mintr-engine}` — i.e. the helper is
 * responsible for itself. User grants are honoured.
 *
 * The historical reason v0.15 switched AWAY from `open` was
 * LaunchServices bundle-id dedup: when both
 *   /Applications/MeetingTranscriber.app (legacy standalone install)
 *   /Applications/Mintr.app/Contents/Resources/MeetingTranscriber.app
 * existed with bundle id `com.meetingtranscriber.app`, `open` could
 * launch either binary. The v0.19 rebrand to `ai.nawaz.mintr-engine`
 * (afterPack hook) eliminated that ambiguity — nothing else on the
 * system has the new bundle id, so `open` is unambiguous again.
 *
 * `-n` forces a new instance even if launchd thinks one is already
 * running (we still pkill any stale helper first via killLiveRecorderSync,
 * but `-n` is defence-in-depth against fast-Mintr-restart races).
 *
 * Trade-off: `open` exits immediately after dispatching to launchd, so
 * we no longer hold a PID handle to the helper. That's why we keep
 * pkill-by-binary-path for kill/restart paths.
 */
export async function startLiveRecorder(env: Record<string, string> = {}): Promise<{
  ok: boolean
  appPath?: string
  message?: string
  reused?: boolean
}> {
  const appPath = resolveLiveRecorderApp()
  if (!appPath) {
    return {
      ok: false,
      message:
        'Live recording engine not bundled. Install MintrEngine.app or rebuild the DMG with the bundled engine.'
    }
  }

  // Serialise behind any in-flight graceful stop so we never probe or relaunch
  // over an engine that is still shutting down.
  if (pendingStop) {
    await pendingStop
  }

  // Step 0: reuse a healthy running engine instead of the kill-mid-IO +
  // relaunch that every routine Timbre launch used to do. A fresh,
  // version-matched heartbeat means the engine is already watching with
  // current permissions, so relaunching would needlessly SIGTERM a live audio
  // tap. (Until the engine writes the heartbeat this always misses and we fall
  // through to the safe stop + relaunch below.) The extra isEngineAlive() call
  // closes the fresh-heartbeat-but-just-died race.
  const verdict = evaluateEngineReuse(await readEngineHeartbeat(), app.getVersion(), Date.now())
  if (verdict.reuse && isEngineAlive()) {
    console.log('[live-recorder] reusing healthy engine (skipping kill + relaunch)')
    return { ok: true, appPath, reused: true }
  }

  // Step 1: stop any stale / mismatched instance GRACEFULLY before launching,
  // so the old engine finalizes its recording and releases its tap instead of
  // fighting the new one for audio. macOS won't refresh a running process's TCC
  // entries anyway, so a stale helper has to go.
  console.log(`[live-recorder] not reusing engine (${verdict.reason}) — stopping + relaunching`)
  await stopEngineGracefully('stale-engine')

  // Step 2: launch via `/usr/bin/open -n <bundled-app> --args --auto-watch`.
  //
  // `-n` forces a fresh instance. `--args --auto-watch` is passed THROUGH
  // `open` into the engine's argv — without it the engine launches but
  // never starts its WatchLoop, because auto-watch only fires when the
  // `--auto-watch` flag (or an `autoWatch` UserDefaults key) is present
  // (MeetingTranscriberApp.swift:63). The v0.19 rebrand gave the engine a
  // fresh bundle id → fresh UserDefaults domain where `autoWatch` defaults
  // to false, so the flag is now the only reliable trigger. This is why
  // the engine sat silent after launch in v0.19-v0.21 — it was never told
  // to watch.
  //
  // We deliberately do NOT pass `-W` (would make `open` block until the
  // app quits, blocking Mintr forever).
  //
  // `open` itself is a child process of Mintr, but it tears down within
  // ~50ms after dispatching to launchd. The helper itself becomes a
  // child of launchd (PID 1), which is the key to severing the TCC
  // responsibility chain that v0.15-v0.20 had.
  const child = spawn('/usr/bin/open', ['-n', appPath, '--args', '--auto-watch'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ...env
    },
    detached: true
  })
  child.unref()

  child.stdout?.on('data', (chunk: Buffer) => {
    // The helper emits to os.log primarily, but anything that does land
    // on stdout (e.g. crash banners on launch) is useful diagnostic
    // info — forward to Electron's console so we can read it in the
    // packaged-app log stream.
    console.log('[live-recorder:stdout]', chunk.toString('utf-8').trimEnd())
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    console.warn('[live-recorder:stderr]', chunk.toString('utf-8').trimEnd())
  })

  child.on('close', (code, signal) => {
    if (code !== null && code !== 0) {
      console.warn(`[live-recorder] helper exited with code ${code}`)
    }
    if (signal) {
      console.warn(`[live-recorder] helper killed by signal ${signal}`)
    }
    liveProcess = null
  })

  child.on('error', (err) => {
    console.error('[live-recorder] spawn error', err)
    liveProcess = null
  })

  // We track the `open` child here, not the helper itself — `open`
  // exits within ~50ms after dispatching to launchd. The actual helper
  // lives under launchd; we manage it via pkill in killLiveRecorderSync.
  liveProcess = child
  child.unref()
  return { ok: true, appPath }
}

/**
 * Stop the bundled engine helper gracefully. Kicks off the SIGTERM → (8 s) →
 * SIGKILL escalation (`stopEngineGracefully`), replacing the old fixed 250 ms
 * fuse so a mid-finalize engine gets time to write its trailing WAV + pipeline
 * snapshot before we ever force-kill it. The escalation is tracked in
 * `pendingStop` so a subsequent `startLiveRecorder` serialises behind it and
 * never reuses / relaunches over a dying engine. Self-contained error handling:
 * it never rejects, so callers may fire-and-forget.
 */
export async function stopLiveRecorder(reason = 'user-stop'): Promise<{ ok: boolean }> {
  const run = stopEngineGracefully(reason)
    .then(() => {})
    .catch((err) => {
      console.warn('[live-recorder] graceful stop failed', err)
    })
  pendingStop = run
  await run
  if (pendingStop === run) pendingStop = null
  liveProcess = null
  return { ok: true }
}

/**
 * Forward backend events to a renderer WebContents over the `backend:event` channel.
 */
export function makeWebContentsForwarder(
  webContents: WebContents,
  jobId: string
): (ev: BatchEvent) => void {
  return (ev: BatchEvent) => {
    if (webContents.isDestroyed()) return
    webContents.send('backend:event', { jobId, ...ev })
  }
}

// ─── Global speakers DB helpers ───────────────────────────────────────────

interface StoredSpeaker {
  name: string
  centroid: number[]
  centroidSampleCount: number
  embeddings: number[][]
  lastUsed: number
  useCount: number
}

/**
 * List enrolled speakers via `mt-batch list-speakers`. Returns [] if the
 * global DB doesn't exist yet, or if mt-batch isn't available.
 */
export function listEnrolledSpeakers(): EnrolledSpeaker[] {
  const bin = resolveBatchBinary()
  if (!existsSync(bin)) return []
  const dbPath = globalSpeakersDBPath()
  const result = spawnSync(bin, ['list-speakers', '--global-db', dbPath], {
    encoding: 'utf-8',
    timeout: 5000
  })
  if (result.error || result.status !== 0) return []
  const out = result.stdout?.trim()
  if (!out) return []
  const speakers: EnrolledSpeaker[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as EnrolledSpeaker
      speakers.push(parsed)
    } catch {
      // ignore malformed lines
    }
  }
  return speakers
}

async function readStoredSpeakers(path: string): Promise<StoredSpeaker[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as StoredSpeaker[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeStoredSpeakersAtomic(
  path: string,
  speakers: StoredSpeaker[]
): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(speakers, null, 2), 'utf-8')
  await fs.rename(tmp, path)
}

/**
 * Add or update an enrolled speaker in the global DB. If a speaker with
 * `newName` already exists, the centroid is updated via a running mean
 * (weighted by sampleCount). Otherwise a new entry is created using the
 * meeting's centroid as the seed.
 */
export async function enrollOrUpdateSpeaker(
  newName: string,
  centroid: number[],
  centroidSampleCount: number,
  embedding: number[] | undefined
): Promise<void> {
  const dbPath = globalSpeakersDBPath()
  const speakers = await readStoredSpeakers(dbPath)
  const now = Date.now() / 1000
  const existingIdx = speakers.findIndex((s) => s.name === newName)
  if (existingIdx >= 0) {
    const existing = speakers[existingIdx]
    // Running-mean centroid update weighted by sample counts.
    const aN = existing.centroidSampleCount || 1
    const bN = centroidSampleCount || 1
    const total = aN + bN
    const merged = existing.centroid.map((v, i) => (v * aN + centroid[i] * bN) / total)
    // L2-normalise so cosine math stays well-behaved.
    const norm = Math.sqrt(merged.reduce((s, v) => s + v * v, 0)) || 1
    existing.centroid = merged.map((v) => v / norm)
    existing.centroidSampleCount = total
    existing.useCount += 1
    existing.lastUsed = now
    if (embedding && existing.embeddings.length < 3) {
      existing.embeddings.push(embedding)
    }
    speakers[existingIdx] = existing
  } else {
    speakers.push({
      name: newName,
      centroid,
      centroidSampleCount,
      embeddings: embedding ? [embedding] : [],
      lastUsed: now,
      useCount: 1
    })
  }
  await writeStoredSpeakersAtomic(dbPath, speakers)
}

/**
 * Remove a speaker from the global DB by name. No-op if not present.
 */
export async function deleteSpeakerFromGlobalDB(name: string): Promise<void> {
  const dbPath = globalSpeakersDBPath()
  const speakers = await readStoredSpeakers(dbPath)
  const filtered = speakers.filter((s) => s.name !== name)
  if (filtered.length === speakers.length) return
  await writeStoredSpeakersAtomic(dbPath, filtered)
}

/**
 * Read a meeting's `speakers.json` and return the StoredSpeaker entry that
 * was assigned the given name in this run. Used by the rename flow to
 * recover the centroid that produced the "Speaker N" label.
 */
export async function readMeetingSpeakers(meetingFolder: string): Promise<StoredSpeaker[]> {
  return readStoredSpeakers(join(meetingFolder, 'speakers.json'))
}

/**
 * Write back the meeting's speakers.json with renamed entries so later
 * navigations see the right labels.
 */
export async function writeMeetingSpeakers(
  meetingFolder: string,
  speakers: StoredSpeaker[]
): Promise<void> {
  await writeStoredSpeakersAtomic(join(meetingFolder, 'speakers.json'), speakers)
}
