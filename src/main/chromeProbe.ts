/**
 * Chrome / Chromium-family tab probe via AppleScript.
 *
 * The Swift engine's window-title detector only fires AFTER the user
 * clicks "Join" — that's when Chrome rewrites the window title from the
 * lobby-screen "Meet" placeholder to "Meet - <meeting-id>". Worse, on
 * older macOS the title can take seconds to update, so the engine misses
 * the start of a meeting if Mintr was launched after the tab opened.
 *
 * This probe reads Chrome's open-tab URL list directly via
 * `osascript`, which works because Chromium browsers expose a scripting
 * dictionary with `tabs of windows`. We poll every 3 seconds when
 * Mintr is in `watching` state, look for any URL matching
 * `https://meet.google.com/<short-id>`, and surface the most recent
 * match to the renderer (Home view live card) and the tray.
 *
 * Supported browsers: Google Chrome, Microsoft Edge, Brave, Arc (the
 * Browser Company), Vivaldi. Safari uses a different scripting model
 * (URLs are exposed on tabs but the application id differs) — handled
 * in a separate branch.
 *
 * Permission model: AppleScript→Chrome requires Automation consent (TCC,
 * `com.google.Chrome` entry under "Allow Mintr to control Chrome").
 * macOS only prompts on the FIRST osascript call that touches Chrome.
 * Once the user has answered (grant or deny), we cache the result and
 * stop spamming them.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import type { ChromeMeetSnapshot, ChromeMeetTab } from '../shared/types'
import { setAutomationChromeState } from './permissions'

const execFileP = promisify(execFile)

/**
 * Bridge the reliable Electron Chrome detection to the engine. The engine's
 * own window-title detector (CGWindowList) only sees the FRONTMOST Chrome
 * tab, so a Meet running in a background tab/window — or while the user looks
 * at another app — is invisible to it and never gets recorded. This probe,
 * by contrast, reads ALL tabs by URL regardless of focus, so we hand the
 * engine that reliable signal: a small JSON file the engine's
 * `ElectronSignalDetector` reads and turns into a recording. We refresh
 * `updatedAt` every tick (heartbeat, so the engine can treat a stale file as
 * gone if Mintr quits) and delete it when no Meet is open.
 */
const ENGINE_IPC_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'MeetingTranscriber',
  'ipc'
)
const ACTIVE_MEETING_SIGNAL = join(ENGINE_IPC_DIR, 'active_meeting.json')

async function writeActiveMeetingSignal(tab: ChromeMeetTab | null): Promise<void> {
  try {
    if (!tab) {
      await fsp.rm(ACTIVE_MEETING_SIGNAL, { force: true })
      return
    }
    await fsp.mkdir(ENGINE_IPC_DIR, { recursive: true })
    const payload = JSON.stringify({
      meetingId: tab.meetingId,
      title: `${tab.meetingId} - Google Meet`,
      browserBundleId: tab.browser,
      url: tab.url,
      updatedAt: Date.now()
    })
    const tmp = `${ACTIVE_MEETING_SIGNAL}.tmp`
    await fsp.writeFile(tmp, payload, 'utf-8')
    await fsp.rename(tmp, ACTIVE_MEETING_SIGNAL)
  } catch {
    // Best-effort — a failed signal write must never break the probe loop.
  }
}

/**
 * Browsers we know how to probe, in priority order. The AppleScript
 * application name on the left, the bundle id on the right (the bundle
 * id is what the user sees in the System Settings → Automation pane).
 *
 * Brave / Edge / Vivaldi / Arc all inherit Chrome's scripting dictionary
 * so the same `tabs of windows` traversal works for each. Arc uses the
 * application name "Arc" but emits TCC under `company.thebrowser.Browser`.
 */
const CHROMIUM_BROWSERS: ReadonlyArray<{ appName: string; bundleId: string }> = [
  { appName: 'Google Chrome', bundleId: 'com.google.Chrome' },
  { appName: 'Brave Browser', bundleId: 'com.brave.Browser' },
  { appName: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
  { appName: 'Arc', bundleId: 'company.thebrowser.Browser' },
  { appName: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi' }
]

/**
 * The Meet URL pattern. Google Meet ids are three groups of lowercase
 * letters separated by hyphens (e.g. `ntu-vwcf-onr`), occasionally with
 * a trailing query string for entry-codes. Anchored to the path root so
 * `meet.google.com/landing` or `meet.google.com/_meet/...` (the
 * marketing pages) don't match.
 */
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})\b/i

interface InternalState {
  snapshot: ChromeMeetSnapshot
  timer: NodeJS.Timeout | null
  /** True while we're in the middle of an osascript call. Prevents overlapping calls
   *  if the previous one is slow. */
  busy: boolean
}

const state: InternalState = {
  snapshot: { available: false, tab: null },
  timer: null,
  busy: false
}

