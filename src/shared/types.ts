// Shared types between main and renderer processes.

export type ThemeMode = 'auto' | 'light' | 'dark'

export interface Settings {
  outputFolder: string
  theme: ThemeMode
  /** Default number-of-speakers hint applied to file imports. */
  numSpeakers: NumSpeakersHint
  /** Whether the left sidebar is collapsed to icon-only mode. */
  sidebarCollapsed: boolean
  /**
   * Auto-start watching for meetings on app launch. Default true — Mintr
   * is meant to feel like a passive background utility (Tailscale / 1Password
   * style); the user shouldn't have to press a button before every meeting.
   * Surfaced in Settings → Output and via the tray menu.
   */
  autoStartWatching: boolean
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
  meetingsExportPreview: 'meetings:exportPreview',
  meetingsSetTags: 'meetings:setTags',
  tagsList: 'tags:list',
  tagsAdd: 'tags:add',
  tagsUpdate: 'tags:update',
  tagsDelete: 'tags:delete',
  /** Returns the current macOS TCC state for permissions Mintr cares about. */
  systemPermissions: 'system:permissions',
  /** Opens System Settings to a specific privacy pane (or to the app itself). */
  systemOpenSettings: 'system:openSettings',
  /** Returns the most recent Chrome meet.google.com tab snapshot. */
  systemChromeMeet: 'system:chromeMeet',
  /** Brings the main app window forward (called from tray menu). */
  systemShowWindow: 'system:showWindow',
  /** Quits the app (called from tray menu). */
  systemQuit: 'system:quit',
  /**
   * Kill the bundled MeetingTranscriber helper and restart it. Required
   * after the user grants Screen Recording (or any other TCC) to the
   * helper, because macOS does not refresh permission state for a
   * running process.
   */
  systemRestartHelper: 'system:restartHelper',
  /**
   * Reveal the bundled helper .app in Finder so the user can drag it
   * onto System Settings → Screen Recording's "+" dialog. macOS won't
   * let us programmatically add a TCC entry — drag-and-drop from
   * Finder is the canonical user-driven way.
   */
  systemRevealHelper: 'system:revealHelper'
} as const

/** Export format kinds for `meetings:export`. */
export type ExportFormat = 'txt' | 'md' | 'json' | 'srt' | 'audio'

/**
 * macOS TCC permission state. `unknown` means we either haven't been able to
 * query it yet, or the API doesn't expose the granted/denied distinction
 * (Automation, for example, only fails when invoked — there's no
 * pre-flight query). UI treats `unknown` and `granted` the same; only
 * `denied` triggers the warning banner.
 */
export type PermissionState = 'granted' | 'denied' | 'unknown' | 'not-determined'

export interface PermissionStatus {
  /** Screen Recording — required for window-title detection (the main Meet trigger). */
  screenRecording: PermissionState
  /** Microphone — required for live audio capture. */
  microphone: PermissionState
  /**
   * Automation (specifically, scripting Chrome via AppleScript). macOS only
   * surfaces this when an osascript invocation has run at least once and the
   * user has answered the consent dialog; before that it's 'not-determined'.
   */
  automationChrome: PermissionState
}

/** Privacy panes that `systemOpenSettings` knows how to deep-link to. */
export type PrivacyPane =
  | 'screen-recording'
  | 'microphone'
  | 'automation'
  | 'accessibility'

/**
 * Snapshot of what the AppleScript Chrome-tab probe found on its last poll.
 * `tab` is set when at least one open Chrome tab matches the meet.google.com
 * URL pattern; otherwise null. The probe runs every ~3 seconds inside the
 * Electron main process — independent of the Swift engine's own
 * window-title polling, which gives us a second detection signal that works
 * BEFORE the user clicks "Join" (when there's no "Meet -" window title yet).
 */
export interface ChromeMeetSnapshot {
  /** True when osascript has run successfully at least once. */
  available: boolean
  /** Most recent error string from osascript, if any (e.g. permission denied). */
  error?: string
  tab: ChromeMeetTab | null
}

export interface ChromeMeetTab {
  /** Browser bundle id we observed it in — e.g. com.google.Chrome, company.thebrowser.Browser. */
  browser: string
  /** Full URL — e.g. https://meet.google.com/ntu-vwcf-onr. */
  url: string
  /** Extracted meeting id — e.g. "ntu-vwcf-onr". */
  meetingId: string
  /** Window title we read off the tab, if AppleScript exposed it. */
  title?: string
}
