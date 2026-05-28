# QA-VERSION-001 — Cross-macOS permission UI matrix

Engine helper: **MintrEngine** (`ai.nawaz.mintr-engine`). Permissions: Screen Recording, Microphone, Accessibility.
Verified hardware: macOS **26.5** / Build 25F71 / Darwin **25.5.0** (`sw_vers` + `uname -r` on this machine).

## 3×3 matrix: permission × macOS version → "+ button" vs "prompt only"

| Permission | macOS 14 Sonoma | macOS 15 Sequoia | macOS 26 Tahoe |
|---|---|---|---|
| **Screen Recording** (pane: "Screen & System Audio Recording" on 15/26; "Screen Recording" on 14) | + / − buttons | + / − buttons | **+ / − buttons** (confirmed via screenshot) |
| **Microphone** | prompt-only (no +) | prompt-only (no +) | **prompt-only, NO + button** (confirmed via screenshot) |
| **Accessibility** | + / − buttons | + / − buttons | **+ / − buttons** (confirmed via screenshot) |

Microphone (and Camera) have **never** exposed a manual "+" — an app only appears after it calls `AVCaptureDevice.requestAccess(for: .audio)`, which is the OS-enforced consent path on 14/15/26. Screen Recording and Accessibility expose +/− on all three versions. The only Tahoe-specific change is cosmetic: the Screen Recording pane is **renamed** "Screen & System Audio Recording" (also true on Sequoia), but its +/− affordance and deep-link anchor are unchanged.

## Deep-link URLs per pane (and version differences)

Anchors are **identical across 14 / 15 / 26** (the underlying pane id does not change when Apple renames the display label):

```
Screen Recording : x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture
Microphone       : x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone
Accessibility    : x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility
```

Open from code: `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"`. No per-version branching needed for the URLs.

## macOS version detection (Swift + Node, with Darwin mapping table)

**Swift (engine):**
```swift
let v = ProcessInfo.processInfo.operatingSystemVersion   // majorVersion = 14 / 15 / 26
switch v.majorVersion { case 14: /* Sonoma */; case 15: /* Sequoia */; case 26: /* Tahoe */; default: break }
```

**Electron main (Node):** prefer `process.getSystemVersion()` — Electron docs state it returns the **product** version (e.g. `"26.5"`), NOT the kernel version, unlike `os.release()`. Parse the major:
```js
const major = parseInt(process.getSystemVersion().split('.')[0], 10); // 14 | 15 | 26
```
If you only have `os.release()` (Darwin kernel), map the Darwin major (mapping per `sindresorhus/macos-release`):

| Darwin major | macOS | Marketing version |
|---|---|---|
| 23 | Sonoma | 14 |
| 24 | Sequoia | 15 |
| 25 | **Tahoe** | **26** |

Note the off-by-one: Darwin 25 = macOS **26** (Apple jumped 16→26). Verified: this machine is Darwin 25.5.0 = macOS 26.5.

## Step sequences: with-+ flow vs prompt-only flow

**With "+" (Screen Recording + Accessibility, all versions):**
1. Open pane via deep link. 2. Click **+**. 3. Press **⌘⇧G**, paste the MintrEngine binary path, **Open**. 4. Toggle the row **on**. 5. macOS prompts to **Quit & Reopen** the helper for Screen Recording — relaunch the engine.

**Prompt-only (Microphone, all versions):**
1. Engine calls `AVCaptureDevice.requestAccess(for: .audio)` at launch (requires `NSMicrophoneUsageDescription` in Info.plist). 2. OS shows "MintrEngine would like to access the microphone". 3. User clicks **Allow** → row auto-added and enabled.

## Denied-recovery path (esp. Tahoe Mic after "Don't Allow")

Once the user clicks **Don't Allow**, `requestAccess` returns `false` immediately on every subsequent call (no second prompt). Because there is **no "+"** on the Mic pane, the app cannot be re-added manually. Recovery options, in order:
1. **The app is still listed** in the Microphone pane after the first prompt (denied apps remain with a toggle, even without a +). The user simply flips the toggle **on**. Per Apple Support, toggling off does not remove the row — toggling back on (or the next access attempt) restores it. **This is the primary user-facing recovery.**
2. If the row is genuinely absent / stuck, reset TCC for the helper: `tccutil reset Microphone ai.nawaz.mintr-engine` (then relaunch → fresh prompt). Requires the helper's correct bundle id; this is a power-user/support step, not first-line wizard copy.

Wizard logic: on denied Mic, **deep-link to `Privacy_Microphone` and tell the user to toggle the existing MintrEngine row on** — do NOT instruct them to click "+" (it doesn't exist).

## Per-version per-permission copy strings (ready to use in the wizard)

**Screen Recording** (14/15/26 — identical flow; only the pane label differs):
> Open Screen Recording settings, click **+**, press **⌘⇧G**, paste the MintrEngine path, click **Open**, then turn it **on**. (On Sequoia/Tahoe the pane is named **"Screen & System Audio Recording"**.) macOS will ask you to **Quit & Reopen** — relaunch when prompted.

**Accessibility** (14/15/26 — identical):
> Open Accessibility settings, click **+**, press **⌘⇧G**, paste the MintrEngine path, click **Open**, then turn it **on**.

**Microphone — Tahoe (26):**
> Click **Allow** on the macOS prompt. If you don't see a prompt, open Microphone settings and turn **MintrEngine on** — there is no "+" button on this Mac.

**Microphone — Sonoma/Sequoia (14/15):**
> Click **Allow** on the macOS prompt. If no prompt appears, open Microphone settings and toggle **MintrEngine on**. (Microphone has no "+" — the app must request access.)

**Microphone — previously denied (any version):**
> Open Microphone settings and turn the **MintrEngine** toggle **on**. (You denied access before, so no new prompt will appear — flip the existing switch.)

## Open questions / things to verify on real hardware

- **Confirm on 14/15 hardware** that the Mic pane keeps showing a denied app with a re-enable toggle (verified-by-doc, not by screenshot). If a denied app is ever fully absent from the list, copy must escalate to the `tccutil reset` path.
- **Verify the `Privacy_ScreenCapture` anchor still focuses the renamed pane on 26.5** (opening the URL is non-destructive — run `open "...?Privacy_ScreenCapture"` and eyeball it).
- Confirm the helper's binary path the user must paste at the "+" step (the `.app` vs raw executable inside the bundle) — TCC matches on code signature, so adding the wrong nested binary can silently fail to grant.
- Confirm Sequoia's monthly screen-recording re-consent nag does not also re-prompt Mic (Sequoia added periodic Screen Recording re-authorization).

---
Sources: [Apple Support — Control microphone access on Mac](https://support.apple.com/guide/mac-help/mchla1b1e1fe/mac) · [Apple System Preferences URL schemes (gist)](https://gist.github.com/rmcdongit/f66ff91e0dad78d4d6346a75ded4b751) · [Scripting System Preferences panes](https://www.macosadventures.com/2022/02/06/scripting-system-preferences-panes/) · [sindresorhus/macos-release Darwin map](https://github.com/sindresorhus/macos-release) · [Electron process.getSystemVersion docs](https://www.electronjs.org/docs/latest/api/process) · [Cyber Acoustics — Mic privacy Ventura/Sonoma/Sequoia](https://www.cyberacoustics.com/cyber-acoustics-blog/how-to-check-microphone-privacy-settings-for-macos-ventura-sonoma-sequoia) · [Microsoft Q&A — Tahoe 26.4 "Screen & System Audio Recording" pane](https://learn.microsoft.com/en-us/answers/questions/5848423/)
