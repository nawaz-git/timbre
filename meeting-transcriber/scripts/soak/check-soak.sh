#!/usr/bin/env bash
# Run the forensic assertions for one capture-stability soak recipe against the
# logs captured during that soak, and print an objective PASS/FAIL verdict.
#
# This is the automatable half of a soak: you run the app through the recipe's
# procedure (see soak/README.md), capture the logs, then hand them here.
#
# Usage:
#   check-soak.sh <recipe> --engine-log <file> [options]
#
# Recipes:
#   baseline        steady simulator/meeting capture — no churn
#   bt-storm        Bluetooth device churn (AirPods + output switching)
#   renderer-churn  browser tab open/close churn
#   lifecycle       app relaunch + engine kill/restart torture
#   sck-churn       screen window minimize/restore churn
#   mic-only        app-audio kill switch on — mic + screen only
#
# Options:
#   --engine-log <file>          engine unified-log window (from collect-logs.sh) [required]
#   --electron-log <file>        recording-app main-process output (supervisor lines)
#   --coreaudiod-before <pid>    coreaudiod PID captured before the soak
#   --coreaudiod-after <pid>     coreaudiod PID captured after the soak
#   --max-tap-rebuilds <n>       override the recipe's tap-rebuild budget
#   --max-supervisor-restarts <n> override the recipe's supervisor-restart cap
#   --tap-pid-cap <n>            override the tap-PID hard cap (default 8)
#
# Exit code: 0 when every assertion passed, 1 otherwise.

set -euo pipefail

SOAK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/soak-assert.sh
source "$SOAK_DIR/lib/soak-assert.sh"

RECIPE="${1:-}"
shift || true

ENGINE_LOG=""
ELECTRON_LOG=""
CA_BEFORE=""
CA_AFTER=""
MAX_TAP_REBUILDS=""
MAX_SUPERVISOR_RESTARTS=""
TAP_PID_CAP=8

while [ $# -gt 0 ]; do
    case "$1" in
        --engine-log)              shift; ENGINE_LOG="$1" ;;
        --electron-log)            shift; ELECTRON_LOG="$1" ;;
        --coreaudiod-before)       shift; CA_BEFORE="$1" ;;
        --coreaudiod-after)        shift; CA_AFTER="$1" ;;
        --max-tap-rebuilds)        shift; MAX_TAP_REBUILDS="$1" ;;
        --max-supervisor-restarts) shift; MAX_SUPERVISOR_RESTARTS="$1" ;;
        --tap-pid-cap)             shift; TAP_PID_CAP="$1" ;;
        -h|--help)                 grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

case "$RECIPE" in
    baseline|bt-storm|renderer-churn|lifecycle|sck-churn|mic-only) ;;
    "") echo "check-soak.sh: recipe required (baseline|bt-storm|renderer-churn|lifecycle|sck-churn|mic-only)" >&2; exit 2 ;;
    *)  echo "check-soak.sh: unknown recipe '$RECIPE'" >&2; exit 2 ;;
esac
[ -n "$ENGINE_LOG" ] || { echo "check-soak.sh: --engine-log is required" >&2; exit 2; }
[ -f "$ENGINE_LOG" ] || { echo "check-soak.sh: engine log '$ENGINE_LOG' not found" >&2; exit 2; }

echo "[soak] recipe: $RECIPE"
echo "[soak] engine log: $ENGINE_LOG"
[ -n "$ELECTRON_LOG" ] && echo "[soak] app log:    $ELECTRON_LOG"
echo

soak_reset

# ── Shared engine-health checks (every recipe) ───────────────────────────────
# A clean coreaudiod (no PID change) + no slow-HAL tripwires + no sentinel
# unresponsive event is the core "Timbre didn't destabilise the audio server"
# guarantee. coreaudiod PIDs are only checked when both were captured.
soak_assert_no_hal_slow "$ENGINE_LOG" || true
soak_assert_no_sentinel_unresponsive "$ENGINE_LOG" || true
if [ -n "$CA_BEFORE" ] || [ -n "$CA_AFTER" ]; then
    soak_assert_no_coreaudiod_restart "$CA_BEFORE" "$CA_AFTER" || true
else
    echo "[soak] note: coreaudiod before/after PIDs not supplied — skipping the restart check"
fi

# ── Recipe-specific checks ───────────────────────────────────────────────────
case "$RECIPE" in
    baseline)
        # Steady capture must leave a summary, drop nothing, and never re-tap.
        soak_assert_capture_summary_present "$ENGINE_LOG" || true
        soak_assert_dropped_bytes_zero "$ENGINE_LOG" || true
        soak_assert_tap_rebuilds_le "$ENGINE_LOG" "${MAX_TAP_REBUILDS:-0}" || true
        ;;
    bt-storm)
        # Device churn is allowed to coalesce into a few rebuilds; it must not
        # storm and must never drop into a wedged/unresponsive state.
        soak_assert_capture_summary_present "$ENGINE_LOG" || true
        soak_assert_dropped_bytes_zero "$ENGINE_LOG" || true
        soak_assert_tap_rebuilds_le "$ENGINE_LOG" "${MAX_TAP_REBUILDS:-6}" || true
        ;;
    renderer-churn)
        # Tab churn must keep the tap PID set capped and provoke few re-taps.
        soak_assert_capture_summary_present "$ENGINE_LOG" || true
        soak_assert_tap_pid_count_le "$ENGINE_LOG" "$TAP_PID_CAP" || true
        soak_assert_tap_rebuilds_le "$ENGINE_LOG" "${MAX_TAP_REBUILDS:-2}" || true
        ;;
    lifecycle)
        # Relaunch/kill torture is judged on the supervisor: restarts stay under
        # the storm cap, and a healthy relaunch never wedges the audio path.
        if [ -n "$ELECTRON_LOG" ]; then
            soak_assert_supervisor_restarts_le "$ELECTRON_LOG" "${MAX_SUPERVISOR_RESTARTS:-3}" || true
            soak_assert_no_audio_wedged_restart "$ELECTRON_LOG" || true
        else
            _soak_fail "lifecycle recipe needs --electron-log (the [supervisor] lines live in the app's main-process output)"
        fi
        ;;
    sck-churn)
        # Screen churn is judged on audio-server health + a clean teardown; the
        # video-pauses-and-resumes observation is a manual eyeball (see README).
        soak_assert_capture_summary_present "$ENGINE_LOG" || true
        ;;
    mic-only)
        # The app-audio kill switch: prove no tap was created, and that the
        # supervisor never mis-fired its audio-wedged branch on the absent
        # IOProc heartbeat field.
        soak_assert_mic_only_no_tap "$ENGINE_LOG" || true
        if [ -n "$ELECTRON_LOG" ]; then
            soak_assert_no_audio_wedged_restart "$ELECTRON_LOG" || true
        else
            _soak_fail "mic-only recipe needs --electron-log to prove ZERO audio-wedged restarts"
        fi
        ;;
esac

echo
soak_summary
