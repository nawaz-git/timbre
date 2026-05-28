import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app, type WebContents } from 'electron'
import type { EnrolledSpeaker, NumSpeakersHint } from '../shared/types'
import { globalSpeakersDBPath } from './settings'

/**
 * Resolve the path to the bundled `mt-batch` Swift CLI.
 *
 * In dev: `../meeting-transcriber/tools/mt-batch/.build/release/mt-batch`
 *   relative to the electron project root.
 * In packaged app: `<Resources>/bin/mt-batch` — placed there by
 *   electron-builder via `extraResources` in `electron-builder.yml`.
 */
export function resolveBatchBinary(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'mt-batch')
  }
  return join(
    app.getAppPath(),
    '..',
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
          '..',
          'meeting-transcriber',
          '.build',
          'release',
          'MeetingTranscriber.app'
        ),
        // Dev bundle from `./scripts/run_app.sh --build-only`
        join(
          app.getAppPath(),
          '..',
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

export function isLiveActive(): boolean {
  return liveProcess !== null && !liveProcess.killed
}

/**
 * Hard-kill any existing MeetingTranscriber helper process.
 *
 * Critical for fresh TCC state. macOS caches Screen Recording / Mic
 * permission at process launch — granting the permission *afterwards*
 * doesn't refresh a running process. v0.12 → v0.13 shipped without this
 * step and we saw a 4-hour-old helper sitting on stale "denied" TCC even
 * after the user granted permission in System Settings, writing zero
 * audio for the whole window.
 *
 * v0.15+: kills ANY MeetingTranscriber Mach-O the user has running, not
 * just the bundled one. With LaunchServices dedup, v0.12-v0.14 sometimes
 * left a *standalone* /Applications/MeetingTranscriber.app helper running
 * with stale TCC. We're the only thing on the system that should be
 * launching this binary, so killing siblings is safe and prevents a
 * surprise zombie process from grabbing audio output.
 */
export function killLiveRecorderSync(): { killed: number } {
  let killed = 0
  // First: kill anything we own a handle to (the cheap path).
  if (liveProcess && liveProcess.pid && !liveProcess.killed) {
    try {
      liveProcess.kill('SIGTERM')
      killed += 1
    } catch (err) {
      console.warn('[live-recorder] direct kill failed', err)
    }
  }
  // Second: belt-and-suspenders pkill of every helper binary path on
  // the system. We match TWO patterns to catch both the v0.19+ rebranded
  // helper (MintrEngine.app/Contents/MacOS/MintrEngine) and any
  // pre-v0.19 helper still alive from a previous install (the legacy
  // MeetingTranscriber.app path, including a user's standalone install
  // in /Applications). On an upgrade, we want both classes gone.
  const patterns = [
    'MintrEngine.app/Contents/MacOS/MintrEngine',
    'MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber'
  ]
  for (const pattern of patterns) {
    try {
      const result = spawnSync('/usr/bin/pkill', ['-f', pattern], {
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
export function startLiveRecorder(env: Record<string, string> = {}): {
  ok: boolean
  appPath?: string
  message?: string
} {
  const appPath = resolveLiveRecorderApp()
  if (!appPath) {
    return {
      ok: false,
      message:
        'Live recording engine not bundled. Install MintrEngine.app or rebuild the DMG with the bundled engine.'
    }
  }

  // Step 1: kill any stale instance. macOS won't refresh a running
  // process's TCC entries, so a 4-hour-old helper that booted before
  // permission was granted is dead weight — silently failing to read
  // window titles for as long as it lives.
  killLiveRecorderSync()

  // Step 2: launch via `/usr/bin/open -n <bundled-app>`. The `-n`
  // forces a fresh instance. We pass `--args` not needed — the helper
  // doesn't take CLI args. We deliberately do NOT pass `-W` (would
  // make `open` block until the app quits, blocking Mintr forever).
  //
  // `open` itself is a child process of Mintr, but it tears down within
  // ~50ms after dispatching to launchd. The helper itself becomes a
  // child of launchd (PID 1), which is the key to severing the TCC
  // responsibility chain that v0.15-v0.20 had.
  const child = spawn('/usr/bin/open', ['-n', appPath], {
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
 * Stop the bundled MeetingTranscriber.app helper. Best-effort AppleScript
 * quit first (so it can finalise any in-flight recording cleanly), then
 * a hard `pkill` as belt-and-suspenders. Both are non-blocking from the
 * caller's perspective — the helper has 250ms to exit gracefully before
 * we force-kill it.
 */
export function stopLiveRecorder(): { ok: boolean; message?: string } {
  // 1) Polite AppleScript quit. Lets the helper close any open files
  //    and write its trailing transcript/metadata. We send the quit
  //    to BOTH application names — v0.19+ "MintrEngine" and the legacy
  //    "MeetingTranscriber" — so this works whether the user is on the
  //    rebranded build or upgrading from an older one.
  for (const appName of ['MintrEngine', 'MeetingTranscriber']) {
    spawn(
      '/usr/bin/osascript',
      ['-e', `tell application "${appName}" to quit`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  }
  // 2) Hard-kill the bundled binary 250ms later. If the AppleScript
  //    quit landed, this finds no process and is a no-op. If it didn't
  //    (helper was hung, frozen on TCC-denied syscall, etc.), this
  //    guarantees the slot is free so the next startLiveRecorder can
  //    launch a fresh process with current permissions.
  setTimeout(() => {
    killLiveRecorderSync()
  }, 250)
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
