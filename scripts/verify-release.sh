#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "verify-release: $*" >&2
  exit 1
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  fail "usage: scripts/verify-release.sh <app-path> <dmg-path> [expected-team-id]"
fi

APP_PATH=$1
DMG_PATH=$2
EXPECTED_TEAM_ID=${3:-${TEAM_ID:-}}
ENGINE_PATH="$APP_PATH/Contents/Resources/MintrEngine.app"
MT_BATCH_PATH="$APP_PATH/Contents/Resources/bin/mt-batch"

[[ -d "$APP_PATH" ]] || fail "app is missing: $APP_PATH"
[[ -d "$ENGINE_PATH" ]] || fail "engine is missing: $ENGINE_PATH"
[[ -f "$MT_BATCH_PATH" ]] || fail "mt-batch is missing: $MT_BATCH_PATH"
[[ -f "$DMG_PATH" ]] || fail "DMG is missing: $DMG_PATH"
[[ -n "$EXPECTED_TEAM_ID" ]] || fail "expected Team ID is required"

CODESIGN=/usr/bin/codesign
FILE=/usr/bin/file
FIND=/usr/bin/find
GREP=/usr/bin/grep
SED=/usr/bin/sed
SPCTL=/usr/sbin/spctl
XCRUN=/usr/bin/xcrun

signature_details() {
  "$CODESIGN" --display --verbose=4 "$1" 2>&1
}

team_id() {
  "$SED" -n 's/^TeamIdentifier=//p' <<<"$1" | /usr/bin/head -n 1
}

require_developer_id() {
  local label=$1
  local details=$2
  "$GREP" -Eq '^Authority=Developer ID Application:' <<<"$details" ||
    fail "$label is not signed by a Developer ID Application authority"
}

require_runtime_and_timestamp() {
  local label=$1
  local details=$2
  "$GREP" -Eq '^CodeDirectory .*flags=.*runtime' <<<"$details" ||
    fail "$label does not have the hardened runtime flag"
  "$GREP" -Eq '^Timestamp=.+$' <<<"$details" || fail "$label has no secure timestamp"
  ! "$GREP" -Eq '^Timestamp=none$' <<<"$details" || fail "$label has no secure timestamp"
}

"$CODESIGN" --verify --deep --strict --verbose=4 "$APP_PATH"

if ! outer_details=$(signature_details "$APP_PATH"); then
  fail "could not read the outer app signature"
fi
if ! engine_details=$(signature_details "$ENGINE_PATH"); then
  fail "could not read the engine signature"
fi

require_developer_id "outer app" "$outer_details"
require_developer_id "engine" "$engine_details"

outer_team=$(team_id "$outer_details")
engine_team=$(team_id "$engine_details")
[[ -n "$outer_team" ]] || fail "outer app Team ID is empty"
[[ -n "$engine_team" ]] || fail "engine Team ID is empty"
[[ "$outer_team" == "$EXPECTED_TEAM_ID" ]] ||
  fail "outer app Team ID does not match the expected Team ID"
[[ "$engine_team" == "$outer_team" ]] || fail "engine Team ID does not match the outer app"

macho_count=0
while IFS= read -r -d '' candidate; do
  case "$("$FILE" -b "$candidate")" in
    *Mach-O*)
      macho_count=$((macho_count + 1))
      if ! candidate_details=$(signature_details "$candidate"); then
        fail "could not read the signature for executable Mach-O: $candidate"
      fi
      require_runtime_and_timestamp "$candidate" "$candidate_details"
      ;;
  esac
done < <("$FIND" "$APP_PATH" -type f -perm -111 -print0)
[[ $macho_count -gt 0 ]] || fail "no executable Mach-O files were found in the app"

"$XCRUN" stapler validate "$APP_PATH"

"$CODESIGN" --verify --strict --verbose=4 "$DMG_PATH"
if ! dmg_details=$(signature_details "$DMG_PATH"); then
  fail "could not read the DMG signature"
fi
require_developer_id "DMG" "$dmg_details"
"$GREP" -Eq '^Timestamp=.+$' <<<"$dmg_details" || fail "DMG has no secure timestamp"
! "$GREP" -Eq '^Timestamp=none$' <<<"$dmg_details" || fail "DMG has no secure timestamp"
"$XCRUN" stapler validate "$DMG_PATH"

if ! gatekeeper_output=$("$SPCTL" --assess --type execute --verbose=4 "$APP_PATH" 2>&1); then
  echo "$gatekeeper_output" >&2
  fail "Gatekeeper rejected the app"
fi
"$GREP" -Fq 'accepted' <<<"$gatekeeper_output" || fail "Gatekeeper did not report accepted"
"$GREP" -Fq 'source=Notarized Developer ID' <<<"$gatekeeper_output" ||
  fail "Gatekeeper source is not Notarized Developer ID"

echo "verify-release: passed for Team ID $EXPECTED_TEAM_ID"
