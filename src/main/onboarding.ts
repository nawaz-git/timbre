/**
 * Onboarding main-process surface (TICKET-IPC-002).
 *
 * The onboarding wizard (TICKET-UI-003) needs to query the HELPER's TCC
 * state — `ai.nawaz.mintr-engine`, NOT Mintr's own bundle id. Mintr's
 * `systemPreferences.getMediaAccessStatus(...)` (used by
 * `permissions.ts → getPermissionStatus`) reports the WRONG principal:
 * the engine is the process that actually calls
 * `CGPreflightScreenCaptureAccess()` / `AXIsProcessTrusted()`, so its
 * per-service grants live under its bundle id, invisible to any public
 * Electron/AppKit API (see qa-002-permission-health-check.md §"Can Mintr
 * Pre-Flight Each Required Permission?").
 *
 * We recover the helper's verdict from two read-only sources, in order of
 * authority:
 *
 *   1. The engine's own live verdict file `/tmp/mt-permission.log`. The
 *      engine writes its `CGPreflightScreenCaptureAccess()` /
 *      `AVCaptureDevice.authorizationStatus` / `AXIsProcessTrusted()`
 *      results there as `checkScreenRecordingLive: … → denied` lines plus
 *      a `[PermissionHealthCheck] screen=… mic=… ax=…` summary
 *      (REQ-001 §1 evidence block). This is the MOST authoritative — it's
 *      the engine's live self-assessment — so we prefer it when present.
 *   2. The unified TCC subsystem log filtered to the helper's bundle id,
 *      using the EXACT `log show … subsystem == "com.apple.TCC" AND
 *      eventMessage CONTAINS "ai.nawaz.mintr-engine"` pattern already
 *      proven in `captureWatchdog.ts → classifyHelperFailure`. We parse
 *      the most-recent `Auth Right:` verdict per service.
 *
 * `watchLoopRunning` greps the engine subsystem log (last 60s) for
 * `WatchLoop] Watch mode started` — the log line the engine emits when
 * its watch loop actually starts (qa-eng-001-watchloop-gating.md).
 */
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { shell } from 'electron'
import { openPrivacyPane } from './permissions'
import { forceKillEngine, resolveLiveRecorderApp, startLiveRecorder } from './backend'
import { resetCaptureWatchdog } from './captureWatchdog'
import { confirmIfRecording, isEngineProcessAlive } from './status'
import { writeSettings } from './settings'
import type {
  GrantStatus,
  HelperPermissionSnapshot,
  OnboardingRestartResult,
  OnboardingService,
  OnboardingVerifyResult,
  PrivacyPane
} from '../shared/types'

/** Bundle id of the bundled MintrEngine.app helper (per Info.plist). */
const ENGINE_BUNDLE_ID = 'ai.nawaz.mintr-engine'
/** The engine's live permission-verdict file (REQ-001 §1, qa-002). */
const ENGINE_VERDICT_FILE = '/tmp/mt-permission.log'
/** Per-call timeout for each `log show` invocation. Mirrors captureWatchdog. */
const LOG_SHOW_TIMEOUT_MS = 2500
/** How long verifyEngine polls the engine log for "Watch mode started". */
const VERIFY_TIMEOUT_MS = 8000
/** Poll interval inside verifyEngine. */
const VERIFY_POLL_MS = 1000

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Probe the HELPER's per-service TCC state. Prefers the engine's own
 * `/tmp/mt-permission.log` verdict (most authoritative); falls back to
 * the tccd subsystem log per-service. `watchLoopRunning` comes from the
 * engine subsystem log regardless.
 */
export async function probeHelperPermissions(): Promise<HelperPermissionSnapshot> {
  // Run all reads in parallel — they're independent and each is bounded.
  const [verdict, tccLog, watchLoopRunning] = await Promise.all([
    readEngineVerdictFile(),
    runTccLogShow(),
    probeWatchLoopRunning()
  ])
  const fromTcc = parseTccAuthRights(tccLog)

  // Prefer the engine's live verdict file when it named the service;
  // fall back to the tccd Auth Right verdict otherwise.
  const pick = (
    fromFile: GrantStatus | null,
    fromLog: GrantStatus
  ): GrantStatus => (fromFile !== null ? fromFile : fromLog)

  return {
    screenRecording: pick(verdict.screenRecording, fromTcc.screenRecording),
    microphone: pick(verdict.microphone, fromTcc.microphone),
    accessibility: pick(verdict.accessibility, fromTcc.accessibility),
    watchLoopRunning
  }
}

