# Capture-stability soak checks

Long-running, on-device verification that a live recording never destabilises
the machine's audio server or the browser/meeting it is capturing — and that the
capture pipeline recovers cleanly from device churn, process churn, and app
lifecycle events. These are the behavioural release gate for the capture stack;
they complement the fast unit + sanitizer suites that run in CI.

Each recipe is a procedure you run on a real Mac, plus an **objective PASS/FAIL
verdict** computed from the logs the run produced. The verdict logic lives in
`lib/soak-assert.sh` and is exercised by `check-soak.sh`; `run-soak.sh` brackets
a run and calls both for you.

## What a soak needs

- **A real GUI login session.** The audio tap captures silence in a headless /
  SSH-only context even when the CoreAudio calls return success. Run these at the
  console (or via screen sharing into an Aqua session), not over a bare SSH pipe.
- **A microphone input device.** Hosts without a built-in mic (e.g. a Mac mini)
  need a virtual input such as BlackHole 2ch set as the default Input, or the
  recorder has nothing to bind the mic engine to.
- **Verbose audio logging ON** so the forensic lines are emitted:
  Settings/Diagnostics → "Verbose Audio Logging" (or the engine's
  `audioDebugLogging` default). The `HAL call slow:` and per-session
  `Capture session summary:` lines are what the checks read.
- **Hardware for the churn recipes:** a Bluetooth headset (AirPods) for the
  Bluetooth-storm recipe; a real browser for the renderer-churn recipe.
- The unit-test and sanitizer (TSan/ASan) legs of the release gate require a full
  Xcode toolchain and run in CI — they are not part of these on-device soaks.

## The two logs a run produces

1. **Engine unified-log window** — the `Capture session summary:`,
   `HAL call slow:`, `Tap health rebuild:`, `Tap PID filter:` and HAL-liveness
   sentinel lines. Captured with `collect-logs.sh` (or automatically by
   `run-soak.sh`) via `log show` over the `com.meetingtranscriber` subsystems.

2. **The app's main-process output** — the `[supervisor] …` engine-supervision
   lines (restart / give-up). These are printed to the app's stdout/stderr, NOT
   the unified log, so you must start the app from a terminal with its output
   redirected to a file when a recipe needs them (the lifecycle and mic-only
   recipes do):

   ```bash
   # from the repo root, capturing the whole app's console output:
   npm run dev 2>&1 | tee ~/timbre-soak-runs/app.log
   ```

   Pass that file to the verdict with `--electron-log`.

## Running a recipe

```bash
cd meeting-transcriber/scripts/soak

# Bracket a run: prints the recipe steps, waits while you perform them, then
# collects the engine log and prints the verdict.
./run-soak.sh baseline --minutes 120
./run-soak.sh mic-only --electron-log ~/timbre-soak-runs/app.log
./run-soak.sh lifecycle --electron-log ~/timbre-soak-runs/app.log
```

`run-soak.sh` does not launch Timbre — start it yourself first (so the recipes
that need the supervisor log can redirect it), then run the driver to bracket
the window. Results (captured engine log + `verdict.txt`) land under
`~/timbre-soak-runs/<recipe>-<timestamp>/`.

If you'd rather bracket a run by hand, capture the two logs yourself and call the
verdict directly:

```bash
./check-soak.sh baseline --engine-log engine.log \
    --coreaudiod-before "$BEFORE_PID" --coreaudiod-after "$AFTER_PID"
```

`check-soak.sh <recipe> --help` lists every option (rebuild/restart budgets, PID
cap, etc.).

## Universal pass criteria

Every recipe asserts the audio server stayed healthy:

- **zero coreaudiod restarts** — the coreaudiod PID is identical before and after
  the run (a PID change is the reboot-requiring failure this whole effort exists
  to prevent);
- **zero `HAL call slow:` tripwires** — no tap create/destroy call blew the
  latency threshold;
- **zero HAL-liveness sentinel "unresponsive" events**.

Additionally, during any recording the browser/meeting must stay clickable and
the produced audio must be valid.

## Recipes

