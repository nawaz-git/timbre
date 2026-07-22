#!/usr/bin/env bash

set -euo pipefail

keychain=${1:?keychain path required}
lockfile="${TMPDIR:-/tmp}/keychain-search-list.lock"
acquired=false

for _ in $(seq 1 100); do
    if shlock -f "$lockfile" -p $$ >/dev/null 2>&1; then
        trap 'rm -f "$lockfile"' EXIT
        acquired=true
        break
    fi
    sleep 0.05
done

if [[ "$acquired" != true ]]; then
    echo "keychain-prepend: failed to acquire $lockfile within 5 s" >&2
    exit 1
fi

existing=()
while IFS= read -r entry; do
    existing+=("$entry")
done < <(
    security list-keychains -d user \
        | awk -v skip="$keychain" '
            {
                gsub(/^[[:space:]]+|[[:space:]]+$/, "")
                gsub(/^"|"$/, "")
                if ($0 != "" && $0 != skip) print
            }
        '
)

security list-keychains -d user -s "$keychain" "${existing[@]+"${existing[@]}"}"
