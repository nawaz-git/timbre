// Shared types between main and renderer processes.

export type ThemeMode = 'auto' | 'light' | 'dark'

/**
 * Which slice of the screen the engine records as video during a meeting.
 * `chromeWindow` (default) captures only the meeting's browser window;
 * `entireScreen` captures the whole display. Mirrors the engine-side
 * `ScreenCaptureScope` and rides the `engine_config.json` bridge.
 */
export type ScreenCaptureScope = 'chromeWindow' | 'entireScreen'

/**
 * Post-processing effort the engine applies after a meeting. `fast` is the
 * default same-latency pipeline; `max` requests the slower, high-accuracy
 * speaker-attribution refinement. Rides the `engine_config.json` bridge as
 * `processingMode` and mirrors the engine-side `ProcessingMode`.
 *
 * This is the canonical name for the concept — a parallel UX quality-tier
 * effort renames onto this field.
 */
export type ProcessingMode = 'fast' | 'max'

/**
 * Transcription-language options surfaced in Settings. The empty string is
 * "Auto-detect" (the default) — it maps to the engine's auto path. The rest
 * are ISO 639-1 codes forwarded verbatim to the engine + mt-batch. Hardcoded
 * here (rather than imported from the Swift engine) so the renderer has no
 * engine dependency; kept short and high-traffic on purpose.
 */
export const ASR_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ar', label: 'Arabic' }
]

