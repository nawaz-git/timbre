/**
 * macOS TCC permission queries.
 *
 * The Swift engine (bundled MeetingTranscriber.app) is the *actual* TCC
 * principal — `CGWindowListCopyWindowInfo` runs inside that helper, so
 * Screen Recording is checked against its bundle id, not Mintr's. But the
 * Electron host can still ask `systemPreferences` for screen capture access
 * because Electron itself ALSO needs it if we ever want to render a live
 * waveform from the system mic (future), and crucially: when an Electron
 * app calls `systemPreferences.getMediaAccessStatus('screen')`, macOS
 * answers based on which TCC entries exist for ANY launched-from-here
 * binaries. If the user already granted the helper, Electron's query may
 * still say `denied` for Mintr itself, which is fine — we surface both
 * states and prompt the user to grant whichever is missing.
 *
 * Microphone is queried via the same `getMediaAccessStatus('microphone')`
 * API. Automation (AppleScript→Chrome) has no pre-flight query — we mark
 * it `not-determined` until `chromeProbe.ts` actually runs osascript and
 * either succeeds or returns a TCC error in stderr.
 */
import { shell, systemPreferences } from 'electron'
import type { PermissionState, PermissionStatus, PrivacyPane } from '../shared/types'

/**
 * Map Electron's `MediaAccessStatus` values onto our app-level
 * `PermissionState`. Electron returns `'granted' | 'not-determined' |
 * 'denied' | 'restricted' | 'unknown'`. We collapse `restricted` and
 * `unknown` to `denied` for UX — both mean the app cannot use the
 * capability and the user has to take action.
 */
function fromMediaAccess(s: string): PermissionState {
  switch (s) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'denied'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unknown'
  }
}

/**
 * Last result of the AppleScript probe — written from `chromeProbe.ts` so
 * the permissions UI can reflect Automation grant state without us having
 * to call osascript a second time. Default 'not-determined' until the
 * probe has had a chance to run.
 */
let automationChromeState: PermissionState = 'not-determined'

export function setAutomationChromeState(s: PermissionState): void {
  automationChromeState = s
}

export function getAutomationChromeState(): PermissionState {
  return automationChromeState
}

export function getPermissionStatus(): PermissionStatus {
  if (process.platform !== 'darwin') {
    // On non-Mac platforms we don't need these — return granted so the UI
    // doesn't show warnings on Linux dev builds.
    return {
      screenRecording: 'granted',
      microphone: 'granted',
      automationChrome: 'granted'
    }
  }
  return {
    screenRecording: fromMediaAccess(systemPreferences.getMediaAccessStatus('screen')),
    microphone: fromMediaAccess(systemPreferences.getMediaAccessStatus('microphone')),
    automationChrome: automationChromeState
  }
}

/**
 * Deep-links into the System Settings privacy pane the user needs to
 * grant. Uses the `x-apple.systempreferences:` URL scheme — works back
 * to macOS Big Sur and through Sequoia. On macOS Sequoia (15+) Settings.app
 * accepts these URLs without any extra prompt.
 *
 * If the URL fails (older macOS without that anchor), we fall back to
 * opening the top-level Privacy & Security pane and the user navigates.
 */
export async function openPrivacyPane(pane: PrivacyPane): Promise<void> {
  if (process.platform !== 'darwin') return
  const url = paneURL(pane)
  try {
    await shell.openExternal(url)
  } catch (err) {
    console.error('[permissions] openExternal failed for', url, err)
    // Fallback: open the privacy root.
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy'
    )
  }
}

function paneURL(pane: PrivacyPane): string {
  switch (pane) {
    case 'screen-recording':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    case 'microphone':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    case 'automation':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
    case 'accessibility':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  }
}
