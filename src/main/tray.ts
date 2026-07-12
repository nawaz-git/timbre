/**
 * macOS menubar tray — always-on background presence for Timbre.
 *
 * What problem does this solve? Before v0.12 the only feedback the user
 * got that Timbre was watching for meetings was a status text on the Home
 * view, which is invisible the moment they close the window or alt-tab
 * away. They could (and did) walk into a Google Meet thinking Timbre was
 * capturing, only to find nothing in the Meetings tab afterwards.
 *
 * The tray gives them a persistent, always-visible status surface plus
 * one-click controls — Pause, Resume, Show Timbre, Open System Settings
 * (when a permission is denied), Quit. Modeled after Tailscale, ProtonVPN,
 * Bartender — same affordance, same mental model.
 *
 * Implementation:
 *   - One Electron Tray with a 22pt PNG of the Timbre leaf (colored, not
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
  shell,
  BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type {
  AppStatus,
  PermissionStatus,
  HelperPermissionSnapshot,
  GrantStatus
} from '../shared/types'
import { onStatusChange, getStatus, startWatching, stopWatching } from './recording'
import { getPermissionStatus, openPrivacyPane } from './permissions'
import { getWatchdogSignal, getLastReadyPrefix } from './captureWatchdog'
import { probeHelperPermissions } from './onboarding'
import { getAppStatus, onAppStatusChange, confirmIfRecording } from './status'
import { liveRecordingsRoot } from './meetings'

let tray: Tray | null = null

/**
 * Latest permission verdict for the bundled ENGINE (ai.nawaz.mintr-engine),
 * which actually holds the Screen Recording / Microphone TCC grants. Electron's
 * own `getMediaAccessStatus` reports Timbre's bundle id — the WRONG principal —
 * so the tray used to show a permanent "Grant Screen Recording…" even when the
 * engine was fully granted and capturing. We poll the engine's live verdict
 * (the same source the Home banner uses) and cache it for the sync builders.
 * Starts 'unknown' so we never flash a warning before the first probe resolves.
 */
let enginePerms: HelperPermissionSnapshot = {
  screenRecording: 'unknown',
  microphone: 'unknown',
  accessibility: 'unknown',
  watchLoopRunning: false
}

/** Only an explicit denial counts as "missing" — 'unknown' (pre-probe) does not. */
function permMissing(s: GrantStatus): boolean {
  return s === 'denied' || s === 'not-determined'
}

/** Re-probe the engine verdict, cache it, and repaint the tray. Bounded + safe. */
async function refreshEnginePerms(): Promise<void> {
  try {
    enginePerms = await probeHelperPermissions()
  } catch {
    // keep the last-known verdict on any probe error
  }
  rebuildMenu()
  refreshTitle()
}
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
  // Template image: the tray PNG is a black glyph on transparency, so macOS
  // renders it monochrome and auto-tints for light/dark menu bars — no white
  // tile, no manual theming. (Replaces the old opaque white-background icon.)
  resized.setTemplateImage(true)

  tray = new Tray(resized)
  tray.setToolTip('Timbre')

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

  // The engine holds the real Screen Recording / Microphone grants, so poll
  // its live verdict and repaint. Initial probe immediately; re-probe every
  // 10s so a just-granted permission clears the tray warning quickly without
  // waiting on a push event we don't have.
  void refreshEnginePerms()
  setInterval(() => {
    void refreshEnginePerms()
  }, 10_000)

  // The single status source pushes on every meaningful change (recording,
  // processing, meet-detected, attention) — repaint the tray off that instead
  // of a blind 1.5s poll. A slow 10s safety poll covers anything time-based
  // that didn't push (e.g. a stuck threshold crossing while idle).
  onAppStatusChange(() => {
    rebuildMenu()
    refreshTitle()
  })
  setInterval(() => {
    rebuildMenu()
    refreshTitle()
  }, 10_000)

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
  const status = getAppStatus()

  // Title text shown NEXT to the icon. On a crowded menubar, every extra
  // pixel can push us off-screen — v0.12 shipped "Meeting · 4:23" type
  // titles and the user reported the icon vanishing entirely during a
  // live meeting (macOS hides menubar items when they don't fit).
  //
  // Policy: NEVER more than 1 glyph of title text, chosen from the single
  // status source — attention ⚠, recording ●, processing ◐, else nothing.
  // Full state text lives in the menu + tooltip.
  let title = ''
  if (status.attention) title = '⚠'
  else if (status.activityKind === 'recording') title = '●'
  else if (status.activityKind === 'processing') title = '◐'
  tray.setTitle(title)

  // Tooltip — long-form status, only visible on hover so it never costs
  // menubar width. macOS shows tooltips with a ~500ms hover delay.
  tray.setToolTip(buildTooltip(status))

  // Manage the per-second tick. We only run the timer while recording, so the
  // tooltip's mm:ss stays live; other states have no per-second value.
  const needsTick = status.activityKind === 'recording'
  if (needsTick && !titleTimer) {
    titleTimer = setInterval(() => refreshTitle(), 1000)
  } else if (!needsTick && titleTimer) {
    clearInterval(titleTimer)
    titleTimer = null
  }
}

function buildTooltip(status: AppStatus): string {
  if (status.attention) return `Timbre — ${status.attention.message}`
  switch (status.activityKind) {
    case 'recording': {
      const t =
        typeof status.recordingElapsedSec === 'number'
          ? ` · ${formatMMSS(status.recordingElapsedSec)}`
          : ''
      return `Timbre — recording${t}`
    }
    case 'processing': {
      const n = status.processingCount ?? 1
      return `Timbre — processing ${n} meeting${n === 1 ? '' : 's'}`
    }
    case 'meet-detected':
      return 'Timbre — Meet open, waiting for capture'
    case 'watching':
      return 'Timbre — watching for meetings'
    case 'paused':
      return 'Timbre — paused'
  }
}

