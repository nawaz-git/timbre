#!/usr/bin/env bash
# setup-signing.sh — create a STABLE self-signed code-signing identity for
# Mintr dev builds. Run ONCE per machine (TouchID / keychain auth happens
# here — this is the only human-gated step in the whole signing flow).
#
# WHAT THIS DOES / WHY:
#   Ad-hoc signing (`codesign --sign -`) gives every rebuild a brand-new
#   code-directory hash (cdhash). macOS TCC binds an ad-hoc app's permission
#   grant to its exact cdhash, so every rebuild silently invalidates Screen
#   Recording / Microphone / Accessibility — the cause of the v0.12→v0.22
#   re-grant loop. A STABLE signing identity makes the cdhash-independent
#   Designated Requirement constant across rebuilds, so grants persist.
#
#   This script creates a self-signed cert "Mintr Dev Signing" in a
#   dedicated keychain with a script-known password, so codesign can use the
#   key non-interactively on every build. Once you've run it and exported
#   MINTR_SIGN_IDENTITY, both the engine build (build_release.sh) and the
#   electron-builder pipeline (electron-builder.config.js + afterPack.js)
#   sign with this same identity.
#
#   Self-signed is enough for YOUR OWN machine: TCC keys off the cert's
#   designated requirement, which is stable. It is NOT trusted by Gatekeeper,
#   so a DMG-delivered build may need a one-time right-click → Open on first
#   launch (acceptable for the dev tier; Developer ID + notarization is a
#   separate prod ticket).
#
# RE-RUNNING IS SAFE (idempotent): if the identity already exists, this is a
#   no-op and just prints the export line again.

set -euo pipefail

# Cert common-name MUST stay stable across machines/rebuilds — TCC + the
# build scripts key off this exact string via $MINTR_SIGN_IDENTITY.
CERT_NAME="Mintr Dev Signing"
CERT_ORG="mintr-dev-signing"

# Dedicated keychain with a script-known password keeps everything
# non-interactive after this one-time setup:
#   - `-A` ACL imports don't re-prompt
#   - `set-key-partition-list -k "$PASS"` succeeds without a GUI prompt
# A dedicated keychain (vs login) also avoids polluting the user's login
# keychain and makes teardown a single `security delete-keychain`.
DEV_KEYCHAIN="$HOME/Library/Keychains/mintr-dev.keychain-db"
DEV_KEYCHAIN_PASS="mintr-dev"

log()  { printf '[setup-signing] %s\n' "$*"; }
fail() { printf '[setup-signing] FAIL: %s\n' "$*" >&2; exit 1; }

