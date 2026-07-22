#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "release publication: $*" >&2
  exit 1
}

if [[ $# -ne 4 ]]; then
  fail "usage: scripts/release/publish.sh <tag> <version> <dmg-path> <zip-path>"
fi

release_tag=$1
version=$2
dmg_path=$3
zip_path=$4
expected_dmg="Timbre-${version}-arm64.dmg"
expected_zip="Timbre-${version}-arm64.zip"

[[ "$release_tag" == "v${version}" ]] || fail "tag and version do not match"
[[ -s "$dmg_path" ]] || fail "DMG is missing or empty: $dmg_path"
[[ -s "$zip_path" ]] || fail "ZIP is missing or empty: $zip_path"
[[ "$(basename "$dmg_path")" == "$expected_dmg" ]] || fail "unexpected DMG filename"
[[ "$(basename "$zip_path")" == "$expected_zip" ]] || fail "unexpected ZIP filename"

release_json=$(mktemp)
release_error=$(mktemp)
trap 'rm -f "$release_json" "$release_error"' EXIT

if gh release view "$release_tag" --json isDraft,assets >"$release_json" 2>"$release_error"; then
  is_draft=$(node -e '
    const fs = require("fs")
    const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.stdout.write(String(release.isDraft))
  ' "$release_json")
  [[ "$is_draft" == "true" ]] ||
    fail "release $release_tag is already public; create a new patch version and tag"
else
  create_args=(
    "$release_tag"
    --verify-tag
    --draft
    --title "Timbre v${version}"
    --generate-notes
  )
  if [[ "$version" == *-* ]]; then
    create_args+=(--prerelease)
  fi
  gh release create "${create_args[@]}"
fi

gh release upload "$release_tag" "$dmg_path" "$zip_path" --clobber
gh release view "$release_tag" --json isDraft,assets >"$release_json"

dmg_size=$(wc -c <"$dmg_path" | tr -d '[:space:]')
zip_size=$(wc -c <"$zip_path" | tr -d '[:space:]')
node - "$release_json" "$expected_dmg" "$dmg_size" "$expected_zip" "$zip_size" <<'NODE'
const fs = require('fs')

const [releasePath, dmgName, dmgSize, zipName, zipSize] = process.argv.slice(2)
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
const expected = new Map([
  [dmgName, Number(dmgSize)],
  [zipName, Number(zipSize)]
])

if (release.isDraft !== true) {
  throw new Error('release became public before asset validation')
}
if (!Array.isArray(release.assets) || release.assets.length !== expected.size) {
  throw new Error(`draft has ${release.assets?.length ?? 0} assets; expected exactly 2`)
}

for (const asset of release.assets) {
  if (!expected.has(asset.name)) {
    throw new Error(`draft contains unexpected asset: ${asset.name}`)
  }
  if (asset.state !== 'uploaded') {
    throw new Error(`${asset.name} is not fully uploaded: ${asset.state || 'missing state'}`)
  }
  const expectedSize = expected.get(asset.name)
  if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size !== expectedSize) {
    throw new Error(
      `${asset.name} has remote size ${asset.size}; expected non-empty local size ${expectedSize}`
    )
  }
  expected.delete(asset.name)
}
if (expected.size !== 0) {
  throw new Error(`draft is missing expected assets: ${[...expected.keys()].join(', ')}`)
}
NODE

gh release edit "$release_tag" --draft=false
echo "Published $release_tag with verified DMG and ZIP assets"
