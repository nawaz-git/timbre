# User observation — onboarding flow for productionization

Captured verbatim during the v0.21 test cycle.

## The ask

> "Create a proper onboarding popup or navigate to settings and then keep
> it everything there. Exact steps that has to be taken by the user cause
> we are thinking of productionizing this app right? So we'll be sending
> [it to] users and then they will be just directing this dmg file, drag
> [it] into the application — after that the journey has to be seamless
> so start working on that. Something to be noted start creating the
> plans or just note it down don't start it now I'll test it once again
> after like doing this manual steps but that has to be in the
> onboarding flow."

## What this means

Production users will:
1. Download `Mintr-X.Y.Z-arm64.dmg`
2. Mount, drag Mintr.app → Applications
3. Open Mintr for the first time

**From that moment forward, the path to "captures a Meet end-to-end"
must be a guided wizard. NO terminal commands, NO manual paths typed
into `⌘⇧G` dialogs, NO grepping unified logs.**

Today the journey is brutal — I had to walk the user through:
- Adding Mintr Engine to Screen Recording manually (via `+ → ⌘⇧G → path`)
- Adding Mintr Engine to Microphone manually
- Adding Mintr Engine to Accessibility manually
- Quitting + reopening Mintr after each grant
- Removing orphan "MeetingTranscriber" entries from each list

That's the experience of a developer debugging their own app. It must
be invisible for production.

## In-scope for the onboarding ticket

- First-run permission wizard with 3 sequential steps (Screen Recording,
  Microphone, Accessibility) for the Mintr Engine bundle id.
- Live status checks per step (polling tccd log or Electron's
  systemPreferences APIs).
- A "Reveal engine in Finder" button per step that opens Finder with
  `MintrEngine.app` highlighted so the user can drag it onto the
  System Settings `+` dialog (we already have this IPC).
- Automatic helper restart after each grant is detected.
- Mirror of the same wizard in Settings → "Setup & permissions" for
  later access (the user said: "navigate to settings and then keep it
  everything there").

## Out of scope (deferred to other tickets)

- Code signing / notarization (Developer ID Application certificate).
- Sparkle / electron-updater auto-update infrastructure.
- Crash reporting (sentry-electron, etc.).
- Privacy policy + EULA modals.
- Localization beyond English.

See `dev/tickets/TICKET-ONBOARDING-001-first-run-permission-wizard.md`
for the full implementation spec.
