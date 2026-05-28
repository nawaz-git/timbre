# Meeting Transcriber — Overnight build, morning verification

Built overnight on 2026-05-28. Here's what shipped, what works, and what to verify.

## Install

```bash
open /Users/nawazpasha/Projects/meeting-transcriber-electron/dist/Meeting\ Transcriber-0.1.0-arm64.dmg
```

Drag **Meeting Transcriber.app** to **/Applications**.

First launch will be blocked by Gatekeeper (the app is ad-hoc signed — no Apple Developer cert). One of these fixes it:

```bash
# Option A: strip the quarantine attribute (cleanest)
xattr -dr com.apple.quarantine "/Applications/Meeting Transcriber.app"

# Option B: right-click the app in Finder → Open → Open in the warning dialog
```

After that, double-click to launch normally.

## What works (validated overnight)

### File-import pipeline — proven end-to-end on your 10-min sample
- Cropped `sample.mp3` to first 10 min at `/Users/nawazpasha/Projects/meeting-transcriber/sample-10min.mp3` (1.7 MB).
- Validated the Swift `mt-batch` CLI **using the binary bundled inside the packaged DMG** (not just the dev build). Produced:
  - `audio.wav` (16 kHz mono, 18 MB)
  - `transcript.txt` (20 speaker-tagged segments, clean Speaker 1 / Speaker 2 alternation)
  - `transcript.json` (structured timeline)
  - `speakers.json` (WeSpeaker voice embeddings — these persist so the same people are auto-recognised in later runs)
- Total processing time: **37 seconds for 10 min of audio** (~16× realtime) on the M5 Pro from the bundled binary.
- Verification artefacts at `/tmp/mt-bundled-test/`.

### Electron app
- Minimal black UI, both light and dark themes (auto-detects system pref; manual override in Settings).
- Three views: **Home** (start/stop + import button), **Meetings** (list of past meetings with inline transcript view), **Settings** (output folder + theme).
- Default output folder: `~/Documents/MeetingTranscripts/` — each meeting goes into a timestamped subfolder named `YYYY-MM-DD_HH-MM-SS_<source-name>/`.
- "Import audio file…" → opens file picker → spawns mt-batch → live progress bar → meeting appears in the list when done.
- Output folder is configurable in Settings; the picker creates folders as needed.

### Google Meet detection patch (the original ask)
- Patched `meeting-transcriber` upstream to detect Google Meet via Chrome's window title regex (`^Meet\s*[-—–]\s*\S`).
- Composite detector now runs both the existing IOKit power-assertion detector (covers Teams/Zoom/Webex) AND a new window-title detector (covers Meet).
- 78 tests pass including new Meet-specific cases (matches em-dash, ignores non-Meet Chrome tabs, ignores non-Chrome browsers).
- Branch: `add-google-meet-detection` in `/Users/nawazpasha/Projects/meeting-transcriber`.

## What requires your manual verification in the morning

These need either TCC permissions you have to grant, or a real Google Meet call you have to be in. I couldn't do them autonomously overnight.

### 1. File-import sanity check via the packaged DMG
1. Install per above.
2. Launch the app.
3. Click **Import audio file…**, pick `/Users/nawazpasha/Projects/meeting-transcriber/sample-10min.mp3`.
4. Progress bar should fill over ~35 seconds. State: `Transcribing`.
5. When it goes back to `Idle`, switch to the **Meetings** tab.
6. The new meeting appears at the top of the list. Click it → transcript loads in the right pane with speaker labels.
7. "Show in Finder" opens `~/Documents/MeetingTranscripts/<timestamp>_sample-10min/`.

Expected output folder contents:
```
audio.wav         (16 kHz mono of the input)
transcript.txt    (speaker-tagged transcript)
transcript.json   (structured timeline)
speakers.json     (voice embeddings)
```

### 2. Live recording (Google Meet, Teams, Zoom, Webex)
The Electron app bundles `MeetingTranscriber.app` (the Swift menu-bar engine) inside its Resources. **Start Watching** spawns it.

