# Diarization Quality Benchmarks

How speaker-attribution quality is measured, what "good" means per tier, and the
exact commands used to produce the numbers and fit the tuning knobs.

The headline metric is **WDER** (word diarization error rate): the fraction of
reference words attributed to the wrong speaker under the optimal hypothesis→
reference speaker mapping. Turn-level DER is blind to the failure users actually
hit — a word attributed to the wrong speaker because a turn boundary fell inside
one ASR segment — so WDER, not DER, is the gate.

## Metrics

All metrics are pure, model-free code in `MTPipelineCore`
(`tools/pipeline-core/Sources/DiarizationMetrics.swift`), so the one
implementation backs both the app quality lane and the `mt-batch --emit-metrics`
sweep. Unit-tested in `Tests/Quality/DiarizationMetricsTests.swift`.

| Metric | Definition | Why |
|---|---|---|
| WDER | wrong-speaker words / total words, optimal speaker mapping | the user-perceived metric; moves with attribution |
| DER | (missed + false-alarm + confusion) / reference speech, no collar | turn-level health, cross-paper comparability |
| Speaker-count error | \|hyp speakers − ref speakers\| | under/over-clustering |
| Overlap recall | reference-overlap words getting a correct speaker | overlap handling (max tier) |
| Duplicate-line rate | near-duplicate cross-track utterances / 10 min | echo/bleed dedup |
| Wall-clock | per stage, per tier | runtime budgets |

WDER has two forms. The **aligned** form scores two equal-length per-word label
streams (unit tests, and any fixture where the hypothesis is scored on the
reference transcript). The **time-projected** form scores a real diarized turn
timeline against word-level truth by projecting each reference word onto the
hypothesis speaker active at its midpoint — this is what the quality lane and
`--emit-metrics` use, because the pipeline's word list never matches the truth's
exactly.

## Fixtures

Under `app/MeetingTranscriber/Tests/Fixtures/quality/attribution/`, with a
`<name>_truth.json` per fixture carrying per-word speaker labels
(`AttributionTruth` schema). `quality_manifest.json` in that directory lists the
matrix and the targets below in machine-readable form.

**Committed (synthetic).** `scripts/generate_dualtrack_fixtures.sh` builds them
with `say` + `sox` — deterministic and commit-safe (2.5 MB total):

- `synth_dualtrack_2spk` — clean dual track: two remote speakers on the app
  track, one local speaker on the mic track, non-overlapping.
- `synth_dualtrack_2spk_bleed` — the same app track summed into the mic track at
  −18 dB / 40 ms (no-headphones scenario), for echo dedup.
- `synth_mixed_3spk` — three speakers on one combined track (import path).

They exercise the full attribution + dual-track + dedup plumbing end to end, but
have no real conversational overlap or >3 speakers.

**Download (realistic).** The AMI corpus (CC-BY-4.0, word-aligned) provides real
turn-taking, overlap, and 4-speaker meetings. AMI-derived fixtures
(`ami_dualtrack_sim_*`, `ami_mix_*`, `overlap_dense_*`) are **not committed** —
they are a CI / first-run download into the same directory under the same
`_truth.json` schema (one AMI speaker's headset channel = the mic track, the sum
of the others = the app track; a −18 dB / 40 ms bleed variant for dedup). Excerpts
stay ≤25 MB; longer meetings are downloaded, never committed. The realistic
numbers — and therefore the enforced baselines — come from these.

Regenerate the committed set:

```bash
cd meeting-transcriber
./scripts/generate_dualtrack_fixtures.sh
```

## Running the quality lane

The attribution lane (`AttributionQualityTests`) and the engine baseline classes
pull production-size models, so they are gated behind `RUN_QUALITY_TESTS=1` and
run in CI's quality job, not on a normal `swift test`.

```bash
cd meeting-transcriber/app/MeetingTranscriber

# Word-attribution lane (FAST tier) over every fixture in the matrix.
RUN_QUALITY_TESTS=1 swift test --filter AttributionQualityTests

# Engine WER/DER baselines (existing).
RUN_QUALITY_TESTS=1 swift test \
  --filter "WhisperKitQualityTests|FluidDiarizerQualityTests|ParakeetQualityTests"
```

Each run appends `QualityResult` rows (now including `wder` / `tier` /
`speakerCountError`) to `quality-results.json` (`QUALITY_RESULTS_PATH` in CI),
uploaded as an artifact for diffing against the main-branch baseline.

## Knob-fitting runbook

Never change a tuning default without numbers. Fit knobs by sweeping them over
the fixture matrix with `mt-batch --emit-metrics`, which scores the transcript a
run produced against a word-level truth without altering it.

**Cluster threshold (FAST default, and the max-tier consensus sweep).** Lower =
more speakers; the fix for remote speakers collapsing into one:

