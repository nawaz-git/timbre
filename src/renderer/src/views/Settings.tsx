import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import {
  Folder,
  Info,
  Monitor,
  Palette,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Tag as TagIcon,
  Trash2
} from 'lucide-react'
import mintrMark from '../assets/mintr-mark.png'
import { PermissionChecklist } from '../components/PermissionChecklist'
import { useSettings } from '../state/settings'
import { useOnboardingComplete } from '../state/onboarding'
import { useTags } from '../state/tags'
import type { ScreenCaptureScope, TagDef, ThemeMode } from '../../../shared/types'

const THEME_OPTIONS: ThemeMode[] = ['auto', 'light', 'dark']
const THEME_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark'
}

const SCREEN_SCOPE_OPTIONS: ReadonlyArray<{ value: ScreenCaptureScope; label: string }> = [
  { value: 'chromeWindow', label: 'Chrome tab' },
  { value: 'entireScreen', label: 'Entire screen' }
]

const APP_VERSION = APP_VERSION_PLACEHOLDER

const NEW_TAG_PALETTE = [
  '#9aa0a6',
  '#8ab4f8',
  '#a1e3a1',
  '#fdd663',
  '#c58af9',
  '#f28b82',
  '#79d5ff',
  '#ff8a65'
]

/**
 * Settings sections share the same card shell: heading row (lucide icon +
 * label) above a divider, body rows below. Pulled out as a component so the
 * structure is uniform across Output / Appearance / Tags / About — the
 * exact pattern Linear and iOS Settings both lean on.
 */
function Section({
  icon,
  title,
  children
}: {
  icon: JSX.Element
  title: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <span className="settings-section__icon" aria-hidden="true">
          {icon}
        </span>
        <h2 className="settings-section__title">{title}</h2>
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  )
}

function SettingsRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__label">{label}</div>
      {description && <div className="settings-row__description">{description}</div>}
      <div className="settings-row__value">{children}</div>
    </div>
  )
}

