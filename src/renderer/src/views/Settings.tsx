import { useCallback } from 'react'
import { useSettings } from '../state/settings'
import type { ThemeMode } from '../../../shared/types'

const THEME_OPTIONS: ThemeMode[] = ['auto', 'light', 'dark']
const THEME_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark'
}

const APP_VERSION = APP_VERSION_PLACEHOLDER

export function SettingsView(): JSX.Element {
  const { settings, setSettings } = useSettings()

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

      <div className="settings__group">
        <div className="settings__label">About</div>
        <div className="about-block">
          <div className="about-block__row">
            <span>Meeting Transcriber</span>
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
