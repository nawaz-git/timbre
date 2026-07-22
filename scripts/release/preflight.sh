#!/usr/bin/env bash

set -euo pipefail

required=(
  DEVELOPER_ID_CERT
  DEVELOPER_ID_CERT_PASSWORD
  DEVELOPER_ID
  APPLE_ID
  TEAM_ID
  APP_PASSWORD
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "release preflight: $name is required" >&2
    exit 1
  fi
done

case "$DEVELOPER_ID" in
  "Developer ID Application: "*) ;;
  *)
    echo "release preflight: DEVELOPER_ID must begin with 'Developer ID Application: '" >&2
    exit 1
    ;;
esac

echo "Release credential preflight passed"