```bash
cd meeting-transcriber/tools/mt-batch
swift build -c release
FX=../../app/MeetingTranscriber/Tests/Fixtures/quality/attribution

for t in 0.5 0.6 0.7; do
  .build/release/mt-batch transcribe \
    --input "$FX/synth_mixed_3spk_mix.wav" \
    --cluster-threshold "$t" \
    --emit-metrics "$FX/synth_mixed_3spk_truth.json" \
    --output-dir "runs/mixed-$t"
done

# Collect: each run writes metrics.json and emits a `metrics` JSONL line.
for t in 0.5 0.6 0.7; do
  echo -n "threshold $t: "; cat "runs/mixed-$t/metrics.json"
done
```

Pick the threshold minimising WDER with speaker-count error 0 on the 2–4 speaker
fixtures. The max tier runs this sweep automatically and takes a co-clustering
consensus across the thresholds rather than trusting one; confirm the consensus
is at least as good as the best single threshold before trusting it.

**Dual-track sweeps** use the pair instead of `--input`:

```bash
.build/release/mt-batch transcribe \
  --input-app "$FX/synth_dualtrack_2spk_app.wav" \
  --input-mic "$FX/synth_dualtrack_2spk_mic.wav" \
  --mic-name Me \
  --emit-metrics "$FX/synth_dualtrack_2spk_truth.json" \
  --output-dir runs/dual

# Bleed / dedup check: point --input-mic at the bleed track, keep the same truth.
.build/release/mt-batch transcribe \
  --input-app "$FX/synth_dualtrack_2spk_app.wav" \
  --input-mic "$FX/synth_dualtrack_2spk_bleed_mic.wav" \
  --mic-name Me \
  --emit-metrics "$FX/synth_dualtrack_2spk_bleed_truth.json" \
  --output-dir runs/dual-bleed
```

WDER on the bleed fixture measures echo dedup: if the app leaks into the mic and
is not dropped, its words are mis-attributed to the local speaker and WDER rises.

**Other knobs, same method** — sweep and record before changing a default:
- matcher similarity floor / margin (enrolled-voice precision/recall), against
  the enrolled-voices fixture;
- cross-track dedup constants (time overlap, text similarity, RMS guard), against
  the bleed fixture's duplicate-line rate;
- the max-tier re-scoring reassignment margin, read off the per-pass ablation.

**Per-pass ablation.** `DiarizationMetrics.ablation` scores the hypothesis
captured after each pass (fast baseline → +consensus → +rescore → +LLM) and
reports the marginal WDER each pass buys. A pass that does not move WDER on the
fixtures is not earning its runtime budget. The consensus contribution is
directly visible from the threshold sweep above; the rescore and LLM
contributions come from the max-tier run.

## Targets (definition of "done")

Set between port parity (FluidAudio reports ~15.5 % DER on AMI-SDM; pyannote
~17 % DER on AMI-headset) and clearly-fixed. Bold-cell targets on the fixture
matrix, plus one manual real-meeting validation (3+ remote speakers, with and
without headphones) where the user judges ≥95 % of utterance labels correct
(max tier).

| Metric (fixture class) | FAST target | MAX target |
|---|---|---|
| WDER, dual-track | ≤ 10 % | ≤ 5 % |
| WDER, mixed single track | ≤ 15 % | ≤ 8 % |
| DER, dual-track | ≤ 14 % | ≤ 9 % |
| DER, mixed single track | ≤ 22 % | ≤ 15 % |
| Speaker-count error (2–4 spk) | 0 | 0 |
| Overlap recall (overlap-dense) | ≥ 30 % (annotate) | ≥ 60 % |
| Duplicate-line rate (bleed) | < 1 / 10 min | < 1 / 10 min |
| Enrolled voices | P ≥ 0.9 at R ≥ 0.7 | P ≥ 0.95 at R ≥ 0.8 |
| Latency, 60-min meeting (M1 Air class) | ≤ today + 15 % | ≤ 30 min hard; ≤ 20 min typical |

These are AMI-calibrated; the synthetic committed fixtures cluster more weakly,
so their absolute numbers are not compared against the table — they guard the
plumbing and feed the ratchet.

## Baselines and the ratchet

The lane does not hard-code magic pass/fail numbers. Instead:

1. The first CI run over the (real, AMI-derived) fixtures records WDER per
   fixture × tier into
   `app/MeetingTranscriber/Tests/Quality/attribution_baselines.json`
   (`{ "<fixture>|<tier>": <wder> }`), committed in that PR.
2. Every later run fails if a fixture's WDER is more than 10 % relatively worse
   than its baseline. Improvements re-baseline (lower the number) in the same PR.
3. A catastrophic-failure sanity bound always holds, so a totally broken
   attribution path fails even before any baseline exists.

This replaces the old absolute DER thresholds with a regression ratchet: the
targets above are the goal the baselines are driven toward, and the ratchet keeps
them from sliding back.
