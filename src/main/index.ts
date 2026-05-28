import { app, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { readSettings } from './settings'

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
