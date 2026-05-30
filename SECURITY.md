# Security & Privacy

## Privacy model

Timbre is **local-first**. Meeting audio, screen video, transcription, and speaker
diarization are processed **on your Mac** and written to
`~/Downloads/MeetingTranscriber/`. There is no Timbre server and no telemetry.

The only optional network paths are ones **you** configure:
- An optional meeting **summary** can be generated via a local LLM
  (Ollama / LM Studio) or the **Claude CLI** — only if you enable it.
- On first run, on-device ML models are downloaded (WhisperKit / FluidAudio /
  Qwen3) from their public model hosts.

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue.

- Email: **contact@nawaz.ai**
- Or use GitHub's **Private vulnerability reporting**
  (repo → Security → "Report a vulnerability").

Include reproduction steps and the affected version. Please do **not** attach real
meeting recordings; describe the scenario instead. You'll get an acknowledgement as
soon as possible.

## Supported versions

Timbre is in active beta; only the **latest release** receives fixes.
