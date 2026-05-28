import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/types'
import type {
  BackendJob,
  EnrolledSpeaker,
  ImportResult,
  MeetingSummary,
  MeetingTranscript,
  RecordingStatus,
  Settings
} from '../../shared/types'
import {
  deleteSpeakerFromGlobalDB,
  listEnrolledSpeakers,
  numSpeakersToArg
} from '../backend'
import {
  listMeetings,
  liveRecordingsRoot,
  readTranscript,
  renameSpeakerInMeeting
} from '../meetings'
import {
  getStatus,
  importFile,
  reanalyzeMeetingProc,
  startWatching,
  stopWatching
} from '../recording'
import { readSettings, writeSettings } from '../settings'

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
}
