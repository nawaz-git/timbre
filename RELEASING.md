# Releasing Timbre

How to cut a downloadable release on GitHub so people can grab the `.dmg`
straight from the Releases page (and you can share that link on social media).

## Prerequisites (one time)

- The `nawaz-git/timbre` repo must be **public** for release assets to be
  publicly downloadable (private-repo assets require a login):
  ```bash
  gh repo edit nawaz-git/timbre --visibility public --accept-visibility-change-consequences
  ```
- `gh` authenticated as the repo owner.

## Manual release (current process)

The signed `.dmg` is produced by the normal build (see `HANDOFF.md`), so a release
is just: tag → build → upload.

```bash
cd ~/Projects/meeting-transcriber-electron

# 1. Make sure the version in package.json matches the tag, and the DMG is built:
#    bash dev/scripts/setup-new-mac.sh   (or the build steps in HANDOFF.md §6)
VERSION=$(node -p "require('./package.json').version")   # e.g. 0.39.0
DMG="dist/Timbre-${VERSION}-arm64.dmg"
ls "$DMG"   # confirm it exists

# 2. Tag the release commit and push the tag:
git tag "v${VERSION}"
git push origin "v${VERSION}"

# 3. Create the GitHub Release and attach the DMG:
gh release create "v${VERSION}" "$DMG" \
  --title "Timbre v${VERSION}" \
  --notes "See CHANGELOG for details. macOS 14.2+ (Apple Silicon). Self-signed build — right-click → Open on first launch, or: xattr -dr com.apple.quarantine /Applications/Timbre.app"
```

The download link to share is then:
`https://github.com/nawaz-git/timbre/releases/latest`

> **Optional:** also attach a zip of the `.app` if you prefer
> (`ditto -c -k --keepParent dist/mac-arm64/Timbre.app dist/Timbre-${VERSION}.zip`),
> but a DMG is the conventional macOS distribution format.

## Versioning

Timbre follows [SemVer](https://semver.org/) (`MAJOR.MINOR.PATCH`). The version
lives in `package.json` and drives the DMG filename and the installed app version.
Bump it before building the release.

## Notarization (roadmap)

The current build is **self-signed**, so downloaders see a Gatekeeper warning. To
ship a warning-free build you need an **Apple Developer ID** ($99/yr) and to
notarize + staple the DMG. Once set up, wire `DEVELOPER_ID` / Apple credentials into
the build and drop the "self-signed" caveat from the README and release notes.

## Automated releases (roadmap)

A `.github/workflows/release.yml` that builds + uploads on a `v*` tag is possible
but needs: a macOS runner, both repos checked out as siblings (the engine repo must
be reachable from CI — a token if it's private), and the signing identity available
on the runner. Until then, the manual flow above is the supported path.
