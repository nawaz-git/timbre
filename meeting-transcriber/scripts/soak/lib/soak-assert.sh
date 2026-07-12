# Forensic assertion library for the capture-stability soak checks.
#
# Source this from a bash script that has already set `set -euo pipefail`:
#
#   source "$SOAK_DIR/lib/soak-assert.sh"
#   soak_reset
#   soak_assert_capture_summary_present "$engine_log"
#   soak_assert_no_hal_slow "$engine_log"
#   soak_summary   # prints the tally, returns non-zero if anything failed
#
# The checks read two captured logs:
#   - the engine unified-log window (see collect-logs.sh), which carries the
#     `Capture session summary:`, `HAL call slow:`, `Tap health rebuild:`,
#     `Tap PID filter:` and HAL-sentinel forensic lines;
#   - optionally the recording app's main-process output (stdout/stderr),
#     which carries the `[supervisor] …` engine-supervision lines.
#
# This file has no shebang and no `set -e` — it inherits the caller's.

# ─── Forensic log signatures (single source of truth) ────────────────────────
# Engine unified-log (subsystem com.meetingtranscriber*).
SOAK_SIG_CAPTURE_SUMMARY='Capture session summary:'
SOAK_SIG_HAL_SLOW='HAL call slow:'
SOAK_SIG_TAP_REBUILD='Tap health rebuild:'
SOAK_SIG_TAP_PID_FILTER='Tap PID filter:'
SOAK_SIG_SENTINEL_UNRESPONSIVE='coreaudiod unresponsive'
SOAK_SIG_APP_TAP_DISABLED='app audio tap DISABLED'
# Recording-app main-process output (engine supervisor).
SOAK_SIG_SUPERVISOR_RESTART='[supervisor] restarting engine'
SOAK_SIG_SUPERVISOR_AUDIO_WEDGED='reason=audio-wedged'
SOAK_SIG_SUPERVISOR_GAVE_UP='[supervisor] engine restart cap reached'

# ─── Tally + reporting ───────────────────────────────────────────────────────

SOAK_PASS_COUNT=0
SOAK_FAIL_COUNT=0

soak_reset() {
    SOAK_PASS_COUNT=0
    SOAK_FAIL_COUNT=0
}

# Internal: record a pass / fail and print a uniform line. Returns 0/1 so a
# caller can branch, but never exits — every check runs so the operator sees
# the full picture, not just the first failure.
_soak_pass() {
    SOAK_PASS_COUNT=$((SOAK_PASS_COUNT + 1))
    printf '[soak] PASS: %s\n' "$*"
    return 0
}
_soak_fail() {
    SOAK_FAIL_COUNT=$((SOAK_FAIL_COUNT + 1))
    printf '[soak] FAIL: %s\n' "$*" >&2
    return 1
}

# Count case-sensitive fixed-string matches of `$2` in file `$1`. Prints the
# count (0 when the file is missing or has no matches). `grep -F` so bracket
# characters in a signature (e.g. `[supervisor]`) are literal. `grep -c` always
# prints the count to stdout and only signals match/no-match via its exit code,
# so `|| true` swallows the no-match exit while keeping the printed "0" — a
# second `echo 0` would emit a stray line and break the numeric comparisons.
soak_count_matches() {
    local file="$1" pattern="$2" n
    [ -f "$file" ] || { echo 0; return 0; }
    n="$(grep -Fc -- "$pattern" "$file" 2>/dev/null || true)"
    [ -n "$n" ] || n=0
    echo "$n"
}

# ─── Assertions ──────────────────────────────────────────────────────────────

# A soak that recorded at all must leave at least one per-session forensic
# summary line — its absence means the capture teardown path never ran (or the
# log window missed it), which invalidates every other engine-side check.
soak_assert_capture_summary_present() {
    local engine_log="$1"
    local n
    n="$(soak_count_matches "$engine_log" "$SOAK_SIG_CAPTURE_SUMMARY")"
    if [ "$n" -ge 1 ]; then
        _soak_pass "capture session summary present ($n session(s))"
    else
        _soak_fail "no '$SOAK_SIG_CAPTURE_SUMMARY' line in the engine log — did a recording finalize in this window?"
    fi
}

# A healthy run trips ZERO slow-HAL tripwires: any create/destroy tap call over
# the threshold is early coreaudiod distress.
soak_assert_no_hal_slow() {
    local engine_log="$1"
    local n
    n="$(soak_count_matches "$engine_log" "$SOAK_SIG_HAL_SLOW")"
    if [ "$n" -eq 0 ]; then
        _soak_pass "no slow HAL calls"
    else
        _soak_fail "$n '$SOAK_SIG_HAL_SLOW' tripwire(s) — coreaudiod was slow to service tap create/destroy"
    fi
}

# The HAL-liveness sentinel must not have latched unresponsive on a healthy run.
soak_assert_no_sentinel_unresponsive() {
    local engine_log="$1"
    local n
    n="$(soak_count_matches "$engine_log" "$SOAK_SIG_SENTINEL_UNRESPONSIVE")"
    if [ "$n" -eq 0 ]; then
        _soak_pass "no HAL-liveness sentinel 'unresponsive' events"
    else
        _soak_fail "$n sentinel 'unresponsive' event(s) — coreaudiod stopped answering during the soak"
    fi
}

