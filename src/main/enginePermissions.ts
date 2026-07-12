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
 * Source: the engine's own live verdict file `/tmp/mt-permission.log` — the same
 * file `onboarding.ts` reads, but here reduced to a single boolean. It is the
 * cheapest robust signal (one file read, no `log show` subprocess): the engine
 * writes its `CGPreflightScreenCaptureAccess()` / `AVCaptureDevice` verdict there
 * on every launch + app activation, so the LAST verdict per service reflects the
 * currently-running engine we're deciding whether to reuse.
 *
 * Scope: gate on Screen Recording + Microphone only — the two capture-critical
 * services. Accessibility (Teams participant reading) is deliberately excluded so
 * reuse still fires for the common case of a user who never granted it.
 */
import { promises as fs } from 'fs'

/** The engine's live permission-verdict file (written by PermissionHealthCheck). */
const ENGINE_VERDICT_FILE = '/tmp/mt-permission.log'

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
  try {
    const raw = await fs.readFile(ENGINE_VERDICT_FILE, 'utf-8')
    return engineCaptureHealthy(raw)
  } catch {
    return false
  }
}
