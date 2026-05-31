# Timbre — Project Handoff

Timbre is a Mac-native, on-device meeting transcription app. It records meeting
audio (and optionally screen video), then transcribes and diarizes everything
**locally** — no cloud, no API keys for the core path. The user-facing app is an
Electron desktop app; the actual capture/transcription/diarization runs in a
bundled headless Swift engine.

This document travels in **both** repos so the handoff is self-contained from
either checkout.

> **⚠️ Update — monorepo (2026-05-31):** The engine and app are now a **single
> repo**. The Swift engine was vendored into the app repo at
> `meeting-transcriber/` (merged via `git subtree`, full history preserved), and
> the build reads it from there. The two-repo **sibling** instructions below
> (§2 and §4) are **historical** — you no longer clone the engine separately;
> it's already in `meeting-transcriber/`. Everything else (signing model, build
> recipe, permissions) still applies — just run the engine commands inside the
> `meeting-transcriber/` subfolder instead of a sibling directory.

---

## 1. What Timbre is

- **Front end (ELECTRON):** Electron 33 + React 18 + TypeScript desktop app
  named "Timbre". It owns the UI, the meeting list, settings, the speaker-naming
  flow, and it bundles + drives the engine. Current version **0.39.0**.
- **Back end (ENGINE):** a headless Swift (SPM) executable that does the heavy
  lifting — audio + screen capture via **AudioTapLib/CATap** and
  **ScreenCaptureKit**, transcription via **WhisperKit**, diarization via
  **FluidAudio**, and protocol/summary generation. It runs headless (no
  menu-bar icon) and is packaged inside the Timbre app at build time.

The engine has no UI of its own. UI-level controls (screen-capture scope,
video-recording on/off) live in Timbre's Settings and are propagated to the
engine through a small file bridge (see §8).

---

## 2. The two-repo SIBLING layout (and why it is mandatory)

There are two git repositories. They **must** be cloned as siblings under the
same parent directory, with these **exact folder names**:

```
<parent>/
  meeting-transcriber/            ← ENGINE  (Swift SPM)
  meeting-transcriber-electron/   ← ELECTRON (the Timbre app)
```

**Why the exact names/layout matter:** the Electron build config
(`electron-builder.js`) reads the engine artifacts from sibling paths at build
time:

- `../meeting-transcriber/.build/release/MeetingTranscriber.app`
- `../meeting-transcriber/tools/mt-batch/.build/release/mt-batch`

If the engine folder is missing or misnamed, `electron-builder` cannot stage the
engine into the app (`extraResources` fails) and the build breaks. Do **not**
rename or relocate either folder.

### Target GitHub repos (account: nawaz-git)

- ELECTRON → `github.com/nawaz-git/timbre`
- ENGINE   → `github.com/nawaz-git/timbre-engine`

The engine's original `origin` (`github.com/pasrom/meeting-transcriber`) is the
**upstream** — nawaz-git has **no push access** there. On the new machine, rename
that remote to `upstream` and add nawaz-git/timbre-engine as `origin`. The
`add-google-meet-detection` work should land on the new repo's `main` branch.

---

## 3. Fresh-Mac prerequisites

Required:

- **Xcode + Swift toolchain** (Xcode 16+, Swift 6.0+; tested on Swift 6.3.2).
  Target is **macOS 14.2+** (CATap / app-audio capture requires 14.2).
- **Node.js v24+ with npm 11+**
- **git**
- **gh CLI**, authenticated as the user (for pushing to the nawaz-git remotes)

Optional:

- **Homebrew** + **ffmpeg** (`brew install ffmpeg`) — expands supported audio
  *import* formats (MKV / WebM / OGG). Not needed for normal recording.
- **Claude Code** — used for the Claude-CLI protocol/summary generator (uses the
  logged-in Claude; no API key).

Apple Silicon (arm64) is assumed; the build target is `mac-arm64`.

---

## 4. Setup steps (fresh Mac)

```bash
# 1. Clone BOTH repos as siblings with the EXACT folder names.
mkdir -p ~/Projects && cd ~/Projects
git clone https://github.com/nawaz-git/timbre-engine.git meeting-transcriber
git clone https://github.com/nawaz-git/timbre.git          meeting-transcriber-electron

# 2. In the ENGINE repo: re-point remotes (upstream = original author, origin = yours).
cd ~/Projects/meeting-transcriber
git remote rename origin upstream                 # only if a 'pasrom' origin exists
git remote add origin https://github.com/nawaz-git/timbre-engine.git
git checkout main                                 # the work lives on main in the new repo

# 3. Run the one-shot bring-up from the ELECTRON repo.
cd ~/Projects/meeting-transcriber-electron
bash dev/scripts/setup-new-mac.sh
```

`dev/scripts/setup-new-mac.sh` (in the ELECTRON repo) is idempotent and does the
whole build/install: mints the signing cert, builds the engine + mt-batch,
`npm install`, builds the **signed** Timbre.app + DMG, installs to
`/Applications`, launches it, and prints the permission checklist. The manual
recipe behind it is in §6.

