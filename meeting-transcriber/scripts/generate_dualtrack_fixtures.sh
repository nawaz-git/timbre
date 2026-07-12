#!/usr/bin/env bash
# Generate word-level diarization-quality fixtures for the attribution lane.
#
# Produces three fixture shapes under
#   app/MeetingTranscriber/Tests/Fixtures/quality/attribution/
# each with a `<name>_truth.json` carrying per-word speaker labels (the
# reference side of WDER):
#
#   1. dual-track      — separate app (remote speakers) + mic (local speaker)
#                        tracks, the product's exact live-recording shape.
#   2. dual-track bleed — same, but the app track is mixed into the mic track
#                        at -18 dB / 40 ms (the no-headphones scenario), to
#                        exercise the cross-track echo dedup.
#   3. mixed           — all speakers summed onto one track (the file-import
#                        path).
#
# These are SYNTHETIC (`say` voices, non-overlapping turns, exact-by-
# construction truth). They are deterministic and commit-safe, and they
# exercise the full attribution + dual-track + dedup plumbing end to end.
# They do NOT contain real conversational overlap or >3 speakers — the
# realistic AMI-derived fixtures (real overlap, word-aligned truth) are a
# CI / first-run download step (see docs/diarization-benchmarks.md), never
# committed, and drop into the same directory with the same `_truth.json`
# schema.
#
# Word timings inside a turn are distributed evenly across the turn's measured
# span. That is approximate at the individual-word level but exact at the turn
# level, which is all the time-projected WDER needs (each word is scored by the
# hypothesis speaker active at its midpoint, and a whole turn is one speaker).
#
# Requires: macOS `say`, `sox` + `soxi` (brew install sox), `python3`.

set -euo pipefail

command -v sox >/dev/null 2>&1 || { echo "ERROR: sox is required (brew install sox)"; exit 1; }
command -v soxi >/dev/null 2>&1 || { echo "ERROR: soxi is required (brew install sox)"; exit 1; }
command -v say >/dev/null 2>&1 || { echo "ERROR: macOS 'say' is required"; exit 1; }

# Resolve a Python that actually runs — a broken venv shim can be first on PATH.
PYTHON=""
for candidate in python3 /usr/bin/python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "print(1)" >/dev/null 2>&1; then
        PYTHON="$candidate"; break
    fi
