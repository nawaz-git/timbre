/**
 * Minimal Electron stand-in for unit tests.
 *
 * The real `electron` module only exists inside a running Electron process, so
 * any main-process file that does `import { app } from 'electron'` would throw
 * the instant Vitest loaded it. `vitest.config.ts` aliases the bare `electron`
 * specifier to this file so those modules import cleanly under plain Node.
 *
 * Deliberately dumb: it satisfies the top-level import surface only. Tests
 * written under this harness must exercise PURE logic — anything that needs
 * real Electron behaviour (windows, IPC round-trips, native dialogs, the app
 * lifecycle) is out of scope here and belongs in a manual or end-to-end check.
 *
 * Add to this surface as new modules are brought under test; keep every member
 * a no-op / benign-value stub.
 */

const noop = (): void => {}

export const app = {
  getPath: (): string => '/tmp/timbre-test',
  getAppPath: (): string => '/tmp/timbre-test',
  isPackaged: false,
  on: noop,
  quit: noop
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}

export class Notification {
  show(): void {
    /* no-op */
  }
  on(): this {
    return this
  }
}

export class Tray {}

export const Menu = {
  buildFromTemplate: (): unknown => ({}),
  setApplicationMenu: noop
}

export const nativeImage = {
  createFromPath: (): unknown => ({ isEmpty: (): boolean => true, setTemplateImage: noop }),
  createEmpty: (): unknown => ({ isEmpty: (): boolean => true })
}

export const dialog = {
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }),
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true
  })
}

export const shell = {
  openPath: async (): Promise<string> => '',
  openExternal: async (): Promise<void> => {},
  showItemInFolder: noop,
  trashItem: async (): Promise<void> => {}
}

export const ipcMain = {
  handle: noop,
  on: noop,
  removeHandler: noop
}

export const systemPreferences = {
  getMediaAccessStatus: (): string => 'granted'
}

export const protocol = {
  handle: noop,
  registerSchemesAsPrivileged: noop
}

export default {
  app,
  BrowserWindow,
  Notification,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
  ipcMain,
  systemPreferences,
  protocol
}
