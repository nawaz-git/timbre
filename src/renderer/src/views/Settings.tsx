import { useCallback, useState } from 'react'
import { useSettings } from '../state/settings'
import { useTags } from '../state/tags'
import type { TagDef, ThemeMode } from '../../../shared/types'

const THEME_OPTIONS: ThemeMode[] = ['auto', 'light', 'dark']
const THEME_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark'
}

const APP_VERSION = APP_VERSION_PLACEHOLDER

const NEW_TAG_PALETTE = [
  '#9aa0a6', '#8ab4f8', '#a1e3a1', '#fdd663', '#c58af9', '#f28b82', '#79d5ff', '#ff8a65'
]

export function SettingsView(): JSX.Element {
  const { settings, setSettings } = useSettings()
  const { tags, addTag, updateTag, deleteTag } = useTags()
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(NEW_TAG_PALETTE[0])
  const [tagError, setTagError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const onPickFolder = useCallback(async () => {
    const result = await window.api.settings.pickFolder()
    if (!result.filePath) return
    await setSettings({ outputFolder: result.filePath })
  }, [setSettings])

  const onTheme = useCallback(
    async (theme: ThemeMode) => {
      await setSettings({ theme })
    },
    [setSettings]
  )

  const onAddTag = useCallback(async () => {
    setTagError(null)
    const name = newTagName.trim()
    if (!name) return
    try {
      await addTag(name, newTagColor)
      setNewTagName('')
      setNewTagColor(NEW_TAG_PALETTE[(NEW_TAG_PALETTE.indexOf(newTagColor) + 1) % NEW_TAG_PALETTE.length])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTagError(msg)
    }
  }, [addTag, newTagName, newTagColor])

  const onUpdateTagColor = useCallback(
    async (tag: TagDef, color: string) => {
      await updateTag(tag.id, { color })
    },
    [updateTag]
  )

  const beginEditTag = useCallback((tag: TagDef) => {
    setEditingId(tag.id)
    setEditingName(tag.name)
  }, [])

  const commitEditTag = useCallback(async () => {
    if (!editingId) return
    const name = editingName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    await updateTag(editingId, { name })
    setEditingId(null)
  }, [editingId, editingName, updateTag])

  if (!settings) {
    return <div className="empty">Loading settings…</div>
  }

  return (
    <div className="settings">
      <div className="settings__group">
        <div className="settings__label">Output folder (file imports)</div>
        <div className="settings__value">
          <div className="settings__path" title={settings.outputFolder}>
            {settings.outputFolder}
          </div>
          <button
            className="btn"
            onClick={() => {
              void onPickFolder()
            }}
          >
            Choose…
          </button>
        </div>
      </div>

      <div className="settings__group">
        <div className="settings__label">Live recordings folder</div>
        <div className="settings__value">
          <div
            className="settings__path"
            title="The bundled engine writes live recordings to ~/Downloads/MeetingTranscriber/. Both file imports and live recordings show up unified in the Meetings tab."
          >
            ~/Downloads/MeetingTranscriber/
          </div>
          <button
            className="btn"
            onClick={() => {
              void window.api.settings.openLiveFolder()
            }}
          >
            Open in Finder
          </button>
        </div>
      </div>

      <div className="settings__group">
        <div className="settings__label">Theme</div>
        <div className="theme-toggle" role="group" aria-label="Theme">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t}
              className={
                'theme-toggle__option' +
                (settings.theme === t ? ' theme-toggle__option--active' : '')
              }
              onClick={() => {
                void onTheme(t)
              }}
            >
              {THEME_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tags ─────────────────────────────────────────────────── */}
      <div className="settings__group">
        <div className="settings__label">Tags</div>
        <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 12 }}>
          Apply tags to meetings to filter the Meetings list by project or type. Click a swatch
          to change a tag's colour, or the name to rename it.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {tags.map((tag) => (
            <div
              key={tag.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '6px 0'
              }}
            >
              <input
                type="color"
                value={tag.color}
                onChange={(e) => void onUpdateTagColor(tag, e.target.value)}
                style={{
                  width: 24,
                  height: 24,
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer'
                }}
                title="Change colour"
              />
              {editingId === tag.id ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => void commitEditTag()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitEditTag()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="speaker-rename-input"
                  style={{ flex: 1 }}
                />
              ) : (
                <button
                  onClick={() => beginEditTag(tag)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    color: 'var(--fg)',
                    fontSize: 13,
                    padding: '2px 4px',
                    cursor: 'text',
                    borderRadius: 4
                  }}
                  title="Click to rename"
                >
                  {tag.name}
                </button>
              )}
              <button
                className="btn btn--small"
                onClick={() => {
                  if (confirm(`Delete tag "${tag.name}"? Meetings keep their tag ids but the label disappears.`)) {
                    void deleteTag(tag.id)
                  }
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            style={{
              width: 24,
              height: 24,
              padding: 0,
              border: 'none',
              background: 'none',
              cursor: 'pointer'
            }}
          />
          <input
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onAddTag()
            }}
            placeholder="New tag name…"
            className="speaker-rename-input"
            style={{ flex: 1 }}
          />
          <button
            className="btn btn--primary btn--small"
            onClick={() => void onAddTag()}
            disabled={!newTagName.trim()}
          >
            Add tag
          </button>
        </div>
        {tagError && (
          <div className="status-detail" style={{ color: 'var(--danger, #ef4444)' }}>
            {tagError}
          </div>
        )}
      </div>

      <div className="settings__group">
        <div className="settings__label">About</div>
        <div className="about-block">
          <div className="about-block__row">
            <span>Mintr</span>
            <span>v{APP_VERSION}</span>
          </div>
          <div className="about-block__row">
            <span>Project</span>
            <a
              href="https://github.com/nawazpasha/meeting-transcriber"
              target="_blank"
              rel="noreferrer"
            >
              github.com/nawazpasha/meeting-transcriber
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
