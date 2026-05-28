import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { IPC } from '../../shared/types'
import type {
  BackendJob,
  EnrolledSpeaker,
  ExportFormat,
  ImportResult,
  MeetingSummary,
  MeetingTranscript,
  RecordingStatus,
  Settings,
  TagDef
} from '../../shared/types'
import {
  deleteSpeakerFromGlobalDB,
  listEnrolledSpeakers,
  numSpeakersToArg
} from '../backend'
import {
  addSpeakerToMeeting,
  exportMeeting,
  previewExportMeeting,
  listMeetings,
  liveRecordingsRoot,
  readTranscript,
  reassignSegmentSpeaker,
  renameMeetingTitle,
  renameSpeakerInMeeting,
  setMeetingTags,
  type ExportPreview
} from '../meetings'
import {
  getStatus,
  importFile,
  reanalyzeMeetingProc,
  startWatching,
  stopWatching
} from '../recording'
import {
  addTag,
  deleteTag,
  readSettings,
  readTags,
  updateTag,
  writeSettings
} from '../settings'

/** Register every IPC handler. Called once after `app.whenReady()`. */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => {
    return readSettings()
  })

  ipcMain.handle(IPC.settingsSet, async (_event, patch: Partial<Settings>): Promise<Settings> => {
    return writeSettings(patch)
  })

  ipcMain.handle(IPC.recordingStart, async (): Promise<RecordingStatus> => {
    console.log('[recording] start')
    return startWatching()
  })

  ipcMain.handle(IPC.recordingStop, async (): Promise<RecordingStatus> => {
    console.log('[recording] stop')
    return stopWatching()
  })

  ipcMain.handle(IPC.recordingStatus, async (): Promise<RecordingStatus> => {
    return getStatus()
  })

  ipcMain.handle(IPC.meetingsList, async (): Promise<MeetingSummary[]> => {
    const settings = await readSettings()
    return listMeetings(settings.outputFolder)
  })

  ipcMain.handle(IPC.meetingsOpen, async (_event, folderPath: string): Promise<string> => {
    return shell.openPath(folderPath)
  })

  ipcMain.handle(
    IPC.meetingsTranscript,
    async (_event, meetingId: string): Promise<MeetingTranscript> => {
      const settings = await readSettings()
      return readTranscript(settings.outputFolder, meetingId)
    }
  )

  ipcMain.handle(IPC.fileImport, async (event): Promise<ImportResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Import audio file',
          properties: ['openFile'],
          filters: [
            { name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff'] }
          ]
        })
      : await dialog.showOpenDialog({
          title: 'Import audio file',
          properties: ['openFile'],
          filters: [
            { name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff'] }
          ]
        })
    if (result.canceled || result.filePaths.length === 0) return {}
    return { filePath: result.filePaths[0] }
  })

  ipcMain.handle(IPC.openLiveFolder, async (): Promise<string> => {
    // shell.openPath creates the folder via Finder if it doesn't exist —
    // the engine creates it on first recording, so it might not exist yet.
    // Open the parent if so.
    return shell.openPath(liveRecordingsRoot)
  })

  ipcMain.handle(IPC.pickFolder, async (event): Promise<ImportResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose output folder',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Choose output folder',
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || result.filePaths.length === 0) return {}
    return { filePath: result.filePaths[0] }
  })

  ipcMain.handle(
    IPC.backendSpawn,
    async (_event, filePath: string, outputDir: string): Promise<BackendJob> => {
      const jobId = randomUUID()
      const settings = await readSettings()
      const numSpeakers = numSpeakersToArg(settings.numSpeakers)
      console.log('[backend:spawn]', { jobId, filePath, outputDir, numSpeakers })
      // Fire-and-forget: kicks off transcription in main, surfaces progress
      // via `backend:event` IPC + recording.status polling. The renderer
      // receives the jobId immediately so it can correlate later events.
      importFile(filePath, outputDir, jobId, numSpeakers)
        .then((result) => {
          console.log('[backend:spawn] done', result)
        })
        .catch((err: Error) => {
          console.error('[backend:spawn] failed', err.message)
        })
      return { jobId, filePath, outputDir }
    }
  )

  ipcMain.handle(
    IPC.meetingsRenameSpeaker,
    async (
      _event,
      meetingId: string,
      oldName: string,
      newName: string
    ): Promise<{ enrolled: boolean }> => {
      const settings = await readSettings()
      return renameSpeakerInMeeting(settings.outputFolder, meetingId, oldName, newName)
    }
  )

  ipcMain.handle(
    IPC.meetingsReassignSegment,
    async (
      _event,
      meetingId: string,
      segmentIndex: number,
      newSpeaker: string
    ): Promise<{ speakerCount: number; newSpeaker: string }> => {
      const settings = await readSettings()
      return reassignSegmentSpeaker(
        settings.outputFolder,
        meetingId,
        segmentIndex,
        newSpeaker
      )
    }
  )

  ipcMain.handle(
    IPC.meetingsAddSpeaker,
    async (
      _event,
      meetingId: string,
      speakerName: string
    ): Promise<{ additionalSpeakers: string[] }> => {
      const settings = await readSettings()
      return addSpeakerToMeeting(settings.outputFolder, meetingId, speakerName)
    }
  )

  ipcMain.handle(
    IPC.meetingsReanalyze,
    async (
      _event,
      meetingId: string,
      numSpeakers?: number
    ): Promise<BackendJob> => {
      const jobId = randomUUID()
      const settings = await readSettings()
      const hint = typeof numSpeakers === 'number'
        ? numSpeakers
        : numSpeakersToArg(settings.numSpeakers)
      console.log('[meetings:reanalyze]', { jobId, meetingId, hint })
      reanalyzeMeetingProc({
        outputFolder: settings.outputFolder,
        meetingId,
        jobId,
        numSpeakers: hint
      })
        .then((result) => {
          console.log('[meetings:reanalyze] done', result)
        })
        .catch((err: Error) => {
          console.error('[meetings:reanalyze] failed', err.message)
        })
      return { jobId, filePath: meetingId, outputDir: settings.outputFolder }
    }
  )

  ipcMain.handle(IPC.speakersList, async (): Promise<EnrolledSpeaker[]> => {
    return listEnrolledSpeakers()
  })

  ipcMain.handle(IPC.speakersDelete, async (_event, name: string): Promise<void> => {
    return deleteSpeakerFromGlobalDB(name)
  })

  ipcMain.handle(
    IPC.meetingsRenameTitle,
    async (_event, meetingId: string, newTitle: string): Promise<{ title: string }> => {
      const settings = await readSettings()
      return renameMeetingTitle(settings.outputFolder, meetingId, newTitle)
    }
  )

  ipcMain.handle(
    IPC.meetingsExport,
    async (
      event,
      meetingId: string,
      format: ExportFormat,
      title: string
    ): Promise<{ savedTo?: string; canceled?: boolean }> => {
      const settings = await readSettings()
      const payload = await exportMeeting(
        settings.outputFolder,
        meetingId,
        format,
        title || 'Meeting'
      )
      const win = BrowserWindow.fromWebContents(event.sender)
      const dialogOpts = {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: payload.filename,
        filters: filtersForFormat(format)
      }
      const result = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts)
      if (result.canceled || !result.filePath) return { canceled: true }
      if (typeof payload.body === 'string') {
        await fs.writeFile(result.filePath, payload.body, 'utf-8')
      } else {
        await fs.writeFile(result.filePath, payload.body)
      }
      return { savedTo: result.filePath }
    }
  )

  // Preview-only sibling to `meetings:export`. Returns the would-be
  // export payload in-memory so the renderer can show it in the new
  // Export-tab preview pane WITHOUT prompting the user to pick a save
  // path. The Save dialog flow stays the only writer to disk — this
  // handler never touches the filesystem beyond `fs.stat` for audio.
  ipcMain.handle(
    IPC.meetingsExportPreview,
    async (
      _event,
      meetingId: string,
      format: ExportFormat,
      title: string
    ): Promise<ExportPreview> => {
      const settings = await readSettings()
      return previewExportMeeting(
        settings.outputFolder,
        meetingId,
        format,
        title || 'Meeting'
      )
    }
  )

  ipcMain.handle(IPC.tagsList, async (): Promise<TagDef[]> => readTags())

  ipcMain.handle(
    IPC.tagsAdd,
    async (_event, name: string, color: string): Promise<TagDef> => addTag(name, color)
  )

  ipcMain.handle(
    IPC.tagsUpdate,
    async (
      _event,
      id: string,
      patch: { name?: string; color?: string }
    ): Promise<TagDef> => updateTag(id, patch)
  )

  ipcMain.handle(IPC.tagsDelete, async (_event, id: string): Promise<void> => deleteTag(id))

  ipcMain.handle(
    IPC.meetingsSetTags,
    async (_event, meetingId: string, tagIds: string[]): Promise<{ tagIds: string[] }> => {
      const settings = await readSettings()
      return setMeetingTags(settings.outputFolder, meetingId, tagIds)
    }
  )
}

function filtersForFormat(format: ExportFormat): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'txt':
      return [{ name: 'Plain text', extensions: ['txt'] }]
    case 'md':
      return [{ name: 'Markdown', extensions: ['md'] }]
    case 'json':
      return [{ name: 'JSON', extensions: ['json'] }]
    case 'srt':
      return [{ name: 'SubRip subtitles', extensions: ['srt'] }]
    case 'audio':
      return [{ name: 'WAV audio', extensions: ['wav'] }]
  }
}
