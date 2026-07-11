import { app, BrowserWindow, protocol, shell } from 'electron'
import {
  promises as fs,
  existsSync,
  createReadStream,
  copyFileSync,
  mkdirSync,
  writeFileSync
} from 'fs'
import { join, resolve, sep, dirname } from 'path'
import { Readable } from 'stream'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { findEngineAudioForPrefix, findEngineVideoForPrefix, liveRecordingsRoot } from './meetings'
import { readSettings } from './settings'
import { createTray, setMainWindowFactory } from './tray'
import { startChromeProbe, stopChromeProbe } from './chromeProbe'
import { writeEngineConfig } from './engineConfig'
import { onStatusChange, startWatching } from './recording'
import { startCaptureWatchdog, stopCaptureWatchdog } from './captureWatchdog'

// `mt-audio://` MUST be registered as privileged before app.whenReady().
// Without this, the renderer's <audio src="mt-audio://..."> gets blocked by
// CORS/security checks. `stream: true` lets net.fetch deliver ranged responses
// so HTML5 audio seeking works without buffering the whole file first.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mt-audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

/**
 * Validates that an absolute path lives under one of the allowed roots —
 * the user's configured Output Folder, or the engine's default folder.
 * Prevents the renderer from coaxing the protocol into serving arbitrary
 * files via `..`-style traversal.
 */
async function isUnderAllowedRoot(absPath: string): Promise<boolean> {
  const settings = await readSettings()
  const roots = [settings.outputFolder, liveRecordingsRoot]
  const target = resolve(absPath)
  for (const root of roots) {
    const r = resolve(root) + sep
    if (target.startsWith(r)) return true
  }
  return false
}

/**
 * Convert a Node ReadStream into a web ReadableStream so we can hand it to
 * a Response. Electron 33's net.fetch from `file://` doesn't set
 * Content-Length, which makes HTML5 `<audio>` report duration as Infinity.
 * Serving the stream ourselves with explicit headers fixes that AND adds
 * proper byte-range support so seeking works without buffering the whole
 * file first.
 */
function nodeStreamToWeb(node: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(node as Readable) as ReadableStream<Uint8Array>
}

function parseRangeHeader(
  header: string | null,
  fileSize: number
): { start: number; end: number } | null {
  if (!header) return null
  const m = /bytes=(\d+)-(\d*)/.exec(header)
  if (!m) return null
  const start = parseInt(m[1], 10)
  const end = m[2] ? parseInt(m[2], 10) : fileSize - 1
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
    return null
  }
  return { start, end: Math.min(end, fileSize - 1) }
}

/**
 * Register the `mt-audio://meeting/<folder-id>/audio.wav` protocol handler.
 * Must be called inside `app.whenReady()`. Implements Range / Accept-Ranges
 * so the renderer's `<audio>` can determine duration + seek properly.
 */
