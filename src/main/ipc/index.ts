import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { IPC } from '../../shared/types'
import type {
  AppStatus,
  BackendJob,
  ChromeMeetSnapshot,
  ChromeProbeTestResult,
  DeleteOutcome,
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
  StorageUsage,
  TagDef,
  TranscriptSearchHit
} from '../../shared/types'
import { getPermissionStatus, openPrivacyPane } from '../permissions'
import { getChromeMeetSnapshot, probeOnce } from '../chromeProbe'
import { confirmIfRecording, getAppStatus } from '../status'
import { writeEngineConfig } from '../engineConfig'
import { showMainWindow } from '../tray'
import { deleteSpeakerFromGlobalDB, listEnrolledSpeakers, numSpeakersToArg } from '../backend'
import {
  addSpeakerToMeeting,
  computeStorageUsage,
  deleteMeeting,
  exportMeeting,
  findEngineAudioForPrefix,
  previewExportMeeting,
  listMeetings,
  liveRecordingsRoot,
  readTranscript,
  reassignSegmentSpeaker,
  removeSpeakerLabelInMeeting,
  renameMeetingTitle,
  renameSpeakerInMeeting,
  retryFailedMeeting,
  searchTranscripts,
  setMeetingTags,
  type ExportPreview
} from '../meetings'
import { withMeetingLock } from '../meetingLock'
import {
  getStatus,
  importFile,
  reanalyzeMeetingProc,
  startWatching,
  stopWatching
} from '../recording'
import { addTag, deleteTag, readSettings, readTags, updateTag, writeSettings } from '../settings'
import * as onboarding from '../onboarding'