export function getChromeMeetSnapshot(): ChromeMeetSnapshot {
  return state.snapshot
}

/**
 * Begin polling. Called when the engine moves into `watching` or
 * `recording` state, and stopped when it returns to `idle`. Safe to
 * call multiple times — idempotent.
 */
export function startChromeProbe(intervalMs = 3000): void {
  if (process.platform !== 'darwin') return
  if (state.timer) return
  // First tick fires immediately so the UI doesn't have to wait 3s.
  void tick()
  state.timer = setInterval(() => {
    void tick()
  }, intervalMs)
}

export function stopChromeProbe(): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  // Engine is no longer watching — remove the signal so a stale file can't
  // trigger a recording later.
  void writeActiveMeetingSignal(null)
}

async function tick(): Promise<void> {
  if (state.busy) return
  state.busy = true
  try {
    const tab = await findFirstMeetTab()
    updateSnapshot({ available: true, tab })
    // Refresh (or clear) the engine signal every tick so it acts as a
    // heartbeat the engine can age out if Mintr stops updating it.
    await writeActiveMeetingSignal(tab)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // osascript exit codes:
    //   -1743 — user has not granted automation permission yet (TCC denied)
    //    -600 — application isn't running (silently treat as "no tabs")
    //   -1728 — application doesn't expose scripting (treat as "no tabs")
    if (/-1743|not allowed assistive|not authorized/i.test(msg)) {
      setAutomationChromeState('denied')
      updateSnapshot({ available: false, error: 'Automation permission denied', tab: null })
    } else {
      updateSnapshot({ available: false, error: msg, tab: null })
    }
    // Can't confirm a meeting this tick — clear the signal so the engine
    // doesn't record against a detection we can no longer verify.
    await writeActiveMeetingSignal(null)
  } finally {
    state.busy = false
  }
}

/**
 * Iterate browsers in priority order, asking each for its open tab URLs.
 * Returns the first Meet URL we find, or null. Skips silently when a
 * browser isn't running.
 */
async function findFirstMeetTab(): Promise<ChromeMeetTab | null> {
  for (const browser of CHROMIUM_BROWSERS) {
    if (!(await isAppRunning(browser.appName))) continue
    const urls = await fetchUrls(browser.appName).catch(() => [] as string[])
    if (urls.length === 0) continue
    for (const raw of urls) {
      const m = MEET_URL_RE.exec(raw)
      if (m) {
        // We made it through at least one successful osascript call —
        // means the user has granted Automation for this browser.
        setAutomationChromeState('granted')
        return {
          browser: browser.bundleId,
          url: m[0],
          meetingId: m[1].toLowerCase()
        }
      }
    }
    // If we got URLs back, Automation works — even if no Meet tab is
    // open. Mark as granted so the UI stops showing "Automation needed".
    setAutomationChromeState('granted')
  }
  return null
}

/**
 * Cheap check: does `<App> is running` come back true from System Events?
 * Without this we'd spam every browser with an osascript call even when
 * none of them are open, and each call costs ~30ms.
 */
async function isAppRunning(appName: string): Promise<boolean> {
  const script = `tell application "System Events" to (name of processes) contains "${escapeAppleScriptString(appName)}"`
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script], {
      timeout: 1500
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Pull every tab URL from the named browser. Returns an empty array if
 * the app refused or threw. We deliberately do NOT use `try ... end try`
 * inside the AppleScript — we want errors to surface as a non-zero exit
 * so the caller can mark Automation as denied.
 */
async function fetchUrls(appName: string): Promise<string[]> {
  // Two-line AppleScript:
  //   1) collect URLs into a list
  //   2) coerce the list to a newline-delimited string (using a known
  //      delimiter so URLs with commas / spaces don't get tangled)
  const script = [
    `tell application "${escapeAppleScriptString(appName)}"`,
    '  set urls to {}',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      set end of urls to URL of t',
    '    end repeat',
    '  end repeat',
    '  set AppleScript\'s text item delimiters to linefeed',
    '  return urls as text',
    'end tell'
  ].join('\n')
  const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script], {
    timeout: 2500,
    maxBuffer: 512 * 1024
  })
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Push a new snapshot into state and notify any renderer windows. The
 * push channel `chrome-meet:update` is a one-way notification — the
 * renderer also has a pull-style getter (`window.api.system.chromeMeet`)
 * for initial state on mount.
 */
function updateSnapshot(next: ChromeMeetSnapshot): void {
  const prev = state.snapshot
  state.snapshot = next
  // Skip notification if nothing meaningful changed — keeps the renderer
  // from re-rendering every 3s when nothing's happening.
  if (
    prev.available === next.available &&
    prev.error === next.error &&
    prev.tab?.url === next.tab?.url
  ) {
    return
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('chrome-meet:update', next)
    }
  }
}
