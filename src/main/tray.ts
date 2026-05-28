/**
 * macOS menubar tray — always-on background presence for Mintr.
 *
 * What problem does this solve? Before v0.12 the only feedback the user
 * got that Mintr was watching for meetings was a status text on the Home
 * view, which is invisible the moment they close the window or alt-tab
 * away. They could (and did) walk into a Google Meet thinking Mintr was
 * capturing, only to find nothing in the Meetings tab afterwards.
 *
 * The tray gives them a persistent, always-visible status surface plus
 * one-click controls — Pause, Resume, Show Mintr, Open System Settings
 * (when a permission is denied), Quit. Modeled after Tailscale, ProtonVPN,
 * Bartender — same affordance, same mental model.
 *
 * Implementation:
 *   - One Electron Tray with a 22pt PNG of the Mintr leaf (colored, not
 *     a template — we want the brand visible like Slack/Spotify/Tailscale
 *     do, not blend in like a system utility).
 *   - State is derived from three sources: recording.ts (idle / watching /
 *     recording / transcribing), permissions.ts (any TCC denied?),
 *     chromeProbe.ts (is a meet.google.com tab open right now?).
 *   - Tray title text (next to the icon) carries the high-signal state
 *     when capturing: "Meeting · 4:23" for a live meeting, "Watching"
 *     when idle. Empty when paused (so the icon alone communicates).
 *   - Click → Electron's `popUpContextMenu` opens the menu. The menu
 *     rebuilds on every state change so checkmarks / disabled items
 *     stay accurate.
 */
