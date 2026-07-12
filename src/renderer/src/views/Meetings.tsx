import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronDown,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Filter,
  Inbox,
  Loader2,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  Search,
  SkipBack,
  SkipForward,
  Subtitles,
  Tag as TagIcon,
  Trash2,
  X
} from 'lucide-react'
import { formatDate, formatDateRelative, formatDuration } from '../state/format'
import {
  filterMeetingsByQuery,
  groupMeetingsByDate,
  hasUnnamedSpeakers,
  highlightParts
} from '../state/meetingSearch'
import { useTags } from '../state/tags'
import { useToast } from '../state/toast'
import { useAppStatus } from '../state/appStatus'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { MarkdownLite } from '../components/MarkdownLite'
import { PencilIcon } from '../components/PencilIcon'
import { RowMenu } from '../components/RowMenu'
import { SpeakerPicker } from '../components/SpeakerPicker'
import { TagPicker } from '../components/TagPicker'
import type {
  EnrolledSpeaker,
  ExportFormat,
  MeetingSummary,
  MeetingTranscript,
  NumSpeakersHint,
  ProcessingStage,
  TranscriptSearchHit,
  TranscriptSegment
} from '../../../shared/types'

type TabKey = 'summary' | 'transcript' | 'speakers' | 'video' | 'export' | 'tags'

/** Human stage labels for a processing meeting (the honest-progress copy). */
const PROCESSING_STAGE_LABEL: Record<ProcessingStage, string> = {
  transcribing: 'Transcribing speech',
  diarizing: 'Identifying speakers',
  summarizing: 'Writing summary',
  unknown: 'Working…'
}

/** Compact elapsed like "3 min" / "1 hr 4 min" from an epoch-ms start. */
function formatProcessingElapsed(startedAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return 'under a minute'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min`
  const hr = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${hr} hr ${rem} min` : `${hr} hr`
}

/** "started 3 min ago" relative label from an epoch-ms start. */
function formatStartedRelative(startedAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return 'started just now'
  return `started ${formatProcessingElapsed(startedAt)} ago`
}

/** "Recorded ~12 min" from an estimated recording length in seconds. */
function formatRecordedLength(estDurationSec: number | undefined): string | null {
  if (!estDurationSec || estDurationSec <= 0) return null
  const min = Math.round(estDurationSec / 60)
  return min >= 1 ? `Recorded ~${min} min` : 'Recorded under a minute'
}

const NUM_SPEAKERS_OPTIONS: NumSpeakersHint[] = ['auto', 2, 3, 4, 5, 6]

type ExportFormatMeta = {
  value: ExportFormat
  label: string
  hint: string
  Icon: typeof FileText
}
const EXPORT_FORMATS: ExportFormatMeta[] = [
  { value: 'txt', label: 'Plain text', hint: 'Speaker-tagged lines (.txt)', Icon: FileText },
  { value: 'md', label: 'Markdown', hint: 'Speakers bolded with timestamps (.md)', Icon: FileCode },
  { value: 'json', label: 'JSON', hint: 'Structured timeline (.json)', Icon: Braces },
  { value: 'srt', label: 'Subtitles', hint: 'SubRip format (.srt)', Icon: Subtitles },
  { value: 'audio', label: 'Audio', hint: 'Original WAV recording (.wav)', Icon: FileAudio },
  {
    value: 'video',
    label: 'Screen video',
    hint: 'Whole-screen recording (.mp4)',
    Icon: FileVideo
  }
]

/** Payload returned by `meetings:exportPreview` (mirrors preload type). */
interface ExportPreviewPayload {
  filename: string
  body: string
  contentType: string
  isBinary?: boolean
  sizeBytes?: number
}

/**
 * Cache slot for a single format's preview state. An absent entry in
 * `previewCache[format]` is implicitly the loading state — the fetcher
 * writes ONLY the terminal status ('ready' | 'error') after its await
 * completes, which keeps it out of the React cascading-render trap.
 */
type ExportPreviewState =
  | { status: 'ready'; payload: ExportPreviewPayload }
  | { status: 'error'; message: string }

/**
 * Pretty-print byte counts for the Audio preview placeholder. Switches
 * units at 1024 boundaries — most meeting WAVs land in the MB range.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Pretty-print JSON for the preview pane. Falls back to the raw string
 * if the body is not valid JSON (defensive — `exportMeeting('json')`
 * already returns parsed file contents, so this should never fail in
 * practice, but the pane shouldn't blank out if the file is corrupt).
 */
function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'speakers', label: 'Speakers' },
  { key: 'video', label: 'Video' },
  { key: 'export', label: 'Export' },
  { key: 'tags', label: 'Tags' }
]

const SPEAKER_PALETTE = ['#8ab4f8', '#fdd663', '#a1e3a1', '#f28b82', '#c58af9', '#79d5ff']

function colorForSpeaker(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length]
}

function formatHHMMSS(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function labelForNumSpeakers(v: NumSpeakersHint): string {
  return v === 'auto' ? 'Auto' : `${v} speakers`
}

/**
 * Parse a fallback flat-text transcript when no structured segments are
 * available. Accepts BOTH formats Mintr might encounter:
 *
 *   `[HH:MM:SS] Speaker: text`  — mt-batch flat exports
 *   `[MM:SS]    Speaker: text`  — engine protocols/*.txt output
 *
 * Hours group is optional: when the first colon-separated number is absent
 * we treat it as zero and the remaining two groups parse as minutes:seconds.
 * v0.17 fix — engine output uses the shorter MM:SS form, which the old
 * three-segment regex never matched, so engine transcripts rendered as
 * empty. (We still prefer the structured `transcript.segments` path when
 * the backend supplies it — this regex is the legacy fallback.)
 */
function parseLegacyTranscript(raw: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  const re = /^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\]\s+([^:]+):\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const [, h, mi, s, speaker, text] = m
    const start = (h ? Number(h) * 3600 : 0) + Number(mi) * 60 + Number(s)
    segments.push({ speaker: speaker.trim(), start, end: start, text: text.trim() })
  }
  for (let i = 0; i < segments.length - 1; i++) segments[i].end = segments[i + 1].start
  if (segments.length > 0) segments[segments.length - 1].end =
    segments[segments.length - 1].start + 30
  return segments
}

function uniqueSpeakers(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>()
  for (const s of segments) seen.add(s.speaker)
  return Array.from(seen)
}

interface MeetingsViewProps {
  initialMeetingId: string | null
  onInitialMeetingConsumed: () => void
}