/** Register every IPC handler. Called once after `app.whenReady()`. */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => {
    return readSettings()
  })

  ipcMain.handle(IPC.settingsSet, async (_event, patch: Partial<Settings>): Promise<Settings> => {
    const result = await writeSettings(patch)
    // Re-emit the engine bridge so a scope/mic change takes effect on the next
    // meeting. Best-effort — a failed bridge write must never fail the save.
    await writeEngineConfig().catch(() => {})
    // Reflect the login-item preference into the OS. Only meaningful for a
    // packaged build — in dev the executable is Electron itself, so skip the
    // syscall to avoid registering the dev binary as a login item.
    if (patch.launchAtLogin !== undefined && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: result.launchAtLogin })
      } catch (err) {
        console.warn('[ipc] setLoginItemSettings failed', err)
      }
    }
    return result
  })

  ipcMain.handle(IPC.recordingStart, async (): Promise<RecordingStatus> => {
    console.log('[recording] start')
    return await startWatching()
  })

  ipcMain.handle(IPC.recordingStop, async (): Promise<RecordingStatus> => {
    // Recording-aware guard: if a meeting is being recorded, confirm first so a
    // stray click can't silently end it. `confirmIfRecording` is a no-op (true)
    // when nothing is recording.
    if (!(await confirmIfRecording('stop'))) return getStatus()
    console.log('[recording] stop')
    // The engine's SIGTERM → escalation stop (inside `stopLiveRecorder`) already
    // gives a live recording time to finalise its WAV/transcript before the hard
    // kill, so no extra stop-grace is threaded here.
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
      importFile(filePath, outputDir, jobId, numSpeakers, settings.asrLanguage)
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
      return withMeetingLock(meetingId, () =>
        renameSpeakerInMeeting(settings.outputFolder, meetingId, oldName, newName)
      )
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
      return withMeetingLock(meetingId, () =>
        reassignSegmentSpeaker(settings.outputFolder, meetingId, segmentIndex, newSpeaker)
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
      return withMeetingLock(meetingId, () =>
        addSpeakerToMeeting(settings.outputFolder, meetingId, speakerName)
      )
    }
  )

  ipcMain.handle(
    IPC.meetingsRemoveSpeakerLabel,
    async (_event, meetingId: string, speakerName: string): Promise<{ speakerCount: number }> => {
      const settings = await readSettings()
      return withMeetingLock(meetingId, () =>
        removeSpeakerLabelInMeeting(settings.outputFolder, meetingId, speakerName)
      )
    }
  )

  ipcMain.handle(
    IPC.meetingsReanalyze,
    async (
      _event,
      meetingId: string,
      numSpeakers?: number,
      mode?: 'fast' | 'max'
    ): Promise<BackendJob> => {
      const jobId = randomUUID()
      const settings = await readSettings()
      const hint =
        typeof numSpeakers === 'number' ? numSpeakers : numSpeakersToArg(settings.numSpeakers)
      // Explicit mode wins (e.g. the "Re-process (Max accuracy)" action); else
      // fall back to the user's default processing tier.
      const effectiveMode = mode ?? settings.processingMode
      console.log('[meetings:reanalyze]', { jobId, meetingId, hint, mode: effectiveMode })
      reanalyzeMeetingProc({
        outputFolder: settings.outputFolder,
        meetingId,
        jobId,
        numSpeakers: hint,
        language: settings.asrLanguage,
        mode: effectiveMode
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

  ipcMain.handle(
    IPC.meetingsProcessNow,
    async (_event, meetingId: string): Promise<BackendJob> => {
      // Recover a processing/stuck engine meeting: run its recorded audio
      // through mt-batch, reusing the exact import path so the existing
      // backend:event progress + speaker-match wiring lights up. The recovered
      // transcript lands as a new imported meeting; nothing is deleted.
      if (!meetingId.startsWith('engine:')) {
        throw new Error('Only engine recordings can be processed with the built-in pipeline.')
      }
      const prefix = meetingId.slice('engine:'.length)
      const audioPath = await findEngineAudioForPrefix(prefix)
      if (!audioPath) throw new Error('This meeting has no audio file to process.')
      const settings = await readSettings()
      const jobId = randomUUID()
      const numSpeakers = numSpeakersToArg(settings.numSpeakers)
      console.log('[meetings:processNow]', { jobId, meetingId, audioPath })
      importFile(audioPath, settings.outputFolder, jobId, numSpeakers)
        .then((result) => console.log('[meetings:processNow] done', result))
        .catch((err: Error) => console.error('[meetings:processNow] failed', err.message))
      return { jobId, filePath: audioPath, outputDir: settings.outputFolder }
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
      return withMeetingLock(meetingId, () =>
        renameMeetingTitle(settings.outputFolder, meetingId, newTitle)
      )
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
      if (payload.sourcePath) {
        // Binary media (audio/video): copy the file straight to the chosen
        // destination — never buffer a multi-GB recording through main.
        await fs.copyFile(payload.sourcePath, result.filePath)
      } else if (typeof payload.body === 'string') {
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
      return previewExportMeeting(settings.outputFolder, meetingId, format, title || 'Meeting')
    }
  )

  ipcMain.handle(IPC.tagsList, async (): Promise<TagDef[]> => readTags())

  ipcMain.handle(
    IPC.tagsAdd,
    async (_event, name: string, color: string): Promise<TagDef> => addTag(name, color)
  )

  ipcMain.handle(
    IPC.tagsUpdate,
    async (_event, id: string, patch: { name?: string; color?: string }): Promise<TagDef> =>
      updateTag(id, patch)
  )

  ipcMain.handle(IPC.tagsDelete, async (_event, id: string): Promise<void> => deleteTag(id))

  ipcMain.handle(
    IPC.meetingsSetTags,
    async (_event, meetingId: string, tagIds: string[]): Promise<{ tagIds: string[] }> => {
      const settings = await readSettings()
      return withMeetingLock(meetingId, () =>
        setMeetingTags(settings.outputFolder, meetingId, tagIds)
      )
    }
  )

  ipcMain.handle(IPC.meetingsDelete, async (_event, meetingId: string): Promise<DeleteOutcome> => {
    const settings = await readSettings()
    return withMeetingLock(meetingId, () => deleteMeeting(settings.outputFolder, meetingId))
  })

  ipcMain.handle(
    IPC.meetingsSearchTranscripts,
    async (_event, query: string): Promise<TranscriptSearchHit[]> => {
      const settings = await readSettings()
      return searchTranscripts(settings.outputFolder, query)
    }
  )

  ipcMain.handle(IPC.meetingsReveal, async (_event, filePath: string): Promise<void> => {
    // Highlight a specific file in Finder (e.g. a just-exported transcript).
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(IPC.storageUsage, async (): Promise<StorageUsage> => {
    // Disk footprint of the live-recordings library. Best-effort + 10s-cached
    // in meetings.ts, so a stat storm never blocks the Storage settings pane.
    return computeStorageUsage()
  })

  ipcMain.handle(
    IPC.meetingsRetryFailed,
    async (_event, meetingId: string): Promise<{ ok: boolean; jobId?: string; error?: string }> => {
      const settings = await readSettings()
      const numSpeakers = numSpeakersToArg(settings.numSpeakers)
      return retryFailedMeeting(
        meetingId,
        settings.outputFolder,
        async (mixPath, outputFolder) => {
          const jobId = randomUUID()
          // Fire-and-forget the batch (same pattern as backend:spawn): the
          // renderer refreshes off the folder-watcher event when it lands.
          importFile(mixPath, outputFolder, jobId, numSpeakers).catch((err: Error) => {
            console.error('[meetings:retryFailed] import failed', err.message)
          })
          return { jobId }
        }
      )
    }
  )

  // ── system:* — tray + permissions surface ─────────────────────────────
  // These are the channels the new Home banner + the tray menu hit. They
  // intentionally sit at the IPC layer (not bundled into recording/*) so
  // permission/queries don't pull in the engine module on first call.

  ipcMain.handle(IPC.systemPermissions, async (): Promise<PermissionStatus> => {
    return getPermissionStatus()
  })

  ipcMain.handle(IPC.systemOpenSettings, async (_event, pane: PrivacyPane): Promise<void> => {
    await openPrivacyPane(pane)
  })

  ipcMain.handle(IPC.systemChromeMeet, async (): Promise<ChromeMeetSnapshot> => {
    return getChromeMeetSnapshot()
  })

  ipcMain.handle(IPC.systemTestChromeProbe, async (): Promise<ChromeProbeTestResult> => {
    // One-shot Chrome-automation probe for the onboarding wizard. This is the
    // call that first triggers the macOS "allow Timbre to control Chrome"
    // prompt, and reports back granted/denied + whether a Meet tab was open.
    return probeOnce()
  })

  ipcMain.handle(IPC.appStatusGet, async (): Promise<AppStatus> => {
    return getAppStatus()
  })

  ipcMain.handle(IPC.systemShowWindow, async (): Promise<void> => {
    showMainWindow()
  })

  ipcMain.handle(IPC.systemQuit, async (): Promise<void> => {
    // Defer one tick so the IPC reply makes it back to the renderer
    // before the process tears down (otherwise the renderer logs a
    // disconnected-pipe error in the console).
    setImmediate(() => app.quit())
  })

  ipcMain.handle(
    IPC.systemRevealHelper,
    async (): Promise<{ revealed: boolean; path?: string }> => {
      const { resolveLiveRecorderApp } = await import('../backend')
      const appPath = resolveLiveRecorderApp()
      if (!appPath) return { revealed: false }
      // `shell.showItemInFolder` highlights the .app bundle inside its
      // parent (Mintr's Resources/), where the user can grab it and drop
      // onto the Screen Recording "+" dialog.
      shell.showItemInFolder(appPath)
      return { revealed: true, path: appPath }
    }
  )

  ipcMain.handle(IPC.systemRestartHelper, async (): Promise<{ ok: boolean; message?: string }> => {
    // Recording-aware guard: restarting the engine interrupts a live recording,
    // so confirm before killing it. No-op (true) when nothing is recording.
    if (!(await confirmIfRecording('restart'))) {
      return { ok: false, message: 'Cancelled — a meeting is being recorded.' }
    }
    // Stop (which also kills) then start. The stopWatching path also
    // flips recording state to 'idle' which would cancel the Chrome
    // probe — so we call backend directly here, bypassing the
    // higher-level state machine.
    const { forceKillEngine, startLiveRecorder } = await import('../backend')
    // TICKET-003: reset the watchdog BEFORE we kill the helper so the
    // renderer sees the cleared `helperPermissionLikely` push first,
    // then the kill/respawn happens. Without this, the red banner
    // stays visible even after a successful restart because the
    // watchdog only un-alarms on meeting-id change.
    const { resetCaptureWatchdog } = await import('../captureWatchdog')
    resetCaptureWatchdog()
    forceKillEngine()
    // Tiny pause so the OS reaps the killed PID before macOS `open`
    // tries to "reactivate" it (which would no-op against the same
    // bundle id).
    await new Promise((r) => setTimeout(r, 300))
    const result = await startLiveRecorder()
    return { ok: result.ok, message: result.message }
  })

  // ── onboarding:* — wizard main-process surface (TICKET-IPC-002) ────────
  // Queries the HELPER's per-service TCC state (not Mintr's own), drives
  // the engine restart/verify cycle, and persists wizard completion. All
  // logic lives in `../onboarding`; these handlers are thin delegations.
  ipcMain.handle(
    IPC.onboardingProbe,
    async (): Promise<HelperPermissionSnapshot> => onboarding.probeHelperPermissions()
  )

  ipcMain.handle(
    IPC.onboardingOpenPane,
    async (_event, svc: OnboardingService): Promise<void> => onboarding.openPane(svc)
  )

  ipcMain.handle(
    IPC.onboardingRevealHelper,
    async (): Promise<{ revealed: boolean; path?: string }> => onboarding.revealHelper()
  )

  ipcMain.handle(
    IPC.onboardingRestartEngine,
    async (): Promise<OnboardingRestartResult> => onboarding.restartEngine()
  )

  ipcMain.handle(
    IPC.onboardingVerifyEngine,
    async (): Promise<OnboardingVerifyResult> => onboarding.verifyEngine()
  )

  ipcMain.handle(IPC.onboardingComplete, async (): Promise<void> => onboarding.markComplete())

  ipcMain.handle(IPC.onboardingReset, async (): Promise<void> => onboarding.reset())
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
    case 'video':
      return [{ name: 'MP4 video', extensions: ['mp4'] }]
  }
}
