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
 * Resolve the path to the bundled meeting-transcriber.app for live recording.
 * Returns `null` when the bundle isn't present — Live recording falls back to
 * a friendly error message in that case.
 */
export function resolveLiveRecorderApp(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'MeetingTranscriber.app')]
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
  // Second: belt-and-suspenders pkill of every MeetingTranscriber binary
  // path on the system. Match the BINARY name inside the .app bundle —
  // any other process named that exactly is going to be a copy of our
  // engine. We intentionally don't constrain to a path prefix here so a
  // standalone install that's stealing our slot via LaunchServices still
  // gets cleaned up.
  try {
    const result = spawnSync(
      '/usr/bin/pkill',
      ['-f', 'MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    if (result.status === 0) killed += 1
  } catch (err) {
    console.warn('[live-recorder] pkill failed', err)
  }
  liveProcess = null
  return { killed }
}

/**
 * Spawn the bundled MeetingTranscriber helper.
 *
 * Critical implementation detail: we `spawn` the helper's binary
 * DIRECTLY at its exact bundled path, rather than going through
 * `/usr/bin/open` (which dispatches via LaunchServices). LaunchServices
 * dedups apps by bundle id — and if the user happens to have a
 * separate `MeetingTranscriber.app` installed in `/Applications` (e.g.
 * a leftover from before Mintr was created), both copies register the
 * same `com.meetingtranscriber.app` bundle id and LaunchServices can
 * silently launch the wrong binary. Confirmed bug in v0.12-v0.14:
 *
 *   `ps -ef` showed
 *     /Applications/MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber
 *   running when we asked it to launch
 *     /Applications/Mintr.app/Contents/Resources/MeetingTranscriber.app/...
 *
 * Spawning the inner binary directly via `spawn(execPath, [])` bypasses
 * LaunchServices entirely. macOS launches THAT exact Mach-O at THAT
 * exact path with no dedup. TCC still applies (entries keyed by bundle
 * id), and the kernel records the running binary's path against the
 * TCC bookmark — so the user's "MeetingTranscriber" Screen Recording
 * entry only matches when its stored path bookmark equals the bundled
 * helper path.
 *
 * Side benefit: we get a real PID we can `kill` directly. The old
 * `open`-then-detach pattern left us no handle on the actual helper.
 *
 * v0.14+: always force-kills any existing helper first so the new
 * launch picks up freshly-granted TCC. The `isLiveActive()` short-circuit
 * was removed — it papered over the stale-PID bug.
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
        'Live recording engine not bundled. Install MeetingTranscriber.app or rebuild the DMG with the bundled engine.'
    }
  }

  // Step 1: kill any stale instance. macOS won't refresh a running
  // process's TCC entries, so a 4-hour-old helper that booted before
  // permission was granted is dead weight — silently failing to read
  // window titles for as long as it lives.
  killLiveRecorderSync()

  // Step 2: resolve the inner Mach-O binary inside the .app bundle.
  // For `Foo.app` the executable lives at `Foo.app/Contents/MacOS/<exec>`
  // where `<exec>` is whatever the bundle's Info.plist sets
  // CFBundleExecutable to (defaulting to the bundle's basename).
  const execName = appPath.split('/').pop()?.replace(/\.app$/, '') ?? 'MeetingTranscriber'
  const execPath = join(appPath, 'Contents', 'MacOS', execName)
  if (!existsSync(execPath)) {
    return {
      ok: false,
      message: `Helper binary not found at ${execPath}`
    }
  }

  // Step 3: launch the binary directly — NO `open`, NO LaunchServices.
  //
  // v0.18+: critical tweaks vs v0.15-v0.17.
  //
  // `detached: true`: makes the helper its own session-group leader,
  // severing the macOS process-responsibility chain to Mintr. Otherwise
  // TCC requests from the helper get attributed to Mintr's bundle id
  // (which lacks Accessibility / certain entitlements), the helper's
  // internal PermissionHealthCheck fails, and WatchLoop never starts —
  // confirmed via unified-log diff between Mintr-spawned (PID 31443:
  // PermissionHealthCheck failed, no WatchLoop) vs shell-spawned
  // (PID 32837: WatchLoop started cleanly).
  //
  // `env`: a deliberately *small* environment instead of inheriting
  // process.env wholesale. Electron sets ELECTRON_RUN_AS_NODE,
  // ELECTRON_NO_ATTACH_CONSOLE, NODE_OPTIONS, dyld interposer paths,
  // Vite dev-server vars, etc. Any of these can change the helper's
  // behaviour (AppKit assertion modes, dyld load behaviour). The helper
  // only needs PATH, HOME, USER, TMPDIR to do its job — keep it minimal.
  //
  // `child.unref()`: lets Mintr exit cleanly even if the helper is still
  // alive. We then cull stale helpers on the next Mintr launch via
  // `killLiveRecorderSync()` (which already runs at startup), so we
  // don't leak zombies across sessions.
  const child = spawn(execPath, [], {
    cwd: appPath,
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

  liveProcess = child
  return { ok: true, appPath: execPath }
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
  //    and write its trailing transcript/metadata.
  spawn('/usr/bin/osascript', ['-e', 'tell application "MeetingTranscriber" to quit'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
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
