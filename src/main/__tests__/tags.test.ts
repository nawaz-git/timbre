import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagDef, TagKind } from '../../shared/types'

// `electron` itself is stubbed by the shared test harness (aliased to
// src/main/__mocks__/electron.ts). settings.ts only touches `app` on the
// settings read/write paths, never the tag CRUD paths exercised here, so the
// module-load import is all the tag tests need from it.
//
// `electron-store` is ESM-only and pulled in lazily via getStore(); the harness
// does not stub it, so we back it with an in-memory Map here. The variable is
// `mock`-prefixed so vitest permits referencing it inside the hoisted factory.
const mockStoreData = new Map<string, unknown>()

vi.mock('electron-store', () => ({
  default: class {
    get(key: string): unknown {
      return mockStoreData.get(key)
    }
    set(key: string, value: unknown): void {
      mockStoreData.set(key, value)
    }
    get store(): Record<string, unknown> {
      return Object.fromEntries(mockStoreData)
    }
  }
}))

// settings.ts caches its store instance in a module-scoped promise; reset the
// module registry between tests so each test starts from an empty store and a
// fresh cache. The in-memory Map is cleared explicitly (it lives in this file's
// scope, which resetModules does not touch).
async function loadSettings(): Promise<typeof import('../settings')> {
  return import('../settings')
}

beforeEach(() => {
  mockStoreData.clear()
  vi.resetModules()
})

/** Seed the store's `tags` key directly, bypassing the seeding-on-first-read. */
function seedTags(
  tags: Array<Partial<TagDef> & { id: string; name: string; color: string }>
): void {
  mockStoreData.set('tags', tags)
}

describe('readTags — kind coercion at the read boundary', () => {
  it('coerces absent / project / junk kinds per the truth table', async () => {
    seedTags([
      { id: 'a', name: 'Absent', color: '#111' }, // no kind
      { id: 'p', name: 'Project', color: '#222', kind: 'project' },
      { id: 'l', name: 'Label', color: '#333', kind: 'label' },
      // junk value that could exist on disk but isn't expressible in TagDef
      { id: 'j', name: 'Junk', color: '#444', kind: 'banana' as unknown as TagKind }
    ])
    const { readTags } = await loadSettings()
    const tags = await readTags()
    expect(tags.map((t) => t.kind)).toEqual(['label', 'project', 'label', 'label'])
  })

  it('reads a legacy v0.39 store (no kind on any tag) clean — all labels', async () => {
    seedTags([
      { id: 'general', name: 'General', color: '#9aa0a6' },
      { id: 'lanco', name: 'Lanco', color: '#c58af9' }
    ])
    const { readTags } = await loadSettings()
    const tags = await readTags()
    expect(tags.every((t) => t.kind === 'label')).toBe(true)
    // AC: the store is loaded unchanged — coercion must NOT write kind back.
    const persisted = mockStoreData.get('tags') as TagDef[]
    expect(persisted.every((t) => !('kind' in t))).toBe(true)
  })

  it('seeds defaults on first access and coerces them to labels', async () => {
    // no 'tags' key present -> first-access seeding path
    const { readTags } = await loadSettings()
    const tags = await readTags()
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.every((t) => t.kind === 'label')).toBe(true)
  })

  it('tolerates a non-array tags value without throwing', async () => {
    mockStoreData.set('tags', 'corrupt')
    const { readTags } = await loadSettings()
    await expect(readTags()).resolves.toEqual([])
  })
})

describe('addTag — persists kind', () => {
  it('persists an explicit project kind and round-trips through a re-read', async () => {
    const { addTag, readTags } = await loadSettings()
    const created = await addTag('Revamp', '#c58af9', 'project')
    expect(created.kind).toBe('project')
    const reread = await readTags()
    expect(reread.find((t) => t.id === created.id)?.kind).toBe('project')
  })

  it('defaults kind to label when omitted', async () => {
    const { addTag } = await loadSettings()
    const created = await addTag('Weekly Sync', '#8ab4f8')
    expect(created.kind).toBe('label')
  })

  it('still rejects duplicate names (behaviour unchanged by the kind arg)', async () => {
    const { addTag } = await loadSettings()
    await addTag('Standup', '#8ab4f8', 'label')
    await expect(addTag('standup', '#000', 'project')).rejects.toThrow(/already exists/)
  })
})

describe('updateTag — flips kind', () => {
  it('flips a label to a project and back, persisting each time', async () => {
    const { addTag, updateTag, readTags } = await loadSettings()
    // Start from an explicitly-empty store so addTag doesn't collide with a
    // default-seed tag (the built-in seed includes a "Client" tag).
    seedTags([])
    const tag = await addTag('Client', '#a1e3a1') // label by default
    const toProject = await updateTag(tag.id, { kind: 'project' })
    expect(toProject.kind).toBe('project')
    expect((await readTags()).find((t) => t.id === tag.id)?.kind).toBe('project')

    const backToLabel = await updateTag(tag.id, { kind: 'label' })
    expect(backToLabel.kind).toBe('label')
  })

  it('preserves kind when the patch omits it (name-only edit)', async () => {
    const { addTag, updateTag } = await loadSettings()
    // Start from an explicitly-empty store so addTag doesn't collide with a
    // default-seed tag (the built-in seed includes an "Interview" tag).
    seedTags([])
    const tag = await addTag('Interview', '#fdd663', 'project')
    const renamed = await updateTag(tag.id, { name: 'Interviews' })
    expect(renamed.name).toBe('Interviews')
    expect(renamed.kind).toBe('project')
  })
})