> Note on remotes: if the clone already used the nawaz-git URLs (as above), there
> is no `pasrom` origin to rename — just ensure `upstream` points at
> `github.com/pasrom/meeting-transcriber` if you want to pull future upstream
> changes, and `origin` points at `nawaz-git/timbre-engine`.

---

## 5. The signing model (do not skip this)

TCC permission stability (Screen Recording, Microphone, Automation) is tied to a
**stable code signature**. Timbre signs with a local self-signed cert.

- `dev/scripts/setup-signing.sh` (ELECTRON repo) creates a self-signed
  codesigning cert named **`Mintr Dev Signing`** in a dedicated keychain at
  `~/Library/Keychains/mintr-dev.keychain-db` (keychain password `mintr-dev`).
  It is **idempotent** — run once per machine; re-runs are no-ops.
- Builds must be invoked with the env var
  **`MINTR_SIGN_IDENTITY="Mintr Dev Signing"`**. The Electron `afterPack` step
  uses it to sign **both** the bundled engine and the outer Timbre app.
- **If `MINTR_SIGN_IDENTITY` is unset, `afterPack` falls back to ad-hoc
  signing**, which produces a fresh cdhash on every rebuild and **invalidates all
  TCC grants** — the app appears completely broken at runtime. `afterPack` prints
  a loud warning when this happens. Always export the identity before building.
- **On a fresh Mac the cert does NOT need transferring.** Just run
  `setup-signing.sh` to mint a new one. A different key is fine — TCC grants are
  per-machine and are granted fresh on first run.

### Stable bundle IDs (must not change)

The bundle identifiers are intentionally **stable** across the Mintr → Timbre
rebrand so user TCC grants survive:

- app:    `ai.nawaz.meeting-transcriber`
- engine: `ai.nawaz.mintr-engine`

The engine is packed by electron-builder as `MeetingTranscriber.app` and then
re-badged by `afterPack` (Info.plist + binary name + `.app` folder name +
`CFBundleIdentifier`) to the stable engine id, then re-signed. Changing either
bundle id is a breaking change that forces users to re-grant all permissions.

---

## 6. Build + install recipe (manual, what the script automates)

```bash
# --- ENGINE ---
cd ~/Projects/meeting-transcriber
# (optional) verify deps resolve:
cd app/MeetingTranscriber && swift build && cd ../..

# Build the release .app bundle. The .app is assembled in the FIRST step of the
# script; it then exits non-zero at the optional notarization step when
# DEVELOPER_ID is unset. That non-zero exit is EXPECTED — the bundle is valid.
# Using --no-notarize skips that step cleanly:
./scripts/build_release.sh --no-notarize 2>&1 | tail -20
# Assert the artifact exists:
ls .build/release/MeetingTranscriber.app

# Build the mt-batch CLI SEPARATELY (it is not built by build_release.sh):
cd tools/mt-batch && swift build -c release && cd ../..
ls tools/mt-batch/.build/release/mt-batch

# --- ELECTRON ---
cd ~/Projects/meeting-transcriber-electron
npm install
bash dev/scripts/setup-signing.sh          # one-time per machine
security unlock-keychain -p mintr-dev ~/Library/Keychains/mintr-dev.keychain-db
MINTR_SIGN_IDENTITY="Mintr Dev Signing" npm run dist:mac
# Output: dist/Timbre-<ver>-arm64.dmg + dist/mac-arm64/Timbre.app

# --- INSTALL ---
rm -rf /Applications/Timbre.app
ditto dist/mac-arm64/Timbre.app /Applications/Timbre.app
open -a Timbre
```

**Why the engine build "fails" but is fine:** `build_release.sh` assembles
`.build/release/MeetingTranscriber.app` in Step 1, then — when not given
`--no-notarize` and with `DEVELOPER_ID` unset — exits 1 at the
notarization-signing step. The `.app` (and DMG) are already fully assembled and
valid by then; electron-builder consumes the `.app` from that path and **re-signs
it** with `MINTR_SIGN_IDENTITY`. The setup script passes `--no-notarize` to skip
that step and then asserts the `.app` exists either way.

---

## 7. First-launch permission grants

On first launch (right-click → Open once if Gatekeeper complains, then run),
grant these in **System Settings → Privacy & Security**. Because capture runs in
the bundled headless engine, most prompts reference the **engine**
("Timbre Engine" / MintrEngine), not the outer Timbre app:

1. **Screen Recording → Timbre Engine** — meeting video capture
2. **Microphone → Timbre Engine** — the mic is **always** recorded (the mic
   toggle was removed in v0.39; Meet's own mute is web-internal and not
   detectable from outside)
3. **Accessibility → Timbre Engine** — if prompted
4. **Automation → allow Timbre to control Google Chrome** — required for Google
   Meet tab detection / auto-capture

These persist across rebuilds **only** because the build is signed with the
stable identity and the bundle ids are stable (see §5).

First run also triggers on-demand **CoreML model downloads** (WhisperKit ~1 GB,
FluidAudio ~50 MB, Qwen3 ~1.75 GB) — expect a one-time startup delay of roughly
5–15 seconds per engine type the first time it's used.

