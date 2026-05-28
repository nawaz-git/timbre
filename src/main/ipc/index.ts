import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/types'
import type {
  BackendJob,
  ImportResult,
  MeetingSummary,
  MeetingTranscript,
  RecordingStatus,
  Settings
} from '../../shared/types'
import { listMeetings, liveRecordingsRoot, readTranscript } from '../meetings'
import { getStatus, importFile, startWatching, stopWatching } from '../recording'
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
      console.log('[backend:spawn]', { jobId, filePath, outputDir })
      // Fire-and-forget: kicks off transcription in main, surfaces progress
      // via `backend:event` IPC + recording.status polling. The renderer
      // receives the jobId immediately so it can correlate later events.
      importFile(filePath, outputDir, jobId)
        .then((result) => {
          console.log('[backend:spawn] done', result)
        })
        .catch((err: Error) => {
          console.error('[backend:spawn] failed', err.message)
        })
      return { jobId, filePath, outputDir }
    }
  )
}
