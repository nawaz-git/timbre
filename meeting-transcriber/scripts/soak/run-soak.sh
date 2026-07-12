#!/usr/bin/env bash
# Bracket a capture-stability soak: capture the window boundaries (wall-clock +
# coreaudiod PID) around the recipe's procedure, then collect the engine log and
# render the PASS/FAIL verdict via check-soak.sh.
#
# This driver does NOT launch Timbre — start it yourself first (see
# soak/README.md for how, and why the app's main-process output must be
# redirected to a file for the recipes that read supervisor lines). The driver
# brackets the run so the log window and the coreaudiod-restart check line up
# exactly with the soak, then hands the captured logs to the assertions.
#
# Usage:
#   run-soak.sh <recipe> [--minutes N] [--electron-log <file>] [--out-dir <dir>]
#
#   <recipe>              baseline | bt-storm | renderer-churn | lifecycle |
#                         sck-churn | mic-only
#   --minutes N           auto-close the window after N minutes (default: wait
#                         for you to press Enter when the soak is done)
#   --electron-log <file> the recording app's redirected stdout+stderr — required
#                         for the lifecycle and mic-only recipes (supervisor lines)
#   --out-dir <dir>       where to write the captured engine log + verdict
#                         (default: a timestamped dir under $HOME/timbre-soak-runs)
#
# Exit code mirrors check-soak.sh: 0 when every assertion passed.

set -euo pipefail

SOAK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RECIPE="${1:-}"
shift || true

MINUTES=""
ELECTRON_LOG=""
OUT_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --minutes)      shift; MINUTES="$1" ;;
        --electron-log) shift; ELECTRON_LOG="$1" ;;
        --out-dir)      shift; OUT_DIR="$1" ;;
        -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

case "$RECIPE" in
    baseline|bt-storm|renderer-churn|lifecycle|sck-churn|mic-only) ;;
    "") echo "run-soak.sh: recipe required (baseline|bt-storm|renderer-churn|lifecycle|sck-churn|mic-only)" >&2; exit 2 ;;
    *)  echo "run-soak.sh: unknown recipe '$RECIPE'" >&2; exit 2 ;;
esac

TS="$(date '+%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$HOME/timbre-soak-runs/$RECIPE-$TS}"
mkdir -p "$OUT_DIR"
ENGINE_LOG="$OUT_DIR/engine.log"

log() { printf '[run-soak] %s\n' "$*"; }

# ── Per-recipe operator guidance (full setup is in soak/README.md) ───────────
print_recipe_steps() {
    case "$RECIPE" in
        baseline)
            cat <<'TXT'
  Steady capture, no churn. Keep the built-in output device selected and let a
  meeting (real or the meeting-simulator fixture) record for the full window.
  No device switching, no minimizing. This is the control run that proves the
  write-path rework did not regress plain capture.
TXT
            ;;
        bt-storm)
            cat <<'TXT'
  Bluetooth storm. Pair AirPods and record a meeting. During the window:
   - switch the system output device every ~45 s (e.g. SwitchAudioSource in a
     loop, or the menu-bar Sound picker), and
   - put the AirPods in and out of the case once every ~10 minutes.
  Capture must survive the churn without a rebuild storm.
TXT
            ;;
        renderer-churn)
            cat <<'TXT'
  Renderer churn. Record a real-browser meeting and open/close ~10 tabs per
  minute for the window. The audio-active PID filter must keep the tap set
  capped and provoke few re-taps.
TXT
            ;;
        lifecycle)
            cat <<'TXT'
  Lifecycle torture. Every ~5 minutes, alternate:
   (a) relaunch Timbre                (engine should be REUSED — 0 deaths;
                                        needs a version-matched build, below),
   (b) kill -TERM the engine          (graceful < 5 s + supervisor relaunch),
   (c) kill -KILL the engine          (supervisor relaunch with backoff).
  The browser/meeting must stay responsive throughout. The [supervisor] lines
  are read from --electron-log, so the app MUST have been started with its
  stdout+stderr redirected to that file.

  REUSE PRECONDITION (a): reuse only fires when the engine bundle's version ==
  the app version. Verify before starting — see soak/README.md → "Version match".
