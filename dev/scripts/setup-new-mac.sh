#!/usr/bin/env bash
#
# setup-new-mac.sh — one-shot, idempotent fresh-Mac bring-up for Timbre.
#
# WHAT THIS DOES (run AFTER both repos are cloned as SIBLINGS):
#   1. Mint the local code-signing cert ("Mintr Dev Signing") via setup-signing.sh.
#   2. Build the Swift engine release bundle (build_release.sh) + the mt-batch CLI.
#   3. npm install in the Electron app.
#   4. Build a SIGNED Timbre.app + DMG (MINTR_SIGN_IDENTITY) so TCC grants stick.
#   5. Install Timbre.app to /Applications and launch it.
#   6. Print the first-launch permission-grant checklist.
#
# MONOREPO LAYOUT (electron-builder reads the in-repo engine at meeting-transcriber/):
#   meeting-transcriber-electron/     (this repo — the Timbre app)
#     meeting-transcriber/            (ENGINE — Swift SPM, vendored in via git subtree)
#
# Run from the ELECTRON repo:
#   bash dev/scripts/setup-new-mac.sh
#
# Re-running is safe: setup-signing.sh is idempotent, builds overwrite, install re-ditto's.

set -euo pipefail

# --- Locate the repo + the vendored engine ----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"          # .../meeting-transcriber-electron (repo root)
PARENT_DIR="$(cd "$ELECTRON_DIR/.." && pwd)"
ENGINE_DIR="$ELECTRON_DIR/meeting-transcriber"          # engine vendored INSIDE the repo (monorepo)

KEYCHAIN="$HOME/Library/Keychains/mintr-dev.keychain-db"
KEYCHAIN_PASS="mintr-dev"
SIGN_IDENTITY="Mintr Dev Signing"

echo "=========================================================="
echo " Timbre fresh-Mac setup"
echo "   Electron repo : $ELECTRON_DIR"
echo "   Engine repo   : $ENGINE_DIR"
echo "=========================================================="

# --- 0. Preconditions --------------------------------------------------------
if [ ! -d "$ENGINE_DIR" ]; then
  echo "ERROR: vendored engine not found at $ENGINE_DIR"
  echo "       The engine lives INSIDE this repo at 'meeting-transcriber/' (monorepo)."
  echo "       If it's missing, your checkout is incomplete — re-checkout the repo."
  echo "       (electron-builder.js reads meeting-transcriber/.build/release/MeetingTranscriber.app)"
  exit 1
fi

for tool in swift node npm git ditto security codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not found on PATH."
    [ "$tool" = "swift" ] && echo "       Install Xcode + Swift toolchain (macOS 14.2+ target for CATap)."
    exit 1
  fi
done
echo "OK: engine sibling present, required tools found."

# --- 1. Signing cert ---------------------------------------------------------
echo
echo ">>> [1/6] Minting local code-signing cert ('$SIGN_IDENTITY')..."
echo "    (idempotent; may prompt for TouchID/keychain auth the first time)"
bash "$ELECTRON_DIR/dev/scripts/setup-signing.sh"

# --- 2. Build the Swift engine ----------------------------------------------
echo
echo ">>> [2/6] Building the Swift engine release bundle..."
# build_release.sh assembles .build/release/MeetingTranscriber.app in its FIRST step,
# then exits non-zero at the optional DEVELOPER_ID/notarization step. With --no-notarize
# that step is skipped; we tolerate any non-zero exit and then ASSERT the .app exists.
(
  cd "$ENGINE_DIR"
  ./scripts/build_release.sh --no-notarize 2>&1 | tail -30
) || echo "    (build_release.sh exited non-zero — expected at the notarization step; verifying artifact next)"

ENGINE_APP="$ENGINE_DIR/.build/release/MeetingTranscriber.app"
if [ ! -d "$ENGINE_APP" ]; then
  echo "ERROR: engine bundle was NOT assembled at $ENGINE_APP"
  echo "       Check the build_release.sh output above (Swift build failure?)."
  exit 1
