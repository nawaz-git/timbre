import { app } from 'electron'
import { join } from 'path'
import type { NumSpeakersHint, Settings, ThemeMode } from '../shared/types'

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
    theme: 'auto',
    numSpeakers: 'auto'
  }
}

function coerceNumSpeakers(raw: unknown): NumSpeakersHint {
  if (raw === 'auto') return 'auto'
  if (typeof raw === 'number' && [2, 3, 4, 5, 6].includes(raw)) {
    return raw as NumSpeakersHint
  }
  return 'auto'
}

export async function readSettings(): Promise<Settings> {
  const store = await getStore()
  const defaults = defaultSettings()
  const outputFolder = store.get<string>('outputFolder') ?? defaults.outputFolder
  const theme = (store.get<ThemeMode>('theme') ?? defaults.theme) as ThemeMode
  const numSpeakers = coerceNumSpeakers(store.get<NumSpeakersHint>('numSpeakers'))
  return { outputFolder, theme, numSpeakers }
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const store = await getStore()
  if (patch.outputFolder !== undefined) store.set('outputFolder', patch.outputFolder)
  if (patch.theme !== undefined) store.set('theme', patch.theme)
  if (patch.numSpeakers !== undefined) {
    store.set('numSpeakers', coerceNumSpeakers(patch.numSpeakers))
  }
  return readSettings()
}

/**
 * Path to the global speakers DB. Both mt-batch (read-only consumer) and
 * the rename-speaker IPC (writer) point at this file. Lives inside
 * Electron's userData dir so it persists across re-installs of the app.
 */
export function globalSpeakersDBPath(): string {
  return join(app.getPath('userData'), 'global-speakers.json')
}
