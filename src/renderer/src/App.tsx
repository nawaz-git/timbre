import { useCallback, useState } from 'react'
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
  /** Single-glyph icon shown in both collapsed and expanded modes. */
  icon: string
}

const NAV: NavItem[] = [
  {
    key: 'home',
    label: 'Home',
    title: 'Home',
    subtitle: 'Record and import audio',
    icon: '⏺'
  },
  {
    key: 'meetings',
    label: 'Meetings',
    title: 'Meetings',
    subtitle: 'Past transcripts',
    icon: '⚏'
  },
  {
    key: 'settings',
    label: 'Settings',
    title: 'Settings',
    subtitle: 'Preferences and about',
    icon: '⚙'
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

  return (
    <div className={'app' + (collapsed ? ' app--sidebar-collapsed' : '')}>
      <aside className={'sidebar' + (collapsed ? ' sidebar--collapsed' : '')}>
        <button
          type="button"
          className="sidebar__toggle"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '▸' : '◂'}
        </button>
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" />
          <span className="sidebar__brand-label">Transcriber</span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={
                'sidebar__nav-item' + (view === item.key ? ' sidebar__nav-item--active' : '')
              }
              onClick={() => setView(item.key)}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
            >
              <span className="sidebar__nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="sidebar__nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar__footer">
          On-device transcription.
          <br />
          Audio never leaves your Mac.
        </div>
      </aside>

      <main className="content">
        <header className="content__header">
          <div className="content__title">{current.title}</div>
          <div className="content__subtitle">{current.subtitle}</div>
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
