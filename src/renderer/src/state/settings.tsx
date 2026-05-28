import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Settings, ThemeMode } from '../../../shared/types'

interface SettingsContextValue {
  settings: Settings | null
  loading: boolean
  setSettings: (patch: Partial<Settings>) => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

/** Resolve "auto" against the OS preference and apply the result to <html>. */
function applyTheme(theme: ThemeMode): void {
  const resolved: 'light' | 'dark' =
    theme === 'auto'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme
  document.documentElement.setAttribute('data-theme', resolved)
}

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)

  // Initial load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await window.api.settings.get()
        if (!cancelled) {
          setSettingsState(current)
          applyTheme(current.theme)
        }
      } catch (err) {
        console.error('Failed to load settings', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Re-resolve "auto" theme on OS-level changes.
  useEffect(() => {
    if (!settings || settings.theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = (): void => applyTheme('auto')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [settings])

  const setSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.api.settings.set(patch)
    setSettingsState(next)
    applyTheme(next.theme)
  }, [])

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, setSettings }),
    [settings, loading, setSettings]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}