print_export_line() {
    cat <<MSG

[setup-signing] DONE. ✓  Stable identity ready: "$CERT_NAME"

Add this to your shell profile (~/.zshrc) or the repo's .env, then re-open
your shell (or \`source\` it) before building:

  export MINTR_SIGN_IDENTITY="$CERT_NAME"

With it exported:
  - Engine:   MINTR_SIGN_IDENTITY="$CERT_NAME" ./scripts/build_release.sh --no-notarize
  - Mintr:    MINTR_SIGN_IDENTITY="$CERT_NAME" npm run dist:mac

Verify after a build:
  codesign -dvvv "<...>/MintrEngine.app" 2>&1 | grep Authority
  # → Authority=$CERT_NAME   (NOT "Signed with ad-hoc")

First launch of a DMG-delivered build may need right-click → Open once
(self-signed cert is not Gatekeeper-trusted). After that, TCC grants
persist across every rebuild signed with this identity.
MSG
}

# --- idempotency check ---------------------------------------------------
# If the identity is already present in the dev keychain, do nothing but
# re-print the export line. `find-identity -p codesigning` (no -v) lists
# untrusted identities too, which is what we have here.
if [ -f "$DEV_KEYCHAIN" ] \
    && security find-identity -p codesigning "$DEV_KEYCHAIN" 2>/dev/null \
        | grep -q "$CERT_NAME"; then
    log "Identity '$CERT_NAME' already exists in $DEV_KEYCHAIN — nothing to do."
    # Make sure it's unlocked + searchable for this session's convenience.
    security unlock-keychain -p "$DEV_KEYCHAIN_PASS" "$DEV_KEYCHAIN" 2>/dev/null || true
    print_export_line
    exit 0
fi

# --- create the cert -----------------------------------------------------
log "Creating self-signed code-signing identity '$CERT_NAME'"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# These THREE extensions are what make the cert usable for code signing on
# macOS 26. EKU codeSigning alone is NOT sufficient — find-identity reports
# "Invalid Key Usage for policy" and codesign refuses with "no identity
# found". `keyUsage = digitalSignature` is required by Apple's code-signing
# policy (CSSMERR_TP_INVALID_CERTIFICATE without it); basicConstraints
# CA:false marks it a leaf. (Mirrors the engine's setup-self-hosted-runner.sh.)
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=$CERT_NAME/O=$CERT_ORG" \
    -keyout "$TMPD/cert.key" -out "$TMPD/cert.crt" \
    -addext "keyUsage = critical, digitalSignature" \
    -addext "extendedKeyUsage = critical, codeSigning" \
    -addext "basicConstraints = critical, CA:false" >/dev/null 2>&1 \
    || fail "openssl req failed"

# `-legacy` keeps the PKCS#12 in the older format the macOS keychain
# accepts; without it, import fails with "MAC verification failed".
openssl pkcs12 -export -legacy \
    -inkey "$TMPD/cert.key" -in "$TMPD/cert.crt" \
    -name "$CERT_NAME" -passout pass:"$DEV_KEYCHAIN_PASS" -out "$TMPD/cert.p12" \
    || fail "openssl pkcs12 failed"

# --- create / refresh the dedicated keychain -----------------------------
if [ -f "$DEV_KEYCHAIN" ]; then
    log "Removing stale dev keychain at $DEV_KEYCHAIN"
    security delete-keychain "$DEV_KEYCHAIN" 2>/dev/null || true
fi
log "Creating dedicated keychain at $DEV_KEYCHAIN"
security create-keychain -p "$DEV_KEYCHAIN_PASS" "$DEV_KEYCHAIN"
# Disable auto-relock so codesign in long builds never hits a locked keychain.
security set-keychain-settings "$DEV_KEYCHAIN"
security unlock-keychain -p "$DEV_KEYCHAIN_PASS" "$DEV_KEYCHAIN"

# Add to the user-domain keychain search list so codesign + find-identity
# actually look there. `list-keychains -s` REPLACES the list, so read the
# existing entries, drop our own (dedup), and prepend.
log "Prepending $DEV_KEYCHAIN to the user keychain search list"
existing=()
while IFS= read -r entry; do
    existing+=("$entry")
done < <(
    security list-keychains -d user \
        | awk -v skip="$DEV_KEYCHAIN" '
            {
                gsub(/^[[:space:]]+|[[:space:]]+$/, "")
                gsub(/^"|"$/, "")
                if ($0 != "" && $0 != skip) print
            }
        '
)
security list-keychains -d user -s "$DEV_KEYCHAIN" "${existing[@]+"${existing[@]}"}"

log "Importing cert into dev keychain"
security import "$TMPD/cert.p12" \
    -k "$DEV_KEYCHAIN" -P "$DEV_KEYCHAIN_PASS" -A -t agg \
    || fail "security import failed"

# Let codesign + apple tools use the private key without prompting on every
# build. -s allows any application; -S scopes to the listed tool partitions.
log "Setting partition list (codesign + apple tools)"
security set-key-partition-list \
    -S "apple-tool:,apple:,codesign:" \
    -s -k "$DEV_KEYCHAIN_PASS" "$DEV_KEYCHAIN" >/dev/null \
    || fail "set-key-partition-list failed"

rm -rf "$TMPD"
trap - EXIT

log "Created identity '$CERT_NAME' in $DEV_KEYCHAIN"
print_export_line
