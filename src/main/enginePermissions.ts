/**
 * Cheap read of the engine's own capture-permission health, for the engine-reuse
 * gate (`evaluateEngineReuse` in backend.ts).
 *
 * Reusing a running engine skips a kill + relaunch, but a surviving engine can be
 * sitting on stale-DENIED TCC (macOS caches Screen Recording / Microphone at
 * process launch and never refreshes a running process). Reusing it would keep
 * writing zero audio; the always-safe kill + relaunch re-runs the engine's
 * permission preflight instead. So reuse must first confirm the CAPTURE-critical
 * grants are healthy.
 *
 * Source: the engine's own live health log `permission_health.log` under the
 * Application Support ipc dir — the engine relocated its verdict off the old
 * world-writable `/tmp/mt-permission.log` path (H20). It's the same file
 * `onboarding.ts` reads (there JSON-first with a full precedence chain), but
 * here reduced to a single boolean off one cheap log parse (no `log show`
 * subprocess): the engine writes its `CGPreflightScreenCaptureAccess()` /
 * `AVCaptureDevice` verdict there on every launch + app activation, so the LAST
 * verdict per service reflects the currently-running engine we're deciding
 * whether to reuse. The legacy `/tmp` path is read as a one-release fallback.
 *
 * Scope: gate on Screen Recording + Microphone only — the two capture-critical
 * services. Accessibility (Teams participant reading) is deliberately excluded so
 * reuse still fires for the common case of a user who never granted it.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * The engine's IPC dir under Application Support — the SAME dir the engine's
 * `AppPaths.ipcDir` and `chromeProbe.ENGINE_IPC_DIR` point at. Constructed inline
 * (not imported from chromeProbe) to keep this cheap reuse-gate module out of the
 * backend ↔ onboarding ↔ chromeProbe import cycle.
 */
const ENGINE_IPC_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'MeetingTranscriber',
  'ipc'
)

/**
 * The engine's relocated permission-health log (written by PermissionHealthCheck,
 * 0600). Same append-only verdict-line format as the old `/tmp` file — just moved
 * under Application Support (H20) — so the parser below is unchanged.
 */
const ENGINE_HEALTH_LOG = join(ENGINE_IPC_DIR, 'permission_health.log')

/**
 * Legacy fixed-path verdict log. Read only as a one-release fallback in case an
 * older engine build (still writing `/tmp`) is installed alongside this app.
 */
const LEGACY_TMP_VERDICT = '/tmp/mt-permission.log'

/** The engine's health vocabulary that maps to "granted". */
function verdictIsGranted(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t.includes('healthy') || t.includes('granted') || t.includes('authorized')
}

export interface EngineCaptureHealth {
  screenRecording: boolean
  microphone: boolean
}

/**
 * Pure parse of the engine verdict-file contents into per-service granted
 * booleans. The file is append-only across launches, so we walk top→bottom and let
 * the LAST verdict per service win (freshest = the running engine's). Handles both
 * the per-service `checkScreenRecordingLive: … → <verdict>` /
 * `checkMicrophoneLive: … → <verdict>` lines and the
 * `[PermissionHealthCheck] screen=… mic=… ax=…` summary line. Anything not clearly
 * granted (denied / not-determined / broken / absent) → false.
 */
export function parseEngineCaptureHealth(raw: string): EngineCaptureHealth {
  const health: EngineCaptureHealth = { screenRecording: false, microphone: false }
  if (!raw.trim()) return health
  for (const line of raw.split(/\r?\n/)) {
    const arrow = line.lastIndexOf('→')
    const verdictText = arrow >= 0 ? line.slice(arrow + 1) : line
    if (/checkScreenRecordingLive/i.test(line)) {
      health.screenRecording = verdictIsGranted(verdictText)
    } else if (/checkMicrophoneLive/i.test(line)) {
      health.microphone = verdictIsGranted(verdictText)
    } else if (/\[PermissionHealthCheck\]/.test(line)) {
      const s = /screen=([a-zA-Z-]+)/.exec(line)
      const m = /mic=([a-zA-Z-]+)/.exec(line)
      if (s) health.screenRecording = verdictIsGranted(s[1])
      if (m) health.microphone = verdictIsGranted(m[1])
    }
  }
  return health
}

/** Pure: are BOTH capture-critical services (screen + mic) granted? */
export function engineCaptureHealthy(raw: string): boolean {
  const health = parseEngineCaptureHealth(raw)
  return health.screenRecording && health.microphone
}

/**
 * Read + evaluate the engine's capture-permission health. Returns false when the
 * verdict file is absent/unreadable or the grants aren't clearly healthy — so any
 * doubt declines reuse and falls back to the always-safe relaunch.
 */
export async function readEngineCaptureHealthy(): Promise<boolean> {
  // Prefer the engine's relocated health log; fall back to the legacy /tmp path
  // for one release in case a stale engine build is still installed. Any doubt
  // (every source absent / unreadable / not-clearly-granted) declines reuse and
  // falls back to the always-safe kill + relaunch.
  for (const path of [ENGINE_HEALTH_LOG, LEGACY_TMP_VERDICT]) {
    try {
      const raw = await fs.readFile(path, 'utf-8')
      if (raw.trim()) return engineCaptureHealthy(raw)
    } catch {
      // Source absent/unreadable — try the next one.
    }
  }
  return false
}
