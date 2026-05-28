// Shared types between main and renderer processes.

export type ThemeMode = 'auto' | 'light' | 'dark'

export interface Settings {
  outputFolder: string
  theme: ThemeMode
  /** Default number-of-speakers hint applied to file imports. */
  numSpeakers: NumSpeakersHint
  /** Whether the left sidebar is collapsed to icon-only mode. */
  sidebarCollapsed: boolean
}

export type RecordingState = 'idle' | 'watching' | 'recording' | 'transcribing'

export interface RecordingStatus {
  state: RecordingState
  /** Title of the in-progress recording (if any). */
  title?: string
  /** Elapsed seconds since the recording started (if recording). */
  elapsedSeconds?: number
  /** Transcription progress, 0–100 (if transcribing). */
  progressPercent?: number
}

export interface MeetingSummary {
  /** Folder name — used as a stable id. */
  id: string
  /** Display title (folder name pretty-printed; overridden by metadata.json if present). */
  title: string
  /** Absolute path to the meeting folder. */
  folderPath: string
  /** ISO timestamp from folder mtime or transcript mtime. */
  date: string
  /** Duration in seconds (best-effort; may be 0 if unknown). */
  durationSeconds: number
  /** Distinct speaker count (best-effort; may be 0 if unknown). */
  speakerCount: number
  /** True if this meeting has audio playback available (mt-batch outputs only — engine flat files don't). */
  hasAudio: boolean
  /** Tag IDs applied to this meeting (resolved against the global tag list). */
  tagIds: string[]
  /**
   * User-added speakers not auto-detected by diarization. Surfaced here so
   * the renderer can offer them in the per-segment reassignment picker
   * without an extra round-trip. Stored on `metadata.json → additionalSpeakers`.
   */
  additionalSpeakers: string[]
}

/** A category label that can be applied to one or more meetings. */
export interface TagDef {
  /** Stable id — never shown. */
  id: string
  /** User-facing label. */
  name: string
  /** CSS color (hex). */
  color: string
}

export interface TranscriptSegment {
  speaker: string
  start: number
  end: number
  text: string
}

export interface StructuredTranscript {
  segments: TranscriptSegment[]
  duration: number
  speakerCount: number
}

export interface SpeakerRecord {
  id: string
  label: string
}

export interface MeetingTranscript {
  meetingId: string
  /** Raw transcript text — backward-compat for older renderer code. */
  transcript: string
  /** Structured segments (preferred) — present when transcript.json exists. */
  segments?: TranscriptSegment[]
  /** Total duration in seconds (from transcript.json). */
  durationSeconds?: number
  speakers: SpeakerRecord[]
}

export interface BackendJob {
  jobId: string
  filePath: string
  outputDir: string
}

/**
 * Progress / status event from a running backend job (mt-batch). Pushed
 * from main → renderer over the `backend:event` channel. Mirrors the JSONL
 * the Swift CLI emits on stdout, with the originating `jobId` attached.
 */
export type BackendEvent =
  | { jobId: string; event: 'loading_audio' }
  | { jobId: string; event: 'loading_models' }
  | { jobId: string; event: 'transcribing'; progress: number }
  | { jobId: string; event: 'diarizing' }
  | { jobId: string; event: 'merging' }
  | { jobId: string; event: 'matched_speakers'; matches: SpeakerMatch[] }
  | { jobId: string; event: 'done'; outputDir: string }
  | { jobId: string; event: 'error'; message: string }

export interface SpeakerMatch {
  detected: string
  enrolled: string | null
  similarity: number
}

export interface EnrolledSpeaker {
  name: string
  centroidSampleCount: number
  useCount: number
  lastUsed: number
}

/** Number-of-speakers hint passed through to mt-batch's --num-speakers. */
export type NumSpeakersHint = 'auto' | 2 | 3 | 4 | 5 | 6

export interface ImportResult {
  /** undefined when the user cancelled the dialog. */
  filePath?: string
}

/** Channel names — single source of truth for both ends of IPC. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingStatus: 'recording:status',
  meetingsList: 'meetings:list',
  meetingsOpen: 'meetings:open',
  meetingsTranscript: 'meetings:transcript',
  meetingsRenameSpeaker: 'meetings:renameSpeaker',
  meetingsReassignSegment: 'meetings:reassignSegment',
  meetingsAddSpeaker: 'meetings:addSpeaker',
  meetingsReanalyze: 'meetings:reanalyze',
  fileImport: 'file:import',
  backendSpawn: 'backend:spawn',
  pickFolder: 'settings:pickFolder',
  openLiveFolder: 'settings:openLiveFolder',
  speakersList: 'speakers:list',
  speakersDelete: 'speakers:delete',
  meetingsRenameTitle: 'meetings:renameTitle',
  meetingsExport: 'meetings:export',
  meetingsSetTags: 'meetings:setTags',
  tagsList: 'tags:list',
  tagsAdd: 'tags:add',
  tagsUpdate: 'tags:update',
  tagsDelete: 'tags:delete'
} as const

/** Export format kinds for `meetings:export`. */
export type ExportFormat = 'txt' | 'md' | 'json' | 'srt' | 'audio'
