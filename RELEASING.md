# Releasing Timbre

Official releases are Apple Silicon direct-download builds. The release workflow
signs the app with a Developer ID, notarizes and staples the app and DMG, verifies
the final artifacts, and publishes only an exact, complete draft asset set.

## Repository trust boundary

The release workflow has two jobs:

1. A read-only job resolves an explicit `refs/tags/v*` ref, checks that `HEAD`
   equals the peeled tag commit, checks tag/package version parity, and proves the
   tag commit is contained in `origin/main`. It receives no Apple secrets.
2. A `release` environment job checks out the validated commit SHA, repeats those
   checks before credentials are imported and again before publication, then
   signs and publishes with narrowly scoped `contents: write` permission.

The repository release boundary uses these controls:

- immutable GitHub Releases;
- a protected `release` environment with admin bypass disabled,
  `prevent_self_review` enabled, and deployments restricted to `v*` tags;
- tag ruleset `19554129`, which restricts `v*` creation to the repository owner;
- tag ruleset `19554131`, which blocks `v*` update, deletion, and force changes.
- main ruleset `19554278`, which requires one pull-request approval, dismisses
  stale approvals, requires resolved review threads and approval after the last
  push, and blocks deletion and non-fast-forward updates.

Before every production tag, confirm that main ruleset `19554278` has no bypass
actor and that a second trusted reviewer is assigned to the `release` environment.
With only the triggering owner assigned, `prevent_self_review` intentionally
prevents the release from proceeding until an independent reviewer is added.

Keep the repository's default Actions token permission read-only. The release
workflow grants write access only to its protected publication job.

## One-time Apple setup

The release owner needs an active Apple Developer Program membership and:

1. A **Developer ID Application** certificate and private key exported together
   as a password-protected `.p12`.
2. The exact identity printed by `security find-identity -v -p codesigning`; it
   must begin with `Developer ID Application: `.
3. The Apple Account email and Team ID associated with that certificate.
4. An app-specific password for Apple's notarization service.

Keep these values in the team's secret manager. Never commit or print them.

## Required environment secrets

Store all six values as secrets on the protected GitHub environment named
`release`, not as repository secrets:

| Secret                       | Contents                                                 |
| ---------------------------- | -------------------------------------------------------- |
| `DEVELOPER_ID_CERT`          | Base64 `.p12` containing the certificate and private key |
| `DEVELOPER_ID_CERT_PASSWORD` | Password used to export the `.p12`                       |
| `DEVELOPER_ID`               | Exact `Developer ID Application: ...` identity           |
| `APPLE_ID`                   | Apple Account email used for notarization                |
| `TEAM_ID`                    | Apple Developer Team ID embedded in the signature        |
| `APP_PASSWORD`               | App-specific password used by `notarytool`               |

Upload the certificate without printing it and enter every other value at the
interactive prompt:

```bash
CERT_PATH=/absolute/path/to/developer-id-certificate.p12
/usr/bin/base64 -i "$CERT_PATH" | gh secret set --env release DEVELOPER_ID_CERT
gh secret set --env release DEVELOPER_ID_CERT_PASSWORD
gh secret set --env release DEVELOPER_ID
gh secret set --env release APPLE_ID
gh secret set --env release TEAM_ID
gh secret set --env release APP_PASSWORD
unset CERT_PATH
gh secret list --env release
```

Secret values are not shown by GitHub after creation. Confirm only their names.

## Cut a release

The Git tag is immutable release input. Its version must exactly match
`package.json`, including any prerelease suffix.

1. Update and validate the version without creating a tag:
   ```bash
   npm version patch --no-git-tag-version
   npm ci
   npm test
   VERSION=$(node -p "require('./package.json').version")
   ```
2. Commit the version change and land it on protected `main` through review.
3. Tag that exact commit and push the tag:
   ```bash
   git tag "v${VERSION}"
   git push origin "v${VERSION}"
   ```
4. An independent reviewer approves the protected `release` environment job.
5. Follow the `Release` workflow until it succeeds, then complete the clean-Mac
   download check below.

The protected job imports the certificate into a temporary keychain, builds the
vendored engine and `mt-batch`, runs the production Electron packaging lane,
notarizes and staples the app and DMG, creates the ZIP from the stapled app, and
runs the final trust verifier. The decoded `.p12` is deleted immediately after
import; the keychain is deleted under `always()` on success or failure.

## Retry an unpublished draft

Manual dispatch is allowed only from the same explicit tag named by the input.
It runs the identical validated commit and packaging path:

```bash
TAG=v$(node -p "require('./package.json').version")
gh workflow run release.yml --ref "$TAG" -f tag="$TAG"
```

A failed run may reuse the same tag only while its GitHub Release is absent or
still a hidden draft. The workflow may replace assets inside that draft, then
requires exactly these two fully uploaded, non-empty assets with remote sizes
equal to their local files before publishing:

- `Timbre-${VERSION}-arm64.dmg`
- `Timbre-${VERSION}-arm64.zip`

An already-published release is terminal. The workflow refuses to mutate it,
even if GitHub reports it as mutable. Any correction after publication requires
a new patch version, commit, and tag.

## Recovery

- **Missing secret:** inspect `gh secret list --env release`, add the missing
  environment secret, then rerun the still-unpublished tag.
- **Environment approval unavailable:** add a second trusted reviewer. Do not
  disable `prevent_self_review` or enable admin bypass as a shortcut.
- **Temporary main bypass still enabled:** remove the owner bypass from ruleset
  `19554278` before creating a production tag.
- **Certificate or identity mismatch:** re-export a `.p12` containing the private
  key and update `DEVELOPER_ID_CERT`, `DEVELOPER_ID_CERT_PASSWORD`, and
  `DEVELOPER_ID` together.
- **Notarization authentication failure:** refresh `APPLE_ID`, `TEAM_ID`, or
  `APP_PASSWORD`, then rerun only if the release remains a draft or absent.
- **Interrupted draft:** rerun the same explicit tag. The draft remains hidden
  unless both verified assets exactly match.
- **Artifact or code failure:** fix it, increment the patch version, and create a
  new reviewed commit and tag. Never attach an artifact manually.
- **Published release:** never clobber or replace it. Immutable releases and the
  tag rulesets enforce this; publish a new patch tag.

## Post-release verification

Confirm the public release exposes exactly the version-matched DMG and ZIP:

```bash
TAG="v${VERSION}"
gh release view "$TAG" --json isDraft,isImmutable,assets \
  --jq '{isDraft,isImmutable,assets:[.assets[]|{name,size,state}]}'
```

Finally, download the DMG through a browser in a fresh macOS account or clean Mac,
confirm quarantine remains present, drag Timbre to Applications, and open it by
normal double-click. Do not use Open Anyway, remove quarantine, or weaken
Gatekeeper. The exact downloaded app must launch and complete a short recording.
