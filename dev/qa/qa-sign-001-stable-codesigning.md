# QA-SIGN-001 — Stable code signing across both repos

Tier 1 goal: one **stable self-signed cert** signs (a) the engine `.app` and
(b) Mintr.app + the rebadged MintrEngine.app, so the cdhash-independent
Designated Requirement stays constant and TCC grants survive rebuilds.

Current state confirmed live: `security find-identity -v -p codesigning` →
`0 valid identities`; engine `.app` is `Signature=adhoc flags=0x2(adhoc)`
(`codesign -dv` on `.build/release/MeetingTranscriber.app`). So nothing is
signed with a stable identity yet.

## How the existing self-signed cert is created (engine repo)

`scripts/setup-self-hosted-runner.sh` already does the whole dance:
- **Cert name / org**: `CERT_NAME="MeetingTranscriberDevSelfHosted"`, `O="meetingtranscriber-self-hosted"` (lines 34-35).
- **Dedicated keychain** (not login): `$HOME/Library/Keychains/meetingtranscriber-dev.keychain-db`, empty password (lines 40-41) so `-A` imports and `set-key-partition-list` are non-interactive.
- **Key-usage workaround** (the macOS 26 gotcha): the cert must carry `keyUsage = critical, digitalSignature` AND `extendedKeyUsage = critical, codeSigning` AND `basicConstraints = critical, CA:false` — created via `openssl req -x509 ... -addext` (lines 80-86). Comment at 77-79: EKU codeSigning alone gives "Invalid Key Usage for policy" / "no identity found".
- **PKCS#12 must be `-legacy`** (lines 90-93) or import fails `MAC verification failed`.
- **Make codesign find it**: create+unlock keychain (100-104) → `keychain-prepend.sh` adds it to the user search list (108) → `security import -A -t agg` (111-113) → `security set-key-partition-list -S "apple-tool:,apple:,codesign:" -s -k ""` (116-119).
- **Signing identifier used**: it signs with the **leaf SHA-1** (`CERT_HASH`, extracted from the `.crt` at lines 134-135), NOT `find-identity -v`, because the cert is **untrusted** so `-v` returns it empty (comment 196-198, 147-150).

**Reuse verbatim?** No — that script also builds, deploys, writes a PPPC
profile, CI keychain, Spotlight marker. **Recommend a trimmed standalone
`scripts/create-dev-signing-cert.sh`** that does only lines 52-137 (create
cert + keychain + partition list, print SHA-1). Both repos source/run it.

## Engine build: how to sign with it (file:line)

`build_release.sh` signs the engine `.app` only in the `NOTARIZE=false`
branch via `SIGN_HASH=$(detect_sign_hash)` (line 183 → helper lines 20-23:
`security find-identity -v -p codesigning | grep -oE '[0-9A-F]{40}'`).
- If found: `codesign --deep --force --sign "$SIGN_HASH" --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"` (line 185).
- Else ad-hoc: `--sign -` (line 188).

**Condition / hazard**: `detect_sign_hash` uses `find-identity **-v**`, which
only lists **trusted** identities. The self-signed cert is **untrusted**, so
`-v` returns empty → it falls through to ad-hoc. **Two fixes**: (a) trust the
cert once (`security add-trusted-cert -r trustRoot -p codeSign -k login.keychain` — the GUI/TouchID step at setup lines 160-163) so `-v` sees it; OR (b) preferred for portability: make `build_release.sh` accept an explicit identity, e.g. `SIGN_HASH=${MT_SIGN_IDENTITY:-$(detect_sign_hash)}`, and pass the **cert name or leaf SHA-1** + `--keychain "$DEV_KEYCHAIN"`. Note: this is the same engine `.app` electron-builder consumes via `extraResources` (`../meeting-transcriber/.build/release/MeetingTranscriber.app`, electron-builder.yml:32-33), so it must be run/signed before `dist:mac`.

## electron-builder.yml change (identity + hardenedRuntime caveat)

- `identity: null` (line 46) forces ad-hoc → change to the cert **common name**: `identity: MeetingTranscriberDevSelfHosted` (electron-builder resolves a name/SHA-1 against the keychain search list; the dev keychain must be in that list and unlocked).
- **hardenedRuntime + self-signed**: `hardenedRuntime: true` (line 47) does NOT require Developer ID for *signing* — codesign will apply `--options runtime` with any identity. It only matters for Gatekeeper/notarization. It is safe to keep, but for a Tier-1 self-signed dev build the safest, lowest-friction choice is **`hardenedRuntime: false`** — hardened runtime adds library-validation/runtime restrictions that, combined with an *untrusted* signer and the engine's `allow-unsigned-executable-memory` / `allow-dyld-environment-variables` entitlements, can surface launch failures that a non-hardened self-signed build avoids. Keep `notarize: false` (line 49) and `gatekeeperAssess: false` (line 48) as-is.
- Recommendation: set `identity: MeetingTranscriberDevSelfHosted`, `hardenedRuntime: false` for Tier 1; revisit hardenedRuntime at Tier 2 (Developer ID + notarize).

## afterPack.js re-sign change (exact codesign cmd)

Today `adhocResign()` (lines 67-73) runs `codesign --force --deep --sign - --preserve-metadata=entitlements`. Replace the identity with the same cert. Exact invocation (no `--deep` — see ORDER below; deep would re-sign nested code and can fight electron-builder):

