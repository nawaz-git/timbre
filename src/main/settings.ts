import { app } from 'electron'
import { join } from 'path'
import type { Settings, ThemeMode } from '../shared/types'

// electron-store v10 is ESM-only — load it via dynamic import the first time we need it.
// We cache the resulting instance so subsequent gets/sets are synchronous-ish from callers.
type StoreLike = {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  store: Record<string, unknown>
}

let storePromise: Promise<StoreLike> | null = null

async function getStore(): Promise<StoreLike> {
  if (!storePromise) {
    storePromise = (async () => {
      const mod = await import('electron-store')
      const StoreCtor = mod.default as unknown as new (opts?: unknown) => StoreLike
      return new StoreCtor({ name: 'settings' })
    })()
  }
  return storePromise
}

function defaultSettings(): Settings {
  return {
    outputFolder: join(app.getPath('documents'), 'MeetingTranscripts'),
    theme: 'auto'
  }
}

export async function readSettings(): Promise<Settings> {
  const store = await getStore()
  const defaults = defaultSettings()
  const outputFolder = store.get<string>('outputFolder') ?? defaults.outputFolder
  const theme = (store.get<ThemeMode>('theme') ?? defaults.theme) as ThemeMode
  return { outputFolder, theme }
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const store = await getStore()
  if (patch.outputFolder !== undefined) store.set('outputFolder', patch.outputFolder)
  if (patch.theme !== undefined) store.set('theme', patch.theme)
  return readSettings()
}
