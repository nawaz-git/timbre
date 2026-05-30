import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/types'
import type {
  BackendEvent,
  BackendJob,
  CaptureWatchdogSignal,
  ChromeMeetSnapshot,
  EnrolledSpeaker,
  ExportFormat,
  HelperPermissionSnapshot,
  ImportResult,
  MeetingSummary,
  MeetingTranscript,
  OnboardingRestartResult,
  OnboardingService,
  OnboardingVerifyResult,
  PermissionStatus,
  PrivacyPane,
  RecordingStatus,
  Settings,
  TagDef
} from '../shared/types'

/**
 * The single typed API surface the renderer is allowed to call. Anything
 * touching Node, the filesystem, or other privileged Electron APIs MUST go
 * through one of these methods — nodeIntegration is off in the renderer.
 */
const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
    pickFolder: (): Promise<ImportResult> => ipcRenderer.invoke(IPC.pickFolder),
    openLiveFolder: (): Promise<string> => ipcRenderer.invoke(IPC.openLiveFolder)
  },
  recording: {
    start: (): Promise<RecordingStatus> => ipcRenderer.invoke(IPC.recordingStart),
    stop: (): Promise<RecordingStatus> => ipcRenderer.invoke(IPC.recordingStop),
    status: (): Promise<RecordingStatus> => ipcRenderer.invoke(IPC.recordingStatus)
  },
  meetings: {
    list: (): Promise<MeetingSummary[]> => ipcRenderer.invoke(IPC.meetingsList),
    open: (folderPath: string): Promise<string> => ipcRenderer.invoke(IPC.meetingsOpen, folderPath),
    transcript: (meetingId: string): Promise<MeetingTranscript> =>
      ipcRenderer.invoke(IPC.meetingsTranscript, meetingId),
    renameSpeaker: (
      meetingId: string,
      oldName: string,
      newName: string
    ): Promise<{ enrolled: boolean }> =>
      ipcRenderer.invoke(IPC.meetingsRenameSpeaker, meetingId, oldName, newName),
    reassignSegment: (
      meetingId: string,
      segmentIndex: number,
      newSpeaker: string
    ): Promise<{ speakerCount: number; newSpeaker: string }> =>
      ipcRenderer.invoke(IPC.meetingsReassignSegment, meetingId, segmentIndex, newSpeaker),
    addSpeaker: (
      meetingId: string,
      speakerName: string
    ): Promise<{ additionalSpeakers: string[] }> =>
      ipcRenderer.invoke(IPC.meetingsAddSpeaker, meetingId, speakerName),
    removeSpeakerLabel: (
      meetingId: string,
      speakerName: string
    ): Promise<{ speakerCount: number }> =>
      ipcRenderer.invoke(IPC.meetingsRemoveSpeakerLabel, meetingId, speakerName),
    reanalyze: (meetingId: string, numSpeakers?: number): Promise<BackendJob> =>
      ipcRenderer.invoke(IPC.meetingsReanalyze, meetingId, numSpeakers),
    renameTitle: (meetingId: string, newTitle: string): Promise<{ title: string }> =>
      ipcRenderer.invoke(IPC.meetingsRenameTitle, meetingId, newTitle),
    export: (
      meetingId: string,
      format: ExportFormat,
      title: string
    ): Promise<{ savedTo?: string; canceled?: boolean }> =>
      ipcRenderer.invoke(IPC.meetingsExport, meetingId, format, title),
    /**
     * In-memory preview of what `export()` would write. Renderer uses this
     * to populate the Export-tab preview pane before the user commits to
     * saving. Audio is returned as metadata-only (no body) — the renderer
     * shows a size card instead of binary contents.
     */
    exportPreview: (
      meetingId: string,
      format: ExportFormat,
      title: string
    ): Promise<{
      filename: string
      body: string
      contentType: string
      isBinary?: boolean
      sizeBytes?: number
    }> => ipcRenderer.invoke(IPC.meetingsExportPreview, meetingId, format, title),
    setTags: (meetingId: string, tagIds: string[]): Promise<{ tagIds: string[] }> =>
      ipcRenderer.invoke(IPC.meetingsSetTags, meetingId, tagIds),
    delete: (meetingId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.meetingsDelete, meetingId)
  },
  speakers: {
    list: (): Promise<EnrolledSpeaker[]> => ipcRenderer.invoke(IPC.speakersList),
    delete: (name: string): Promise<void> => ipcRenderer.invoke(IPC.speakersDelete, name)
  },
  tags: {
    list: (): Promise<TagDef[]> => ipcRenderer.invoke(IPC.tagsList),
    add: (name: string, color: string): Promise<TagDef> =>
      ipcRenderer.invoke(IPC.tagsAdd, name, color),
    update: (id: string, patch: { name?: string; color?: string }): Promise<TagDef> =>
      ipcRenderer.invoke(IPC.tagsUpdate, id, patch),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.tagsDelete, id)
  },
  file: {
    import: (): Promise<ImportResult> => ipcRenderer.invoke(IPC.fileImport)
  },
  backend: {
    spawn: (filePath: string, outputDir: string): Promise<BackendJob> =>
      ipcRenderer.invoke(IPC.backendSpawn, filePath, outputDir),
    /**
     * Subscribe to progress events for any in-flight backend job. Returns
     * an unsubscribe function. Each event includes the originating `jobId`
     * so consumers can filter to a specific import.
     */
    onEvent: (handler: (ev: BackendEvent) => void): (() => void) => {
      const listener = (_: Electron.IpcRendererEvent, ev: BackendEvent): void => handler(ev)
      ipcRenderer.on('backend:event', listener)
      return () => {
        ipcRenderer.removeListener('backend:event', listener)
      }
    }
  },
  /**
   * System / TCC / Chrome-probe surface (v0.12+). Exposes:
   *   - permissions(): current macOS TCC state for Screen Recording, Mic, Automation
   *   - openSettings(): deep-link to a System Settings privacy pane
   *   - chromeMeet(): last AppleScript probe of Chrome / Brave / Edge tabs
   *   - onChromeMeetUpdate(): push subscription for live Meet-tab changes
   *   - showWindow(): bring the main Mintr window to the front (used by tray)
   *   - quit(): force-quit the app (used by tray)
   */
  system: {
    permissions: (): Promise<PermissionStatus> => ipcRenderer.invoke(IPC.systemPermissions),
    openSettings: (pane: PrivacyPane): Promise<void> =>
      ipcRenderer.invoke(IPC.systemOpenSettings, pane),
    chromeMeet: (): Promise<ChromeMeetSnapshot> => ipcRenderer.invoke(IPC.systemChromeMeet),
    onChromeMeetUpdate: (handler: (snap: ChromeMeetSnapshot) => void): (() => void) => {
      const listener = (
        _: Electron.IpcRendererEvent,
        snap: ChromeMeetSnapshot
      ): void => handler(snap)
      ipcRenderer.on('chrome-meet:update', listener)
      return () => {
        ipcRenderer.removeListener('chrome-meet:update', listener)
      }
    },
    showWindow: (): Promise<void> => ipcRenderer.invoke(IPC.systemShowWindow),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.systemQuit),
    /**
     * Force the bundled helper (MeetingTranscriber.app) to relaunch.
     * macOS doesn't refresh TCC permission state for a running process —
     * so when the user grants Screen Recording AFTER the helper has
     * started, the new permission doesn't kick in until the helper is
     * killed and respawned. This is the explicit user-driven way to
     * trigger that, surfaced as a button in the permission banner.
     */
    restartHelper: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.systemRestartHelper),
    /**
     * Open Finder with the bundled MeetingTranscriber.app highlighted so
     * the user can drag it directly onto System Settings → Screen
     * Recording's "+" dialog. macOS doesn't allow apps to add their own
     * TCC entries — drag-and-drop from Finder is the canonical path.
     */
    revealHelper: (): Promise<{ revealed: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.systemRevealHelper),
    /**
     * Subscribe to capture-watchdog signals (v0.13+). Fires when the
     * Chrome probe reports a live Meet for >25s but the bundled engine
     * helper hasn't written anything — i.e. the helper is silently
     * failing, almost certainly because its own TCC entry
     * (`com.meetingtranscriber.app`) hasn't been granted Screen Recording.
     */
    onWatchdogUpdate: (
      handler: (signal: CaptureWatchdogSignal) => void
    ): (() => void) => {
      const listener = (
        _: Electron.IpcRendererEvent,
        signal: CaptureWatchdogSignal
      ): void => handler(signal)
      ipcRenderer.on('capture-watchdog:update', listener)
      return () => {
        ipcRenderer.removeListener('capture-watchdog:update', listener)
      }
    },
    /**
     * Push channel — fires when a new meeting folder appears (or a
     * sub-file inside one changes) so the Home view + Meetings tab can
     * auto-refresh without polling. Debounced 1.5s on the main side.
     */
    onMeetingsChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('meetings:changed', listener)
      return () => {
        ipcRenderer.removeListener('meetings:changed', listener)
      }
    }
  },
  /**
   * Onboarding wizard surface (TICKET-IPC-002). Mirrors the IPC contract
   * the wizard (TICKET-UI-003) codes against. Unlike `system.permissions`,
   * `probe()` reports the HELPER's (`ai.nawaz.mintr-engine`) TCC state —
   * the correct principal — by preferring the engine's live verdict file
   * and falling back to the tccd subsystem log.
   */
  onboarding: {
    probe: (): Promise<HelperPermissionSnapshot> => ipcRenderer.invoke(IPC.onboardingProbe),
    openPane: (svc: OnboardingService): Promise<void> =>
      ipcRenderer.invoke(IPC.onboardingOpenPane, svc),
    revealHelper: (): Promise<{ revealed: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.onboardingRevealHelper),
    restartEngine: (): Promise<OnboardingRestartResult> =>
      ipcRenderer.invoke(IPC.onboardingRestartEngine),
    verifyEngine: (): Promise<OnboardingVerifyResult> =>
      ipcRenderer.invoke(IPC.onboardingVerifyEngine),
    complete: (): Promise<void> => ipcRenderer.invoke(IPC.onboardingComplete),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.onboardingReset)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // contextIsolation is supposed to be on — but mirror to window as a fallback so
  // a misconfigured build still works in dev.
  ;(window as unknown as { electron: typeof electronAPI }).electron = electronAPI
  ;(window as unknown as { api: Api }).api = api
}