export interface Settings {
  outputFolder: string
  theme: ThemeMode
  /** Default number-of-speakers hint applied to file imports. */
  numSpeakers: NumSpeakersHint
  /** Whether the left sidebar is collapsed to icon-only mode. */
  sidebarCollapsed: boolean
  /**
   * Video capture scope for live recordings. Default `chromeWindow` — record
   * only the meeting's browser window, not the whole screen. Written into the
   * engine_config.json bridge and read fresh by the engine each meeting.
   */
  screenCaptureScope: ScreenCaptureScope
  /**
   * Kill switch for the app-audio CATap. Default false. When true the engine
   * records the microphone (and screen video) only — it creates NO CoreAudio
   * process tap or aggregate device at all. Rides the same engine_config.json
   * bridge as `screenCaptureScope` and is read fresh by the engine each
   * meeting. Immediate field mitigation: if capturing a browser's audio ever
   * destabilises the meeting, turning this on isolates the app tap in one step
   * while still saving the mic-side transcript.
   */
  disableAppAudioTap: boolean
  /**
   * Auto-start watching for meetings on app launch. Default true — Mintr
   * is meant to feel like a passive background utility (Tailscale / 1Password
   * style); the user shouldn't have to press a button before every meeting.
   * Surfaced in Settings → Output and via the tray menu.
   */
  autoStartWatching: boolean
  /**
   * Post-processing quality tier. `fast` (default) matches today's latency;
   * `max` runs the slower high-accuracy speaker-attribution refinement. Rides
   * the engine_config.json bridge to the engine + forwarded to mt-batch as
   * `--mode`.
   */
  processingMode: ProcessingMode
  /**
   * ASR language, empty string = auto-detect (default). ISO 639-1 otherwise.
   * Written into the engine bridge as `asrLanguage` (fixing the previously
   * forced-German live path) and passed to mt-batch as `--language`.
   */
  asrLanguage: string
  /**
   * MAX-tier LLM speaker-repair toggle. When on (and a protocol provider is
   * configured), the refine's optional LLM pass fixes speaker labels under a
   * strict relabel-only validator. Rides the bridge as `llmRepair.enabled`;
   * default false. Only meaningful with `processingMode: 'max'`.
   */
  llmRepair: boolean
  /**
   * Register Timbre as a macOS login item so it relaunches after a reboot.
   * Default true — a recorder that isn't running can't capture the meeting
   * you just joined. Applied via `app.setLoginItemSettings` on save and
   * reconciled once at startup. No-op in dev (only meaningful when packaged).
   */
  launchAtLogin: boolean
  /**
   * Wall-clock ms epoch when the user finished (or skipped) the onboarding
   * wizard. `undefined` => the wizard has not been completed and App.tsx
   * mounts it instead of the normal shell. Set via `onboarding:complete`,
   * cleared via `onboarding:reset`.
   */
  onboardingCompletedAt?: number
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

/**
 * Liveness state the engine advertises in `engine_heartbeat.json`. Mirrors the
 * Swift `EngineLivenessState` — keep the union in lockstep.
 */
export type EngineLivenessState = 'watching' | 'recording' | 'processing' | 'idle'

/**
 * Engine liveness heartbeat, written by the engine (Swift
 * `EngineHeartbeatWriter`) to the shared IPC dir every ~2 s and read on the
 * Electron side to (a) decide whether a running engine can be reused instead of
 * killed + relaunched (`evaluateEngineReuse` in `backend.ts`), (b) supervise a
 * wedged/dead engine (`engineSupervisor.ts`), and (c) back the Chrome probe off
 * while a recording is live (`index.ts` → `chromeProbe.setRecordingActiveProvider`).
 *
 * `startedAt` / `updatedAt` / `lastIOCallbackAt` / `lastSCKFrameAt` are epoch
 * **milliseconds**, matching `active_meeting.json` / `engine_config.json`.
 * `version` is the engine build version, compared against `app.getVersion()`
 * (the monorepo keeps the two in lockstep). Optional liveness fields are omitted
 * when the engine has nothing to report (e.g. no active tap).
 */
export interface EngineHeartbeat {
  pid: number
  version: string
  state: EngineLivenessState
  startedAt: number
  lastIOCallbackAt?: number
  lastSCKFrameAt?: number
  tapPIDCount?: number
  updatedAt: number
}

// ═══════════════════════════════════════════════════════════════════════
// AppStatus — the single source of truth for what Timbre is doing.
//
// One state machine in the main process (`src/main/status.ts`) owns app
// status; every surface (tray glyph + menu, Home hero, meeting rows,
// notifications, dock) renders THIS object rather than re-deriving its own.
// "Recording" is shown ONLY when audio is verifiably being written to disk
// (the capture heartbeat), never because a browser tab exists.
// ═══════════════════════════════════════════════════════════════════════

/**
 * The app's status, in strict priority order (first match wins):
 *   attention → recording → processing → meet-detected → watching → paused
 * `attention` means something needs the user (permission broken, live capture
 * failed, an engine meeting's processing dead-ended, or the engine is missing).
 */
export type AppStatusKind =
  | 'attention'
  | 'recording'
  | 'processing'
  | 'meet-detected'
  | 'watching'
  | 'paused'

/** The underlying activity kind — `AppStatusKind` with `attention` removed. */
export type ActivityKind = Exclude<AppStatusKind, 'attention'>

/** Pipeline stage of a processing meeting (inferred without the engine status file). */
export type ProcessingStage = 'transcribing' | 'diarizing' | 'summarizing' | 'unknown'

/** One meeting currently in the post-recording pipeline. */
export interface ProcessingItem {
  /** Meeting id (`engine:<prefix>`). */
  id: string
  title: string
  /** Epoch ms recording ended / processing began (mix-WAV mtime). */
  startedAt: number
  stage: ProcessingStage
  /** Real progress 0–100 when the engine status file provides it; else absent. */
  percent?: number
  /** Recorded length estimate in seconds (from WAV size), when known. */
  estDurationSec?: number
  /** True when the pipeline appears to have stalled and needs recovery. */
  stuck?: boolean
}

/** A condition that needs the user's attention. Priority already resolved in main. */
export interface AppAttention {
  code: 'permission' | 'capture-failed' | 'processing-stuck' | 'engine-missing'
  message: string
  /** Related meeting id, when the attention is about a specific meeting. */
  meetingId?: string
}

/**
 * The single status object broadcast to every surface. `kind` is the resolved
 * ladder value (may be `attention`); `activityKind` is what's actually
 * happening underneath so a surface can render the activity block AND the
 * attention banner at once (the Home hero does exactly this).
 */
export interface AppStatus {
  kind: AppStatusKind
  /** The activity underneath any attention overlay. */
  activityKind: ActivityKind
  // ── recording ──
  /** Chrome meet id when known (best-effort context; recording is proven by the heartbeat). */
  recordingMeetingId?: string
  /** Epoch ms the current recording began (WAV birthtime). */
  recordingStartedAt?: number
  /** Elapsed recording seconds (computed live on read). */
  recordingElapsedSec?: number
  // ── processing ──
  processingCount?: number
  processing?: ProcessingItem[]
  // ── attention ──
  attention?: AppAttention
  // ── context every surface may need ──
  meetTab?: { meetingId: string; url: string } | null
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
  /** True if a whole-screen video (<prefix>_screen.mp4) exists for playback/export. */
  hasVideo: boolean
  /** Tag IDs applied to this meeting (resolved against the global tag list). */
  tagIds: string[]
  /**
   * User-added speakers not auto-detected by diarization. Surfaced here so
   * the renderer can offer them in the per-segment reassignment picker
   * without an extra round-trip. Stored on `metadata.json → additionalSpeakers`.
   */
  additionalSpeakers: string[]
  /**
   * Distinct speaker display names in this meeting (diarized/named labels),
   * derived cheaply from data the listers already read (segments sidecar or
   * flat transcript / speakers.json). Powers client-side "search by who was
   * in it" without loading each transcript. Empty when unknown (e.g. a
   * still-processing meeting). The knowledge-graph stream also consumes this.
   */
  speakerNames: string[]
  /**
   * Set on synthesised placeholder rows the main process injects while a
   * Meet is detected but the engine hasn't written a file yet (TICKET-001).
   * Real, filesystem-backed entries leave this `undefined` (falsy). The
   * renderer keys the LIVE badge + "Recording in progress…" copy off this.
   */
  isLive?: boolean
  /**
   * Processing-state discriminator for a finished-but-not-yet-transcribed
   * meeting. The engine writes the RAW recordings
   * (`recordings/<prefix>_{mix,app,mic}.wav` + `_screen.mp4`) the instant
   * recording stops, THEN runs its pipeline (transcribe → diarize →
   * protocol) which lands `protocols/<prefix>.txt` + `_segments.json`
   * LATER. While only the raw audio exists, the meeting is surfaced with
   * `status: 'processing'` so it appears in Recent / Meetings IMMEDIATELY
   * as a card with a Processing badge and a playable audio file, instead
   * of being invisible for the whole processing window. Once the `.txt`
   * lands it is re-derived as `status: 'ready'`. OPTIONAL — every existing
   * call site omits it; the renderer treats `undefined` as 'ready'.
   *
   * `refining` is the MAX-tier background upgrade: the FAST transcript is
   * already on disk (the meeting is usable) while the engine re-writes it with
   * better speaker attribution. It is derived from a `<prefix>.refining` marker
   * file the engine writes during the refine and removes on completion —
   * processing-not-stuck, so a stale-status cap should treat it as in-progress.
   */
  status?: 'processing' | 'ready' | 'refining'
}

/**
 * Default threshold for surfacing a live-meeting placeholder row once a
 * Chrome `meet.google.com/...` tab has been visible for this many ms.
 * The capture watchdog (`captureWatchdog.ts`) holds its own
 * `LIVE_PLACEHOLDER_DELAY_MS` constant so it can run without importing
 * shared types; this export exists for any future code (Settings UI,
 * tests, docs) that needs to reference the same default.
 * TODO: replace with a `livePlaceholderDelayMs` field on `Settings` once
 *       the Settings UI control lands.
 */
export const LIVE_PLACEHOLDER_DEFAULT_MS = 10_000

/** One full-text transcript search hit — a meeting id plus a match snippet. */
export interface TranscriptSearchHit {
  /** Meeting id (`engine:<prefix>` or `imported:<folder>`). */
  id: string
  /** ±60-char excerpt around the first match; the query term is highlighted client-side. */
  snippet: string
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
  /**
   * The LLM-generated meeting summary (protocol), as Markdown. Present when
   * the engine wrote `protocols/<prefix>.md` (or an import produced a
   * `summary.md`). Drives the Summary tab — the meeting page leads with the
   * summary, then transcript, then media. Absent when no summary exists yet.
   */
  summaryMarkdown?: string
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
  meetingsRemoveSpeakerLabel: 'meetings:removeSpeakerLabel',
  meetingsReanalyze: 'meetings:reanalyze',
  /**
   * Recover a processing/stuck engine meeting by running its recorded audio
   * through the built-in mt-batch pipeline (same eventing as a file import).
   */
  meetingsProcessNow: 'meetings:processNow',
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
  meetingsDelete: 'meetings:delete',
  /** Full-text search across transcript/protocol `.txt` files → TranscriptSearchHit[]. */
  meetingsSearchTranscripts: 'meetings:searchTranscripts',
  /** Reveal a file in Finder (`shell.showItemInFolder`) — e.g. an exported file. */
  meetingsReveal: 'meetings:reveal',
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
  /**
   * Pull the current `AppStatus` (the single source of truth for recording /
   * processing / attention state). The matching push channel is
   * `app-status:update` (broadcast, deliberately NOT in this invoke const).
   */
  appStatusGet: 'app-status:get',
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
  systemRevealHelper: 'system:revealHelper',
  // ─── TICKET-IPC-002 (onboarding) — keep self-contained for merge ───────
  /** Probe the HELPER's per-service TCC state → HelperPermissionSnapshot. */
  onboardingProbe: 'onboarding:probe',
  /** Deep-link System Settings to the privacy pane for a given service. */
  onboardingOpenPane: 'onboarding:openPane',
  /** Reveal the bundled MintrEngine.app in Finder for drag-to-grant. */
  onboardingRevealHelper: 'onboarding:revealHelper',
  /** Kill + relaunch the engine so freshly-granted TCC takes effect. */
  onboardingRestartEngine: 'onboarding:restartEngine',
  /** Poll the engine log for "Watch mode started" after a restart. */
  onboardingVerifyEngine: 'onboarding:verifyEngine',
  /** Persist onboardingCompletedAt = now. */
  onboardingComplete: 'onboarding:complete',
  /** Clear onboardingCompletedAt (re-show the wizard). */
  onboardingReset: 'onboarding:reset'
} as const

/** Export format kinds for `meetings:export`. */
export type ExportFormat = 'txt' | 'md' | 'json' | 'srt' | 'audio' | 'video'

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
export type PrivacyPane = 'screen-recording' | 'microphone' | 'automation' | 'accessibility'

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

/**
 * Best-guess classification of WHICH TCC service the bundled engine
 * helper is missing when the watchdog fires. Computed in
 * `captureWatchdog.ts` by grepping the helper's unified-log output for
 * known failure substrings; surfaced to the renderer so the banner can
 * name the specific permission (e.g. Accessibility) the user must grant.
 */
export type WatchdogPermissionHint = 'accessibility' | 'microphone' | 'screenRecording' | 'unknown'

/**
 * Capture-watchdog signal pushed from main → renderer. Flips to
 * `helperPermissionLikely: true` after the threshold elapses with Chrome
 * reporting a live Meet but no engine writes. `hint` is the best-guess
 * classification of which TCC service is missing — used by the renderer
 * to render permission-specific copy + buttons.
 */
export interface CaptureWatchdogSignal {
  helperPermissionLikely: boolean
  hint?: WatchdogPermissionHint
  /** Meeting id we were watching when the watchdog fired (for context in UI). */
  meetingId?: string
  /** Wall-clock ms when the signal flipped. UI uses this to render time-since. */
  firedAt?: number
}

// ═══════════════════════════════════════════════════════════════════════
// Onboarding (TICKET-IPC-002 + TICKET-UI-003) — main-process surface +
// renderer contract. The wizard walks the user through granting these TCC
// services to the HELPER (`ai.nawaz.mintr-engine`), not to Mintr itself.
// ═══════════════════════════════════════════════════════════════════════

/** The three macOS TCC services the bundled MintrEngine helper needs granted. */
export type OnboardingService = 'screen-recording' | 'microphone' | 'accessibility'

/**
 * Per-service grant verdict for the helper. `not-determined` means the OS
 * has never been asked (yellow chip); `denied` is an explicit "Don't Allow"
 * (red); `granted` is good (green); `unknown` means no signal (neither the
 * engine's verdict file nor the tccd log named it) — treated like
 * `not-determined` by the wizard for prompting.
 */
export type GrantStatus = 'granted' | 'denied' | 'not-determined' | 'unknown'

/**
 * Snapshot of the HELPER's TCC state, surfaced to the onboarding wizard via
 * `window.api.onboarding.probe()`. Computed in `src/main/onboarding.ts` by
 * preferring the engine's own live verdict file (`/tmp/mt-permission.log`)
 * and falling back to the unified TCC subsystem log filtered to the helper's
 * bundle id. `watchLoopRunning` is the engine-health signal the wizard waits
 * for after a restart-and-verify.
 */
export interface HelperPermissionSnapshot {
  screenRecording: GrantStatus
  microphone: GrantStatus
  accessibility: GrantStatus
  /** True once the engine has logged "Watch mode started" since last (re)launch. */
  watchLoopRunning: boolean
}

/** Result of `onboarding:restartEngine`. */
export interface OnboardingRestartResult {
  ok: boolean
  message?: string
}

/** Result of `onboarding:verifyEngine`. */
export interface OnboardingVerifyResult {
  watchLoopRunning: boolean
  detail?: string
}