import {
  Menu,
  Tray,
  app,
  nativeImage,
  BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type { RecordingStatus, ChromeMeetSnapshot, PermissionStatus } from '../shared/types'
import { onStatusChange, getStatus, startWatching, stopWatching } from './recording'
import { getPermissionStatus, openPrivacyPane } from './permissions'
import { getChromeMeetSnapshot } from './chromeProbe'

let tray: Tray | null = null
/**
 * Repaint tick — refreshes the title timer (e.g. "Meeting · 4:23") once a
 * second while a meeting is live. We do NOT rebuild the menu every tick;
 * the menu rebuild happens only on state-class changes (status / permission /
 * chrome-meet detection toggle) to avoid a Mac quirk where rebuilding the
 * menu while it's open snaps it shut.
 */
let titleTimer: NodeJS.Timeout | null = null

/**
 * Resolve the tray icon PNG.
 *
 * Path layouts we have to cope with:
 *
 *   1. `electron-vite dev` — code runs from the repo, assets live at
 *      `<repo>/resources/tray/tray-icon.png`. `app.getAppPath()` returns
 *      the repo root.
 *
 *   2. Packaged production build — electron-builder bundles renderer/main
 *      into `Contents/Resources/app.asar`, but anything matching
 *      `asarUnpack: resources/**` (see electron-builder.yml) gets
 *      shadow-copied to `Contents/Resources/app.asar.unpacked/resources/`.
 *      That's where NativeImage actually has to read from (asar paths are
 *      virtual and can't be `fs.read`-ed by image loaders).
 *
 *   3. Future / unusual builds — bare `resources/` directly under
 *      `Contents/Resources/` and the legacy `../resources/` sibling.
 *
 * We probe all four in priority order. NativeImage picks `tray-icon@2x.png`
 * automatically when present alongside `tray-icon.png`, so we only need to
 * point it at the 1x file.
 */
function resolveTrayIcon(): string {
  const candidates = [
    // 2. Packaged macOS — unpacked-from-asar path (the real one)
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'tray', 'tray-icon.png'),
    // 1. Dev — source path off the project root
    join(app.getAppPath(), 'resources', 'tray', 'tray-icon.png'),
    // 3. Hypothetical packaged layouts
    join(process.resourcesPath, 'tray', 'tray-icon.png'),
    join(process.resourcesPath, 'tray-icon.png'),
    join(app.getAppPath(), '..', 'resources', 'tray', 'tray-icon.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // No PNG found — return the first guess; nativeImage will create an
  // empty image and the tray will still appear (just without an icon).
  // A missing icon shouldn't crash the tray on launch.
  console.warn(
    '[tray] no tray icon found in any candidate path; tray will render iconless',
    candidates
  )
  return candidates[0]
}

export function createTray(): void {
  if (tray) return
  if (process.platform !== 'darwin') {
    // Linux/Windows trays work the same way but we only need this on Mac
    // for now. Skip silently on other platforms.
    return
  }

  const iconPath = resolveTrayIcon()
  const image = nativeImage.createFromPath(iconPath)
  // 22 px is the macOS-recommended menubar height. Resizing here keeps
  // the icon crisp even if the source PNG is larger.
  const resized = image.isEmpty() ? image : image.resize({ width: 22, height: 22 })

  tray = new Tray(resized)
  tray.setToolTip('Mintr')

  rebuildMenu()

  // Tap the icon to pop the menu. Right-click also pops it (Tray default
  // on macOS) — both routes share the same handler.
  tray.on('click', () => {
    if (tray) tray.popUpContextMenu(buildMenu())
  })

  // Subscribe to status changes — every transition rebuilds the menu so
  // checkmarks and disabled items reflect reality.
  onStatusChange(() => {
    rebuildMenu()
    refreshTitle()
  })

  // Permissions don't have a push channel — re-poll once a minute so the
  // menu picks up newly-granted permissions even if the user grants them
  // outside our flow.
  setInterval(() => rebuildMenu(), 60_000)

  // Chrome probe push channel — chromeProbe.ts broadcasts to all renderer
  // windows, but the tray lives in main and doesn't get those. We poll
  // its snapshot once a second (cheap — just a struct read).
  setInterval(() => {
    rebuildMenu()
    refreshTitle()
  }, 1500)

  // Per-second title timer ONLY ticks while a meeting is active. Started
  // and stopped from `refreshTitle()`.
  refreshTitle()
}

export function destroyTray(): void {
  if (titleTimer) {
    clearInterval(titleTimer)
    titleTimer = null
  }
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
}

function rebuildMenu(): void {
  if (!tray) return
  tray.setContextMenu(buildMenu())
}

function refreshTitle(): void {
  if (!tray) return
  const status = getStatus()
  const chrome = getChromeMeetSnapshot()
  const perms = getPermissionStatus()

  // Title text shown next to the icon in the menubar. Keep it terse so it
  // doesn't crowd out the user's other tray items. Use "·" (middle-dot)
  // for separators — looks lighter than a hyphen.
  let title = ''
  if (perms.screenRecording === 'denied') {
    title = ' Permission needed'
  } else if (status.state === 'recording' && typeof status.elapsedSeconds === 'number') {
    title = ` Meeting · ${formatMMSS(status.elapsedSeconds)}`
  } else if (chrome.tab) {
    // Chrome probe found a Meet tab even though the engine hasn't moved to
    // 'recording' yet. Surface this — it tells the user we *see* the
    // meeting and are tracking the right window.
    title = ' In Meet'
  } else if (status.state === 'watching') {
    title = ' Watching'
  } else if (status.state === 'transcribing') {
    title = ` Transcribing · ${status.progressPercent ?? 0}%`
  }
  // Empty string clears the title — necessary or the previous value
  // sticks. Electron treats null as "leave it alone", not as "clear".
  tray.setTitle(title)

  // Manage the per-second tick. We only run the timer when there's a
  // changing value to display (mm:ss meeting timer). Saves a wakeup-per-
  // second when nothing's happening.
  const needsTick = status.state === 'recording' || status.state === 'transcribing'
  if (needsTick && !titleTimer) {
    titleTimer = setInterval(() => refreshTitle(), 1000)
  } else if (!needsTick && titleTimer) {
    clearInterval(titleTimer)
    titleTimer = null
  }
}

function formatMMSS(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildMenu(): Menu {
  const status: RecordingStatus = getStatus()
  const perms: PermissionStatus = getPermissionStatus()
  const chrome: ChromeMeetSnapshot = getChromeMeetSnapshot()

  const items: MenuItemConstructorOptions[] = []

  // ── Status row ──────────────────────────────────────────────────────
  // Single non-clickable label that summarises what the app is doing.
  // Distinct icon styling via a leading glyph chosen per state.
  const stateLabel = stateRowLabel(status, chrome)
  items.push({ label: stateLabel, enabled: false })

  // Sub-label if Chrome probe has more context (meeting id detected).
  if (chrome.tab) {
    items.push({ label: `   ${chrome.tab.meetingId} · ${shortenHost(chrome.tab.url)}`, enabled: false })
  }

  items.push({ type: 'separator' })

  // ── Permission warnings ─────────────────────────────────────────────
  // Surface BEFORE the action items, because nothing else works if Screen
  // Recording is denied. One-click open of System Settings.
  if (perms.screenRecording === 'denied' || perms.screenRecording === 'not-determined') {
    items.push({
      label: '⚠︎  Grant Screen Recording…',
      click: () => {
        void openPrivacyPane('screen-recording')
      }
    })
    items.push({ type: 'separator' })
  }
  if (perms.microphone === 'denied') {
    items.push({
      label: '⚠︎  Grant Microphone access…',
      click: () => {
        void openPrivacyPane('microphone')
      }
    })
    items.push({ type: 'separator' })
  }
  if (perms.automationChrome === 'denied') {
    items.push({
      label: '⚠︎  Allow Mintr to read Chrome tabs…',
      click: () => {
        void openPrivacyPane('automation')
      }
    })
    items.push({ type: 'separator' })
  }

  // ── Watch toggle ────────────────────────────────────────────────────
  // The primary control. Disabled while transcribing (you can't pause
  // mid-transcription — the engine is post-processing audio already
  // recorded).
  const watching = status.state === 'watching' || status.state === 'recording'
  if (watching) {
    items.push({
      label: 'Pause watching',
      enabled: status.state !== 'transcribing',
      click: () => {
        stopWatching()
      }
    })
  } else {
    items.push({
      label: 'Start watching',
      enabled: status.state !== 'transcribing',
      click: () => {
        startWatching()
      }
    })
  }

  items.push({ type: 'separator' })

  // ── Window controls ─────────────────────────────────────────────────
  items.push({
    label: 'Show Mintr',
    click: () => {
      showMainWindow()
    },
    accelerator: 'CommandOrControl+0'
  })
  items.push({ type: 'separator' })

  // ── Quit ────────────────────────────────────────────────────────────
  items.push({
    label: 'Quit Mintr',
    click: () => {
      // Force-quit irrespective of the macOS "close window keeps app alive"
      // convention. The tray is the user's contract that the app is
      // running; quit from the tray means quit for real.
      app.quit()
    },
    accelerator: 'Command+Q'
  })

  return Menu.buildFromTemplate(items)
}

/**
 * Best-effort summary line for the top of the menu. Bullet-leading
 * glyph reads as a coloured-dot status badge — green/amber/red maps to
 * macOS's own "live-recording dot" convention even though menu items
 * can't actually render in colour.
 */
function stateRowLabel(status: RecordingStatus, chrome: ChromeMeetSnapshot): string {
  if (status.state === 'transcribing') {
    return `◐  Transcribing · ${status.progressPercent ?? 0}%`
  }
  if (status.state === 'recording') {
    return '●  Recording meeting'
  }
  if (chrome.tab && status.state === 'watching') {
    return '●  Meeting detected — capturing'
  }
  if (status.state === 'watching') {
    return '●  Watching for meetings'
  }
  return '○  Paused (not watching)'
}

function shortenHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Bring an existing window to the front. If for some reason all windows
 * have been closed (rare on macOS — `app.on('window-all-closed')` is a
 * no-op there since v0.12 to keep the tray alive), we ask index.ts to
 * create one via the registered factory. We use a setter pattern instead
 * of importing from index.ts to avoid a circular dep — index.ts calls
 * `setMainWindowFactory(createWindow)` once during whenReady, and we
 * call it back here.
 */
type WindowFactory = () => BrowserWindow
let windowFactory: WindowFactory | null = null

export function setMainWindowFactory(fn: WindowFactory): void {
  windowFactory = fn
}

export function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0]
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    app.focus({ steal: true })
    return
  }
  if (windowFactory) {
    const win = windowFactory()
    win.focus()
    app.focus({ steal: true })
    return
  }
  console.warn('[tray] showMainWindow has no window and no factory registered')
}

