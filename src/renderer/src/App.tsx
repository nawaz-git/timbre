import { useCallback, useEffect, useState } from 'react'
import {
  Home as HomeIcon,
  Mic,
  Network as NetworkIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SettingsProvider, useSettings } from './state/settings'
import { TagsProvider } from './state/tags'
import { HomeView } from './views/Home'
import { MeetingsView } from './views/Meetings'
import { NetworkView } from './views/Network'
import { Onboarding } from './views/Onboarding'
import { SettingsView } from './views/Settings'

type ViewKey = 'home' | 'meetings' | 'network' | 'settings'

interface NavItem {
  key: ViewKey
  label: string
  subtitle: string
  title: string
  /** Lucide component rendered at 16px inside the nav-item icon slot. */
  Icon: LucideIcon
  /** Human-readable keyboard shortcut shown on the right of the nav row. */
  shortcut: string
  /** Bare key portion of the shortcut, matched against `e.key`. */
  shortcutKey: '1' | '2' | '3' | '4'
}

const NAV: NavItem[] = [
  {
    key: 'home',
    label: 'Home',
    title: 'Home',
    subtitle: 'Record and import audio',
    Icon: HomeIcon,
    shortcut: '⌘1',
    shortcutKey: '1'
  },
  {
    key: 'meetings',
    label: 'Meetings',
    title: 'Meetings',
    subtitle: 'Past transcripts',
    Icon: Mic,
    shortcut: '⌘2',
    shortcutKey: '2'
  },
  {
    key: 'network',
    label: 'Network',
    title: 'Network',
    subtitle: 'People + meetings, mapped — on your Mac, never uploaded',
    Icon: NetworkIcon,
    shortcut: '⌘3',
    shortcutKey: '3'
  },
  {
    key: 'settings',
    label: 'Settings',
    title: 'Settings',
    subtitle: 'Preferences and about',
    Icon: SettingsIcon,
    shortcut: '⌘4',
    shortcutKey: '4'
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

  // A "Transcript ready" notification (fired from the main process) can ask
  // the UI to jump straight to the finished meeting. Same effect as clicking
  // a recent-meeting row.
  useEffect(() => {
    return window.api.system.onOpenMeeting((id) => openMeeting(id))
  }, [openMeeting])

  const toggleSidebar = useCallback(() => {
    void setSettings({ sidebarCollapsed: !collapsed })
  }, [collapsed, setSettings])

  // Global keyboard shortcuts:
  //   ⌘\             — toggle the sidebar
  //   ⌘1 / 2 / 3 / 4 — switch to Home / Meetings / Network / Settings
  //
  // Bound at the document level so they work regardless of which pane has
  // focus. We early-out when an INPUT/TEXTAREA owns focus so we don't
  // hijack normal text entry (e.g. typing "1" in a tag-rename field).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return

      if (e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
        return
      }
      const hit = NAV.find((n) => n.shortcutKey === e.key)
      if (hit) {
        e.preventDefault()
        setView(hit.key)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [toggleSidebar])

  return (
    <div className={'app' + (collapsed ? ' app--sidebar-collapsed' : '')}>
      <aside className={'sidebar' + (collapsed ? ' sidebar--collapsed' : '')}>
        {/*
          Top row — just the collapse toggle. No brand mark / wordmark
          (the macOS menubar already shows "Mintr"). Sits just below the
          44px-tall reserved strip that clears the traffic lights.
        */}
        <div className="sidebar__top">
          <button
            type="button"
            className="sidebar__toggle"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
            title={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
            aria-keyshortcuts="Meta+\\"
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
                className={'sidebar__nav-item' + (active ? ' sidebar__nav-item--active' : '')}
                onClick={() => setView(item.key)}
                title={collapsed ? `${item.label} (${item.shortcut})` : undefined}
                aria-label={item.label}
                aria-keyshortcuts={`Meta+${item.shortcutKey}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="sidebar__nav-icon" aria-hidden="true">
                  <Icon size={16} strokeWidth={1.75} />
                </span>
                <span className="sidebar__nav-label">{item.label}</span>
                <span className="sidebar__nav-shortcut" aria-hidden="true">
                  {item.shortcut}
                </span>
              </button>
            )
          })}
        </nav>

        <div className="sidebar__footer">
          <span className="sidebar__footer-line">On-device transcription.</span>
          <span className="sidebar__footer-line">Audio never leaves your Mac.</span>
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
          {view === 'home' && (
            <HomeView onOpenMeeting={openMeeting} onViewAll={() => setView('meetings')} />
          )}
          {view === 'meetings' && (
            <MeetingsView
              initialMeetingId={initialMeetingId}
              onInitialMeetingConsumed={() => setInitialMeetingId(null)}
            />
          )}
          {view === 'network' && <NetworkView onOpenMeeting={openMeeting} />}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
    </div>
  )
}

/**
 * TICKET-UI-003 gate. Sits inside SettingsProvider so it can read settings.
 * When settings have loaded and the user has never completed onboarding
 * (`!onboardingCompletedAt`), we early-return the full-pane wizard INSTEAD of
 * the normal AppShell body — the AppShell (nav, ⌘1-4 shortcuts, sidebar) is
 * left completely intact and simply not mounted until onboarding is done.
 * While settings are still loading we render nothing to avoid a wizard flash.
 */
function Root(): JSX.Element | null {
  const { settings } = useSettings()
  if (!settings) return null
  if (!settings.onboardingCompletedAt) return <Onboarding />
  return <AppShell />
}

export default function App(): JSX.Element {
  return (
    <SettingsProvider>
      <TagsProvider>
        <Root />
      </TagsProvider>
    </SettingsProvider>
  )
}