```
codesign --force --sign "MeetingTranscriberDevSelfHosted" \
  --keychain "$HOME/Library/Keychains/meetingtranscriber-dev.keychain-db" \
  --entitlements <engine-entitlements.plist> \
  <MintrEngine.app>
```

- Use the **engine's own entitlements** (mic/audio) — the engine repo's `Homebrew.entitlements` (audio-input only) or a copy in this repo. `--preserve-metadata=entitlements` only works if the prior signature already carried them; an explicit `--entitlements` is more robust.
- Add `--options runtime` ONLY if you keep `hardenedRuntime: true`; omit it if you set hardenedRuntime false (must match the outer app's regime).
- Sign the engine **leaf-up**: helper binaries / dylibs first (the engine `.app` has none today — `find` shows no nested `.app`/`.dylib`), then the `.app` itself. So a single non-deep `codesign` on the bundle is sufficient here.

## Signing ORDER + correct hook (rename → sign engine → sign Mintr.app)

The hazard is real: electron-builder signs the **outer** Mintr.app (which
seals a hash of the nested `Resources/MeetingTranscriber.app`). `afterPack`
runs **before** electron-builder's own signing of the outer app; it
**renames + edits + re-signs** the engine. Renaming/editing a nested signed
bundle invalidates the **outer** seal — but because afterPack runs *before*
the outer signature is computed, the outer signing picks up the already-mutated,
already-(re)signed engine. So the working sequence is:

1. **afterPack** (current hook): rename inner exec → patch Info.plist → rename `.app` → **re-sign MintrEngine.app with the cert** (replace `adhocResign`).
2. electron-builder then signs the **outer Mintr.app with the same `identity:`**, sealing the now-final engine.

Keep everything in **afterPack** (do NOT move to afterSign — afterSign runs
after the outer app is sealed, so a re-sign there would invalidate the outer
seal and you'd have to re-sign Mintr.app yourself). The only change: swap the
ad-hoc `--sign -` for `--sign MeetingTranscriberDevSelfHosted` and ensure the
dev keychain is unlocked + in the search list when `dist:mac` runs.

## Gatekeeper/launch implications on user's own machine

- A self-signed cert is enough to **launch on the user's own Mac** *iff* the cert is trusted in their keychain (`add-trusted-cert -r trustRoot -p codeSign`, setup lines 160-163) — then the DR validates locally and TCC grants persist.
- If the cert is **untrusted**, the binary still has a valid stable cdhash/DR for TCC purposes, but **Gatekeeper** treats first launch from quarantine like an unidentified developer → user still needs **right-click → Open** once (or `xattr -dr com.apple.quarantine`). DMG-delivered apps get the quarantine xattr, so expect one right-click→Open unless the cert is trusted.
- `gatekeeperAssess: false` (yml:48) only disables electron-builder's *build-time* assessment; it does not change runtime Gatekeeper on the user's machine.

## Recommended concrete change list (no code, just precise specs)

1. Add `scripts/create-dev-signing-cert.sh` (trimmed from setup lines 52-137): create `MeetingTranscriberDevSelfHosted` self-signed cert (the 3 critical extensions) in `meetingtranscriber-dev.keychain-db`, partition list, prepend to search list, print leaf SHA-1. Run once per machine; optionally `add-trusted-cert` for trust.
2. `build_release.sh`: make identity overridable — `SIGN_HASH=${MT_SIGN_IDENTITY:-$(detect_sign_hash)}` and pass `--keychain "$DEV_KEYCHAIN"`; or trust the cert so existing `find-identity -v` path picks it up. Keep `--deep --force --entitlements`.
3. `electron-builder.yml`: `identity: MeetingTranscriberDevSelfHosted`; set `hardenedRuntime: false` for Tier 1; leave `notarize:false`, `gatekeeperAssess:false`.
4. `afterPack.js`: replace `adhocResign(newAppPath)` (line 145 / helper 67-73) with cert signing (`--force --sign MeetingTranscriberDevSelfHosted --keychain <dev keychain> --entitlements <engine plist>`, no `--deep`). Drop `--options runtime` to match hardenedRuntime:false.
5. Ensure the dev keychain is **unlocked** (`security unlock-keychain -p "" …`) and in the user search list **before** `npm run dist:mac`.
6. One-time per machine: `add-trusted-cert` (TouchID) to avoid right-click→Open; pre-grant TCC once. All future rebuilds keep the grant.

## Open questions / risks

- **Same cert, two keychains?** Engine repo created it in the dev keychain; electron-builder and afterPack must resolve the *same* leaf. Verify both use that keychain (search-list order) — risk of a name collision if a different cert with the same CN exists in login keychain. Prefer pinning by **leaf SHA-1** over CN where possible.
- **hardenedRuntime regime must match** between outer Mintr.app and inner MintrEngine.app; mismatched `--options runtime` can cause `-67062`/library-validation launch failures. Decide once (recommend off for Tier 1).
- **electron-builder `--deep` vs explicit**: confirm electron-builder doesn't itself `--deep` re-sign the engine and clobber our entitlements; if it does, our afterPack entitlements survive only because the inner bundle is sealed by reference. Validate `codesign -dv MintrEngine.app` post-build shows the cert authority + audio entitlement.
- **TCC principal**: afterPack changes the engine bundle id to `ai.nawaz.mintr-engine`; the stable cert DR is what TCC keys on — verify the grant survives a rebuild via `tccd` logs (the original symptom).
- **Trust step is interactive** (TouchID) — cannot be done over SSH; fine for the user's own machine, blocker for headless CI (setup script already documents this at lines 152-173).