/**
 * Deep-link System Settings to the privacy pane for `svc`. Reuses
 * `openPrivacyPane()` (permissions.ts) — deep-links are version-
 * independent (qa-version-001) so no macOS-version branching here.
 */
export async function openPane(svc: OnboardingService): Promise<void> {
  await openPrivacyPane(serviceToPane(svc))
}

/**
 * Reveal the bundled MintrEngine.app in Finder so the user can drag it
 * onto a privacy pane's "+" / drop target. Mirrors the existing
 * `system:revealHelper` handler (shell.showItemInFolder on the resolved
 * helper path).
 */
export function revealHelper(): { revealed: boolean; path?: string } {
  const appPath = resolveLiveRecorderApp()
  if (!appPath) return { revealed: false }
  shell.showItemInFolder(appPath)
  return { revealed: true, path: appPath }
}

/**
 * Kill + relaunch the engine so freshly-granted TCC takes effect — macOS
 * does NOT refresh permission state for a running process. Reuses
 * `forceKillEngine()` + `startLiveRecorder()` (backend.ts, the v0.21
 * `/usr/bin/open --args --auto-watch` path). We also reset the capture
 * watchdog first (mirrors `system:restartHelper`) so any stale red banner
 * clears before the respawn.
 */
export async function restartEngine(): Promise<OnboardingRestartResult> {
  // Recording-aware guard: restarting interrupts a live recording. No-op (true)
  // when nothing is recording.
  if (!(await confirmIfRecording('restart'))) {
    return { ok: false, message: 'Cancelled — a meeting is being recorded.' }
  }
  resetCaptureWatchdog()
  forceKillEngine()
  // Tiny pause so the OS reaps the killed PID before `open` tries to
  // reactivate the same bundle id (would no-op otherwise).
  await new Promise((r) => setTimeout(r, 300))
  const result = await startLiveRecorder()
  return { ok: result.ok, message: result.message }
}

/**
 * After a restart, poll the engine subsystem log up to VERIFY_TIMEOUT_MS
 * for `WatchLoop] Watch mode started`. Returns once seen (or on timeout).
 */
export async function verifyEngine(): Promise<OnboardingVerifyResult> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  let lastErr: string | undefined
  while (Date.now() < deadline) {
    const running = await probeWatchLoopRunning()
    if (running) {
      return { watchLoopRunning: true, detail: 'WatchLoop] Watch mode started' }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(VERIFY_POLL_MS, remaining)))
  }
  lastErr = `"Watch mode started" not seen within ${VERIFY_TIMEOUT_MS / 1000}s`
  return { watchLoopRunning: false, detail: lastErr }
}

/** Persist completion — `onboardingCompletedAt = now`. */
export async function markComplete(): Promise<void> {
  await writeSettings({ onboardingCompletedAt: Date.now() })
}

/** Clear completion so the wizard shows again. */
export async function reset(): Promise<void> {
  await writeSettings({ onboardingCompletedAt: undefined })
}

// ─── Source 1: engine verdict file (/tmp/mt-permission.log) ─────────────

interface VerdictFromFile {
  screenRecording: GrantStatus | null
  microphone: GrantStatus | null
  accessibility: GrantStatus | null
}

/**
 * Read + parse the engine's live verdict file. Returns `null` per service
 * when the file is absent or the service wasn't named (so the caller can
 * fall back to the tccd log).
 *
 * Two shapes are handled (REQ-001 §1):
 *   - per-service lines: `checkScreenRecordingLive: … → denied`,
 *     `checkMicrophoneLive: authStatus=authorized → healthy`,
 *     `checkAccessibilityLive: trusted=false → denied`
 *   - summary line: `[PermissionHealthCheck] screen=… mic=… ax=…`
 * Per-service lines win over the summary (more specific); we read the
 * LAST occurrence of each (the file is append-only across launches, so
 * the latest line is the freshest verdict).
 */
