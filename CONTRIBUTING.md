# Contributing to Timbre

Thanks for your interest in improving Timbre! This is a macOS-only,
Apple-Silicon, on-device app. It's a **monorepo**: the Electron app **timbre**
with the Swift engine vendored in at `meeting-transcriber/`.

## Getting set up

1. Clone the repo — the Swift engine is vendored in at `meeting-transcriber/`
   (no separate clone needed); the app build reads it from there:
   ```
   timbre/                           # nawaz-git/timbre (this repo)
     meeting-transcriber/            # the Swift engine (vendored in-repo)
   ```
2. Run the one-shot bring-up:
   ```bash
   cd timbre && bash dev/scripts/setup-new-mac.sh
   ```
   See [`HANDOFF.md`](./HANDOFF.md) for prerequisites, the signing model, and the
   manual build recipe.

## Development

- **App (this repo):** `npm run dev` (electron-vite), `npm run typecheck`,
  `npm run lint`.
- **Engine (`meeting-transcriber/`):** `cd meeting-transcriber/app/MeetingTranscriber && swift build`,
  `swift test --parallel`. Run a release build (`swift build -c release`) before
  pushing — it surfaces Swift 6 strict-concurrency (`Sendable`) issues that debug
  builds tolerate.
- Always build signed (`MINTR_SIGN_IDENTITY="Mintr Dev Signing"`); ad-hoc signing
  invalidates macOS permission grants (see `HANDOFF.md`).

## Pull requests

- Branch off `main`, keep PRs focused on one change.
- Make sure `npm run typecheck` (app) and `swift build` + relevant `swift test`
  (engine) pass before opening the PR.
- Describe **what** changed and **why**; note anything that needs manual/live
  verification (audio capture, screen recording, and permission flows can't be
  fully tested headlessly).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
— types `feat` / `fix` / `docs` / `refactor` / `test` / `perf` / `chore` / `build`.
Keep commits atomic (one logical change each).

## Reporting bugs / requesting features

Use the GitHub issue templates. For anything involving captured audio/video, please
**don't** attach real meeting recordings — describe the scenario instead.

## Code of conduct

Be respectful and constructive. Harassment or abuse isn't tolerated.
