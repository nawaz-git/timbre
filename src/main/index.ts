import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { liveRecordingsRoot } from './meetings'
import { readSettings } from './settings'

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
 * Register the `mt-audio://meeting/<folder-id>/audio.wav` protocol handler.
 * Must be called inside `app.whenReady()`.
 */
function registerAudioProtocol(): void {
  protocol.handle('mt-audio', async (req) => {
    try {
      const url = new URL(req.url)
      if (url.hostname !== 'meeting') {
        return new Response('Bad request', { status: 400 })
      }
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments.length !== 2 || segments[1] !== 'audio.wav') {
        return new Response('Not found', { status: 404 })
      }
      const folderId = decodeURIComponent(segments[0])
      if (folderId.includes('..') || folderId.includes('/') || folderId.includes('\\')) {
        return new Response('Bad id', { status: 400 })
      }
      const settings = await readSettings()
      const candidates = [
        join(settings.outputFolder, folderId, 'audio.wav'),
        join(liveRecordingsRoot, folderId, 'audio.wav')
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate) && (await isUnderAllowedRoot(candidate))) {
          return net.fetch(pathToFileURL(candidate).toString())
        }
      }
      return new Response('Not found', { status: 404 })
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('ai.nawaz.meeting-transcriber')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAudioProtocol()
  registerIpcHandlers()
  await ensureOutputFolder()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