fi
echo "OK: engine bundle assembled at $ENGINE_APP"

echo
echo ">>> Building the mt-batch CLI (separate release build)..."
(
  cd "$ENGINE_DIR/tools/mt-batch"
  swift build -c release
)
MT_BATCH="$ENGINE_DIR/tools/mt-batch/.build/release/mt-batch"
if [ ! -x "$MT_BATCH" ]; then
  echo "ERROR: mt-batch CLI was NOT built at $MT_BATCH"
  exit 1
fi
echo "OK: mt-batch built at $MT_BATCH"

# --- 3. npm install ----------------------------------------------------------
echo
echo ">>> [3/6] Installing Electron app JS dependencies (npm install)..."
(
  cd "$ELECTRON_DIR"
  npm install
)
echo "OK: node_modules installed."

# --- 4. Signed build ---------------------------------------------------------
echo
echo ">>> [4/6] Building SIGNED Timbre.app + DMG..."
echo "    Unlocking dev keychain and signing with MINTR_SIGN_IDENTITY='$SIGN_IDENTITY'."
echo "    (Without this, afterPack falls back to ad-hoc signing and LOSES all TCC grants.)"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
(
  cd "$ELECTRON_DIR"
  MINTR_SIGN_IDENTITY="$SIGN_IDENTITY" npm run dist:mac
)

BUILT_APP="$ELECTRON_DIR/dist/mac-arm64/Timbre.app"
if [ ! -d "$BUILT_APP" ]; then
  echo "ERROR: signed Timbre.app not found at $BUILT_APP"
  echo "       Inspect the electron-builder output above."
  exit 1
fi
echo "OK: signed app at $BUILT_APP"
echo "    DMG(s):"
ls -1 "$ELECTRON_DIR"/dist/Timbre-*-arm64.dmg 2>/dev/null || echo "    (no DMG matched — non-fatal; the .app is what we install)"

# --- 5. Install to /Applications --------------------------------------------
echo
echo ">>> [5/6] Installing to /Applications via ditto..."
rm -rf /Applications/Timbre.app
ditto "$BUILT_APP" /Applications/Timbre.app
echo "OK: installed /Applications/Timbre.app"

echo
echo ">>> Launching Timbre..."
open -a Timbre || echo "    (could not auto-launch; open Timbre from /Applications manually)"

# --- 6. Permission checklist -------------------------------------------------
echo
echo "=========================================================="
echo " [6/6] FIRST-LAUNCH PERMISSION GRANTS"
echo "=========================================================="
echo " Grant these in System Settings > Privacy & Security."
echo " The capture/transcribe work runs in the bundled headless engine,"
echo " so most prompts reference the engine ('Timbre Engine' / MintrEngine),"
echo " NOT the outer Timbre app:"
echo
echo "   1. Screen Recording   -> Timbre Engine   (meeting video capture)"
echo "   2. Microphone         -> Timbre Engine   (mic is ALWAYS recorded)"
echo "   3. Accessibility      -> Timbre Engine   (if prompted)"
echo "   4. Automation         -> allow Timbre to control Google Chrome"
echo "                            (required for Google Meet tab detection)"
echo
echo " These grants persist across rebuilds ONLY because the build is signed"
echo " with a STABLE identity ('$SIGN_IDENTITY') and STABLE bundle ids"
echo " (app=ai.nawaz.meeting-transcriber, engine=ai.nawaz.mintr-engine)."
echo
echo " First run also downloads CoreML models on demand (WhisperKit ~1 GB,"
echo " FluidAudio ~50 MB, Qwen3 ~1.75 GB) — expect a one-time startup delay."
echo
echo " To reset permission state between test iterations:"
echo "   bash \"$ELECTRON_DIR/dev/scripts/clean-uninstall-timbre.sh\""
echo "   (keeps ~/Downloads/MeetingTranscriber transcripts unless --wipe-transcripts)"
echo
echo " Setup complete."
echo "=========================================================="