TXT
            ;;
        sck-churn)
            cat <<'TXT'
  Screen-capture churn. Record for ~30 min while minimizing + restoring the
  captured window every minute, then leave it fully static for ~10 min. Watch
  that the video pauses on minimize and RESUMES on restore with no visible
  restart. The automated verdict covers audio-server health + a clean teardown;
  the pause/resume + zero-spurious-restart is a manual eyeball on the video and
  the engine log's [ScreenRecorder] lines.
TXT
            ;;
        mic-only)
            cat <<'TXT'
  App-audio kill switch. In Timbre → Settings → Recording, turn ON "Disable app
  audio capture", then record a meeting for the window. The recording must be
  mic-only (no app tap created) and the supervisor must NEVER fire an
  audio-wedged restart on the absent IOProc heartbeat field. Needs
  --electron-log for the supervisor assertion.
TXT
            ;;
    esac
}

echo
log "recipe: $RECIPE"
log "results dir: $OUT_DIR"
echo "──────────────────────────────────────────────────────────────────────"
print_recipe_steps
echo "──────────────────────────────────────────────────────────────────────"

# Sanity: the lifecycle + mic-only verdicts need the app log.
case "$RECIPE" in
    lifecycle|mic-only)
        if [ -z "$ELECTRON_LOG" ]; then
            log "WARNING: $RECIPE needs --electron-log (the app's redirected stdout+stderr)."
            log "         Start Timbre with its output redirected to a file and pass it here,"
            log "         or the supervisor assertion cannot run. See soak/README.md."
        elif [ ! -f "$ELECTRON_LOG" ]; then
            log "WARNING: --electron-log '$ELECTRON_LOG' does not exist yet — make sure the app"
            log "         is writing there before the window closes."
        fi
        ;;
esac

# ── Open the window ──────────────────────────────────────────────────────────
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
CA_BEFORE="$(pgrep -x coreaudiod | head -1 || true)"
log "window opened at $START_TS  (coreaudiod pid: ${CA_BEFORE:-<not found>})"
[ -n "$CA_BEFORE" ] || log "note: coreaudiod PID not found — the restart check will be skipped"

echo
read -r -p "[run-soak] Press Enter to START the timed window… " _ || true

if [ -n "$MINUTES" ]; then
    log "running the soak for $MINUTES minute(s) — perform the recipe actions now"
    # Minute ticks so a long soak shows progress and the operator can pace the
    # manual actions.
    for ((m = 1; m <= MINUTES; m++)); do
        sleep 60
        log "  … $m/$MINUTES min elapsed"
    done
else
    log "perform the recipe actions now; press Enter when the soak window is complete"
    read -r -p "[run-soak] Press Enter to CLOSE the window… " _ || true
fi

# ── Close the window ─────────────────────────────────────────────────────────
END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
CA_AFTER="$(pgrep -x coreaudiod | head -1 || true)"
log "window closed at $END_TS  (coreaudiod pid: ${CA_AFTER:-<not found>})"

# ── Collect + judge ──────────────────────────────────────────────────────────
"$SOAK_DIR/collect-logs.sh" --start "$START_TS" --end "$END_TS" --out "$ENGINE_LOG"

CHECK_ARGS=("$RECIPE" --engine-log "$ENGINE_LOG")
[ -n "$ELECTRON_LOG" ] && CHECK_ARGS+=(--electron-log "$ELECTRON_LOG")
[ -n "$CA_BEFORE" ] && CHECK_ARGS+=(--coreaudiod-before "$CA_BEFORE")
[ -n "$CA_AFTER" ] && CHECK_ARGS+=(--coreaudiod-after "$CA_AFTER")

echo
set +e
"$SOAK_DIR/check-soak.sh" "${CHECK_ARGS[@]}" | tee "$OUT_DIR/verdict.txt"
VERDICT=${PIPESTATUS[0]}
set -e

echo
log "engine log:  $ENGINE_LOG"
log "verdict:     $OUT_DIR/verdict.txt"
exit "$VERDICT"
