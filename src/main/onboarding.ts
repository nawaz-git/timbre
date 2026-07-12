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
 * We recover the helper's verdict from read-only sources, in order of
 * authority:
 *
 *   1. The engine's structured verdict JSON (`permission_verdict.json` under
 *      the Application Support ipc dir) — the engine's live self-assessment,
 *      written atomically with an `updatedAt` stamp. Preferred when fresh
 *      (ignored when older than 10 min so a stale verdict can't mask reality).
 *      Also carries the engine's notification-auth status.
 *   2. The engine's health log (`permission_health.log`, same dir) — the same
 *      `checkScreenRecordingLive: … → denied` / `[PermissionHealthCheck]
 *      screen=… mic=… ax=…` lines the engine appends. Used when the JSON is
 *      absent/stale. A legacy `/tmp/mt-permission.log` is read as a last-ditch
 *      fallback for one release (older engine builds still write it).
 *   3. The unified TCC subsystem log filtered to the helper's bundle id,
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
import { join } from 'path'
import { shell } from 'electron'
import { openPrivacyPane } from './permissions'
import { ENGINE_IPC_DIR } from './chromeProbe'
import { forceKillEngine, resolveLiveRecorderApp, startLiveRecorder } from './backend'
import { resetCaptureWatchdog } from './captureWatchdog'
import { confirmIfRecording, isEngineProcessAlive } from './status'
import { writeSettings } from './settings'
import type {
  GrantStatus,
  HelperPermissionSnapshot,
  NotificationAuthStatus,
  OnboardingRestartResult,
  OnboardingService,
  OnboardingVerifyResult,
  PrivacyPane
} from '../shared/types'

/** Bundle id of the bundled MintrEngine.app helper (per Info.plist). */
const ENGINE_BUNDLE_ID = 'ai.nawaz.mintr-engine'
/**
 * The engine's structured permission verdict — the primary, most-authoritative
 * source. JSON under the Application Support ipc dir (same dir as
 * `active_meeting.json`), written atomically by the engine, staleness-gated
 * (ignored when older than VERDICT_JSON_MAX_AGE_MS).
 */
const ENGINE_VERDICT_JSON = join(ENGINE_IPC_DIR, 'permission_verdict.json')
/** The engine's health log (verdict lines) — fallback when the JSON is absent/stale. */
const ENGINE_HEALTH_LOG = join(ENGINE_IPC_DIR, 'permission_health.log')
/**
 * Legacy fixed-path verdict log. Read only as a last-ditch fallback for one
 * release, in case an older engine build (still writing /tmp) is installed.
 */
const LEGACY_TMP_VERDICT = '/tmp/mt-permission.log'
/** A verdict JSON older than this is treated as stale and ignored. */
const VERDICT_JSON_MAX_AGE_MS = 10 * 60_000
/**
 * A health log whose last write (mtime) is older than this is treated as stale
 * and ignored, mirroring the JSON's gate. Without it the retained
 * `permission_health.log` — which has no internal timestamp — would win over
 * live tccd forever, self-latching a stale verdict (stuck-denied during
 * onboarding, or stale-granted masking a dead/revoked engine).
 */
const VERDICT_LOG_MAX_AGE_MS = 10 * 60_000
/** Per-call timeout for each `log show` invocation. Mirrors captureWatchdog. */
const LOG_SHOW_TIMEOUT_MS = 2500
/** How long verifyEngine polls the engine log for "Watch mode started". */
const VERIFY_TIMEOUT_MS = 8000
/** Poll interval inside verifyEngine. */
const VERIFY_POLL_MS = 1000

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Probe the HELPER's per-service TCC state. Precedence per service:
 *   1. the engine's fresh structured verdict JSON (most authoritative)
 *   2. the engine's health log (new path, then the legacy /tmp fallback)
 *   3. the tccd subsystem log's Auth Right verdict
 * `broken` from the engine collapses to `denied`. `watchLoopRunning` and the
 * notification-auth status come from the engine regardless.
 */
export async function probeHelperPermissions(): Promise<HelperPermissionSnapshot> {
  // Run all reads in parallel — they're independent and each is bounded.
  const [json, logVerdict, tccLog, watchLoopRunning] = await Promise.all([
    readVerdictJson(),
    readVerdictLog(),
    runTccLogShow(),
    probeWatchLoopRunning()
  ])
  const fromTcc = parseTccAuthRights(tccLog)

  return {
    screenRecording: resolveGrant(
      json?.verdict.screenRecording ?? null,
      logVerdict.screenRecording,
      fromTcc.screenRecording
    ),
    microphone: resolveGrant(
      json?.verdict.microphone ?? null,
      logVerdict.microphone,
      fromTcc.microphone
    ),
    accessibility: resolveGrant(
      json?.verdict.accessibility ?? null,
      logVerdict.accessibility,
      fromTcc.accessibility
    ),
    watchLoopRunning,
    ...(json?.notifications ? { notifications: json.notifications } : {})
  }
}

/**
 * Precedence resolver for a single service's grant: a fresh JSON verdict wins,
 * else the log-file verdict, else the tccd Auth Right. Pure — unit-tested.
 */
export function resolveGrant(
  fromJson: GrantStatus | null,
  fromLog: GrantStatus | null,
  fromTcc: GrantStatus
): GrantStatus {
  return fromJson ?? fromLog ?? fromTcc
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

// ─── Sources 1 & 2: engine verdict JSON + health log ───────────────────

interface VerdictFromFile {
  screenRecording: GrantStatus | null
  microphone: GrantStatus | null
  accessibility: GrantStatus | null
}

/**
 * Parse the engine's health-log text into a per-service verdict. Returns `null`
 * per service when the service wasn't named (so the caller falls back).
 *
 * Two shapes are handled:
 *   - per-service lines: `checkScreenRecordingLive: … → denied`,
 *     `checkMicrophoneLive: authStatus=authorized → healthy`,
 *     `checkAccessibilityLive: trusted=false → denied`
 *   - summary line: `[PermissionHealthCheck] screen=… mic=… ax=…`
 * Per-service lines win over the summary (more specific); we read the LAST
 * occurrence of each (the log is append-only, so the latest is freshest).
 */
export function parseVerdictLog(raw: string): VerdictFromFile {
  const out: VerdictFromFile = {
    screenRecording: null,
    microphone: null,
    accessibility: null
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

/**
 * Whether a health-log file last written at `mtimeMs` is still fresh enough to
 * trust over live tccd. Pure — mirrors parseVerdictJson's staleness gate so a
 * dead/idle engine's retained log can't self-latch a stale verdict.
 */
export function isVerdictLogFresh(
  mtimeMs: number,
  nowMs: number,
  maxAgeMs = VERDICT_LOG_MAX_AGE_MS
): boolean {
  return nowMs - mtimeMs <= maxAgeMs
}

/**
 * Read the engine's health log — the new Application Support path first, then
 * the legacy `/tmp` path (one-release transition). Returns the first source
 * that is FRESH (per its mtime) and named at least one service; all-null when
 * neither exists or both are stale. Skipping a stale log lets the caller fall
 * through to live tccd instead of latching a verdict the engine last wrote
 * long ago.
 */
async function readVerdictLog(): Promise<VerdictFromFile> {
  const nowMs = Date.now()
  for (const path of [ENGINE_HEALTH_LOG, LEGACY_TMP_VERDICT]) {
    let raw: string
    let mtimeMs: number
    try {
      // stat before parse: a log whose last write predates the staleness gate
      // can't out-rank live tccd (the engine may be dead or its grant revoked).
      mtimeMs = (await fsp.stat(path)).mtimeMs
      raw = await fsp.readFile(path, 'utf-8')
    } catch {
      continue
    }
    if (!isVerdictLogFresh(mtimeMs, nowMs)) continue
    const parsed = parseVerdictLog(raw)
    if (parsed.screenRecording || parsed.microphone || parsed.accessibility) {
      return parsed
    }
  }
  return { screenRecording: null, microphone: null, accessibility: null }
}

/**
 * Read + parse the engine's structured verdict JSON. Returns null when the file
 * is absent or the payload is unparseable/stale (see parseVerdictJson).
 */
async function readVerdictJson(): Promise<
  { verdict: VerdictFromFile; notifications?: NotificationAuthStatus } | null
> {
  let raw: string
  try {
    raw = await fsp.readFile(ENGINE_VERDICT_JSON, 'utf-8')
  } catch {
    return null
  }
  return parseVerdictJson(raw, Date.now())
}

/**
 * Parse the engine verdict JSON `{ screen, mic, ax, notifications, updatedAt }`.
 * Returns null (caller falls back to the log / tccd) when the payload is
 * unparseable, lacks `updatedAt`, or is STALE (older than `maxAgeMs`) — a stale
 * verdict must never mask the live tccd state. `broken` collapses to `denied`
 * via mapEngineVerdict. Pure — unit-tested for precedence + staleness.
 */
export function parseVerdictJson(
  raw: string,
  nowMs: number,
  maxAgeMs = VERDICT_JSON_MAX_AGE_MS
): { verdict: VerdictFromFile; notifications?: NotificationAuthStatus } | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const rec = obj as Record<string, unknown>
  const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : null
  if (updatedAt === null || nowMs - updatedAt > maxAgeMs) return null
  const verdict: VerdictFromFile = {
    screenRecording: typeof rec.screen === 'string' ? mapEngineVerdict(rec.screen) : null,
    microphone: typeof rec.mic === 'string' ? mapEngineVerdict(rec.mic) : null,
    accessibility: typeof rec.ax === 'string' ? mapEngineVerdict(rec.ax) : null
  }
  const notifications = mapNotifications(rec.notifications)
  return notifications ? { verdict, notifications } : { verdict }
}

/** Map the engine's notification-auth wire value to our NotificationAuthStatus. */
function mapNotifications(v: unknown): NotificationAuthStatus | undefined {
  if (v === 'authorized') return 'authorized'
  if (v === 'denied') return 'denied'
  if (v === 'provisional') return 'provisional'
  if (v === 'notDetermined' || v === 'not-determined') return 'not-determined'
  return undefined
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
 *
 * Accepted limitation: the engine only logs "Watch mode started" on (re)start,
 * never periodically, so the sticky window is the ONLY thing keeping a long
 * healthy session green. That means a watch loop that dies while its process
 * stays alive (a hang) is trusted for up to WATCHLOOP_TRUST_MS. Shortening the
 * trust would just reintroduce the flapping for healthy sessions; a clean fix
 * needs an engine-side periodic liveness signal (out of scope here).
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