1. Click **Start Watching** in the Electron app.
2. macOS will prompt for **Screen Recording** and **Microphone** permissions for `MeetingTranscriber`. Grant both. (Restart MeetingTranscriber from its menu bar icon if it doesn't auto-pick up the new permissions.)
3. The menu bar shows a waveform icon (idle).
4. Join a Google Meet. The icon transitions through `recording → transcribing → protocol`. The detection patch I added recognises Meet via Chrome's window title.
5. When the meeting ends, the transcript + protocol land in `~/Downloads/MeetingTranscriber/` (the engine's default folder).
6. **The new live recording shows up in the Electron Meetings tab automatically** — the Electron app scans both `~/Documents/MeetingTranscripts/` (file imports, per-folder layout) AND `~/Downloads/MeetingTranscriber/` (live recordings, flat-file layout), unifying everything into a single list. The Settings tab has an "Open in Finder" button for the live recordings folder so you can navigate there directly.

> **Note:** Files physically live in two folders (engine's default + your configured Output Folder). The Electron app reads both and merges them in the UI. If you'd prefer the engine to also write into your Output Folder, change the engine's setting via its menu bar → Settings → Output Folder (it has its own picker independent of the Electron app's setting).

### 3. Verify mt-batch is bundled correctly inside the DMG
```bash
# After install:
/Applications/Meeting\ Transcriber.app/Contents/Resources/bin/mt-batch --help
```
Should print the CLI usage. If it errors with "command not found" the bundle is corrupt.

## Known limitations

1. **Gatekeeper warning on first launch** — unavoidable without an Apple Developer ID Application cert. Either strip the quarantine attribute (command above) or right-click → Open once.
2. **First run downloads ~1 GB of models** — WhisperKit Large-v3 Turbo on first transcription, FluidAudio diarization model (~150 MB) on first speaker separation. Both cached locally afterwards; subsequent runs are ~14× realtime.
3. **Output folder split (visual unification, physical split)** — file imports go to your configured Output Folder, live recordings go to the engine's `~/Downloads/MeetingTranscriber/`. Both kinds show in the unified Meetings tab; physical files stay separate unless you point the engine at the same folder via its own menu bar Settings.
4. **No app icon** — still using electron-vite scaffold default. Wired into electron-builder via `build/icon.{png,icns,ico}` if you want to replace it.
5. **Speaker count auto-detection on long, single-voice-dominant audio** — the diarizer's default clustering threshold (0.6) sometimes collapses to 1 speaker on audio where one person talks for very long stretches. `mt-batch` exposes `--cluster-threshold` and `--num-speakers` for tuning; the Electron app currently doesn't pass these through (it relies on auto-detect). Tweakable in a future iteration.

## What's where

- **Electron app source:** `/Users/nawazpasha/Projects/meeting-transcriber-electron/`
- **Swift backends (mt-batch + MeetingTranscriber.app):** `/Users/nawazpasha/Projects/meeting-transcriber/` on branch `add-google-meet-detection`
- **Packaged DMG:** `/Users/nawazpasha/Projects/meeting-transcriber-electron/dist/Meeting Transcriber-0.1.0-arm64.dmg`
- **Standalone Swift app DMG (no Electron):** `/Users/nawazpasha/Projects/meeting-transcriber/.build/release/MeetingTranscriber-0.6.0.dmg`
- **Sample test output:** `/tmp/mt-batch-10min/`

## Rebuilding

If you make changes:

```bash
# Rebuild the Swift batch CLI
cd /Users/nawazpasha/Projects/meeting-transcriber/tools/mt-batch
swift build -c release

# Rebuild the live-recording engine
cd /Users/nawazpasha/Projects/meeting-transcriber
./scripts/build_release.sh --no-notarize

# Rebuild + repackage the Electron DMG
cd /Users/nawazpasha/Projects/meeting-transcriber-electron
rm -rf dist
npm run dist:mac
```