# The SPSC ring must not drop a byte on a healthy disk. Sums `droppedBytes=N`
# across every capture-summary line and asserts the total is zero.
soak_assert_dropped_bytes_zero() {
    local engine_log="$1"
    local total
    # awk's END always prints, so `total` is a clean integer even with no
    # matches; `|| true` guards the pipefail exit when the first grep misses.
    total="$(grep -Eo 'droppedBytes=[0-9]+' "$engine_log" 2>/dev/null \
        | grep -Eo '[0-9]+' | awk '{s+=$1} END{print s+0}' || true)"
    [ -n "$total" ] || total=0
    if [ "$total" -eq 0 ]; then
        _soak_pass "zero dropped capture bytes"
    else
        _soak_fail "$total dropped capture byte(s) — the writer thread fell behind the IOProc"
    fi
}

# coreaudiod must not have restarted during the soak — a PID change is the
# reboot-requiring failure this whole effort exists to prevent. Pass the PID
# captured before the soak and the PID captured after.
soak_assert_no_coreaudiod_restart() {
    local before_pid="$1" after_pid="$2"
    if [ -z "$before_pid" ] || [ -z "$after_pid" ]; then
        _soak_fail "coreaudiod PID not captured (before='$before_pid' after='$after_pid')"
        return 1
    fi
    if [ "$before_pid" = "$after_pid" ]; then
        _soak_pass "coreaudiod PID unchanged ($after_pid)"
    else
        _soak_fail "coreaudiod PID changed $before_pid → $after_pid — the audio server restarted"
    fi
}

# Tap-health rebuilds are recovery events; a healthy soak keeps them at or below
# an expected ceiling (0 for a bilaterally-silent or steady run, a small N for a
# Bluetooth / renderer-churn recipe that deliberately provokes re-taps).
soak_assert_tap_rebuilds_le() {
    local engine_log="$1" max="$2"
    local n
    n="$(soak_count_matches "$engine_log" "$SOAK_SIG_TAP_REBUILD")"
    if [ "$n" -le "$max" ]; then
        _soak_pass "tap-health rebuilds within budget ($n <= $max)"
    else
        _soak_fail "$n tap-health rebuild(s) exceed the budget of $max — capture churned more than expected"
    fi
}

# The engine supervisor must never fire its audio-path-wedged restart while the
# app tap is disabled — with no IOProc there is no `lastIOCallbackAt`, so the
# supervisor's guard must keep that branch dormant. This is the load-bearing
# mic-only assertion.
soak_assert_no_audio_wedged_restart() {
    local electron_log="$1"
    local n
    n="$(soak_count_matches "$electron_log" "$SOAK_SIG_SUPERVISOR_AUDIO_WEDGED")"
    if [ "$n" -eq 0 ]; then
        _soak_pass "no audio-path-wedged engine restarts"
    else
        _soak_fail "$n audio-path-wedged restart(s) — the supervisor mis-fired (mic-only mode must never trip this)"
    fi
}

# Bound supervisor-driven restarts for a lifecycle soak: the storm guard caps
# them, so more than `$max` in the window means the cap failed.
soak_assert_supervisor_restarts_le() {
    local electron_log="$1" max="$2"
    local n
    n="$(soak_count_matches "$electron_log" "$SOAK_SIG_SUPERVISOR_RESTART")"
    if [ "$n" -le "$max" ]; then
        _soak_pass "supervisor restarts within cap ($n <= $max)"
    else
        _soak_fail "$n supervisor restart(s) exceed the cap of $max — restart storm not bounded"
    fi
}

# The audio-active PID filter must keep the tap set at or below its hard cap
# (default 8) on every (re)tap. Parses the `M` from each
# `Tap PID filter: N → M audio-active` line and asserts the largest is <= cap.
# A run with no tap-filter lines (e.g. mic-only) passes vacuously.
soak_assert_tap_pid_count_le() {
    local engine_log="$1" cap="$2"
    [ -f "$engine_log" ] || { _soak_fail "tap-PID-cap check: engine log '$engine_log' missing"; return 1; }
    local max_m
    max_m="$(grep -Eo 'Tap PID filter: [0-9]+ → [0-9]+ audio-active' "$engine_log" 2>/dev/null \
        | grep -Eo '→ [0-9]+' | grep -Eo '[0-9]+' | awk 'BEGIN{m=0} {if($1>m)m=$1} END{print m}' || true)"
    [ -n "$max_m" ] || max_m=0
    if [ "$max_m" -le "$cap" ]; then
        _soak_pass "largest tap PID set within cap ($max_m <= $cap)"
    else
        _soak_fail "tap PID set reached $max_m, over the cap of $cap — the audio-active filter let too many through"
    fi
}

# Mic-only recording must genuinely skip the process tap: the recorder logs the
# disabled marker AND emits NO tap-PID-filter line (which only runs at tap
# creation). Both conditions together prove no CATap was created.
soak_assert_mic_only_no_tap() {
    local engine_log="$1"
    local disabled tap_filter
    disabled="$(soak_count_matches "$engine_log" "$SOAK_SIG_APP_TAP_DISABLED")"
    tap_filter="$(soak_count_matches "$engine_log" "$SOAK_SIG_TAP_PID_FILTER")"
    if [ "$disabled" -ge 1 ] && [ "$tap_filter" -eq 0 ]; then
        _soak_pass "mic-only recording created no app tap (disabled marker x$disabled, tap-filter x0)"
    else
        _soak_fail "mic-only tap check: disabled-marker=$disabled (want >=1), tap-filter=$tap_filter (want 0)"
    fi
}

# Print the tally and return non-zero if any assertion failed.
soak_summary() {
    printf '[soak] ── %d passed, %d failed ──\n' "$SOAK_PASS_COUNT" "$SOAK_FAIL_COUNT"
    [ "$SOAK_FAIL_COUNT" -eq 0 ]
}