| Recipe | Duration | Needs | Beyond the universal checks |
|---|---|---|---|
| `baseline` | ~2 h | built-in output | capture summary present, **0 dropped bytes**, **0** tap rebuilds |
| `bt-storm` | ~90 min | AirPods | tap rebuilds coalesced (≤ budget), 0 dropped bytes, no wedge |
| `renderer-churn` | ~60 min | real browser | tap PID set **≤ 8**, ≤ 2 tap rebuilds |
| `lifecycle` | ~60 min | version-matched build, app log | supervisor restarts **≤ 3**, **0** audio-wedged restarts |
| `sck-churn` | ~40 min | — | clean capture teardown; video pause/resume is a manual eyeball |
| `mic-only` | ~30 min | app log | **no app tap created**, **0** audio-wedged restarts |

### baseline

Steady capture with no churn — the control that proves the write-path rework did
not regress plain recording. Keep the built-in output selected and record a
meeting (real, or the `tools/meeting-simulator` fixture) for the full window. No
device switching, no minimizing.

### bt-storm

Pair AirPods and record. During the window, switch the system output device
every ~45 s (e.g. `SwitchAudioSource` in a loop) and cycle the AirPods
in/out of the case once every ~10 min. Capture must survive the churn: rebuilds
stay coalesced (a handful, not a storm), no degraded state, audio stays valid.

### renderer-churn

Record a real-browser meeting and open/close ~10 tabs per minute. The
audio-active PID filter must keep the tap set at or below its cap and provoke few
re-taps, and the audio must stay transcribable.

### lifecycle

Every ~5 min, alternate: (a) relaunch the app — the engine must be **reused**, no
engine deaths; (b) `kill -TERM` the engine — graceful finalize < 5 s then a
supervised relaunch; (c) `kill -KILL` the engine — supervised relaunch with
backoff. The browser must stay responsive throughout, and the storm guard must
hold the restart count to its cap.

> **Version match (required for the reuse leg).** The engine is only reused
> instead of killed when the engine bundle's version equals the app version.
> A plain dev engine build carries a placeholder version and will therefore be
> killed + relaunched every time (safe, but it does **not** exercise reuse). To
> test reuse, run against a build where the two are stamped the same — verify
> with:
>
> ```bash
> # app version:
> node -p "require('./package.json').version"
> # engine bundle version (adjust path to the bundle under test):
> /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
>   /path/to/MintrEngine.app/Contents/Info.plist
> ```
>
> If they differ, the reuse leg is not applicable on that build; kill+relaunch is
> the expected, safe behaviour and the run still validates the graceful-stop and
> supervised-relaunch legs.

### sck-churn

Record for ~30 min while minimizing and restoring the captured window every
minute, then leave it fully static for ~10 min. Watch that the video **pauses**
on minimize and **resumes** on restore with no visible restart. The automated
verdict covers audio-server health and a clean capture teardown; the
pause/resume and "zero spurious stream restarts" are a manual eyeball on the
video and the engine log's `[ScreenRecorder]` lines.

### mic-only

Turn ON Settings → Recording → "Disable app audio capture", then record a meeting.
The recording must be mic-only — **no process tap is created** — and the engine
supervisor must **never** fire an audio-path-wedged restart. (With no tap there
is no IOProc, so the liveness heartbeat omits its audio-callback timestamp and
the supervisor's audio-wedged branch stays dormant; this recipe proves that end
to end.) Needs `--electron-log`.

## Manual matrix (run once on a Bluetooth-headset machine class)

Join/leave a meeting ×3 with AirPods; minimize + restore mid-meeting; close the
meeting tab mid-recording; quit + relaunch the app mid-meeting; sleep/wake the
laptop mid-meeting; start/stop a second audio app (Music) mid-meeting. After
each, verify: the browser is clickable, the recording finalized, the liveness
heartbeat is clean, and no sentinel event fired.

## Field acceptance

After rollout, any freeze report must arrive with a sentinel event **and** a
`Capture session summary:` line in the diagnostics export. If the sentinel fires
while the rebuild counters are quiet, the residual cause is outside our capture
lifecycle — and the "Disable app audio capture" switch isolates it in one step.