async function readEngineVerdictFile(): Promise<VerdictFromFile> {
  const out: VerdictFromFile = {
    screenRecording: null,
    microphone: null,
    accessibility: null
  }
  let raw: string
  try {
    raw = await fsp.readFile(ENGINE_VERDICT_FILE, 'utf-8')
  } catch {
    // Absent / unreadable — caller falls back to tccd log.
    return out
  }
  if (!raw.trim()) return out

  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    // Per-service `checkXLive: … → <verdict>` lines. Take the verdict
    // after the final arrow on the line.
    const arrow = line.lastIndexOf('→')
    const verdictText = arrow >= 0 ? line.slice(arrow + 1) : line

    if (/checkScreenRecordingLive/i.test(line)) {
      const g = mapEngineVerdict(verdictText)
      if (g) out.screenRecording = g
    } else if (/checkMicrophoneLive/i.test(line)) {
      const g = mapEngineVerdict(verdictText)
      if (g) out.microphone = g
    } else if (/checkAccessibilityLive/i.test(line)) {
      const g = mapEngineVerdict(verdictText)
      if (g) out.accessibility = g
    } else if (/\[PermissionHealthCheck\]/.test(line)) {
      // Summary: `screen=healthy mic=healthy ax=denied`. Only fill a
      // service the more-specific per-service lines didn't already set.
      const screen = matchKV(line, /screen=([a-zA-Z-]+)/)
      const mic = matchKV(line, /mic=([a-zA-Z-]+)/)
      const ax = matchKV(line, /ax=([a-zA-Z-]+)/)
      if (out.screenRecording === null && screen) out.screenRecording = mapEngineVerdict(screen)
      if (out.microphone === null && mic) out.microphone = mapEngineVerdict(mic)
      if (out.accessibility === null && ax) out.accessibility = mapEngineVerdict(ax)
    }
  }
  return out
}

function matchKV(line: string, re: RegExp): string | null {
  const m = re.exec(line)
  return m ? m[1] : null
}

/**
 * Map the engine's health vocabulary to our GrantStatus.
 *   healthy        → granted
 *   denied         → denied
 *   notDetermined  → not-determined
 *   (anything else → null, so we fall back to the tccd log)
 */
function mapEngineVerdict(text: string): GrantStatus | null {
  const t = text.trim().toLowerCase()
  if (t.includes('healthy') || t.includes('granted') || t.includes('authorized')) {
    return 'granted'
  }
  if (t.includes('notdetermined') || t.includes('not-determined') || t.includes('not determined')) {
    return 'not-determined'
  }
  if (t.includes('denied') || t.includes('restricted') || t.includes('broken')) {
    return 'denied'
  }
  return null
}

// ─── Source 2: tccd subsystem log (Auth Right per service) ──────────────

interface VerdictFromTcc {
  screenRecording: GrantStatus
  microphone: GrantStatus
  accessibility: GrantStatus
}

/**
 * Parse the most-recent `Auth Right:` verdict per service out of the
 * tccd subsystem log. Each TCC log block names a service
 * (`kTCCServiceScreenCapture` / `kTCCServiceMicrophone` /
 * `kTCCServiceAccessibility`) and an `Auth Right:` verdict:
 *   `Allowed (System Set)` / `Allowed (User Consent)` → granted
 *   `Denied`                                          → denied
 *   `Unknown (None)`                                  → not-determined
 *   no entry for the service                          → unknown
 *
 * The log is chronological; later lines override earlier ones, so we
 * walk top→bottom and let the last verdict per service win.
 */
function parseTccAuthRights(logText: string): VerdictFromTcc {
  const out: VerdictFromTcc = {
    screenRecording: 'unknown',
    microphone: 'unknown',
    accessibility: 'unknown'
  }
  if (!logText.trim()) return out

  const lines = logText.split(/\r?\n/)
  // Track the most-recent service mentioned so an `Auth Right:` line on a
  // following line attributes to the right service.
  let currentService: keyof VerdictFromTcc | null = null
  for (const line of lines) {
    const svc = serviceFromTccLine(line)
    if (svc) currentService = svc

    const authIdx = line.indexOf('Auth Right:')
    if (authIdx >= 0 && currentService) {
      const verdict = mapAuthRight(line.slice(authIdx + 'Auth Right:'.length))
      if (verdict) out[currentService] = verdict
    }
  }
  return out
}

