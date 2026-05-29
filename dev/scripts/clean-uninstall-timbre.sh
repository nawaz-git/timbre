#!/usr/bin/env bash
# clean-uninstall-timbre.sh — fully remove Timbre (and its old "Mintr" identity)
# so you can reinstall the DMG from a clean slate, and reset the macOS
# permission (TCC) grants so the reinstalled app re-prompts for them fresh.
#
# Safe by default: your MEETING TRANSCRIPTS are NOT deleted unless you pass
#   --wipe-transcripts   (removes ~/Downloads/MeetingTranscriber and the
#                         configured Output Folder)
#
# Usage:
#   bash clean-uninstall-timbre.sh                 # app + app-data + TCC reset
#   bash clean-uninstall-timbre.sh --wipe-transcripts   # also delete transcripts
#
# After running, install /Applications by dragging Timbre.app from the DMG,
# then re-grant the 4 permissions (the script prints the checklist at the end).

set -uo pipefail
WIPE_TRANSCRIPTS=0
[ "${1:-}" = "--wipe-transcripts" ] && WIPE_TRANSCRIPTS=1

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
rm_if() { if [ -e "$1" ]; then rm -rf "$1" && echo "  removed: $1"; fi; }

say "1/5  Quitting Timbre + the bundled engine"
osascript -e 'tell application "Timbre" to quit' 2>/dev/null || true
osascript -e 'tell application "Mintr" to quit' 2>/dev/null || true
pkill -f 'Timbre.app/Contents/MacOS/Timbre' 2>/dev/null || true
pkill -f 'Mintr.app/Contents/MacOS/Mintr' 2>/dev/null || true
pkill -f 'MintrEngine.app/Contents/MacOS/MintrEngine' 2>/dev/null || true
pkill -f 'MeetingTranscriber.app/Contents/MacOS/MeetingTranscriber' 2>/dev/null || true
sleep 2

say "2/5  Removing the app(s)"
rm_if "/Applications/Timbre.app"
rm_if "/Applications/Mintr.app"

say "3/5  Removing app data (Electron userData + engine data + prefs)"
rm_if "$HOME/Library/Application Support/Timbre"
rm_if "$HOME/Library/Application Support/Mintr"
# Engine data: IPC state, in-progress recordings, enrolled-voice DB (speakers.json).
# Removing this gives a true clean slate but forgets enrolled speaker voices.
rm_if "$HOME/Library/Application Support/MeetingTranscriber"
for d in ai.nawaz.meeting-transcriber ai.nawaz.mintr-engine com.meetingtranscriber.app; do
  defaults delete "$d" 2>/dev/null && echo "  cleared defaults: $d" || true
  rm_if "$HOME/Library/Preferences/$d.plist"
done
killall cfprefsd 2>/dev/null || true   # flush macOS preferences cache

say "4/5  Resetting macOS permission (TCC) grants so the reinstall re-prompts cleanly"
# Engine holds Screen Recording / Microphone / Accessibility (bundle id ai.nawaz.mintr-engine).
for svc in ScreenCapture Microphone Accessibility; do
  tccutil reset "$svc" ai.nawaz.mintr-engine 2>/dev/null && echo "  reset $svc → engine" || true
done
# The app itself holds Automation (control Google Chrome) + Accessibility (bundle id ai.nawaz.meeting-transcriber).
for svc in AppleEvents Accessibility; do
  tccutil reset "$svc" ai.nawaz.meeting-transcriber 2>/dev/null && echo "  reset $svc → app" || true
done

if [ "$WIPE_TRANSCRIPTS" = "1" ]; then
  say "5/5  --wipe-transcripts: deleting your saved meetings (irreversible)"
  rm_if "$HOME/Downloads/MeetingTranscriber"
  rm_if "$HOME/Documents/MeetingTranscripts"
else
  say "5/5  Keeping your transcripts (~/Downloads/MeetingTranscriber, ~/Documents/MeetingTranscripts)"
  echo "      (re-run with --wipe-transcripts to delete them too)"
fi

cat <<'NEXT'

✅ Clean uninstall done. Now reinstall as an end user:

  1. Open the DMG:  open ~/Projects/meeting-transcriber-electron/dist/Timbre-0.30.0-arm64.dmg
  2. Drag  Timbre.app  →  Applications.
  3. First launch: it is self-signed, so right-click Timbre.app → Open → Open
     (only needed once to clear Gatekeeper).
  4. Re-grant permissions when prompted / via System Settings → Privacy & Security:
       • Screen & System Audio Recording → enable "Timbre Engine"
       • Microphone                      → enable "Timbre Engine"
       • Accessibility                   → enable "Timbre Engine"
       • Automation                      → allow "Timbre" to control "Google Chrome"   ← needed for Meet detection
     Quit & reopen Timbre after granting Screen Recording.
  5. Test: join a Google Meet. The Home page should show the green
     "Google Meet detected in Chrome" card, then capture starts automatically.
NEXT
