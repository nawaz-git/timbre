#!/usr/bin/env bash
# Snapshot the engine's unified-log window into a plain file the soak
# assertions can grep. The engine logs under the `com.meetingtranscriber`
# and `com.meetingtranscriber.audiotap` subsystems; `BEGINSWITH` captures both.
#
# Usage:
#   collect-logs.sh --start "YYYY-MM-DD HH:MM:SS" --out /path/to/engine.log
#   collect-logs.sh --start "2026-07-12 09:00:00" --out engine.log --end "2026-07-12 11:00:00"
#
# `--start` is required (the wall-clock the soak window opened — capture it with
# `date '+%Y-%m-%d %H:%M:%S'` right before you begin). `--end` defaults to now.
#
# The recording app's OWN main-process output (the `[supervisor] …` lines) is
# NOT in the unified log — capture that separately by running the app from a
# terminal and redirecting stdout+stderr to a file (see soak/README.md).

set -euo pipefail

START=""
END=""
OUT=""
SUBSYSTEM_PREFIX="com.meetingtranscriber"

while [ $# -gt 0 ]; do
    case "$1" in
        --start) shift; START="$1" ;;
        --end)   shift; END="$1" ;;
        --out)   shift; OUT="$1" ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

[ -n "$START" ] || { echo "collect-logs.sh: --start is required" >&2; exit 2; }
[ -n "$OUT" ]   || { echo "collect-logs.sh: --out is required" >&2; exit 2; }

PREDICATE="subsystem BEGINSWITH \"$SUBSYSTEM_PREFIX\""

# `--style compact` keeps one event per line (grep-friendly); `--info` +
# `--debug` are NOT passed so we get default+error level — the forensic lines
# are logged at info/error, which `log show` includes by default for a
# `--predicate` query on recent history. If a run is missing expected lines,
# re-run with `--info --debug` appended here.
ARGS=(show --predicate "$PREDICATE" --start "$START" --style compact)
[ -n "$END" ] && ARGS+=(--end "$END")

echo "[collect] log show (subsystem BEGINSWITH \"$SUBSYSTEM_PREFIX\") from '$START'${END:+ to '$END'}"
/usr/bin/log "${ARGS[@]}" >"$OUT"

LINES="$(wc -l <"$OUT" | tr -d ' ')"
echo "[collect] wrote $LINES line(s) to $OUT"