function registerAudioProtocol(): void {
  protocol.handle('mt-audio', async (req) => {
    try {
      const url = new URL(req.url)
      if (url.hostname !== 'meeting') {
        return new Response('Bad request', { status: 400 })
      }
      const segments = url.pathname.split('/').filter(Boolean)
      const tail = segments[1]
      const isVideo = tail === 'screen.mp4'
      const isAudio = tail === 'audio.wav'
      if (segments.length !== 2 || (!isAudio && !isVideo)) {
        return new Response('Not found', { status: 404 })
      }
      const contentType = isVideo ? 'video/mp4' : 'audio/wav'
      const folderId = decodeURIComponent(segments[0])
      if (folderId.includes('..') || folderId.includes('/') || folderId.includes('\\')) {
        return new Response('Bad id', { status: 400 })
      }

      // v0.17+: route engine-format ids (`engine:<prefix>`) to the
      // engine's flat-naming layout in recordings/. Engine writes
      // `<prefix>_mix.wav` / `<prefix>_screen.mp4` etc. rather than
      // `<id>/audio.wav` like mt-batch does — same protocol, different
      // physical layout. The same privileged scheme serves both media kinds.
      let path: string | null = null
      if (folderId.startsWith('engine:')) {
        const prefix = folderId.slice('engine:'.length)
        if (!/^[A-Za-z0-9_\-]+$/.test(prefix)) {
          return new Response('Bad engine prefix', { status: 400 })
        }
        const enginePath = isVideo
          ? await findEngineVideoForPrefix(prefix)
          : await findEngineAudioForPrefix(prefix)
        if (enginePath && (await isUnderAllowedRoot(enginePath))) {
          path = enginePath
        }
      } else {
        const settings = await readSettings()
        const fileName = isVideo ? 'screen.mp4' : 'audio.wav'
        const candidates = [
          join(settings.outputFolder, folderId, fileName),
          join(liveRecordingsRoot, folderId, fileName)
        ]
        for (const candidate of candidates) {
          if (existsSync(candidate) && (await isUnderAllowedRoot(candidate))) {
            path = candidate
            break
          }
        }
      }
      if (!path) return new Response('Not found', { status: 404 })

      const stat = await fs.stat(path)
      const fileSize = stat.size
      const range = parseRangeHeader(req.headers.get('Range'), fileSize)

      if (!range) {
        // Whole-file response — must include Content-Length for `<audio>`/
        // `<video>` to compute duration without buffering the whole file.
        return new Response(nodeStreamToWeb(createReadStream(path)), {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }

      const { start, end } = range
      const chunkSize = end - start + 1
      return new Response(nodeStreamToWeb(createReadStream(path, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      console.error('[mt-audio] handler error', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 760,
    minHeight: 500,
    show: false,
    // macOS: hiddenInset gives us native traffic lights flush with the chrome.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    console.log('[main] window shown')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] renderer finished load')
  })

  mainWindow.webContents.on('render-process-gone', (_evt, details) => {
    console.error('[main] renderer gone:', details)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/** Make sure the configured output folder exists so meetings:list can read it. */
async function ensureOutputFolder(): Promise<void> {
  try {
    const settings = await readSettings()
    await fs.mkdir(settings.outputFolder, { recursive: true })
  } catch (err) {
    console.warn('[main] failed to ensure output folder', err)
  }
}

/**
 * One-time migration of the user's settings when the product was renamed
 * Mintr → Timbre. Electron derives `userData` from the product name, so the
 * rename moves the store from `…/Application Support/Mintr` to `…/Timbre`,
 * which would otherwise orphan the user's tags, theme, output folder, enrolled
 * speakers, and onboarding-complete flag (re-showing the wizard). We copy the
 * files we own from the old dir into the new one before electron-store first
 * reads, guarded by a marker so it runs exactly once and never clobbers data
 * the user creates under the new name. Bundle ids are unchanged, so this is the
 * only state that moves. Must run BEFORE the first readSettings/getStore call.
 */
function migrateLegacyUserData(): void {
  try {
    const newDir = app.getPath('userData') // …/Timbre
    const oldDir = join(dirname(newDir), 'Mintr') // …/Mintr
    if (newDir === oldDir) return
    const marker = join(newDir, '.migrated-from-mintr')
    if (existsSync(marker)) return
    mkdirSync(newDir, { recursive: true })
    if (existsSync(join(oldDir, 'settings.json'))) {
      for (const f of ['settings.json', 'global-speakers.json']) {
        const src = join(oldDir, f)
        if (existsSync(src)) copyFileSync(src, join(newDir, f))
      }
      console.log('[main] migrated user settings from legacy Mintr userData → Timbre')
    }
    writeFileSync(marker, new Date().toISOString())
  } catch (e) {
    console.warn('[main] legacy userData migration failed (non-fatal)', e)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('ai.nawaz.meeting-transcriber')
  // Restore Mintr-era settings into the renamed (Timbre) userData before
  // anything reads the store. One-time, marker-guarded.
  migrateLegacyUserData()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAudioProtocol()
  registerIpcHandlers()
  await ensureOutputFolder()
  // Ensure engine_config.json exists with current/default settings before any
  // meeting starts, even if the user never opens Settings. Best-effort.
  await writeEngineConfig().catch((err) => console.warn('[main] writeEngineConfig failed', err))
  // Register the window factory BEFORE creating the tray so the tray can
  // call back into it if all windows have been closed.
  setMainWindowFactory(createWindow)
  createWindow()
  // Tray sits in the menubar for the whole app lifetime. Created after
  // the window so the first menu rebuild has a window to point at when
  // the user clicks "Show Mintr".
  createTray()

  // Chrome probe is only useful while we're actively watching, so start
  // and stop it in tandem with the engine state. We do this in the main
  // process (not the engine) because osascript needs Mintr's TCC
  // Automation entry, not the bundled helper's.
  onStatusChange((status) => {
    if (status.state === 'idle') {
      stopChromeProbe()
    } else {
      startChromeProbe()
    }
  })

  // Capture watchdog + folder watcher — fires for the lifetime of the
  // app (not just while watching). The folder watcher needs to be live
  // even while paused so the user sees new file imports show up; the
  // watchdog itself only flips when the Chrome probe is also active.
  await startCaptureWatchdog().catch((err) =>
    console.warn('[main] startCaptureWatchdog failed', err)
  )

  // Auto-start watching on launch unless the user opted out. The tray
  // exists at this point so the user has a way to pause if they want.
  try {
    const settings = await readSettings()
    if (settings.autoStartWatching) {
      const status = await startWatching()
      if (status.state !== 'watching') {
        console.warn('[main] auto-start watching did not enter watching state', status)
      } else {
        // Kick the probe immediately so the user gets feedback fast.
        startChromeProbe()
      }
    }
  } catch (err) {
    console.warn('[main] auto-start watching failed', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * macOS behaviour: closing the last window does NOT quit the app — the
 * tray keeps Mintr alive in the background so it can keep watching for
 * meetings. The user quits explicitly via the tray's "Quit Mintr" item
 * or ⌘Q. Linux/Windows still quit on last-window-closed since they don't
 * have the tray pattern as deeply ingrained.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopChromeProbe()
  stopCaptureWatchdog()
})
