<div align="center">

# Timbre

**Private, on-device meeting transcription for macOS.**

Timbre records your meetings, separates who said what, and turns them into
searchable transcripts — entirely on your Mac. No cloud, no accounts, no API
keys for the core experience.

![platform](https://img.shields.io/badge/platform-macOS%2014.2%2B%20(Apple%20Silicon)-black)
![license](https://img.shields.io/badge/license-MIT-black)
![status](https://img.shields.io/badge/status-beta-black)

</div>

---

## What it does

- 🎙️ **Captures meetings automatically** — detects Google Meet in Chrome and
  records both sides of the conversation (your mic + the meeting's system audio).
- 🗣️ **Separates speakers** — on-device diarization labels each speaker; you can
  rename, merge, or reassign them, and enrolled voices are recognised next time.
- 📝 **Transcribes locally** — speech-to-text runs on the Apple Neural Engine
  (WhisperKit / Parakeet / Qwen3). Export as TXT, Markdown, JSON, or SRT.
- 🖥️ **Optional screen video** — records the meeting's Chrome window (or the whole
  screen) to an HEVC `.mp4` alongside the transcript.
- 🔒 **Private by design** — audio, transcription, and diarization never leave your
  machine. Optional meeting summaries can use a local LLM (Ollama / LM Studio) or
  the Claude CLI — your choice.
- 🪶 **Stays out of the way** — runs quietly in the menu bar and surfaces finished
  meetings automatically.

> Timbre is in **beta** and under active development. Expect rough edges in the UI
> while the capture/transcription core stabilises.

## Requirements

- macOS **14.2+** on **Apple Silicon** (the audio-tap capture API requires 14.2).
- **Google Chrome** (for automatic Google Meet detection).

## Download & install

1. Grab the latest **`Timbre-x.y.z-arm64.dmg`** from the
   [**Releases**](https://github.com/nawaz-git/timbre/releases) page.
2. Open the DMG and drag **Timbre** to **Applications**.

> **Gatekeeper note.** Timbre is currently **self-signed, not Apple-notarized**, so
> on first launch macOS will warn that the developer can't be verified. Either
> **right-click the app → Open** (then confirm once), or clear the quarantine flag:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Timbre.app
> ```
> A notarized build is on the roadmap.

### First-launch permissions

The capture work runs in a bundled background engine, so most prompts mention
**"Timbre Engine"**. Grant, in **System Settings → Privacy & Security**:

| Permission | Why |
|---|---|
| **Screen Recording** | meeting/screen video capture + meeting detection |
| **Microphone** | records your side of the conversation |
| **Automation → Google Chrome** | detects when a Google Meet tab is live |
| **Accessibility** *(if prompted)* | reads meeting window context |

## Build from source

Timbre is two repositories that **must be cloned as siblings** (the app build reads
the engine from `../meeting-transcriber`):

```
<parent>/
  meeting-transcriber/            # the Swift engine  → nawaz-git/timbre-engine
  meeting-transcriber-electron/   # the Timbre app    → nawaz-git/timbre (this repo)
```

```bash
mkdir -p ~/Projects && cd ~/Projects
git clone https://github.com/nawaz-git/timbre-engine.git meeting-transcriber
git clone https://github.com/nawaz-git/timbre.git          meeting-transcriber-electron
cd meeting-transcriber-electron
bash dev/scripts/setup-new-mac.sh   # mints a signing cert, builds engine + app, installs
```

Prerequisites: **Xcode + Swift toolchain**, **Node 20+ / npm**, **git**, and the
**`gh`** CLI. Full details — the signing model, the build recipe, and what's
gitignored — live in [`HANDOFF.md`](./HANDOFF.md).

## How it works

```
Chrome (Google Meet)
   │  detected via Automation + window titles
   ▼
Timbre (Electron + React)  ──UI, settings, meeting library──┐
   │  spawns + configures                                    │
   ▼                                                         │
Timbre Engine (headless Swift)                               │
   • app + mic audio  (AudioTapLib / CATap)                  │
   • screen video     (ScreenCaptureKit)                     │
   • transcription    (WhisperKit / Parakeet / Qwen3, ANE)   │
   • diarization      (FluidAudio, ANE)                      │
   ▼                                                         ▼
  ~/Downloads/MeetingTranscriber/  ◄── transcripts, audio, video, segments
```

The Electron app is the front end; the Swift engine does capture, transcription, and
speaker diarization on-device and writes the results back to disk, which the app
displays. See [`HANDOFF.md`](./HANDOFF.md) for the architecture in depth.

## Tech stack

**App:** Electron 33 · React 18 · TypeScript
**Engine:** Swift (SPM) · [WhisperKit](https://github.com/argmaxinc/WhisperKit) ·
[FluidAudio](https://github.com/FluidInference/FluidAudio) · ScreenCaptureKit ·
CoreAudio (CATap)

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). For how releases
are cut, see [`RELEASING.md`](./RELEASING.md).

## License

[MIT](./LICENSE) © 2026 Nawaz.

## Acknowledgements

- The capture/transcription engine builds on
  [`pasrom/meeting-transcriber`](https://github.com/pasrom/meeting-transcriber) (MIT).
- On-device ML by [WhisperKit](https://github.com/argmaxinc/WhisperKit) and
  [FluidAudio](https://github.com/FluidInference/FluidAudio).