done
[ -n "$PYTHON" ] || { echo "ERROR: a working python3 is required"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/app/MeetingTranscriber/Tests/Fixtures/quality/attribution"
mkdir -p "$OUT_DIR"

RATE=16000
GAP=0.5          # silence between turns, seconds
BLEED_GAIN=-18   # app-into-mic attenuation, dB
BLEED_DELAY=0.04 # app-into-mic delay, seconds

# render_say <voice> <text> <out16k.wav>
render_say() {
    local voice="$1" text="$2" out="$3" raw
    raw="$(mktemp -t say).wav"
    say -v "$voice" "$text" --file-format=WAVE --data-format=LEI16 -o "$raw"
    sox "$raw" -r "$RATE" -c 1 -b 16 "$out"
    rm -f "$raw"
}

# silence <dur> <out.wav>
silence() {
    sox -n -r "$RATE" -c 1 -b 16 "$2" trim 0.0 "$1"
}

# build_dualtrack <name> <mic_speaker> <turn...>
# Each turn: "SPEAKER|TRACK|VOICE|TEXT" where TRACK is app|mic.
# Writes <name>_app.wav, <name>_mic.wav, <name>_mix.wav, <name>_truth.json,
# plus <name>_bleed_mic.wav + <name>_bleed_truth.json (bleed variant).
build_dualtrack() {
    local name="$1" mic_speaker="$2"; shift 2
    local tmp; tmp="$(mktemp -d)"
    local app_parts=() mic_parts=() py_args=()
    local cursor=0 idx=0 total=$#
    local gap_sil="$tmp/gap.wav"
    silence "$GAP" "$gap_sil"

    for entry in "$@"; do
        local speaker="${entry%%|*}" rest="${entry#*|}"
        local track="${rest%%|*}"; rest="${rest#*|}"
        local voice="${rest%%|*}" text="${rest#*|}"

        local seg="$tmp/seg${idx}.wav" sil="$tmp/sil${idx}.wav" dur start end
        render_say "$voice" "$text" "$seg"
        dur="$(soxi -D "$seg")"
        silence "$dur" "$sil"
        start="$cursor"
        end="$(awk -v s="$start" -v d="$dur" 'BEGIN { printf "%.6f", s + d }')"

        if [ "$track" = "mic" ]; then
            app_parts+=("$sil"); mic_parts+=("$seg")
        else
            app_parts+=("$seg"); mic_parts+=("$sil")
        fi
        py_args+=("$speaker" "$start" "$end" "$text")

        cursor="$end"
        if [ "$idx" -lt $((total - 1)) ]; then
            app_parts+=("$gap_sil"); mic_parts+=("$gap_sil")
            cursor="$(awk -v s="$cursor" -v g="$GAP" 'BEGIN { printf "%.6f", s + g }')"
        fi
        idx=$((idx + 1))
    done

    local app_wav="$OUT_DIR/${name}_app.wav"
    local mic_wav="$OUT_DIR/${name}_mic.wav"
    local mix_wav="$OUT_DIR/${name}_mix.wav"
    local bleed_wav="$OUT_DIR/${name}_bleed_mic.wav"
    sox "${app_parts[@]}" "$app_wav"
    sox "${mic_parts[@]}" "$mic_wav"
    sox -m "$app_wav" "$mic_wav" "$mix_wav"

    # Bleed: app attenuated + delayed, summed into the mic track.
    local delayed="$tmp/app_delayed.wav"
    sox "$app_wav" "$delayed" gain "$BLEED_GAIN" delay "$BLEED_DELAY"
    sox -m "$mic_wav" "$delayed" "$bleed_wav"

    local dur; dur="$(soxi -D "$mix_wav")"
    write_truth "$name" dualtrack "$dur" \
        "${name}_app.wav" "${name}_mic.wav" "" "$mic_speaker" "${py_args[@]}"
    # Bleed variant shares the app track; only the mic track differs.
    write_truth "${name}_bleed" dualtrack "$dur" \
        "${name}_app.wav" "${name}_bleed_mic.wav" "" "$mic_speaker" "${py_args[@]}"

    rm -rf "$tmp"
    echo "Created dual-track: ${name} (+bleed) — ${dur}s"
}

# build_mixed <name> <turn...>  where turn is "SPEAKER|VOICE|TEXT"
build_mixed() {
    local name="$1"; shift
    local tmp; tmp="$(mktemp -d)"
    local parts=() py_args=()
    local cursor=0 idx=0 total=$#
    local gap_sil="$tmp/gap.wav"
    silence "$GAP" "$gap_sil"

    for entry in "$@"; do
        local speaker="${entry%%|*}" rest="${entry#*|}"
        local voice="${rest%%|*}" text="${rest#*|}"
        local seg="$tmp/seg${idx}.wav" dur start end
        render_say "$voice" "$text" "$seg"
        dur="$(soxi -D "$seg")"
        start="$cursor"
        end="$(awk -v s="$start" -v d="$dur" 'BEGIN { printf "%.6f", s + d }')"
        parts+=("$seg")
        py_args+=("$speaker" "$start" "$end" "$text")
        cursor="$end"
        if [ "$idx" -lt $((total - 1)) ]; then
            parts+=("$gap_sil")
            cursor="$(awk -v s="$cursor" -v g="$GAP" 'BEGIN { printf "%.6f", s + g }')"
        fi
        idx=$((idx + 1))
    done

    local mix_wav="$OUT_DIR/${name}_mix.wav" dur
    sox "${parts[@]}" "$mix_wav"
    dur="$(soxi -D "$mix_wav")"
    write_truth "$name" mixed "$dur" "${name}_mix.wav" "" "" "" "${py_args[@]}"
    rm -rf "$tmp"
    echo "Created mixed: ${name} — ${dur}s"
}

# write_truth <name> <kind> <duration> <audio|appAudio> <micAudio> <_> <micSpeaker> <speaker start end text ...>
write_truth() {
    local name="$1" kind="$2" duration="$3" a1="$4" a2="$5" _reserved="$6" mic_speaker="$7"; shift 7
    "$PYTHON" - "$name" "$kind" "$duration" "$RATE" "$a1" "$a2" "$mic_speaker" "$OUT_DIR/${name}_truth.json" "$@" <<'PY'
import json, sys
name, kind, duration, rate, a1, a2, mic_speaker, out_path, *rest = sys.argv[1:]
words = []
turns = []
# rest is groups of (speaker, start, end, text)
for i in range(0, len(rest), 4):
    speaker, start, end, text = rest[i], float(rest[i+1]), float(rest[i+2]), rest[i+3]
    turns.append({"speaker": speaker, "start": round(start, 6), "end": round(end, 6)})
    toks = text.split()
    if not toks:
        continue
    span = (end - start) / len(toks)
    for j, tok in enumerate(toks):
        w_start = start + j * span
        words.append({
            "w": tok,
            "start": round(w_start, 6),
            "end": round(w_start + span, 6),
            "speaker": speaker,
        })
data = {
    "fixture": name,
    "kind": kind,
    "sampleRate": int(rate),
    "duration": round(float(duration), 6),
    "words": words,
    "turns": turns,
}
if kind == "dualtrack":
    data["appAudio"] = a1
    data["micAudio"] = a2
    data["micDelay"] = 0.0
    if mic_speaker:
        data["micSpeaker"] = mic_speaker
else:
    data["audio"] = a1
with open(out_path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

# --- Fixtures ---------------------------------------------------------------

# Two remote speakers (app) + one local speaker (mic), non-overlapping turns.
build_dualtrack "synth_dualtrack_2spk" "Me" \
    "A|app|Alex|Good morning everyone and welcome to the weekly sync." \
    "Me|mic|Samantha|Thanks let me quickly share the current status." \
    "B|app|Daniel|The backend migration is done and all tests are green." \
    "A|app|Alex|Great work how is the frontend coming along this week." \
    "Me|mic|Samantha|I will send the meeting notes right after this call."

# Three speakers on one combined track (the file-import path).
build_mixed "synth_mixed_3spk" \
    "A|Alex|Let us start with the quarterly planning review." \
    "B|Daniel|I have prepared the roadmap for the next release." \
    "C|Karen|The design team finished the new onboarding flow." \
    "A|Alex|Perfect can we ship the onboarding before the deadline." \
    "C|Karen|Yes it is ready pending a final accessibility pass."

# --- Manifest ---------------------------------------------------------------

"$PYTHON" - "$OUT_DIR/quality_manifest.json" <<'PY'
import json, sys
out = sys.argv[1]
manifest = {
    "note": "Fixture matrix + per-tier WDER/DER targets for the attribution "
            "quality lane. Synthetic fixtures are committed; AMI-derived "
            "fixtures (real overlap, >3 speakers, long meetings) are a "
            "CI/first-run download into this directory and share the schema.",
    "fixtures": [
        {"name": "synth_dualtrack_2spk", "kind": "dualtrack", "class": "dualtrack",
         "committed": True, "speakers": 3, "notes": "clean headset-style dual track"},
        {"name": "synth_dualtrack_2spk_bleed", "kind": "dualtrack", "class": "bleed",
         "committed": True, "speakers": 3, "notes": "app bled into mic at -18 dB / 40 ms"},
        {"name": "synth_mixed_3spk", "kind": "mixed", "class": "mixed",
         "committed": True, "speakers": 3, "notes": "single combined track, import path"},
        {"name": "ami_dualtrack_sim_*", "kind": "dualtrack", "class": "dualtrack",
         "committed": False, "notes": "AMI headset channels, real turns — CI download"},
        {"name": "ami_mix_*", "kind": "mixed", "class": "mixed",
         "committed": False, "notes": "AMI mix, 4 speakers real overlap — CI download"},
        {"name": "overlap_dense_*", "kind": "mixed", "class": "overlap",
         "committed": False, "notes": ">=20% overlapped speech — CI download"},
    ],
    "targets": {
        "dualtrack": {"wder_fast": 0.10, "wder_max": 0.05, "der_fast": 0.14, "der_max": 0.09},
        "mixed": {"wder_fast": 0.15, "wder_max": 0.08, "der_fast": 0.22, "der_max": 0.15},
        "overlap_recall": {"fast": 0.30, "max": 0.60},
        "duplicate_line_rate_per_10min": {"max": 1.0},
    },
    "ratchet": {
        "baseline_file": "app/MeetingTranscriber/Tests/Quality/attribution_baselines.json",
        "tolerance_relative": 0.10,
        "note": "Recorded on the first CI run over real fixtures; the lane then "
                "fails on a >10% relative WDER regression.",
    },
}
with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"Wrote manifest: {out}")
PY

echo
echo "Done. Attribution fixtures + manifest in: $OUT_DIR"