export function SettingsView(): JSX.Element {
  const { settings, setSettings } = useSettings()
  const { reset: rerunWizard } = useOnboardingComplete()
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
      setNewTagColor(
        NEW_TAG_PALETTE[(NEW_TAG_PALETTE.indexOf(newTagColor) + 1) % NEW_TAG_PALETTE.length]
      )
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
    return (
      <div className="settings">
        <div className="skeleton-row" />
        <div className="skeleton-row" />
        <div className="skeleton-row" />
      </div>
    )
  }

  return (
    <div className="settings">
      {/* ── Setup & Permissions (TICKET-UI-003) ────────────────────── */}
      <Section icon={<ShieldCheck size={16} />} title="Setup & Permissions">
        <div className="settings-row__description settings-row__description--top">
          The bundled engine needs these macOS permissions to capture meetings. Grant any that
          aren&apos;t green, or re-run the guided first-run wizard.
        </div>
        <PermissionChecklist mode="settings" />
        <div className="settings-row__value">
          <button
            className="btn"
            onClick={() => {
              void rerunWizard()
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>Re-run setup wizard</span>
          </button>
        </div>
      </Section>

      {/* ── Output ─────────────────────────────────────────────────── */}
      <Section icon={<Folder size={16} />} title="Output">
        <SettingsRow
          label="Output folder"
          description="Where transcripts from imported audio files are saved."
        >
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
        </SettingsRow>

        <SettingsRow
          label="Live recordings folder"
          description="The bundled engine writes live recordings here. Both file imports and live recordings show up unified in the Meetings tab."
        >
          <div className="settings__path">~/Downloads/MeetingTranscriber/</div>
          <button
            className="btn"
            onClick={() => {
              void window.api.settings.openLiveFolder()
            }}
          >
            Open in Finder
          </button>
        </SettingsRow>
      </Section>

      {/* ── Background behaviour ───────────────────────────────────── */}
      <Section icon={<Play size={16} />} title="Background behaviour">
        <SettingsRow
          label="Auto-start watching on launch"
          description="Timbre lives in the menubar like Tailscale or 1Password. When this is on, Timbre begins watching for meetings the moment it starts — so a Meet you join won't slip past unrecorded. Turn it off to require an explicit Start each session."
        >
          <label className="toggle-switch" title="Auto-start watching">
            <input
              type="checkbox"
              checked={settings.autoStartWatching}
              onChange={(e) => {
                void setSettings({ autoStartWatching: e.target.checked })
              }}
            />
            <span className="toggle-switch__track" aria-hidden="true">
              <span className="toggle-switch__thumb" />
            </span>
            <span className="toggle-switch__label">
              {settings.autoStartWatching ? 'On' : 'Off'}
            </span>
          </label>
        </SettingsRow>
      </Section>

      {/* ── Recording ──────────────────────────────────────────────── */}
      <Section icon={<Monitor size={16} />} title="Recording">
        <SettingsRow
          label="Screen capture"
          description="Record only the meeting's Chrome window, or the entire screen."
        >
          <div className="theme-toggle" role="group" aria-label="Screen capture">
            {SCREEN_SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={
                  'theme-toggle__option' +
                  (settings.screenCaptureScope === opt.value ? ' theme-toggle__option--active' : '')
                }
                onClick={() => {
                  void setSettings({ screenCaptureScope: opt.value })
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Disable app audio capture"
          description="Record the microphone and screen only, without tapping the browser's audio. Turn this on if capturing meeting audio ever destabilises your browser — your voice is still recorded and transcribed."
        >
          <label className="toggle-switch" title="Disable app audio capture">
            <input
              type="checkbox"
              checked={settings.disableAppAudioTap}
              onChange={(e) => {
                void setSettings({ disableAppAudioTap: e.target.checked })
              }}
            />
            <span className="toggle-switch__track" aria-hidden="true">
              <span className="toggle-switch__thumb" />
            </span>
            <span className="toggle-switch__label">
              {settings.disableAppAudioTap ? 'On' : 'Off'}
            </span>
          </label>
        </SettingsRow>
      </Section>

      {/* ── Appearance ─────────────────────────────────────────────── */}
      <Section icon={<Palette size={16} />} title="Appearance">
        <SettingsRow label="Theme" description="Follow the system, or force light or dark.">
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
        </SettingsRow>
      </Section>

      {/* ── Tags ───────────────────────────────────────────────────── */}
      <Section icon={<TagIcon size={16} />} title="Tags">
        <div className="settings-row__description settings-row__description--top">
          Apply tags to meetings to filter the Meetings list by project or type. Click a swatch to
          change a tag&apos;s colour, or the name to rename it.
        </div>

        {tags.length > 0 && (
          <div className="tag-manager">
            {tags.map((tag) => (
              <div key={tag.id} className="tag-manager__row">
                <label
                  className="tag-manager__swatch"
                  style={{ background: tag.color }}
                  title="Change colour"
                >
                  <input
                    type="color"
                    value={tag.color}
                    onChange={(e) => void onUpdateTagColor(tag, e.target.value)}
                    className="tag-manager__color-input"
                    aria-label={`Change colour for ${tag.name}`}
                  />
                </label>
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
                    className="tag-manager__name-input"
                  />
                ) : (
                  <button
                    onClick={() => beginEditTag(tag)}
                    className="tag-manager__name"
                    title="Click to rename"
                  >
                    {tag.name}
                  </button>
                )}
                <button
                  className="tag-manager__delete"
                  aria-label={`Delete ${tag.name}`}
                  title={`Delete ${tag.name}`}
                  onClick={() => {
                    if (
                      confirm(
                        `Delete tag "${tag.name}"? Meetings keep their tag ids but the label disappears.`
                      )
                    ) {
                      void deleteTag(tag.id)
                    }
                  }}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="tag-manager__add">
          <label
            className="tag-manager__swatch"
            style={{ background: newTagColor }}
            title="Pick colour"
          >
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="tag-manager__color-input"
              aria-label="New tag colour"
            />
          </label>
          <input
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onAddTag()
            }}
            placeholder="New tag name…"
            className="tag-manager__name-input tag-manager__name-input--add"
          />
          <button
            className="btn btn--primary btn--small"
            onClick={() => void onAddTag()}
            disabled={!newTagName.trim()}
          >
            <Plus size={14} aria-hidden="true" />
            <span>Add tag</span>
          </button>
        </div>
        {tagError && (
          <div className="settings-row__error" role="alert">
            {tagError}
          </div>
        )}
      </Section>

      {/* ── About ──────────────────────────────────────────────────── */}
      <Section icon={<Info size={16} />} title="About">
        <div className="about-brand">
          <span className="about-brand__mark" aria-hidden="true">
            <img src={mintrMark} alt="" width={36} height={36} draggable={false} />
          </span>
          <div className="about-brand__copy">
            <div className="about-brand__name">Timbre</div>
            <div className="about-brand__tagline">
              On-device meeting transcription. Audio never leaves your Mac.
            </div>
          </div>
          <span className="about-brand__version">v{APP_VERSION}</span>
        </div>
        <div className="about-links">
          <a
            href="https://github.com/nawazpasha/meeting-transcriber"
            target="_blank"
            rel="noreferrer"
            className="about-links__link"
          >
            github.com/nawazpasha/meeting-transcriber
          </a>
        </div>
      </Section>
    </div>
  )
}
