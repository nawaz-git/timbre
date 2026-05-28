# TICKET-SIGN-001 — Stable code signing (the re-grant loop-breaker)

**Source**: REQ-001 §Deliverable A · `dev/qa/qa-sign-001-*.md`
**Branch**: `v23-sign`
**Lane**: build config + scripts (both repos). NO renderer/main TS logic.

## Why
Ad-hoc signing (`codesign --sign -`) gives every rebuild a new cdhash;
macOS TCC binds an ad-hoc app's grant to its cdhash, so every rebuild
silently invalidates Screen Recording / Mic / Accessibility. A STABLE
signing identity makes the Designated Requirement constant across
rebuilds → grants persist. (Confirmed root cause of the whole re-grant
loop the user hit v0.12-v0.22.)

## Design: env-var-driven identity, with a one-command setup script

Do NOT hardcode a cert or require the cert to exist at build time. Make
signing **opt-in via an env var** so CI/other devs still build ad-hoc,
and the user enables stable signing by running one script once.

### 1. `dev/scripts/setup-signing.sh` (NEW — Electron repo)
A self-contained script that creates a stable self-signed codesigning
identity the user runs ONCE (TouchID/keychain auth happens here, the
only human-gated step). Model it on the engine repo's
`/Users/nawazpasha/Projects/meeting-transcriber/scripts/setup-self-hosted-runner.sh`
cert-creation portion (read it — it already solves the macOS 26 "Invalid
Key Usage for policy" gotcha via the right extended-key-usage on the
cert). Requirements:
- Cert common-name: `Mintr Dev Signing` (stable).
- Create in a dedicated keychain `mintr-dev.keychain-db` with a
  script-known password (so partition-list is non-interactive), OR the
  login keychain if simpler — match whatever the engine script proved
  works on macOS 26.
- `security set-key-partition-list -S "apple-tool:,apple:,codesign:"`
  so codesign uses the key without prompting on every build.
- Print, at the end, the line the user should add to their shell or a
  `.env`: `export MINTR_SIGN_IDENTITY="Mintr Dev Signing"`.
- Idempotent: if the identity already exists, no-op + print the export line.
- Print clear "what this does / why" header comment.

### 2. Electron `electron-builder.yml`
- Change `mac.identity: null` → read from env: keep `null` as the
  default, but document that when `MINTR_SIGN_IDENTITY` is set, the
  build must sign with it. electron-builder reads `mac.identity` at
  config-eval time — since the yml is static, use electron-builder's
  support for `${env.MINTR_SIGN_IDENTITY}` interpolation if available, OR
  switch to a JS config (`electron-builder.config.js`) that reads
  `process.env.MINTR_SIGN_IDENTITY || null`. Pick whichever is cleanest;
  JS config is the robust choice.
- When signing with a self-signed (not Developer ID) identity, set
  `hardenedRuntime: false`. Hardened runtime + self-signed + the engine's
  JIT/unsigned-exec-memory entitlements = launch failure (`qa-sign`
  finding). Gate hardenedRuntime on whether the identity is a Developer
  ID (heuristic: identity string starts with "Developer ID"). For the
  self-signed dev tier → false.

### 3. Electron `scripts/afterPack.js`
- Currently re-signs the renamed `MintrEngine.app` with
  `codesign --force --deep --sign -` (ad-hoc). Change to sign with
  `process.env.MINTR_SIGN_IDENTITY` when set (`--sign "$IDENTITY"`),
  else keep ad-hoc `--sign -`. Drop `--options runtime` when self-signed.
  Keep `--preserve-metadata=entitlements`.

### 4. Engine `build_release.sh` (meeting-transcriber repo)
- It already signs with `$SIGN_HASH` from `security find-identity -v
  -p codesigning` (trusted identities only), else ad-hoc. A self-signed
  cert may not appear under `-v` (valid/trusted) until trusted. Add
  support for an explicit `MINTR_SIGN_IDENTITY` env override that signs
  with that identity by NAME (`codesign --sign "$NAME"`), bypassing the
  find-identity trust filter. Keep existing behavior when the env var is
  unset. Do NOT change the Developer ID path.

## Acceptance
With `MINTR_SIGN_IDENTITY="Mintr Dev Signing"` exported:
1. `./scripts/setup-signing.sh` creates the identity (one-time).
2. Build engine (`MINTR_SIGN_IDENTITY=... ./scripts/build_release.sh --no-notarize`).
3. Build Mintr (`MINTR_SIGN_IDENTITY=... npm run dist:mac`).
4. `codesign -dvvv` on MintrEngine.app shows `Authority=Mintr Dev Signing`
   (not "Signed with ad-hoc").
5. Rebuild Mintr a SECOND time. The cdhash of MintrEngine changes but the
   Authority stays "Mintr Dev Signing" → TCC grants set after build #1
   still apply after build #2 (verify: engine `/tmp/mt-permission.log`
   shows `screen=healthy` on build #2 WITHOUT re-granting).

## Out of scope
- Developer ID + notarization (separate prod ticket).
- Trusting the cert in the System store (Gatekeeper) — first launch may
  need right-click→Open; acceptable for dev tier. Document it.
