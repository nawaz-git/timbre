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
import { coerceAsrLanguage, coerceProcessingMode } from './settingsCoercion'

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
    // Default for the engine bridge (engine_config.json): record only the
    // meeting's Chrome window. The microphone is always captured alongside the
    // meeting audio (no toggle — the user's voice must be recorded).
    screenCaptureScope: 'chromeWindow',
    // Kill switch for the app-audio CATap — off by default (normal dual-source
    // capture). Flip on as an immediate field mitigation to record mic + screen
    // only, with no CoreAudio process tap at all.
    disableAppAudioTap: false,
    // Mintr is intended to behave like Tailscale / 1Password — quietly
    // watching in the background unless the user explicitly pauses it.
    // First launch auto-enrols into watch mode; the tray menu surfaces
    // a Pause toggle so users who want full control still have it.
    autoStartWatching: true,
    // Default post-processing tier: fast (today's latency). Max is opt-in.
    processingMode: 'fast',
    // Default ASR language: auto-detect (empty). No more forced German.
    asrLanguage: '',
    // MAX-tier LLM speaker repair off by default — opt-in, provider-gated.
    llmRepair: false,
    // Register as a login item by default — a background recorder is only
    // useful if it comes back after a reboot.
    launchAtLogin: true
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
  const launchAtLoginRaw = store.get<boolean>('launchAtLogin')
  const launchAtLogin =
    typeof launchAtLoginRaw === 'boolean' ? launchAtLoginRaw : defaults.launchAtLogin
  const screenCaptureScope = coerceScope(store.get<ScreenCaptureScope>('screenCaptureScope'))
  const disableAppAudioTapRaw = store.get<boolean>('disableAppAudioTap')
  const disableAppAudioTap =
    typeof disableAppAudioTapRaw === 'boolean' ? disableAppAudioTapRaw : defaults.disableAppAudioTap
  const processingMode = coerceProcessingMode(store.get<string>('processingMode'))
  const asrLanguage = coerceAsrLanguage(store.get<string>('asrLanguage'))
  const llmRepairRaw = store.get<boolean>('llmRepair')
  const llmRepair = typeof llmRepairRaw === 'boolean' ? llmRepairRaw : defaults.llmRepair
  const recordingsFolderRaw = store.get<string>('recordingsFolder')
  const recordingsFolder =
    typeof recordingsFolderRaw === 'string' && recordingsFolderRaw ? recordingsFolderRaw : undefined
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
    disableAppAudioTap,
    autoStartWatching,
    processingMode,
    asrLanguage,
    llmRepair,
    launchAtLogin,
    recordingsFolder,
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
  if (patch.launchAtLogin !== undefined) {
    store.set('launchAtLogin', Boolean(patch.launchAtLogin))
  }
  if (patch.screenCaptureScope !== undefined) {
    store.set('screenCaptureScope', coerceScope(patch.screenCaptureScope))
  }
  if (patch.disableAppAudioTap !== undefined) {
    store.set('disableAppAudioTap', Boolean(patch.disableAppAudioTap))
  }
  if (patch.processingMode !== undefined) {
    store.set('processingMode', coerceProcessingMode(patch.processingMode))
  }
  if (patch.asrLanguage !== undefined) {
    store.set('asrLanguage', coerceAsrLanguage(patch.asrLanguage))
  }
  if (patch.llmRepair !== undefined) {
    store.set('llmRepair', Boolean(patch.llmRepair))
  }
  if (patch.recordingsFolder !== undefined) {
    store.set('recordingsFolder', patch.recordingsFolder)
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
    { id: 'one-on-one', name: '1:1', color: '#8ab4f8' },
    { id: 'team', name: 'Team', color: '#a1e3a1' },
    { id: 'client', name: 'Client', color: '#fdd663' },
    { id: 'interview', name: 'Interview', color: '#c58af9' }
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
