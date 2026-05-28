import { useCallback, useEffect, useState } from 'react'
import {
  Home as HomeIcon,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Sparkles
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SettingsProvider, useSettings } from './state/settings'
import { TagsProvider } from './state/tags'
import { HomeView } from './views/Home'
import { MeetingsView } from './views/Meetings'
import { SettingsView } from './views/Settings'

type ViewKey = 'home' | 'meetings' | 'settings'

interface NavItem {
  key: ViewKey
  label: string
  subtitle: string
  title: string
  /** Lucide component rendered at 18px inside the nav-item icon slot. */
  Icon: LucideIcon
}

const NAV: NavItem[] = [
  {
    key: 'home',
    label: 'Home',
    title: 'Home',
    subtitle: 'Record and import audio',
    Icon: HomeIcon
  },
  {
    key: 'meetings',
    label: 'Meetings',
    title: 'Meetings',
    subtitle: 'Past transcripts',
    Icon: Mic
  },
  {
    key: 'settings',
    label: 'Settings',
    title: 'Settings',
    subtitle: 'Preferences and about',
    Icon: SettingsIcon
  }
]

function AppShell(): JSX.Element {
  const [view, setView] = useState<ViewKey>('home')
  const [initialMeetingId, setInitialMeetingId] = useState<string | null>(null)
  const current = NAV.find((n) => n.key === view) ?? NAV[0]
  const { settings, setSettings } = useSettings()

  const collapsed = settings?.sidebarCollapsed ?? false

  const openMeeting = useCallback((id: string) => {
    setInitialMeetingId(id)
    setView('meetings')
  }, [])

  const toggleSidebar = useCallback(() => {
    void setSettings({ sidebarCollapsed: !collapsed })
  }, [collapsed, setSettings])

  // ⌘\ — global recovery shortcut so users can re-expand the sidebar even
  // if the toggle button is somehow obscured (e.g. behind macOS chrome on an
  // older build). Bound at the document level so it works regardless of
  // which pane has focus. We ignore the event when an input/textarea has
  // focus to avoid hijacking text entry on non-US layouts where the
  // backslash key may be used as a normal character.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.key !== '\\') return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      e.preventDefault()
      toggleSidebar()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [toggleSidebar])

  return (
    <div className={'app' + (collapsed ? ' app--sidebar-collapsed' : '')}>
      <aside className={'sidebar' + (collapsed ? ' sidebar--collapsed' : '')}>
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            <Sparkles size={14} strokeWidth={2} />
          </span>
          <span className="sidebar__brand-label">Mintr</span>
          <button
            type="button"
            className="sidebar__toggle"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
            title={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
        <nav className="sidebar__nav" aria-label="Primary">
          {NAV.map((item) => {
            const { Icon } = item
            const active = view === item.key
            return (
              <button
                key={item.key}
                type="button"
                className={
                  'sidebar__nav-item' + (active ? ' sidebar__nav-item--active' : '')
                }
                onClick={() => setView(item.key)}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
              >
                <span className="sidebar__nav-icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <span className="sidebar__nav-label">{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar__footer">
          On-device transcription.
          <br />
          Audio never leaves your Mac.
        </div>
      </aside>

      <main className="content">
        <header className="content__header">
          <div>
            <div className="content__title">{current.title}</div>
            <div className="content__subtitle">{current.subtitle}</div>
          </div>
        </header>
        <div className="content__body">
          {view === 'home' && <HomeView onOpenMeeting={openMeeting} />}
          {view === 'meetings' && (
            <MeetingsView
              initialMeetingId={initialMeetingId}
              onInitialMeetingConsumed={() => setInitialMeetingId(null)}
            />
          )}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <SettingsProvider>
      <TagsProvider>
        <AppShell />
      </TagsProvider>
    </SettingsProvider>
  )
}
