import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type {
  NumSpeakersHint,
  ScreenCaptureScope,
  Settings,
  TagDef,
  ThemeMode
} from '../shared/types'

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
    numSpeakers: 'auto',
    sidebarCollapsed: false,
    // Defaults for the engine bridge (engine_config.json): record only the
    // meeting's Chrome window, and keep the mic ON so the user's voice is
    // never silently dropped (diarization needs the mic track).
    screenCaptureScope: 'chromeWindow',
    recordMicrophone: true,
    // Mintr is intended to behave like Tailscale / 1Password — quietly
    // watching in the background unless the user explicitly pauses it.
    // First launch auto-enrols into watch mode; the tray menu surfaces
    // a Pause toggle so users who want full control still have it.
    autoStartWatching: true
    // onboardingCompletedAt is intentionally absent from defaults —
    // `undefined` is the "wizard not yet completed" sentinel (TICKET-IPC-002).
  }
}

function coerceNumSpeakers(raw: unknown): NumSpeakersHint {
  if (raw === 'auto') return 'auto'
  if (typeof raw === 'number' && [2, 3, 4, 5, 6].includes(raw)) {
    return raw as NumSpeakersHint
  }
  return 'auto'
}

/** Anything that isn't the explicit `entireScreen` opt-in defaults to the
 *  Chrome-window scope — the privacy-first product default. */
function coerceScope(raw: unknown): ScreenCaptureScope {
  return raw === 'entireScreen' ? 'entireScreen' : 'chromeWindow'
}

export async function readSettings(): Promise<Settings> {
  const store = await getStore()
  const defaults = defaultSettings()
  const outputFolder = store.get<string>('outputFolder') ?? defaults.outputFolder
  const theme = (store.get<ThemeMode>('theme') ?? defaults.theme) as ThemeMode
  const numSpeakers = coerceNumSpeakers(store.get<NumSpeakersHint>('numSpeakers'))
  const sidebarCollapsedRaw = store.get<boolean>('sidebarCollapsed')
  const sidebarCollapsed =
    typeof sidebarCollapsedRaw === 'boolean' ? sidebarCollapsedRaw : defaults.sidebarCollapsed
  const autoStartWatchingRaw = store.get<boolean>('autoStartWatching')
  const autoStartWatching =
    typeof autoStartWatchingRaw === 'boolean' ? autoStartWatchingRaw : defaults.autoStartWatching
  const screenCaptureScope = coerceScope(store.get<ScreenCaptureScope>('screenCaptureScope'))
  const recordMicrophoneRaw = store.get<boolean>('recordMicrophone')
  const recordMicrophone =
    typeof recordMicrophoneRaw === 'boolean' ? recordMicrophoneRaw : defaults.recordMicrophone
  // TICKET-IPC-002: undefined => wizard not completed (no default).
  const onboardingCompletedAtRaw = store.get<number>('onboardingCompletedAt')
  const onboardingCompletedAt =
    typeof onboardingCompletedAtRaw === 'number' ? onboardingCompletedAtRaw : undefined
  return {
    outputFolder,
    theme,
    numSpeakers,
    sidebarCollapsed,
    screenCaptureScope,
    recordMicrophone,
    autoStartWatching,
    onboardingCompletedAt
  }
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const store = await getStore()
  if (patch.outputFolder !== undefined) store.set('outputFolder', patch.outputFolder)
  if (patch.theme !== undefined) store.set('theme', patch.theme)
  if (patch.numSpeakers !== undefined) {
    store.set('numSpeakers', coerceNumSpeakers(patch.numSpeakers))
  }
  if (patch.sidebarCollapsed !== undefined) {
    store.set('sidebarCollapsed', Boolean(patch.sidebarCollapsed))
  }
  if (patch.autoStartWatching !== undefined) {
    store.set('autoStartWatching', Boolean(patch.autoStartWatching))
  }
  if (patch.screenCaptureScope !== undefined) {
    store.set('screenCaptureScope', coerceScope(patch.screenCaptureScope))
  }
  if (patch.recordMicrophone !== undefined) {
    store.set('recordMicrophone', Boolean(patch.recordMicrophone))
  }
  // TICKET-IPC-002: use `in` (not `!== undefined`) so the reset path can
  // explicitly clear completion by passing `onboardingCompletedAt: undefined`.
  if ('onboardingCompletedAt' in patch) {
    if (typeof patch.onboardingCompletedAt === 'number') {
      store.set('onboardingCompletedAt', patch.onboardingCompletedAt)
    } else {
      store.set('onboardingCompletedAt', undefined)
    }
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

// ─── Tags ────────────────────────────────────────────────────────────────

/**
 * Tags shipped on first launch. Users can add / remove / edit any of these
 * via Settings; deletion is permitted (we don't pin any of them).
 */
function defaultTagSeed(): TagDef[] {
  return [
    { id: 'general', name: 'General', color: '#9aa0a6' },
    { id: 'standup', name: 'Standup', color: '#8ab4f8' },
    { id: 'eod-sync', name: 'EOD Sync', color: '#a1e3a1' },
    { id: 'internal', name: 'Internal', color: '#fdd663' },
    { id: 'lanco', name: 'Lanco', color: '#c58af9' }
  ]
}

/**
 * Read the user's tag list, seeding defaults on first ever access. After
 * the first call the key is present in the store (even if the user clears
 * every tag) so we won't re-seed.
 */
export async function readTags(): Promise<TagDef[]> {
  const store = await getStore()
  const raw = store.get<TagDef[] | undefined>('tags')
  if (raw === undefined) {
    const seeded = defaultTagSeed()
    store.set('tags', seeded)
    return seeded
  }
  return Array.isArray(raw) ? raw : []
}

export async function addTag(name: string, color: string): Promise<TagDef> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Tag name must not be empty')
  const store = await getStore()
  const tags = await readTags()
  if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`Tag "${trimmed}" already exists`)
  }
  const tag: TagDef = { id: randomUUID(), name: trimmed, color }
  store.set('tags', [...tags, tag])
  return tag
}

export async function updateTag(id: string, patch: Partial<Omit<TagDef, 'id'>>): Promise<TagDef> {
  const store = await getStore()
  const tags = await readTags()
  const idx = tags.findIndex((t) => t.id === id)
  if (idx < 0) throw new Error(`Tag ${id} not found`)
  const merged: TagDef = {
    ...tags[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {})
  }
  const next = [...tags]
  next[idx] = merged
  store.set('tags', next)
  return merged
}

export async function deleteTag(id: string): Promise<void> {
  const store = await getStore()
  const tags = await readTags()
  store.set(
    'tags',
    tags.filter((t) => t.id !== id)
  )
}
