#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

fail() {
  echo "test-release-signing: $*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local text=$2
  /usr/bin/grep -Fq -- "$text" "$file" || fail "$file is missing: $text"
}

assert_not_contains() {
  local file=$1
  local text=$2
  ! /usr/bin/grep -Fq -- "$text" "$file" || fail "$file unexpectedly contains: $text"
}

line_number() {
  /usr/bin/grep -nF -- "$2" "$1" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1
}

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
cp electron-builder.js "$TEMP_DIR/electron-builder.js"

if TIMBRE_RELEASE=1 MINTR_SIGN_IDENTITY='Mintr Dev Signing' \
  node -e "require(process.argv[1])" "$TEMP_DIR/electron-builder.js" \
  >"$TEMP_DIR/invalid-identity.out" 2>"$TEMP_DIR/invalid-identity.err"; then
  fail "production accepted a non-Developer-ID identity"
fi
assert_contains "$TEMP_DIR/invalid-identity.err" 'Developer ID Application:'

if TIMBRE_RELEASE=1 MINTR_SIGN_IDENTITY='Developer ID Application: Test (TEAMID)' \
  node -e "require(process.argv[1])" "$TEMP_DIR/electron-builder.js" \
  >"$TEMP_DIR/missing-inputs.out" 2>"$TEMP_DIR/missing-inputs.err"; then
  fail "production accepted missing engine inputs"
fi
assert_contains "$TEMP_DIR/missing-inputs.err" 'MeetingTranscriber.app'
assert_contains "$TEMP_DIR/missing-inputs.err" 'mt-batch'

mkdir -p "$TEMP_DIR/meeting-transcriber/tools/mt-batch/.build/release"
mkdir -p "$TEMP_DIR/meeting-transcriber/.build/release/MeetingTranscriber.app"
touch "$TEMP_DIR/meeting-transcriber/tools/mt-batch/.build/release/mt-batch"

TIMBRE_RELEASE=1 MINTR_SIGN_IDENTITY='Developer ID Application: Test (TEAMID)' \
  node -e '
    const config = require(process.argv[1])
    if (config.mac.hardenedRuntime !== true) process.exit(1)
    if (config.afterSign !== "scripts/notarize.js") process.exit(1)
  ' "$TEMP_DIR/electron-builder.js" || fail "production configuration is not hardened"

for selector in '' true 01 yes; do
  TIMBRE_RELEASE=$selector MINTR_HARDENED_RUNTIME=1 MINTR_SIGN_IDENTITY='Mintr Dev Signing' \
    node -e '
      const config = require(process.argv[1])
      if (config.mac.hardenedRuntime !== false) process.exit(1)
    ' "$TEMP_DIR/electron-builder.js" || fail "development selector '$selector' became hardened"
done

assert_contains scripts/afterPack.js "return process.env.TIMBRE_RELEASE === '1'"
assert_contains scripts/afterPack.js 'const hardened = isProduction'
assert_not_contains scripts/afterPack.js 'MINTR_HARDENED_RUNTIME'
assert_contains scripts/afterPack.js "args.push('--preserve-metadata=entitlements')"
assert_contains scripts/afterPack.js 'requireProductionResources(oldAppPath, newAppPath, mtBatchPath)'

l0=$(line_number scripts/afterPack.js "console.log('[afterPack] L0:")
l1=$(line_number scripts/afterPack.js "console.log('[afterPack] L1:")
l2=$(line_number scripts/afterPack.js "console.log('[afterPack] L2:")
l3=$(line_number scripts/afterPack.js "console.log('[afterPack] L3:")
l4=$(line_number scripts/afterPack.js 'console.log(`[afterPack] L4:')
[[ -n "$l0" && -n "$l1" && -n "$l2" && -n "$l3" && -n "$l4" ]] ||
  fail 'one or more signing levels are missing'
((l0 < l1 && l1 < l2 && l2 < l3 && l3 < l4)) || fail 'L0-L4 signing order changed'

for file in scripts/notarize.js scripts/notarize-dmg.js; do
  assert_contains "$file" "'notarytool'"
  assert_contains "$file" "'--wait'"
  assert_contains "$file" "result.status !== 'Accepted'"
  assert_contains "$file" "['stapler', 'staple'"
  assert_contains "$file" "['stapler', 'validate'"
done

for text in \
  '"$CODESIGN" --verify --deep --strict' \
  '^Authority=Developer ID Application:' \
  'Team ID is empty' \
  'flags=.*runtime' \
  '^Timestamp=' \
  'stapler validate' \
  '--type execute' \
  'source=Notarized Developer ID'; do
  assert_contains scripts/verify-release.sh "$text"
done

if /usr/bin/grep -Eiq -- \
  '--appstore|com\.apple\.security\.app-sandbox|xattr.*quarantine|spctl.*disable' \
  electron-builder.js scripts/afterPack.js scripts/notarize.js scripts/notarize-dmg.js \
  scripts/verify-release.sh .github/workflows/release.yml; then
  fail 'production lane contains an App Store or Gatekeeper-bypass path'
fi

bash scripts/tests/test-release-workflow.sh

echo 'release signing regression checks passed'
