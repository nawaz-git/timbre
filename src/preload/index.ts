import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/types'
import type {
  BackendEvent,
  BackendJob,
  EnrolledSpeaker,
  ExportFormat,
  ImportResult,
  MeetingSummary,
  MeetingTranscript,
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
    setTags: (meetingId: string, tagIds: string[]): Promise<{ tagIds: string[] }> =>
      ipcRenderer.invoke(IPC.meetingsSetTags, meetingId, tagIds)
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