export function MeetingsView(props: MeetingsViewProps): JSX.Element {
  const { initialMeetingId, onInitialMeetingConsumed } = props
  const { tags: allTags, byId: tagById } = useTags()
  const { toast } = useToast()

  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Mirror of selectedId for use inside long-lived event/poll callbacks
  // (onMeetingsChanged, the processing poll) without re-subscribing on every
  // selection change.
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [tab, setTab] = useState<TabKey>('transcript')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  // Library search — client-side over title/speakers/tags, plus a debounced
  // full-text pass across transcript files (the `In transcripts` group).
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [txHits, setTxHits] = useState<TranscriptSearchHit[]>([])
  const [searching, setSearching] = useState(false)

  // Single source of truth for live recording/processing state. Used to show
  // honest per-meeting processing stage/elapsed and the stuck → "Process now"
  // recovery, rather than a static "transcript coming" guess.
  const appStatus = useAppStatus()
  // Recovery state is keyed by meeting id so it naturally scopes to the current
  // selection (no reset effect needed — a different selection just doesn't match).
  const [processingNowFor, setProcessingNowFor] = useState<string | null>(null)
  const [processNowStartedFor, setProcessNowStartedFor] = useState<string | null>(null)
  const [processNowError, setProcessNowError] = useState<{ id: string; message: string } | null>(
    null
  )

  // Kick off the built-in pipeline for a stuck meeting. The invoke returns a
  // job id immediately (mt-batch runs in the background); its progress + the
  // recovered transcript surface as a new imported meeting via the existing
  // backend:event + meetings:changed wiring.
  const handleProcessNow = useCallback(async () => {
    const id = selectedId
    if (!id) return
    setProcessingNowFor(id)
    setProcessNowError((e) => (e?.id === id ? null : e))
    try {
      await window.api.meetings.processNow(id)
      setProcessNowStartedFor(id)
    } catch (err) {
      setProcessNowError({ id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setProcessingNowFor((cur) => (cur === id ? null : cur))
    }
  }, [selectedId])

  // Title editing
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleValue, setTitleValue] = useState('')

  // Inline list-row rename — separate from the detail-pane title editor.
  const [rowEditingId, setRowEditingId] = useState<string | null>(null)
  const [rowEditingValue, setRowEditingValue] = useState('')

  // Tag-picker popover on a meeting list row — id of the row whose
  // popover is currently open, or null when closed. One at a time.
  // We also stash the anchor button so the popover can pin itself to
  // viewport coords (it lives outside the list's scroll container).
  const [tagPickerForRowId, setTagPickerForRowId] = useState<string | null>(null)
  const [tagPickerAnchor, setTagPickerAnchor] = useState<HTMLElement | null>(null)

  // Per-row overflow (⋮) menu — id of the row whose kebab menu is open, plus
  // its anchor button. The menu hosts Edit title / Edit tags / Delete; opening
  // "Edit tags" hands the same anchor to the TagPicker.
  const [rowMenuForId, setRowMenuForId] = useState<string | null>(null)
  const [rowMenuAnchor, setRowMenuAnchor] = useState<HTMLElement | null>(null)

  // Speaker picker — which cluster name is open?
  const [pickerForCluster, setPickerForCluster] = useState<string | null>(null)
  // Anchor element for ALL three SpeakerPicker invocations (cluster pill,
  // per-segment label, "+ Add speaker"). Only one picker is open at a time
  // so a single ref state covers all three. The picker is portal-mounted
  // and positions itself via getBoundingClientRect against this element.
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  // Per-segment reassignment dropdown — segment index, or null when closed.
  const [pickerForSegment, setPickerForSegment] = useState<number | null>(null)
  // "+ Add speaker" dropdown anchored to its button on the Speakers tab.
  const [addSpeakerOpen, setAddSpeakerOpen] = useState(false)
  const [enrolledSpeakers, setEnrolledSpeakers] = useState<EnrolledSpeaker[]>([])

  // Re-analyse
  const [reanalyzePending, setReanalyzePending] = useState(false)
  const [reanalyzeSpeakers, setReanalyzeSpeakers] = useState<NumSpeakersHint>('auto')
  const [reanalyzeJobId, setReanalyzeJobId] = useState<string | null>(null)

  // Export tab — preview-then-export flow.
  // Currently-selected format in the preview pane (default Plain text).
  const [exportBusy, setExportBusy] = useState(false)
  const [previewFormat, setPreviewFormat] = useState<ExportFormat>('txt')
  // Cache previews per format so toggling between chips is instant after the
  // first fetch. Keyed by format; entries are tagged with status so the
  // pane can render skeleton / error / content from a single state slice.
  // Invalidated on meeting switch (different transcript files entirely) and
  // after a successful re-analyse (transcript content has changed on disk).
  const [previewCache, setPreviewCache] = useState<
    Partial<Record<ExportFormat, ExportPreviewState>>
  >({})

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Whole-screen video playback (only mounted on the Video tab).
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  // Seek bar hover tooltip
  const seekWrapRef = useRef<HTMLDivElement | null>(null)
  const [seekHover, setSeekHover] = useState<{ x: number; time: number } | null>(null)

  // Transient flash on a speaker pill when its segment is clicked
  const [flashedSpeaker, setFlashedSpeaker] = useState<string | null>(null)
  const flashTimeoutRef = useRef<number | null>(null)

  // Re-analyse progress (0–100) shown inline on the Run / Re-analyse button —
  // the old inline "Re-analysing… N%" banner is retired in favour of this +
  // toasts, keeping the detail pane to one inline banner at a time.
  const [reanalyzeProgress, setReanalyzeProgress] = useState<number | null>(null)

  // Meeting pending a Move-to-Trash confirmation (drives the ConfirmDialog).
  const [deletePending, setDeletePending] = useState<MeetingSummary | null>(null)

  // Transient "Copied" affordance for the Copy-transcript action.
  const [copiedTranscript, setCopiedTranscript] = useState(false)

  // Transient "Copied" affordance for the Copy-summary action (Summary tab).
  const [copiedSummary, setCopiedSummary] = useState(false)

  // Animated tab indicator. We measure the currently-active tab button's
  // offsetLeft + offsetWidth and slide a single underline pseudo-element to
  // its position via a CSS transform. Re-measures on tab change, layout
  // change (window resize), and when a meeting is selected (since the strip
  // mounts at that point).
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabBtnRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [tabIndicator, setTabIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0
  })

  // Cascade banner — non-blocking nudge shown after a successful rename or
  // per-segment reassign. Aggregates ALL renamed/reassigned speakers since
  // the last successful re-analyse (or meeting switch), in insertion order,
  // de-duped. The banner renders each name as a colored inline pill so the
  // user can see at a glance every voice that will benefit from a single
  // re-analyse. Cleared on meeting switch, after a re-analyse completes,
  // or when the user clicks "Later" (next rename re-populates).
  const [reassignQueue, setReassignQueue] = useState<string[]>([])

  // "Who was in this meeting?" naming panel — the in-app consolidation of
  // speaker naming (design goal: one surface). It shows whenever the open
  // meeting still has unnamed speakers and the user hasn't dismissed it for
  // this meeting id (session-scoped). We don't own the native
  // post-processing naming popup (Swift engine); `suppressSpeakerNamingWindow`
  // rides the engine-config bridge to retire it once the engine honours it.
  const [namingNudgeDismissed, setNamingNudgeDismissed] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.meetings.list()
      setMeetings(list)
    } catch (err) {
      console.error('Failed to list meetings', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTranscript = useCallback(
    async (meetingId: string): Promise<MeetingTranscript | null> => {
      setTranscriptLoading(true)
      try {
        const t = await window.api.meetings.transcript(meetingId)
        setTranscript(t)
        return t
      } catch (err) {
        console.error('Failed to read transcript', err)
        const empty: MeetingTranscript = { meetingId, transcript: '', speakers: [] }
        setTranscript(empty)
        return empty
      } finally {
        setTranscriptLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // v0.13+: auto-refresh when new files land in the live-recordings or
  // import folder. Without this the Meetings list went stale immediately
  // after a meeting finished — the user had to switch tabs (or restart
  // the app) to see it.
  useEffect(() => {
    const unsub = window.api.system.onMeetingsChanged(() => {
      void refresh()
      // If the open detail is an engine meeting, reload its transcript too.
      // When a processing meeting's pipeline finishes it writes
      // protocols/<prefix>.txt (a watched file → this event), but the
      // backend `done` reload at the other effect only fires for an active
      // reanalyzeJobId — so a fresh processing completion would otherwise
      // leave the open detail stuck on the Processing panel until the user
      // reselected it. Reloading here flips it to the transcript live.
      if (selectedIdRef.current?.startsWith('engine:')) {
        void loadTranscript(selectedIdRef.current)
      }
    })
    return unsub
  }, [refresh, loadTranscript])

  // Poll safety-net (≥4s) while ANY visible meeting is still processing. The
  // onMeetingsChanged push above is the primary trigger, but macOS fs.watch
  // can coalesce a final .txt write into an earlier debounce window and not
  // emit a distinct event — this poll guarantees the processing → ready flip
  // (and the open detail's transcript reveal) eventually lands without the
  // user closing/reopening the app. The interval clears itself once no
  // processing meetings remain and on unmount.
  const hasProcessing = useMemo(
    // Poll while anything is transcribing (processing) OR upgrading (refining)
    // so the row + open transcript refresh the moment the engine finishes.
    () => meetings.some((m) => m.status === 'processing' || m.status === 'refining'),
    [meetings]
  )
  useEffect(() => {
    if (!hasProcessing) return
    const id = window.setInterval(() => {
      void refresh()
      if (selectedIdRef.current?.startsWith('engine:')) {
        void loadTranscript(selectedIdRef.current)
      }
    }, 4000)
    return () => window.clearInterval(id)
  }, [hasProcessing, refresh, loadTranscript])

  const loadEnrolled = useCallback(async () => {
    try {
      const list = await window.api.speakers.list()
      setEnrolledSpeakers(list)
    } catch (err) {
      console.error('Failed to load enrolled speakers', err)
      setEnrolledSpeakers([])
    }
  }, [])

  // Search state is driven from event handlers (typing / clear), NOT set
  // synchronously inside the debounce effect — that would trip the
  // cascading-render lint rule. The `searching` spinner flips on in the
  // change handler; the effect only schedules the async fetch.
  const onSearchChange = useCallback((value: string) => {
    setQuery(value)
    if (value.trim() === '') {
      setSearching(false)
      setTxHits([])
    } else {
      setSearching(true)
    }
  }, [])

  const clearSearch = useCallback(() => {
    setQuery('')
    setSearching(false)
    setTxHits([])
  }, [])

  // Debounced full-text transcript search (300 ms). A search error falls back
  // silently to the client-side title/speaker results. No synchronous setState
  // in the body — all state changes happen inside the async callback.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await window.api.meetings.searchTranscripts(q)
          setTxHits(hits)
        } catch (err) {
          console.warn('Transcript search failed', err)
          setTxHits([])
        } finally {
          setSearching(false)
        }
      })()
    }, 300)
    return () => window.clearTimeout(handle)
  }, [query])

  // ⌘F focuses the search field while the Meetings view is mounted (it only
  // mounts on this view, so the shortcut is naturally scoped here). A future
  // in-transcript find can pre-empt this by handling ⌘F on the detail pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const onSelect = useCallback(
    async (m: MeetingSummary) => {
      setSelectedId(m.id)
      setReassignQueue([])
      setTitleEditing(false)
      setPickerForCluster(null)
      setPickerForSegment(null)
      setAddSpeakerOpen(false)
      setCurrentTime(0)
      setIsPlaying(false)
      setTab('transcript')
      // Reset the Export-tab state for the new meeting — the previous
      // meeting's cached previews belong to different transcript files.
      setPreviewFormat('txt')
      setPreviewCache({})
      // TICKET-001: `live:<id>` rows are in-memory placeholders with no
      // file on disk yet — skip transcript load (would 404) and skip
      // enrolled-speakers load (irrelevant). The detail pane shows a
      // dedicated "Recording in progress…" empty state for these.
      if (m.id.startsWith('live:')) {
        setTranscript(null)
        return
      }
      // The meeting page leads with the Summary when one exists, else the
      // Transcript. `setTab('transcript')` above resets instantly; bump to
      // Summary once we know it's present.
      const t = await loadTranscript(m.id)
      if (t?.summaryMarkdown) setTab('summary')
      await loadEnrolled()
    },
    [loadTranscript, loadEnrolled]
  )

  // If App nav handed us a pre-selected meeting id, open it once.
  useEffect(() => {
    if (!initialMeetingId) return
    const m = meetings.find((x) => x.id === initialMeetingId)
    if (m) {
      void onSelect(m)
      onInitialMeetingConsumed()
    }
  }, [initialMeetingId, meetings, onSelect, onInitialMeetingConsumed])

  // Auto-refresh on backend events
  useEffect(() => {
    const unsub = window.api.backend.onEvent((ev) => {
      if (ev.event === 'done') {
        void refresh()
        if (reanalyzeJobId && ev.jobId === reanalyzeJobId) {
          setReanalyzeJobId(null)
          setReanalyzeProgress(null)
          toast('Re-analysis complete.', { kind: 'success' })
          // The cascade just ran — every renamed centroid in the queue has
          // been re-matched across the meeting via the global DB; clear it.
          setReassignQueue([])
          // Transcript files on disk changed — drop the export-preview
          // cache so the Export tab refetches against the new contents.
          setPreviewCache({})
          if (selectedId) void loadTranscript(selectedId)
        }
      } else if (ev.event === 'error' && reanalyzeJobId && ev.jobId === reanalyzeJobId) {
        setReanalyzeJobId(null)
        setReanalyzeProgress(null)
        toast(`Couldn't re-analyse: ${ev.message}`, { kind: 'error' })
      } else if (ev.event === 'transcribing' && reanalyzeJobId && ev.jobId === reanalyzeJobId) {
        setReanalyzeProgress(Math.round(ev.progress * 100))
      }
    })
    return unsub
  }, [refresh, reanalyzeJobId, selectedId, loadTranscript, toast])

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId]
  )

  // The Video tab only exists when this meeting has a whole-screen recording.
  // The same filtered list drives BOTH the tab-strip render and the sliding
  // tab-indicator measurement so the underline stays aligned.
  const visibleTabs = useMemo(
    () =>
      TAB_DEFS.filter((t) => {
        // Summary tab only when the LLM protocol exists; Video only with a screen recording.
        if (t.key === 'summary') return !!transcript?.summaryMarkdown
        if (t.key === 'video') return !!selectedMeeting?.hasVideo
        return true
      }),
    [selectedMeeting, transcript]
  )

  const segments: TranscriptSegment[] = useMemo(() => {
    if (!transcript) return []
    if (transcript.segments && transcript.segments.length > 0) return transcript.segments
    return parseLegacyTranscript(transcript.transcript)
  }, [transcript])

  const speakersInTranscript = useMemo(() => uniqueSpeakers(segments), [segments])

  /**
   * Detected speakers + user-added "additional" speakers (the latter come
   * from `metadata.json → additionalSpeakers` and represent people who
   * were present but missed by diarization). Both sets are offered in the
   * per-segment reassignment dropdown so the user can re-tag a misheard
   * segment to anyone in the meeting.
   */
  const allSpeakersForPicker = useMemo(() => {
    const seen = new Set<string>()
    const merged: string[] = []
    for (const n of [...speakersInTranscript, ...(selectedMeeting?.additionalSpeakers ?? [])]) {
      if (!n || seen.has(n)) continue
      seen.add(n)
      merged.push(n)
    }
    return merged
  }, [speakersInTranscript, selectedMeeting])

  const audioSrc = useMemo(() => {
    if (!selectedMeeting?.hasAudio) return null
    const id = selectedMeeting.id.startsWith('imported:')
      ? selectedMeeting.id.slice('imported:'.length)
      : selectedMeeting.id
    return `mt-audio://meeting/${encodeURIComponent(id)}/audio.wav`
  }, [selectedMeeting])

  const videoSrc = useMemo(() => {
    if (!selectedMeeting?.hasVideo) return null
    const id = selectedMeeting.id.startsWith('imported:')
      ? selectedMeeting.id.slice('imported:'.length)
      : selectedMeeting.id
    return `mt-audio://meeting/${encodeURIComponent(id)}/screen.mp4`
  }, [selectedMeeting])

  // The media element that currently owns playback: the <video> on the Video
  // tab, otherwise the <audio> player-bar. Centralised so transcript
  // click-to-seek + Space/Arrow keys drive whichever player is mounted.
  const activeMediaEl = useCallback(
    (): HTMLMediaElement | null => (tab === 'video' ? videoRef.current : audioRef.current),
    [tab]
  )

  // Keyboard shortcuts
  useEffect(() => {
    if (!selectedMeeting) return
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (titleEditing || pickerForCluster || pickerForSegment !== null || addSpeakerOpen) return
      const el = activeMediaEl()
      if (e.code === 'Space') {
        e.preventDefault()
        if (el) {
          if (el.paused) void el.play()
          else el.pause()
        }
      } else if (e.code === 'ArrowLeft') {
        if (el) {
          el.currentTime = Math.max(0, el.currentTime - 5)
        }
      } else if (e.code === 'ArrowRight') {
        if (el) {
          el.currentTime = Math.min(el.duration || 0, el.currentTime + 5)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedMeeting, titleEditing, pickerForCluster, pickerForSegment, addSpeakerOpen, activeMediaEl])

  const activeSegmentIndex = useMemo(() => {
    if (segments.length === 0) return -1
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (currentTime >= s.start && currentTime < s.end) return i
    }
    if (currentTime >= segments[segments.length - 1].end) return segments.length - 1
    return -1
  }, [segments, currentTime])

  // Measure + reposition the tab-strip's sliding indicator whenever the
  // active tab, the strip's existence, or window size changes. useLayoutEffect
  // so the indicator is positioned in the same paint as the new active tab.
  useLayoutEffect(() => {
    const idx = visibleTabs.findIndex((t) => t.key === tab)
    const btn = tabBtnRefs.current[idx]
    if (!btn) {
      // Tab strip not mounted (no meeting selected) — keep indicator hidden.
      setTabIndicator({ left: 0, width: 0 })
      return
    }
    setTabIndicator({ left: btn.offsetLeft, width: btn.offsetWidth })
  }, [tab, selectedId, visibleTabs])

  // Re-measure on window resize so the indicator follows reflow.
  useEffect(() => {
    function onResize(): void {
      const idx = visibleTabs.findIndex((t) => t.key === tab)
      const btn = tabBtnRefs.current[idx]
      if (!btn) return
      setTabIndicator({ left: btn.offsetLeft, width: btn.offsetWidth })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [tab, visibleTabs])

  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!isPlaying || activeSegmentIndex < 0) return
    const container = transcriptListRef.current
    if (!container) return
    const row = container.querySelector<HTMLElement>(
      `[data-segment-index="${activeSegmentIndex}"]`
    )
    if (row) {
      const cRect = container.getBoundingClientRect()
      const rRect = row.getBoundingClientRect()
      if (rRect.top < cRect.top || rRect.bottom > cRect.bottom) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
  }, [activeSegmentIndex, isPlaying])

  /**
   * Lazy-load the export preview for the currently-selected format whenever
   * the Export tab is the active tab. Cached per format inside the meeting
   * session — switching back to a format we've already loaded is instant.
   * Skipped for audio when the meeting has no audio file (the pane shows
   * a "not available" placeholder using the existing `hasAudio` flag).
   * Also skipped for engine-prefix meetings (live recordings) since they
   * only support txt/md export.
   */
  useEffect(() => {
    if (tab !== 'export') return
    if (!selectedId || !selectedMeeting) return
    const fmt = previewFormat
    // Don't fetch audio/video preview when the file isn't present.
    if (fmt === 'audio' && !selectedMeeting.hasAudio) return
    if (fmt === 'video' && !selectedMeeting.hasVideo) return
    // Engine meetings now support every text format too — the backend throws
    // a readable message (rendered in the pane) when a structured transcript
    // is missing, so no format is gated client-side here.
    // Already fetched (or in-flight) — let the cached entry stand.
    if (previewCache[fmt]) return
    let cancelled = false
    // Treat "no cache entry" as the loading state in the renderer instead
    // of writing an explicit { status: 'loading' } before the await — that
    // synchronous setState inside an effect trips the cascading-render lint
    // rule. The placeholder branch renders the same skeleton either way.
    void (async () => {
      try {
        const payload = await window.api.meetings.exportPreview(
          selectedId,
          fmt,
          selectedMeeting.title
        )
        if (cancelled) return
        setPreviewCache((prev) => ({
          ...prev,
          [fmt]: { status: 'ready', payload }
        }))
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setPreviewCache((prev) => ({
          ...prev,
          [fmt]: { status: 'error', message }
        }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, selectedId, selectedMeeting, previewFormat, previewCache])

  // ─── Actions ──────────────────────────────────────────────────────────

  const seekTo = useCallback(
    (t: number, play = true) => {
      const el = activeMediaEl()
      if (!el) return
      el.currentTime = t
      setCurrentTime(t)
      if (play) void el.play()
    },
    [activeMediaEl]
  )

  const flashPillFor = useCallback((speaker: string) => {
    setFlashedSpeaker(speaker)
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current)
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashedSpeaker(null)
      flashTimeoutRef.current = null
    }, 1000)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current)
      }
    }
  }, [])

  // Seek-bar hover: derive time from cursor X over the input's bounding rect.
  const onSeekMouseMove = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      if (!duration || duration <= 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      setSeekHover({ x: e.clientX - rect.left, time: ratio * duration })
    },
    [duration]
  )

  const onSeekMouseLeave = useCallback(() => {
    setSeekHover(null)
  }, [])

  const hoverSpeaker = useMemo(() => {
    if (!seekHover) return null
    const t = seekHover.time
    for (const s of segments) {
      if (t >= s.start && t < s.end) return s.speaker
    }
    return null
  }, [seekHover, segments])

  // Active-speaker name (used for pulsing pills during playback)
  const activeSpeaker = useMemo(() => {
    if (!isPlaying) return null
    if (activeSegmentIndex < 0) return null
    return segments[activeSegmentIndex]?.speaker ?? null
  }, [isPlaying, activeSegmentIndex, segments])

  const beginTitleEdit = useCallback(() => {
    if (!selectedMeeting) return
    setTitleEditing(true)
    setTitleValue(selectedMeeting.title)
  }, [selectedMeeting])

  const commitTitle = useCallback(async () => {
    if (!selectedMeeting) return
    const next = titleValue.trim()
    if (!next || next === selectedMeeting.title) {
      setTitleEditing(false)
      return
    }
    try {
      await window.api.meetings.renameTitle(selectedMeeting.id, next)
      setTitleEditing(false)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't rename: ${msg}`, { kind: 'error' })
      setTitleEditing(false)
    }
  }, [selectedMeeting, titleValue, refresh])

  const beginRowRename = useCallback((m: MeetingSummary) => {
    setRowEditingId(m.id)
    setRowEditingValue(m.title)
  }, [])

  const cancelRowRename = useCallback(() => {
    setRowEditingId(null)
    setRowEditingValue('')
  }, [])

  const commitRowRename = useCallback(async () => {
    const id = rowEditingId
    if (!id) return
    const original = meetings.find((m) => m.id === id)
    const next = rowEditingValue.trim()
    setRowEditingId(null)
    setRowEditingValue('')
    if (!original || !next || next === original.title) return
    try {
      await window.api.meetings.renameTitle(id, next)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't rename: ${msg}`, { kind: 'error' })
    }
  }, [rowEditingId, rowEditingValue, meetings, refresh, toast])

  const onDeleteMeeting = useCallback((m: MeetingSummary) => {
    // Open the confirmation modal; the actual trash happens on confirm.
    setDeletePending(m)
  }, [])

  const performDeleteMeeting = useCallback(async () => {
    const m = deletePending
    if (!m) return
    try {
      await window.api.meetings.delete(m.id)
      // If the deleted meeting was open in the detail pane, clear it.
      if (selectedId === m.id) {
        setSelectedId(null)
        setTranscript(null)
      }
      setDeletePending(null)
      toast('Moved to Trash.', { kind: 'success' })
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setDeletePending(null)
      toast(`Couldn't delete: ${msg}`, { kind: 'error' })
    }
  }, [deletePending, selectedId, refresh, toast])

  const onPickSpeaker = useCallback(
    async (clusterName: string, newName: string) => {
      if (!selectedId) return
      try {
        const result = await window.api.meetings.renameSpeaker(
          selectedId,
          clusterName,
          newName
        )
        toast(
          result.enrolled
            ? `Assigned "${newName}" — enrolled their voice for next time.`
            : `Renamed to "${newName}".`,
          { kind: 'success' }
        )
        // Append to the cascade queue for this meeting-session. Insertion
        // order preserved; existing names are not duplicated.
        // The cross-meeting re-analyse cascade only applies to imported
        // meetings — engine (live) recordings carry no centroids and can't be
        // re-analysed, and the rename above already relabelled every segment,
        // so there's nothing to propagate. Skip the cascade banner for them.
        if (!selectedId?.startsWith('engine:')) {
          setReassignQueue((q) => (q.includes(newName) ? q : [...q, newName]))
        }
        setPickerForCluster(null)
        // Transcript files were rewritten by the rename — drop any cached
        // export previews so the next preview fetch reads fresh contents.
        setPreviewCache({})
        await loadTranscript(selectedId)
        await loadEnrolled()
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't rename: ${msg}`, { kind: 'error' })
      }
    },
    [selectedId, loadTranscript, loadEnrolled, refresh, toast]
  )

  /**
   * Delete a speaker cluster. `target` non-null → merge (reassign every line of
   * `clusterName` to `target`, reusing the existing renameSpeaker IPC). `target`
   * null → remove the label only (relabel to a neutral placeholder via the new
   * removeSpeakerLabel IPC). Both then re-derive the transcript, pills, enrolled
   * list, and header stats so the deleted name disappears everywhere.
   */
  const onDeleteSpeaker = useCallback(
    async (clusterName: string, target: string | null) => {
      if (!selectedId) return
      try {
        if (target) {
          await window.api.meetings.renameSpeaker(selectedId, clusterName, target)
        } else {
          await window.api.meetings.removeSpeakerLabel(selectedId, clusterName)
        }
        toast(
          target
            ? `Merged "${clusterName}" into "${target}".`
            : `Removed label "${clusterName}".`,
          { kind: 'success' }
        )
        setPickerForCluster(null)
        setPickerAnchor(null)
        setPreviewCache({})
        await loadTranscript(selectedId)
        await loadEnrolled()
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't delete: ${msg}`, { kind: 'error' })
      }
    },
    [selectedId, loadTranscript, loadEnrolled, refresh, toast]
  )

  /**
   * Reassign a SINGLE segment's speaker (not the cluster). Other segments
   * sharing the old name are untouched. Backed by `meetings:reassignSegment`.
   */
  const onReassignSegment = useCallback(
    async (segmentIndex: number, newName: string) => {
      if (!selectedId) return
      try {
        await window.api.meetings.reassignSegment(selectedId, segmentIndex, newName)
        setPickerForSegment(null)
        toast(`Segment ${segmentIndex + 1} → "${newName}".`, { kind: 'success' })
        // Per-segment reassign also benefits from a re-analyse: the user's
        // mental model is "I just told the app this voice is Bob, propagate it".
        // Append to the queue so all touched voices show in the cascade banner.
        if (!selectedId?.startsWith('engine:')) {
          setReassignQueue((q) => (q.includes(newName) ? q : [...q, newName]))
        }
        // Transcript files were rewritten — drop cached export previews.
        setPreviewCache({})
        await loadTranscript(selectedId)
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't reassign: ${msg}`, { kind: 'error' })
      }
    },
    [selectedId, loadTranscript, refresh, toast]
  )

  /**
   * Append a name to this meeting's `additionalSpeakers`. The picker
   * passes either an enrolled name (from the dropdown) or a freshly-typed
   * name. The list refresh propagates the new name into the per-segment
   * picker via `selectedMeeting.additionalSpeakers`.
   */
  const onAddSpeaker = useCallback(
    async (name: string) => {
      if (!selectedId) return
      try {
        await window.api.meetings.addSpeaker(selectedId, name)
        setAddSpeakerOpen(false)
        toast(`Added "${name}" to this meeting.`, { kind: 'success' })
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't add speaker: ${msg}`, { kind: 'error' })
      }
    },
    [selectedId, refresh, toast]
  )

  const onReanalyze = useCallback(async () => {
    if (!selectedId) return
    const hint: number | undefined =
      reanalyzeSpeakers === 'auto' ? undefined : reanalyzeSpeakers
    // Progress shows on the Run button itself (no inline banner).
    try {
      const job = await window.api.meetings.reanalyze(selectedId, hint)
      setReanalyzeJobId(job.jobId)
      setReanalyzePending(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't re-analyse: ${msg}`, { kind: 'error' })
    }
  }, [selectedId, reanalyzeSpeakers, toast])

  /**
   * Re-process at MAX accuracy: the slower, high-accuracy speaker-attribution
   * refinement (consensus diarization + utterance re-scoring + optional LLM
   * repair). Overwrites the meeting's transcript in place on completion.
   */
  const onReanalyzeMax = useCallback(async () => {
    if (!selectedId) return
    const hint: number | undefined =
      reanalyzeSpeakers === 'auto' ? undefined : reanalyzeSpeakers
    toast('Re-processing at max accuracy — this can take several minutes…', { kind: 'info' })
    try {
      const job = await window.api.meetings.reanalyze(selectedId, hint, 'max')
      setReanalyzeJobId(job.jobId)
      setReanalyzePending(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Re-process failed: ${msg}`, { kind: 'error' })
    }
  }, [selectedId, reanalyzeSpeakers, toast])

  /**
   * One-click cascade from the banner: re-run mt-batch with the meeting's
   * existing speaker count as the hint so the diarizer keeps the same
   * cluster count, but with the updated global-DB centroid now in play.
   * Any cluster matching the renamed speaker's voice will pick up the name
   * automatically. Falls back to "auto" if speakerCount is unknown.
   */
  const onCascadeReanalyze = useCallback(async () => {
    if (!selectedId || !selectedMeeting) return
    const hint: number | undefined =
      selectedMeeting.speakerCount > 0 ? selectedMeeting.speakerCount : undefined
    try {
      const job = await window.api.meetings.reanalyze(selectedId, hint)
      setReanalyzeJobId(job.jobId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't re-analyse: ${msg}`, { kind: 'error' })
    }
  }, [selectedId, selectedMeeting, toast])

  const onCopyTranscript = useCallback(async () => {
    // Prefer diarized segments as `[mm:ss] Speaker: text`; fall back to the
    // raw protocol text when there are no segments.
    const text =
      segments.length > 0
        ? segments
            .map((seg) => `[${formatHHMMSS(seg.start)}] ${seg.speaker}: ${seg.text.trim()}`)
            .join('\n')
        : (transcript?.transcript ?? '')
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedTranscript(true)
      setTimeout(() => setCopiedTranscript(false), 1600)
    } catch {
      // Clipboard access denied — rare in the packaged app; nothing to do.
    }
  }, [segments, transcript])

  const onCopySummary = useCallback(async () => {
    const text = transcript?.summaryMarkdown?.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedSummary(true)
      setTimeout(() => setCopiedSummary(false), 1600)
    } catch {
      // Clipboard access denied — nothing to do.
    }
  }, [transcript])

  const onExport = useCallback(
    async (format: ExportFormat) => {
      if (!selectedId || !selectedMeeting) return
      setExportBusy(true)
      try {
        const result = await window.api.meetings.export(
          selectedId,
          format,
          selectedMeeting.title
        )
        if (result.savedTo) {
          const savedTo = result.savedTo
          toast(`Saved to ${savedTo.split('/').pop() ?? savedTo}`, {
            kind: 'success',
            actionLabel: 'Reveal in Finder',
            onAction: () => void window.api.meetings.reveal(savedTo)
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't export: ${msg}`, { kind: 'error' })
      } finally {
        setExportBusy(false)
      }
    },
    [selectedId, selectedMeeting, toast]
  )

  const onToggleTag = useCallback(
    async (tagId: string) => {
      if (!selectedMeeting) return
      const current = new Set(selectedMeeting.tagIds)
      if (current.has(tagId)) current.delete(tagId)
      else current.add(tagId)
      try {
        await window.api.meetings.setTags(selectedMeeting.id, Array.from(current))
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't update tags: ${msg}`, { kind: 'error' })
      }
    },
    [selectedMeeting, refresh, toast]
  )

  /**
   * Toggle a tag on a meeting selected from the LIST row (independent of
   * the detail pane's selected meeting). Pulls the latest tagIds straight
   * off the meetings array so successive toggles within an open popover
   * reflect each other without waiting for a re-render of the row.
   */
  const onToggleTagForRow = useCallback(
    async (meetingId: string, tagId: string) => {
      const target = meetings.find((m) => m.id === meetingId)
      if (!target) return
      const next = new Set(target.tagIds)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      try {
        await window.api.meetings.setTags(meetingId, Array.from(next))
        await refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't update tags: ${msg}`, { kind: 'error' })
      }
    },
    [meetings, refresh, toast]
  )

  // ─── Render ───────────────────────────────────────────────────────────

  const tagNamesFor = useCallback(
    (m: MeetingSummary): string[] =>
      m.tagIds.map((id) => tagById(id)?.name).filter((n): n is string => !!n),
    [tagById]
  )

  // Tag filter, then client-side text filter over title / speakers / tag names.
  const tagFiltered = useMemo(
    () => (tagFilter ? meetings.filter((m) => m.tagIds.includes(tagFilter)) : meetings),
    [meetings, tagFilter]
  )
  const visibleMeetings = useMemo(
    () => filterMeetingsByQuery(tagFiltered, query, tagNamesFor),
    [tagFiltered, query, tagNamesFor]
  )
  const dateGroups = useMemo(() => groupMeetingsByDate(visibleMeetings), [visibleMeetings])

  // Full-text hits NOT already surfaced by the metadata filter, resolved to
  // their summary row (respecting the active tag filter) → the bottom group.
  const transcriptOnlyHits = useMemo(() => {
    if (!query.trim() || txHits.length === 0) return []
    const shown = new Set(visibleMeetings.map((m) => m.id))
    const byId = new Map(tagFiltered.map((m) => [m.id, m]))
    const out: Array<{ meeting: MeetingSummary; snippet: string }> = []
    for (const hit of txHits) {
      if (shown.has(hit.id)) continue
      const meeting = byId.get(hit.id)
      if (meeting) out.push({ meeting, snippet: hit.snippet })
    }
    return out
  }, [query, txHits, visibleMeetings, tagFiltered])

  const totalResults = visibleMeetings.length + transcriptOnlyHits.length
  const noResults = query.trim() !== '' && totalResults === 0

  // Speaker pills for the detail-pane row — shared between the standalone
  // "Speakers" row and the "Who was in this meeting?" naming panel so the
  // pill markup lives in exactly one place.
  const speakerPills = speakersInTranscript.map((name) => {
    const pulsing = activeSpeaker === name
    const flashing = flashedSpeaker === name
    const color = colorForSpeaker(name)
    return (
      <div key={name} className="speaker-pill-wrap">
        <button
          className={
            'speaker-pill' +
            (pulsing ? ' speaker-pill--pulse' : '') +
            (flashing ? ' speaker-pill--flash' : '')
          }
          style={{ ['--pill-color' as string]: color } as React.CSSProperties}
          onClick={(e) => {
            setPickerAnchor(e.currentTarget)
            setPickerForCluster(name)
          }}
          title="Click to rename or assign an enrolled voice"
        >
          <span className="speaker-pill__dot" />
          <span className="speaker-pill__name">{name}</span>
          <ChevronDown
            className="speaker-pill__edit"
            size={12}
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
        {pickerForCluster === name && (
          <SpeakerPicker
            current={name}
            inThisMeeting={speakersInTranscript}
            enrolled={enrolledSpeakers}
            anchorEl={pickerAnchor}
            onPick={(newName) => onPickSpeaker(name, newName)}
            onRename={(newName) => onPickSpeaker(name, newName)}
            onDelete={(target) => onDeleteSpeaker(name, target)}
            onClose={() => {
              setPickerForCluster(null)
              setPickerAnchor(null)
            }}
          />
        )}
      </div>
    )
  })

  // The naming panel shows whenever the open meeting still has unnamed
  // speakers and hasn't been dismissed. Unlike a one-shot transition nudge,
  // this makes it a reliable deep-link target (open a meeting → name people).
  // The cascade banner (post-rename) takes the single inline-banner slot when
  // it's queued, so the two never stack.
  const showNamingPanel =
    !!selectedMeeting &&
    reassignQueue.length === 0 &&
    !namingNudgeDismissed.has(selectedMeeting.id) &&
    hasUnnamedSpeakers(speakersInTranscript)

  const dismissNaming = (): void => {
    if (!selectedMeeting) return
    const id = selectedMeeting.id
    setNamingNudgeDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  // Re-analyse progress rides the button label (the old inline banner is gone).
  const reanalyzeLabel = (idle: string): string =>
    reanalyzeJobId === null
      ? idle
      : reanalyzeProgress !== null
        ? `Re-analysing… ${reanalyzeProgress}%`
        : 'Re-analysing…'

  const renderMeetingRow = (m: MeetingSummary, snippet?: string): JSX.Element => {
    const isEditing = rowEditingId === m.id
    return (
      <div
        key={m.id}
        role="button"
        tabIndex={0}
        className={
          'meetings__row' +
          (m.id === selectedId ? ' meetings__row--active' : '') +
          (isEditing ? ' meetings__row--editing' : '') +
          (m.isLive ? ' meetings__row--live' : '') +
          (m.status === 'processing' ? ' meetings__row--processing' : '')
        }
        onClick={() => {
          if (isEditing) return
          void onSelect(m)
        }}
        onKeyDown={(e) => {
          if (isEditing) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void onSelect(m)
          }
        }}
      >
        <div className="meetings__row-main">
          {isEditing ? (
            <input
              autoFocus
              className="meetings__row-input"
              value={rowEditingValue}
              onChange={(e) => setRowEditingValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitRowRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelRowRename()
                }
              }}
              onBlur={() => void commitRowRename()}
            />
          ) : (
            <div className="meetings__row-title">
              {m.isLive && (
                <span className="meetings__row-live-dot" aria-label="Recording in progress" />
              )}
              <span>{m.title}</span>
              {m.status === 'processing' && (
                <span
                  className="processing-pill"
                  aria-label="Processing"
                  title="Transcribing and separating speakers"
                >
                  <Loader2
                    size={11}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="home-status-icon--spin"
                  />
                  <span>Processing</span>
                </span>
              )}
              {m.status === 'refining' && (
                <span
                  className="processing-pill"
                  aria-label="Refining"
                  title="Upgrading speaker attribution (Max accuracy)"
                >
                  <Loader2
                    size={11}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="home-status-icon--spin"
                  />
                  <span>Refining</span>
                </span>
              )}
            </div>
          )}
          {!isEditing && !m.isLive && (
            <div className="meetings__row-actions">
              <div className="meetings__row-tag-wrap">
                <button
                  type="button"
                  className={
                    'meetings__row-action' +
                    (rowMenuForId === m.id || tagPickerForRowId === m.id
                      ? ' meetings__row-action--open'
                      : '')
                  }
                  aria-label="Meeting actions"
                  title="Meeting actions"
                  aria-haspopup="menu"
                  aria-expanded={rowMenuForId === m.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTagPickerForRowId(null)
                    setTagPickerAnchor(null)
                    if (rowMenuForId === m.id) {
                      setRowMenuForId(null)
                      setRowMenuAnchor(null)
                    } else {
                      setRowMenuForId(m.id)
                      setRowMenuAnchor(e.currentTarget)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                    }
                  }}
                >
                  <MoreVertical size={15} strokeWidth={2} aria-hidden="true" />
                </button>
                {rowMenuForId === m.id && (
                  <RowMenu
                    anchorEl={rowMenuAnchor}
                    onClose={() => {
                      setRowMenuForId(null)
                      setRowMenuAnchor(null)
                    }}
                    items={[
                      {
                        key: 'rename',
                        label: 'Edit title',
                        icon: <PencilIcon size={13} />,
                        onSelect: () => {
                          setRowMenuForId(null)
                          setRowMenuAnchor(null)
                          beginRowRename(m)
                        }
                      },
                      {
                        key: 'tags',
                        label: 'Edit tags',
                        icon: <TagIcon size={13} strokeWidth={2} aria-hidden="true" />,
                        onSelect: () => {
                          setTagPickerForRowId(m.id)
                          setTagPickerAnchor(rowMenuAnchor)
                          setRowMenuForId(null)
                        }
                      },
                      {
                        key: 'delete',
                        label: 'Delete meeting',
                        icon: <Trash2 size={13} strokeWidth={2} aria-hidden="true" />,
                        danger: true,
                        onSelect: () => {
                          setRowMenuForId(null)
                          setRowMenuAnchor(null)
                          void onDeleteMeeting(m)
                        }
                      }
                    ]}
                  />
                )}
                {tagPickerForRowId === m.id && (
                  <TagPicker
                    allTags={allTags}
                    activeTagIds={m.tagIds}
                    anchorEl={tagPickerAnchor}
                    onToggle={(tagId) => void onToggleTagForRow(m.id, tagId)}
                    onClose={() => {
                      setTagPickerForRowId(null)
                      setTagPickerAnchor(null)
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
        {m.isLive ? (
          <div className="meetings__row-meta meetings__row-meta--live">
            Recording in progress — full transcript when meeting ends.
          </div>
        ) : m.status === 'processing' ? (
          <div className="meetings__row-meta meetings__row-meta--processing">
            {(() => {
              const proc = appStatus.processing?.find((p) => p.id === m.id)
              if (proc?.stuck) return "Processing didn't finish — open to recover it."
              if (!proc) return 'Processing · Working…'
              return `Processing · ${PROCESSING_STAGE_LABEL[proc.stage]} · ${formatProcessingElapsed(proc.startedAt)} elapsed`
            })()}
          </div>
        ) : (
          <div className="meetings__row-meta">
            <span>{formatDateRelative(m.date)}</span>
            <span aria-hidden="true">·</span>
            <span className="meetings__row-meta-duration">
              {formatDuration(m.durationSeconds)}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {m.speakerCount} {m.speakerCount === 1 ? 'speaker' : 'speakers'}
            </span>
          </div>
        )}
        {snippet && (
          <div className="meetings__row-snippet">
            {highlightParts(snippet, query).map((part, i) =>
              part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
            )}
          </div>
        )}
        {m.tagIds.length > 0 && (
          <div className="meetings__row-tags">
            {m.tagIds.map((id) => {
              const t = tagById(id)
              if (!t) return null
              return (
                <span
                  key={id}
                  className="meetings__row-tag-pill"
                  style={{ background: t.color }}
                >
                  <TagIcon size={9} aria-hidden="true" className="meetings__row-tag-icon" />
                  <span>{t.name}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="meetings">
      <div className="meetings__list-wrap">
        {/* Search — matches title, speakers, tags, and (debounced) transcripts. ⌘F focuses it. */}
        <div className="meetings__search">
          <Search size={14} aria-hidden="true" className="meetings__search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            role="searchbox"
            className="meetings__search-input"
            placeholder="Search meetings"
            aria-label="Search meetings"
            value={query}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                clearSearch()
              }
            }}
          />
          {searching && (
            <Loader2
              size={14}
              aria-hidden="true"
              className="meetings__search-spinner home-status-icon--spin"
            />
          )}
          {query && !searching && (
            <button
              type="button"
              className="meetings__search-clear"
              onClick={clearSearch}
              aria-label="Clear search"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Live result-count announcement for screen readers (search only). */}
        <div className="sr-only" role="status" aria-live="polite">
          {query.trim() ? `${totalResults} ${totalResults === 1 ? 'meeting' : 'meetings'}` : ''}
        </div>

        {/* Tag filter chips */}
        <div className="tag-filter-row" role="toolbar" aria-label="Filter meetings by tag">
          <button
            className={'tag-chip' + (tagFilter === null ? ' tag-chip--active' : '')}
            onClick={() => setTagFilter(null)}
            aria-pressed={tagFilter === null}
          >
            <Filter size={11} aria-hidden="true" className="tag-chip__leading-icon" />
            <span>All</span>
          </button>
          {allTags.map((tag) => {
            const active = tagFilter === tag.id
            return (
              <button
                key={tag.id}
                className={'tag-chip' + (active ? ' tag-chip--active' : '')}
                style={
                  {
                    borderColor: tag.color,
                    ['--chip-color' as string]: tag.color
                  } as React.CSSProperties
                }
                onClick={() => setTagFilter(tag.id)}
                aria-pressed={active}
              >
                <span className="tag-chip__dot" style={{ background: tag.color }} />
                <span>{tag.name}</span>
                {active && (
                  <Check size={11} aria-hidden="true" className="tag-chip__check" />
                )}
              </button>
            )
          })}
        </div>

        <div className="meetings__list">
          {loading && (
            <div className="meetings__list-skeleton" aria-hidden="true">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          )}
          {!loading && !query.trim() && dateGroups.length === 0 && (
            <div className="empty-state empty-state--in-list">
              <Inbox size={32} aria-hidden="true" className="empty-state__icon" />
              <div className="empty-state__title">
                {tagFilter ? 'Nothing here yet' : 'No meetings yet'}
              </div>
              <div className="empty-state__hint">
                {tagFilter
                  ? 'No meetings match this tag.'
                  : 'Import an audio file or start watching to create your first meeting.'}
              </div>
            </div>
          )}
          {!loading && noResults && (
            <div className="empty-state empty-state--in-list">
              <Search size={28} aria-hidden="true" className="empty-state__icon" />
              <div className="empty-state__title">
                {searching ? 'Searching…' : `Nothing matches "${query.trim()}"`}
              </div>
              {!searching && (
                <button type="button" className="btn btn--small" onClick={clearSearch}>
                  Clear search
                </button>
              )}
            </div>
          )}
          {!loading &&
            dateGroups.map((group) => (
              <div key={group.key} className="meetings__group">
                <div className="meetings__group-header" role="presentation">
                  {group.label}
                </div>
                {group.meetings.map((m) => renderMeetingRow(m))}
              </div>
            ))}
          {!loading && transcriptOnlyHits.length > 0 && (
            <div className="meetings__group">
              <div className="meetings__group-header" role="presentation">
                In transcripts
              </div>
              {transcriptOnlyHits.map(({ meeting, snippet }) => renderMeetingRow(meeting, snippet))}
            </div>
          )}
        </div>
      </div>

      <div className="meetings__detail">
        {!selectedMeeting && <div className="empty">Select a meeting to view its transcript.</div>}
        {selectedMeeting && selectedMeeting.isLive && (
          /* TICKET-001: live placeholders have no transcript on disk yet —
             show a dedicated empty state instead of the full editor stack,
             which would try to render an empty transcript + speaker pills. */
          <div className="empty meetings__detail-live-empty">
            <div className="meetings__detail-live-title">
              <span className="meetings__row-live-dot" aria-hidden="true" />
              <span>{selectedMeeting.title}</span>
            </div>
            <div className="meetings__detail-live-body">
              Recording in progress. The transcript will appear here when
              the meeting ends.
            </div>
          </div>
        )}
        {selectedMeeting && !selectedMeeting.isLive && (
          <>
            {/* ── Title row ────────────────────────────────────────────── */}
            <div className="detail-header">
              <div className="detail-title-wrap">
                {titleEditing ? (
                  <input
                    autoFocus
                    className="detail-title-input"
                    value={titleValue}
                    onChange={(e) => setTitleValue(e.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitTitle()
                      if (e.key === 'Escape') setTitleEditing(false)
                    }}
                  />
                ) : (
                  <h2 className="detail-title" onClick={beginTitleEdit} title="Click to rename">
                    {selectedMeeting.title}
                  </h2>
                )}
                <div className="detail-meta">
                  <span>{formatDate(selectedMeeting.date)}</span>
                  {selectedMeeting.status === 'processing' ? (
                    <>
                      <span>·</span>
                      <span
                        className="processing-pill"
                        aria-label="Processing"
                        title="Transcribing and separating speakers"
                      >
                        <Loader2
                          size={11}
                          strokeWidth={2}
                          aria-hidden="true"
                          className="home-status-icon--spin"
                        />
                        <span>Processing</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span>·</span>
                      <span>{formatDuration(selectedMeeting.durationSeconds)}</span>
                      <span>·</span>
                      <span>{selectedMeeting.speakerCount} speakers</span>
                    </>
                  )}
                </div>
              </div>
              <div className="detail-actions">
                <button
                  className="btn"
                  onClick={() => setReanalyzePending((v) => !v)}
                >
                  Re-analyse…
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void window.api.meetings.open(selectedMeeting.folderPath)
                  }}
                >
                  Show in Finder
                </button>
                <button
                  className="btn"
                  onClick={() => void onCopyTranscript()}
                  disabled={segments.length === 0 && !transcript?.transcript}
                >
                  {copiedTranscript ? 'Copied' : 'Copy transcript'}
                </button>
              </div>
            </div>

            {reanalyzePending && (
              <div className="reanalyze-bar">
                <span className="reanalyze-bar__label">Speakers</span>
                <select
                  value={String(reanalyzeSpeakers)}
                  onChange={(e) => {
                    const raw = e.target.value
                    setReanalyzeSpeakers(
                      raw === 'auto' ? 'auto' : (Number(raw) as NumSpeakersHint)
                    )
                  }}
                  className="select"
                >
                  {NUM_SPEAKERS_OPTIONS.map((opt) => (
                    <option key={String(opt)} value={String(opt)}>
                      {labelForNumSpeakers(opt)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn--primary"
                  onClick={() => void onReanalyze()}
                  disabled={reanalyzeJobId !== null}
                >
                  {reanalyzeLabel('Run')}
                </button>
                <button
                  className="btn"
                  onClick={() => void onReanalyzeMax()}
                  disabled={reanalyzeJobId !== null}
                  title="Slower, higher-accuracy speaker attribution (several minutes)"
                >
                  Max accuracy
                </button>
                <button className="btn" onClick={() => setReanalyzePending(false)}>
                  Cancel
                </button>
              </div>
            )}

            {/* ── Speaker naming — one surface ──────────────────────────
                When the meeting still has unnamed speakers, the pills live
                inside a "Who was in this meeting?" panel that invites naming;
                otherwise they show as the plain Speakers row. Either way the
                pill markup comes from the single `speakerPills` render. The
                native post-processing popup is retired via the engine-config
                bridge (`suppressSpeakerNamingWindow`) — until the engine
                honours it, both may briefly appear. */}
            {speakersInTranscript.length > 0 &&
              (showNamingPanel ? (
                <div
                  className="naming-panel"
                  id="meeting-naming-panel"
                  role="group"
                  aria-label="Name the speakers"
                >
                  <div className="naming-panel__head">
                    <span className="naming-panel__title">Who was in this meeting?</span>
                    <button type="button" className="naming-panel__done" onClick={dismissNaming}>
                      Done
                    </button>
                  </div>
                  <div className="speaker-row speaker-row--in-panel">{speakerPills}</div>
                  <p className="naming-panel__hint">
                    Click a name to assign or rename. Named voices are recognised automatically next
                    time.
                  </p>
                </div>
              ) : (
                <div className="speaker-row">
                  <span className="speaker-row__label">Speakers</span>
                  {speakerPills}
                </div>
              ))}

            {/* ── Audio player ─────────────────────────────────────────── */}
            {/* Hidden on the Video tab so only one media element owns
                currentTime / playback state at a time. */}
            {audioSrc && tab !== 'video' && (
              <div className="player-bar">
                <audio
                  ref={audioRef}
                  src={audioSrc}
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration
                    setDuration(isFinite(d) ? d : 0)
                  }}
                  onDurationChange={(e) => {
                    const d = e.currentTarget.duration
                    if (isFinite(d) && d > 0) setDuration(d)
                  }}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
                <button
                  className="player-bar__btn"
                  onClick={() => {
                    if (!audioRef.current) return
                    if (audioRef.current.paused) void audioRef.current.play()
                    else audioRef.current.pause()
                  }}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause size={18} strokeWidth={2.25} aria-hidden="true" />
                  ) : (
                    <Play
                      size={18}
                      strokeWidth={2.25}
                      aria-hidden="true"
                      style={{ marginLeft: 2 }}
                    />
                  )}
                </button>
                <span className="player-bar__time player-bar__time--elapsed">
                  {formatHHMMSS(currentTime)}
                </span>
                <div className="player-bar__seek-wrap" ref={seekWrapRef}>
                  {/*
                   * Speaker-colour track — one absolutely-positioned slice per
                   * segment, sized as a percentage of the total duration so
                   * the whole strip reads as "who is talking when" at a
                   * glance. Sits behind the scrubber thumb / progress
                   * overlay (z-index ordering handled in CSS).
                   */}
                  {duration > 0 && segments.length > 0 && (
                    <div className="player-bar__speaker-track" aria-hidden="true">
                      {segments.map((seg, i) => {
                        const startPct = Math.max(0, (seg.start / duration) * 100)
                        const widthPct = Math.max(
                          0,
                          ((Math.min(seg.end, duration) - seg.start) / duration) * 100
                        )
                        if (widthPct <= 0) return null
                        return (
                          <span
                            key={i}
                            className="player-bar__speaker-segment"
                            style={{
                              left: `${startPct}%`,
                              width: `${widthPct}%`,
                              background: colorForSpeaker(seg.speaker)
                            }}
                          />
                        )
                      })}
                    </div>
                  )}
                  <div
                    className="player-bar__seek-progress"
                    aria-hidden="true"
                    style={{
                      width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%'
                    }}
                  />
                  <input
                    className="player-bar__seek"
                    type="range"
                    min={0}
                    max={duration || 1}
                    step={0.1}
                    value={currentTime}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      if (audioRef.current) audioRef.current.currentTime = t
                      setCurrentTime(t)
                    }}
                    onMouseMove={onSeekMouseMove}
                    onMouseLeave={onSeekMouseLeave}
                    aria-label="Seek"
                  />
                  {seekHover && (
                    <div
                      className="audio-tooltip"
                      style={{ left: seekHover.x }}
                      role="tooltip"
                    >
                      {hoverSpeaker && (
                        <span
                          className="audio-tooltip__speaker"
                          style={
                            {
                              ['--tooltip-speaker-color' as string]:
                                colorForSpeaker(hoverSpeaker)
                            } as React.CSSProperties
                          }
                        >
                          {hoverSpeaker}
                        </span>
                      )}
                      <span className="audio-tooltip__time">
                        {formatHHMMSS(seekHover.time)}
                      </span>
                    </div>
                  )}
                </div>
                <span className="player-bar__time player-bar__time--total">
                  {duration > 0 ? formatHHMMSS(duration) : '—'}
                </span>
                <div className="player-bar__skip-group" aria-label="Skip controls">
                  <button
                    className="player-bar__btn-small"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = Math.max(
                          0,
                          audioRef.current.currentTime - 5
                        )
                      }
                    }}
                    aria-label="Back 5 seconds"
                    title="Back 5 seconds"
                  >
                    <SkipBack size={14} strokeWidth={2} aria-hidden="true" />
                    <span className="player-bar__btn-small-label">5s</span>
                  </button>
                  <button
                    className="player-bar__btn-small"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = Math.min(
                          audioRef.current.duration || 0,
                          audioRef.current.currentTime + 5
                        )
                      }
                    }}
                    aria-label="Forward 5 seconds"
                    title="Forward 5 seconds"
                  >
                    <span className="player-bar__btn-small-label">5s</span>
                    <SkipForward size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            {/* ── Cascade banner ──────────────────────────────────────────
                Shown after a successful cluster rename or per-segment reassign
                on the currently-selected meeting. Aggregates EVERY touched
                speaker since the last re-analyse / meeting switch as colored
                inline pills, so the user sees at a glance every voice that a
                single re-analyse will propagate. Auto-dismisses on a successful
                re-analyse; "Later" clears the queue (next rename re-populates). */}
            {reassignQueue.length > 0 && (
              <div
                className="cascade-banner"
                style={{
                  // Single-speaker case: tint the accent stripe with that
                  // speaker's color (familiar v0.7 behaviour). With multiple
                  // speakers, fall back to the neutral brand accent — picking
                  // one speaker's color over another would be arbitrary.
                  borderLeftColor:
                    reassignQueue.length === 1
                      ? colorForSpeaker(reassignQueue[0]!)
                      : 'var(--accent)'
                }}
                role="status"
              >
                <span className="cascade-banner__icon" aria-hidden="true">
                  <RefreshCw size={14} strokeWidth={2} />
                </span>
                <div className="cascade-banner__body">
                  {reassignQueue.length === 1 ? (
                    <>
                      <div className="cascade-banner__line">
                        Updated <strong>&ldquo;{reassignQueue[0]}&rdquo;</strong>&apos;s
                        voice in your enrolled list.
                      </div>
                      <div className="cascade-banner__line cascade-banner__line--dim">
                        Re-analyse this meeting to apply{' '}
                        <strong>&ldquo;{reassignQueue[0]}&rdquo;</strong> everywhere
                        their voice appears.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="cascade-banner__line cascade-banner__pills-line">
                        <span>Updated voices:</span>
                        {reassignQueue.map((name) => {
                          const color = colorForSpeaker(name)
                          return (
                            <span
                              key={name}
                              className="speaker-pill speaker-pill--inline"
                              style={
                                {
                                  ['--pill-color' as string]: color
                                } as React.CSSProperties
                              }
                            >
                              <span className="speaker-pill__dot" />
                              <span className="speaker-pill__name">{name}</span>
                            </span>
                          )
                        })}
                      </div>
                      <div className="cascade-banner__line cascade-banner__line--dim">
                        Re-analyse this meeting to apply these voices everywhere
                        they appear.
                      </div>
                    </>
                  )}
                </div>
                <div className="cascade-banner__actions">
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    onClick={() => void onCascadeReanalyze()}
                    disabled={reanalyzeJobId !== null}
                  >
                    {reanalyzeLabel('Re-analyse now')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setReassignQueue([])}
                    disabled={reanalyzeJobId !== null}
                  >
                    Later
                  </button>
                </div>
              </div>
            )}

            {/* ── Tab strip with animated indicator ─────────────────────── */}
            <div className="tab-strip" ref={tabStripRef} role="tablist">
              {visibleTabs.map((t, i) => (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabBtnRefs.current[i] = el
                  }}
                  role="tab"
                  id={`meeting-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls={`meeting-tabpanel-${t.key}`}
                  className={'tab-strip__btn' + (tab === t.key ? ' tab-strip__btn--active' : '')}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
              <span
                className="tab-strip__indicator"
                aria-hidden="true"
                style={{
                  width: tabIndicator.width,
                  transform: `translateX(${tabIndicator.left}px)`,
                  opacity: tabIndicator.width === 0 ? 0 : 1
                }}
              />
            </div>

            {/* ── Tab content ───────────────────────────────────────────── */}
            {tab === 'summary' && transcript?.summaryMarkdown && (
              <div
                className="tab-pane summary-pane"
                role="tabpanel"
                id="meeting-tabpanel-summary"
                aria-labelledby="meeting-tab-summary"
              >
                <div className="summary-pane__actions">
                  <button className="btn btn--small" onClick={() => void onCopySummary()}>
                    {copiedSummary ? 'Copied' : 'Copy summary'}
                  </button>
                </div>
                <MarkdownLite markdown={transcript.summaryMarkdown} />
              </div>
            )}
            {tab === 'transcript' && (
              <>
                {transcriptLoading && <div className="empty">Loading transcript…</div>}
                {!transcriptLoading &&
                  segments.length === 0 &&
                  selectedMeeting.status === 'processing' &&
                  (() => {
                    const proc = appStatus.processing?.find((p) => p.id === selectedMeeting.id)
                    if (proc?.stuck) {
                      const busy = processingNowFor === selectedMeeting.id
                      const started = processNowStartedFor === selectedMeeting.id
                      const error =
                        processNowError?.id === selectedMeeting.id ? processNowError.message : null
                      return (
                        <div className="meetings__detail-stuck" role="alert">
                          <div className="meetings__detail-stuck-head">
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span>Processing didn&apos;t finish</span>
                          </div>
                          <p className="meetings__detail-stuck-body">
                            The recording is safe on disk, but the transcript never arrived. You can
                            process it now with the built-in pipeline.
                          </p>
                          <div className="meetings__detail-stuck-actions">
                            <button
                              className="btn btn--primary"
                              onClick={() => void handleProcessNow()}
                              disabled={busy || started}
                            >
                              {busy
                                ? 'Processing…'
                                : started
                                  ? 'Processing started'
                                  : 'Process now'}
                            </button>
                            <button
                              className="btn"
                              onClick={() =>
                                void window.api.meetings.open(selectedMeeting.folderPath)
                              }
                            >
                              Show files in Finder
                            </button>
                          </div>
                          {started && !error && (
                            <p className="meetings__detail-stuck-note">
                              Processing started — it&apos;ll appear as a new meeting when it&apos;s
                              ready.
                            </p>
                          )}
                          {error && (
                            <p className="meetings__detail-stuck-error">
                              Couldn&apos;t start processing: {error}
                            </p>
                          )}
                        </div>
                      )
                    }
                    const stageLabel = proc ? PROCESSING_STAGE_LABEL[proc.stage] : 'Working…'
                    const recorded = proc ? formatRecordedLength(proc.estDurationSec) : null
                    const relStarted = proc ? formatStartedRelative(proc.startedAt) : null
                    const subline = [recorded, stageLabel, relStarted].filter(Boolean).join(' · ')
                    return (
                      <div className="meetings__detail-processing" role="status">
                        <div className="meetings__detail-processing-head">
                          <Loader2
                            size={16}
                            aria-hidden="true"
                            className="home-status-icon--spin"
                          />
                          <span>Processing this meeting</span>
                        </div>
                        {subline && (
                          <div className="meetings__detail-processing-sub">{subline}</div>
                        )}
                        <p className="meetings__detail-processing-note">
                          You can play the audio above while you wait. Fast mode usually takes about
                          half the meeting length.
                        </p>
                      </div>
                    )
                  })()}
                {!transcriptLoading &&
                  segments.length === 0 &&
                  selectedMeeting.status !== 'processing' &&
                  (transcript?.transcript?.trim() ? (
                    // Diarized segments are absent, but a raw transcript exists
                    // (e.g. the engine wrote a protocol without a segments
                    // sidecar). Show it verbatim rather than a dead-end empty
                    // state — the text is what the user came for.
                    <pre className="transcript-raw">{transcript.transcript}</pre>
                  ) : (
                    <div className="empty">(No transcript text yet.)</div>
                  ))}
                {!transcriptLoading && segments.length > 0 && (
                  <div className="transcript-list" ref={transcriptListRef}>
                    {segments.map((seg, i) => (
                      <div
                        key={i}
                        data-segment-index={i}
                        className={
                          'segment-row' + (i === activeSegmentIndex ? ' segment-row--active' : '')
                        }
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          seekTo(seg.start, true)
                          flashPillFor(seg.speaker)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            seekTo(seg.start, true)
                            flashPillFor(seg.speaker)
                          }
                        }}
                        title="Click to jump to this point"
                      >
                        <span className="segment-row__time">{formatHHMMSS(seg.start)}</span>
                        <span className="segment-row__speaker-wrap">
                          <button
                            type="button"
                            className="segment-row__speaker"
                            style={{ color: colorForSpeaker(seg.speaker) }}
                            onClick={(e) => {
                              // Don't trigger the seek action on the parent row.
                              e.stopPropagation()
                              const target = e.currentTarget
                              setPickerForSegment((cur) => {
                                const next = cur === i ? null : i
                                setPickerAnchor(next === null ? null : target)
                                return next
                              })
                            }}
                            title="Click to reassign this segment's speaker"
                          >
                            {seg.speaker}
                          </button>
                          {pickerForSegment === i && (
                            <SpeakerPicker
                              current={seg.speaker}
                              inThisMeeting={allSpeakersForPicker}
                              addedSpeakers={selectedMeeting.additionalSpeakers ?? []}
                              enrolled={enrolledSpeakers}
                              anchorEl={pickerAnchor}
                              onPick={(newName) => onReassignSegment(i, newName)}
                              onRename={(newName) => onPickSpeaker(seg.speaker, newName)}
                              onClose={() => {
                                setPickerForSegment(null)
                                setPickerAnchor(null)
                              }}
                            />
                          )}
                        </span>
                        <span className="segment-row__text">{seg.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'video' && videoSrc && (
              <div
                className="tab-pane video-pane"
                role="tabpanel"
                id="meeting-tabpanel-video"
                aria-labelledby="meeting-tab-video"
              >
                <video
                  ref={videoRef}
                  className="video-pane__player"
                  src={videoSrc}
                  controls
                  preload="metadata"
                  playsInline
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration
                    setDuration(isFinite(d) ? d : 0)
                  }}
                  onDurationChange={(e) => {
                    const d = e.currentTarget.duration
                    if (isFinite(d) && d > 0) setDuration(d)
                  }}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
                <p className="video-pane__privacy-note">
                  Video of the meeting window (or full screen, per your Recording settings). Click
                  any transcript line to jump the video there.
                </p>
              </div>
            )}

            {tab === 'speakers' && (
              <div
                className="tab-pane"
                role="tabpanel"
                id="meeting-tabpanel-speakers"
                aria-labelledby="meeting-tab-speakers"
              >
                <p className="tab-pane__intro">
                  Speakers detected in this meeting. Click a name to rename it or assign an
                  already-enrolled voice. Enrolled voices are matched automatically in future
                  imports.
                </p>
                <div className="speakers-tab__pills">
                  {speakersInTranscript.length === 0 &&
                    (selectedMeeting.additionalSpeakers ?? []).length === 0 && (
                      <div className="empty">No speakers detected yet.</div>
                    )}
                  {speakersInTranscript.map((name) => {
                    const pulsing = activeSpeaker === name
                    const flashing = flashedSpeaker === name
                    const color = colorForSpeaker(name)
                    return (
                      <div key={name} className="speaker-pill-wrap">
                        <button
                          className={
                            'speaker-pill' +
                            (pulsing ? ' speaker-pill--pulse' : '') +
                            (flashing ? ' speaker-pill--flash' : '')
                          }
                          style={
                            {
                              ['--pill-color' as string]: color
                            } as React.CSSProperties
                          }
                          onClick={(e) => {
                            setPickerAnchor(e.currentTarget)
                            setPickerForCluster(name)
                          }}
                        >
                          <span className="speaker-pill__dot" />
                          <span className="speaker-pill__name">{name}</span>
                          <ChevronDown
                            className="speaker-pill__edit"
                            size={12}
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        </button>
                        {pickerForCluster === name && (
                          <SpeakerPicker
                            current={name}
                            inThisMeeting={allSpeakersForPicker}
                            addedSpeakers={selectedMeeting.additionalSpeakers ?? []}
                            enrolled={enrolledSpeakers}
                            anchorEl={pickerAnchor}
                            onPick={(newName) => onPickSpeaker(name, newName)}
                            onRename={(newName) => onPickSpeaker(name, newName)}
                            onDelete={(target) => onDeleteSpeaker(name, target)}
                            onClose={() => {
                              setPickerForCluster(null)
                              setPickerAnchor(null)
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                  {(selectedMeeting.additionalSpeakers ?? [])
                    .filter((n) => !speakersInTranscript.includes(n))
                    .map((name) => {
                      const color = colorForSpeaker(name)
                      return (
                        <span
                          key={`add-${name}`}
                          className="speaker-pill speaker-pill--added"
                          style={
                            {
                              ['--pill-color' as string]: color
                            } as React.CSSProperties
                          }
                          title="Added manually — assign segments to this person from the Transcript tab."
                        >
                          <span className="speaker-pill__dot" />
                          <span className="speaker-pill__name">{name}</span>
                        </span>
                      )
                    })}
                  <div className="speaker-pill-wrap">
                    <button
                      className="add-speaker-btn"
                      onClick={(e) => {
                        const target = e.currentTarget
                        setAddSpeakerOpen((v) => {
                          const next = !v
                          setPickerAnchor(next ? target : null)
                          return next
                        })
                      }}
                      title="Add a person who was present but not auto-detected"
                    >
                      + Add speaker
                    </button>
                    {addSpeakerOpen && (
                      <SpeakerPicker
                        current=""
                        inThisMeeting={allSpeakersForPicker}
                        enrolled={enrolledSpeakers}
                        anchorEl={pickerAnchor}
                        onPick={(newName) => onAddSpeaker(newName)}
                        onClose={() => {
                          setAddSpeakerOpen(false)
                          setPickerAnchor(null)
                        }}
                        hideInMeetingGroup
                        newNamePlaceholder="Type a new name…"
                      />
                    )}
                  </div>
                </div>
                {enrolledSpeakers.length > 0 && (
                  <>
                    <h4 className="enrolled-list__heading">All enrolled voices</h4>
                    <div className="enrolled-list">
                      {enrolledSpeakers
                        .slice()
                        .sort((a, b) => b.useCount - a.useCount)
                        .map((s) => (
                          <div key={s.name} className="enrolled-list__row">
                            <span
                              className="enrolled-list__dot"
                              style={{ background: colorForSpeaker(s.name) }}
                              aria-hidden="true"
                            />
                            <span className="enrolled-list__name">{s.name}</span>
                            <span className="enrolled-list__count">
                              {s.useCount} meeting{s.useCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === 'export' && (
              <div
                className="tab-pane export-preview"
                role="tabpanel"
                id="meeting-tabpanel-export"
                aria-labelledby="meeting-tab-export"
              >
                {/*
                 * Format selector chips. Live recordings (engine: prefix)
                 * only support txt/md export, so the rest are disabled
                 * with an explanatory title. Audio is disabled when the
                 * meeting has no audio file.
                 */}
                <div
                  className="export-preview__chips"
                  role="tablist"
                  aria-label="Export format"
                >
                  {EXPORT_FORMATS.map((f) => {
                    const Icon = f.Icon
                    // Every format is offered for both engine and imported
                    // meetings; a format with no source file (or no structured
                    // transcript) surfaces a readable error in the preview pane
                    // rather than a disabled chip.
                    const audioDisabled = f.value === 'audio' && !selectedMeeting.hasAudio
                    const videoDisabled = f.value === 'video' && !selectedMeeting.hasVideo
                    const disabled = audioDisabled || videoDisabled
                    const active = previewFormat === f.value
                    return (
                      <button
                        key={f.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        disabled={disabled}
                        title={
                          audioDisabled
                            ? 'This meeting has no audio file.'
                            : videoDisabled
                              ? 'This meeting has no screen video.'
                              : undefined
                        }
                        className={
                          'export-preview__chip' +
                          (active ? ' export-preview__chip--active' : '')
                        }
                        onClick={() => setPreviewFormat(f.value)}
                      >
                        <Icon
                          size={14}
                          strokeWidth={2}
                          aria-hidden="true"
                          className="export-preview__chip-icon"
                        />
                        <span>{f.label}</span>
                      </button>
                    )
                  })}
                </div>

                {/*
                 * Preview header — section title + the explicit Export
                 * button. The button is the only thing that opens the
                 * Save dialog; the chips just change what's previewed.
                 */}
                <div className="export-preview__header">
                  <div className="export-preview__header-text">
                    <h3 className="export-preview__title">Preview</h3>
                    <div className="export-preview__subtitle">
                      {(() => {
                        const meta = EXPORT_FORMATS.find((x) => x.value === previewFormat)
                        const cached = previewCache[previewFormat]
                        const filename =
                          cached?.status === 'ready' ? cached.payload.filename : null
                        return filename ? filename : meta?.hint ?? ''
                      })()}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void onExport(previewFormat)}
                    disabled={
                      exportBusy ||
                      (previewFormat === 'audio' && !selectedMeeting.hasAudio) ||
                      (previewFormat === 'video' && !selectedMeeting.hasVideo) ||
                      // A format whose preview failed (e.g. no structured
                      // transcript) can't be exported — the pane shows why.
                      previewCache[previewFormat]?.status === 'error'
                    }
                  >
                    {exportBusy ? 'Exporting…' : 'Export…'}
                  </button>
                </div>

                {/*
                 * Preview pane. Renders one of:
                 *   - "Loading preview…" while the IPC roundtrip is in flight
                 *   - error message in --danger if the fetch failed
                 *   - audio placeholder card (icon + filename + size) for .wav
                 *   - pretty-printed JSON / raw text inside a <pre> for the rest
                 *
                 * Solid `--surface-base` background per spec (no transparency
                 * — the cascade-banner sibling rules apply only there).
                 */}
                <div className="export-preview__pane-wrap">
                  {(() => {
                    const cached = previewCache[previewFormat]
                    const audioUnavailable =
                      previewFormat === 'audio' && !selectedMeeting.hasAudio
                    const videoUnavailable =
                      previewFormat === 'video' && !selectedMeeting.hasVideo

                    if (audioUnavailable) {
                      return (
                        <div className="export-preview__placeholder">
                          This meeting has no audio file to export.
                        </div>
                      )
                    }
                    if (videoUnavailable) {
                      return (
                        <div className="export-preview__placeholder">
                          This meeting has no screen video to export.
                        </div>
                      )
                    }
                    if (!cached) {
                      // No entry yet → fetcher is in flight (or about to be).
                      return (
                        <div className="export-preview__placeholder">
                          Loading preview…
                        </div>
                      )
                    }
                    if (cached.status === 'error') {
                      return (
                        <div
                          className="export-preview__placeholder export-preview__placeholder--error"
                          role="alert"
                        >
                          Failed to load preview: {cached.message}
                        </div>
                      )
                    }
                    // Ready — branch by format. Audio + video share the same
                    // binary "file card" (size + filename, no inline body).
                    if (previewFormat === 'audio' || previewFormat === 'video') {
                      const isVideo = previewFormat === 'video'
                      return (
                        <div className="export-preview__audio-card">
                          <span
                            className="export-preview__audio-icon"
                            aria-hidden="true"
                          >
                            {isVideo ? (
                              <FileVideo size={48} strokeWidth={1.5} />
                            ) : (
                              <FileAudio size={48} strokeWidth={1.5} />
                            )}
                          </span>
                          <div className="export-preview__audio-meta">
                            <div className="export-preview__audio-filename">
                              {cached.payload.filename}
                            </div>
                            <div className="export-preview__audio-size">
                              {typeof cached.payload.sizeBytes === 'number'
                                ? formatBytes(cached.payload.sizeBytes)
                                : 'Binary file'}
                            </div>
                            <div className="export-preview__audio-hint">
                              {isVideo ? (
                                <>
                                  The whole-screen recording is exported as the
                                  original MP4. Click <strong>Export…</strong> to
                                  save a copy.
                                </>
                              ) : (
                                <>
                                  Audio files are exported as the original WAV.
                                  Click <strong>Export…</strong> to save a copy.
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    }
                    const body =
                      previewFormat === 'json'
                        ? tryFormatJson(cached.payload.body)
                        : cached.payload.body
                    return (
                      <pre
                        className="export-preview__pane"
                        aria-label={`${previewFormat.toUpperCase()} preview`}
                      >
                        {body || '(empty)'}
                      </pre>
                    )
                  })()}
                </div>
              </div>
            )}

            {tab === 'tags' && (
              <div
                className="tab-pane"
                role="tabpanel"
                id="meeting-tabpanel-tags"
                aria-labelledby="meeting-tab-tags"
              >
                <p className="tab-pane__intro">
                  Apply tags so you can filter meetings by project or type. Manage the tag list in
                  Settings.
                </p>
                {allTags.length === 0 ? (
                  <div className="empty">
                    No tags defined yet. Open Settings → Tags to create some.
                  </div>
                ) : (
                  <div className="tag-chip-row">
                    {allTags.map((tag) => {
                      const active = selectedMeeting.tagIds.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          className={'tag-chip' + (active ? ' tag-chip--active' : '')}
                          style={
                            {
                              borderColor: tag.color,
                              ['--chip-color' as string]: tag.color
                            } as React.CSSProperties
                          }
                          onClick={() => void onToggleTag(tag.id)}
                        >
                          <span className="tag-chip__dot" style={{ background: tag.color }} />
                          {tag.name}
                          {active && (
                            <span className="tag-chip__check" aria-hidden="true">
                              <Check size={12} strokeWidth={2.5} />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {deletePending && (
        <ConfirmDialog
          title={`Move "${deletePending.title}" to Trash?`}
          body="The transcript, audio, and video move to the macOS Trash. You can restore them from there."
          confirmLabel="Move to Trash"
          danger
          onConfirm={performDeleteMeeting}
          onCancel={() => setDeletePending(null)}
        />
      )}
    </div>
  )
}
