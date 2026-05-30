# Changelog

All notable changes to Timbre are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [0.39.0]

### Changed
- The microphone is now **always** recorded alongside the meeting audio. The
  "Meeting audio only" toggle was removed — it dropped your own voice entirely,
  and Google Meet's in-call mute is internal web-app state that can't be detected
  from outside the browser.

## [0.38.0]

### Added
- **Capture scope** setting (Settings → Recording): record only the meeting's
  **Chrome window** (default) or the **entire screen**, with a graceful fall-back
  to full-screen when the window can't be resolved. Propagated to the headless
  engine via a small `engine_config.json` bridge.

## [0.37.0]

### Changed
- Redesigned the native **Name Speakers** popup to the minimal monochrome look
  (visual/UX only; automation hooks and behavior unchanged).

## [0.36.0]

### Fixed
- **Audio recorded at ~0.5× speed** on Bluetooth (AirPods) meetings — caused by an
  HFP↔A2DP sample-rate renegotiation; the recorder now tracks the device's actual
  rate per buffer and self-corrects against a wall-clock anchor.
- **Screen video stopped after ~1 second** — the capture stream now has a delegate
  + a frame-staleness watchdog that restarts it onto the same writer.

### Added
- A finished meeting now appears in the list **immediately** with a "Processing"
  badge and live status; the detail view plays the audio right away and upgrades to
  the transcript when processing completes.

## [0.35.0]

### Fixed
- Speaker **reassign / merge / delete** now works for live (flat-transcript) engine
  meetings, and such meetings no longer show "0 speakers · 0:00".

## [0.34.0] and earlier

- Rebrand **Mintr → Timbre**, minimal monochrome theme, headless engine.
- Screen-video recording (HEVC, audio muxed).
- Google Meet auto-detection + dual-source (mic + system) audio capture.
- On-device transcription (WhisperKit / Parakeet / Qwen3) + speaker diarization
  (FluidAudio), with transcript export (TXT / Markdown / JSON / SRT).

[0.39.0]: https://github.com/nawaz-git/timbre/releases/tag/v0.39.0
[0.38.0]: https://github.com/nawaz-git/timbre/releases/tag/v0.38.0
[0.37.0]: https://github.com/nawaz-git/timbre/releases/tag/v0.37.0
[0.36.0]: https://github.com/nawaz-git/timbre/releases/tag/v0.36.0
[0.35.0]: https://github.com/nawaz-git/timbre/releases/tag/v0.35.0
