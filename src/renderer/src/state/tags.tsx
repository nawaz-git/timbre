import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TagDef, TagKind } from '../../../shared/types'

interface TagsContextValue {
  tags: TagDef[]
  /** Tags with `kind === 'project'` (memoised subset of `tags`). */
  projects: TagDef[]
  /** Tags that are plain filters — `kind !== 'project'` (memoised subset). */
  labels: TagDef[]
  loading: boolean
  refresh: () => Promise<void>
  addTag: (name: string, color: string, kind?: TagKind) => Promise<TagDef>
  updateTag: (
    id: string,
    patch: { name?: string; color?: string; kind?: TagKind }
  ) => Promise<TagDef>
  deleteTag: (id: string) => Promise<void>
  byId: (id: string) => TagDef | undefined
}

const TagsContext = createContext<TagsContextValue | null>(null)

export function TagsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tags, setTags] = useState<TagDef[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.tags.list()
      setTags(list)
    } catch (err) {
      console.error('Failed to load tags', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addTag = useCallback(
    async (name: string, color: string, kind?: TagKind) => {
      const tag = await window.api.tags.add(name, color, kind)
      await refresh()
      return tag
    },
    [refresh]
  )

  const updateTag = useCallback(
    async (id: string, patch: { name?: string; color?: string; kind?: TagKind }) => {
      const tag = await window.api.tags.update(id, patch)
      await refresh()
      return tag
    },
    [refresh]
  )

  const deleteTag = useCallback(
    async (id: string) => {
      await window.api.tags.delete(id)
      await refresh()
    },
    [refresh]
  )

  const byId = useCallback((id: string): TagDef | undefined => tags.find((t) => t.id === id), [
    tags
  ])

  // Derived, memoised partitions so consumers don't re-filter on every render.
  // `labels` is the complement of `projects` (kind absent ⇒ label), matching
  // the read-boundary coercion in the main process.
  const projects = useMemo(() => tags.filter((t) => t.kind === 'project'), [tags])
  const labels = useMemo(() => tags.filter((t) => t.kind !== 'project'), [tags])

  const value = useMemo<TagsContextValue>(
    () => ({ tags, projects, labels, loading, refresh, addTag, updateTag, deleteTag, byId }),
    [tags, projects, labels, loading, refresh, addTag, updateTag, deleteTag, byId]
  )

  return <TagsContext.Provider value={value}>{children}</TagsContext.Provider>
}

export function useTags(): TagsContextValue {
  const ctx = useContext(TagsContext)
  if (!ctx) throw new Error('useTags must be used inside <TagsProvider>')
  return ctx
}