function formatMMSS(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildMenu(): Menu {
  const status = getAppStatus()
  const perms: PermissionStatus = getPermissionStatus()

  const items: MenuItemConstructorOptions[] = []

  // ── Status row ──────────────────────────────────────────────────────
  // Non-clickable summary from the single status source, mirroring the
  // tooltip. Leading glyph reads as a coloured-dot status badge.
  items.push({ label: menuStatusLabel(status), enabled: false })

  // Context sub-row: who + when while recording; the meet id while a Meet
  // is open but capture isn't confirmed yet.
  if (status.activityKind === 'recording' && status.recordingStartedAt) {
    const who = status.recordingMeetingId ?? 'meeting'
    items.push({
      label: `   ${who} · started ${formatClock(status.recordingStartedAt)}`,
      enabled: false
    })
  } else if (status.activityKind === 'meet-detected' && status.meetTab) {
    items.push({ label: `   ${status.meetTab.meetingId}`, enabled: false })
  }

  items.push({ type: 'separator' })

  // ── Permission warnings (actions) ───────────────────────────────────
  // The status row summarises the problem; these are the one-click fixes.
  if (permMissing(enginePerms.screenRecording)) {
    items.push({
      label: '⚠︎  Grant Screen Recording…',
      click: () => {
        void openPrivacyPane('screen-recording')
      }
    })
    items.push({ type: 'separator' })
  }

  // v0.13+: helper-permission alarm. The bundled MeetingTranscriber.app
  // has its own bundle id and needs Screen Recording granted separately —
  // the watchdog catches this when Chrome reports a Meet but the helper
  // isn't writing any files. Surface it loudly in the tray so users
  // notice even when the main window is closed.
  const watchdog = getWatchdogSignal()
  if (watchdog.helperPermissionLikely) {
    items.push({
      label: '⚠︎  Timbre Engine not capturing — fix permission…',
      click: () => {
        void openPrivacyPane('screen-recording')
      }
    })
    items.push({
      label: '   Look for "Timbre Engine" in the list',
      enabled: false
    })
    items.push({ type: 'separator' })
  }
  if (permMissing(enginePerms.microphone)) {
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
      label: '⚠︎  Allow Timbre to read Chrome tabs…',
      click: () => {
        void openPrivacyPane('automation')
      }
    })
    items.push({ type: 'separator' })
  }

  // ── Watch toggle (recording-aware) ──────────────────────────────────
  // Pause routes through the recording-aware guard so it can't silently
  // end a live recording.
  const watchOn = getStatus().state !== 'idle'
  if (watchOn) {
    items.push({
      label: 'Pause watching',
      click: () => {
        void pauseWatching()
      }
    })
  } else {
    items.push({
      label: 'Resume watching',
      click: () => {
        // Fire-and-forget: startWatching may await a graceful stop of a stale
        // engine; the tray refreshes from the status listener when it settles.
        void startWatching()
      }
    })
  }

  items.push({ type: 'separator' })

  // ── Window + meeting shortcuts ──────────────────────────────────────
  items.push({
    label: 'Show Timbre',
    click: () => {
      showMainWindow()
    },
    accelerator: 'CommandOrControl+0'
  })
  items.push({
    label: 'Open latest meeting',
    enabled: getLastReadyPrefix() !== null,
    click: () => {
      openLatestMeeting()
    }
  })
  items.push({
    label: 'Open recordings folder',
    click: () => {
      void shell.openPath(liveRecordingsRoot)
    }
  })
  items.push({ type: 'separator' })

  // ── Quit (recording-aware) ──────────────────────────────────────────
  items.push({
    label: 'Quit Timbre',
    click: () => {
      void quitWithGuard()
    },
    accelerator: 'Command+Q'
  })

  return Menu.buildFromTemplate(items)
}

/** The menu status row: glyph + summary from the single status source. */
function menuStatusLabel(status: AppStatus): string {
  if (status.attention) return `⚠  ${status.attention.message}`
  switch (status.activityKind) {
    case 'recording': {
      const t =
        typeof status.recordingElapsedSec === 'number'
          ? ` · ${formatMMSS(status.recordingElapsedSec)}`
          : ''
      return `●  Recording${t}`
    }
    case 'processing': {
      const n = status.processingCount ?? 1
      return `◐  Processing ${n} meeting${n === 1 ? '' : 's'}`
    }
    case 'meet-detected':
      return '●  Meet open — waiting for capture'
    case 'watching':
      return '●  Watching for meetings'
    case 'paused':
      return '○  Paused (not watching)'
  }
}

/** "2:00 PM"-style clock label from an epoch-ms timestamp. */
function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Pause watching, guarded so a live recording isn't ended without consent. */
async function pauseWatching(): Promise<void> {
  if (!(await confirmIfRecording('stop'))) return
  // The engine's SIGTERM → escalation stop already gives a live recording time
  // to finalise before the hard kill, so no extra stop-grace is threaded here.
  stopWatching()
}

/** Quit, guarded so a live recording isn't ended without consent. */
async function quitWithGuard(): Promise<void> {
  if (!(await confirmIfRecording('quit'))) return
  app.quit()
}

/** Deep-link to the freshest finished meeting (last "Transcript ready"). */
function openLatestMeeting(): void {
  const prefix = getLastReadyPrefix()
  if (!prefix) return
  showMainWindow()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('meetings:openMeeting', { id: `engine:${prefix}` })
      break
    }
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