function serviceFromTccLine(line: string): keyof VerdictFromTcc | null {
  if (line.includes('kTCCServiceScreenCapture')) return 'screenRecording'
  if (line.includes('kTCCServiceMicrophone')) return 'microphone'
  if (line.includes('kTCCServiceAccessibility')) return 'accessibility'
  return null
}

function mapAuthRight(text: string): GrantStatus | null {
  const t = text.trim()
  if (/Allowed/i.test(t)) return 'granted'
  if (/Denied/i.test(t)) return 'denied'
  if (/Unknown/i.test(t)) return 'not-determined'
  return null
}

/**
 * Read the tccd subsystem log for the helper's bundle id. Reuses the
 * EXACT predicate proven in `captureWatchdog.ts → classifyHelperFailure`.
 * A 15s window is enough — tccd re-emits a verdict block on each
 * preflight, and the engine preflights on every launch.
 */
function runTccLogShow(): Promise<string> {
  return runLogShow([
    'show',
    '--last',
    '15s',
    '--predicate',
    `subsystem == "com.apple.TCC" AND eventMessage CONTAINS "${ENGINE_BUNDLE_ID}"`,
    '--info'
  ])
}

// ─── watchLoopRunning ───────────────────────────────────────────────────

/**
 * How long a confirmed watch-loop "seen" stays trusted while the engine
 * process is still alive. The engine logs "Watch mode started" exactly ONCE
 * per launch, so the 60s log window ages it out long before the loop stops —
 * which made the wizard flap back to "restart the engine" even though nothing
 * changed. We remember the last positive and keep trusting it as long as the
 * engine is actually running.
 */
const WATCHLOOP_TRUST_MS = 30 * 60_000

/** Wall-clock ms of the last confirmed "Watch mode started", or null. */
let watchLoopSeenAt: number | null = null

/**
 * Grep the engine subsystem log (last 60s) for `WatchLoop] Watch mode
 * started` — the line the engine emits when its watch loop actually
 * starts (qa-eng-001-watchloop-gating.md). We match on `process ==
 * "MintrEngine"` (same attribution captureWatchdog uses for pass A).
 *
 * The raw log line ages out of the 60s window while the loop keeps running,
 * so a fresh positive is cached: once seen, we report running for up to
 * WATCHLOOP_TRUST_MS as long as the engine process is still alive (`pgrep`).
 * This removes the regression where a healthy, unchanged setup kept nagging
 * the user to restart the engine every minute.
 */
async function probeWatchLoopRunning(): Promise<boolean> {
  const out = await runLogShow([
    'show',
    '--last',
    '60s',
    '--predicate',
    'process == "MintrEngine"',
    '--info'
  ])
  if (out.includes('WatchLoop] Watch mode started')) {
    watchLoopSeenAt = Date.now()
    return true
  }
  // Sticky fallback: trust a recent positive while the engine is still up.
  if (
    watchLoopSeenAt !== null &&
    Date.now() - watchLoopSeenAt < WATCHLOOP_TRUST_MS &&
    isEngineProcessAlive()
  ) {
    return true
  }
  return false
}

// ─── shared `log show` runner (mirrors captureWatchdog.runLogShow) ──────

/**
 * Runs `/usr/bin/log` with the supplied args, capped at
 * `LOG_SHOW_TIMEOUT_MS`. Always resolves (never rejects) — returns the
 * captured stdout or empty string on any error. Mirrors the proven
 * helper in `captureWatchdog.ts`.
 */
function runLogShow(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/log',
      args,
      { timeout: LOG_SHOW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve('')
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}

// ─── service → privacy-pane mapping ─────────────────────────────────────

function serviceToPane(svc: OnboardingService): PrivacyPane {
  switch (svc) {
    case 'screen-recording':
      return 'screen-recording'
    case 'microphone':
      return 'microphone'
    case 'accessibility':
      return 'accessibility'
  }
}