To reset permission state between test iterations, use
`dev/scripts/clean-uninstall-timbre.sh` (ELECTRON repo). It removes the app,
app-data, and TCC grants but **keeps** transcripts in
`~/Downloads/MeetingTranscriber` unless you pass `--wipe-transcripts`.

---

## 8. What's gitignored (and recreated on the new Mac)

Nothing below is tracked; the fresh Mac regenerates all of it.

**ELECTRON:**
- `node_modules/` — `npm install`
- `dist/` — `npm run dist:mac`
- `.eslintcache` — first lint
- `.env` — optional; only for the non-Claude (OpenAI-compatible) protocol
  generator. The Claude-CLI generator uses the logged-in Claude.

**ENGINE:**
- `.build/`, `app/MeetingTranscriber/.build/`, `tools/audiotap/.build/`,
  `tools/mt-batch/.build/` — Swift builds (debug + the release bundle/DMG)
- `protocols/` — generated markdown protocols (output dir)
- `recordings/`, `speakers.json` — user data / voice-profile DB (auto-created)
- `.env` — optional; only for DEVELOPER_ID/APPLE_ID notarization secrets
- scratch/CI dirs: `.worktrees/`, `docs/plans/.local/`, `__pycache__/`,
  `.coverage`

**Machine-local (not in any repo):**
- `~/Library/Keychains/mintr-dev.keychain-db` — `setup-signing.sh` creates it
- CoreML models — auto-download on first run
- `~/Library/Application Support/MeetingTranscriber/ipc/engine_config.json` — the
  settings bridge (see below), written by Timbre
- `~/Downloads/MeetingTranscriber` — recordings + transcripts (user data)

**No secrets are tracked in either repo** (verified by both auditors).

### The headless-engine settings bridge

Because the engine is headless, the screen-capture-scope and video-recording
toggles live in Timbre's Settings UI and are propagated via an atomically-written
`engine_config.json` under
`~/Library/Application Support/MeetingTranscriber/ipc/`. The engine reads this
fresh at the start of each meeting. (Verified in
`src/main/engineConfig.ts`, `src/main/settings.ts`, `src/shared/types.ts`.)

---

## 9. Current version + what shipped this session (v0.24 → v0.39.0)

All changes below are **local** to this session and have **not yet been pushed**.

- Rebrand **Mintr → Timbre**: minimal monochrome theme, headless engine (no
  menu-bar icon), new icon.
- **Screen-video recording** (HEVC, audio muxed) with a processing-aware meeting
  list — an immediate "Processing" card plus live status.
- **Speaker tooling**: reassign / merge / delete speakers for flat-`.txt` engine
  meetings; redesigned native "Name Speakers" popup.
- **Recording-corruption fixes:**
  - 0.5x-speed audio caused by Bluetooth HFP↔A2DP sample-rate drift.
  - 1-second screen-video stall (SCStream delegate + watchdog), with a wall-clock
    self-correct guard and regression tests.
- **Capture scope:** video records only the meeting's Chrome window by default
  (falls back to full screen), toggled in Settings → Recording, propagated via
  the `engine_config.json` bridge. The **microphone is always recorded** (mic
  toggle removed in v0.39).

---

## 10. PENDING — needs live verification on the new Mac

These cannot be checked headlessly and require a real Mac with a live meeting /
Bluetooth audio:

- **(a)** Audio plays at normal speed on a real Bluetooth/AirPods meeting (the
  0.5x-speed fix + wall-clock guard).
- **(b)** Screen video captures only the Chrome window, with full-screen
  fallback working.
- **(c)** The "Processing" card + redesigned "Name Speakers" popup visuals.
- **(d)** Google Meet auto-capture works once the Automation → Chrome grant is
  given.

---

## 11. Engine-specific gotchas worth knowing

- **mt-batch is a separate build** — `swift build -c release` in
  `tools/mt-batch`; it is **not** produced by `build_release.sh`.
- **Swift 6 strict concurrency** — `Package.swift` declares
  `swiftLanguageModes: [.v6]`. Run `./scripts/pre-push.sh` before pushing to
  catch `Sendable` diagnostics (it does a release build).
- **macOS 14.2+ required** — `CATapDescription` needs 14.2; a clone on macOS < 14
  fails at `swift build`.
- **Homebrew vs App Store variant** — the default (Homebrew) variant includes
  Claude CLI subprocess support + the debug RPC server. `--appstore` excludes
  both. Don't mix variants when pushing to nawaz-git/timbre-engine.
- **Test fixtures are committed** — Swift tests use pre-recorded `.wav` fixtures
  in `app/MeetingTranscriber/Tests/Fixtures/` (e.g. `two_speakers_de.wav`).
- **Tag protection** — upstream (pasrom) gates `v*` tags on CI via a GitHub Tag
  Ruleset. nawaz-git/timbre-engine starts without it; run
  `./scripts/configure-tag-ruleset.sh` if you plan stable releases.

---

*This handoff was assembled from two independent repo audits and verified against
the live working trees (ENGINE branch `add-google-meet-detection`, ELECTRON
branch `main`, v0.39.0, both working trees clean).*
