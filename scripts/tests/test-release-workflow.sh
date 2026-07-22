#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
VALIDATE_REF="$ROOT/scripts/release/validate-ref.sh"
PUBLISH="$ROOT/scripts/release/publish.sh"
WORKFLOW="$ROOT/.github/workflows/release.yml"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "test-release-workflow: $*" >&2
  exit 1
}

expect_failure() {
  local label=$1
  shift
  if "$@" >"$TEMP_DIR/failure.out" 2>"$TEMP_DIR/failure.err"; then
    fail "$label unexpectedly passed"
  fi
}

git init --bare "$TEMP_DIR/origin.git" >/dev/null
git init "$TEMP_DIR/repo" >/dev/null
git -C "$TEMP_DIR/repo" config user.name 'Release Test'
git -C "$TEMP_DIR/repo" config user.email 'release-test@example.invalid'
git -C "$TEMP_DIR/repo" branch -M main
printf '{"version":"0.40.4"}\n' >"$TEMP_DIR/repo/package.json"
git -C "$TEMP_DIR/repo" add package.json
git -C "$TEMP_DIR/repo" commit -m 'release base' >/dev/null
release_commit=$(git -C "$TEMP_DIR/repo" rev-parse HEAD)
git -C "$TEMP_DIR/repo" tag v0.40.4
git -C "$TEMP_DIR/repo" remote add origin "$TEMP_DIR/origin.git"
git -C "$TEMP_DIR/repo" push -u origin main refs/tags/v0.40.4 >/dev/null
git -C "$TEMP_DIR/repo" fetch origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null

(
  cd "$TEMP_DIR/repo"
  RELEASE_TAG=v0.40.4 "$VALIDATE_REF"
) >/dev/null || fail 'exact release tag did not validate'

git -C "$TEMP_DIR/repo" switch -c v0.40.4 >/dev/null
printf 'branch collision\n' >"$TEMP_DIR/repo/collision.txt"
git -C "$TEMP_DIR/repo" add collision.txt
git -C "$TEMP_DIR/repo" commit -m 'colliding branch' >/dev/null
git -C "$TEMP_DIR/repo" push origin refs/heads/v0.40.4 >/dev/null
expect_failure 'same-named branch checkout' bash -c \
  'cd "$1" && RELEASE_TAG=v0.40.4 "$2"' _ "$TEMP_DIR/repo" "$VALIDATE_REF"

git -C "$TEMP_DIR/repo" switch main >/dev/null
printf 'approved follow-up\n' >"$TEMP_DIR/repo/approved.txt"
git -C "$TEMP_DIR/repo" add approved.txt
git -C "$TEMP_DIR/repo" commit -m 'approved follow-up' >/dev/null
approved_commit=$(git -C "$TEMP_DIR/repo" rev-parse HEAD)
git -C "$TEMP_DIR/repo" push origin main >/dev/null
git -C "$TEMP_DIR/repo" tag -f v0.40.4 "$approved_commit" >/dev/null
git -C "$TEMP_DIR/repo" fetch origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null
expect_failure 'tag movement after validation' bash -c \
  'cd "$1" && RELEASE_TAG=v0.40.4 EXPECTED_RELEASE_COMMIT="$3" "$2"' \
  _ "$TEMP_DIR/repo" "$VALIDATE_REF" "$release_commit"

git -C "$TEMP_DIR/repo" switch -c unreviewed "$release_commit" >/dev/null
printf 'unreviewed\n' >"$TEMP_DIR/repo/unreviewed.txt"
git -C "$TEMP_DIR/repo" add unreviewed.txt
git -C "$TEMP_DIR/repo" commit -m 'unreviewed release' >/dev/null
unreviewed_commit=$(git -C "$TEMP_DIR/repo" rev-parse HEAD)
git -C "$TEMP_DIR/repo" tag -f v0.40.4 "$unreviewed_commit" >/dev/null
expect_failure 'tag outside approved main' bash -c \
  'cd "$1" && RELEASE_TAG=v0.40.4 "$2"' _ "$TEMP_DIR/repo" "$VALIDATE_REF"

validation_block=$(sed -n '/^  validate-release:/,/^  package-and-release:/p' "$WORKFLOW")
package_block=$(sed -n '/^  package-and-release:/,$p' "$WORKFLOW")
! grep -Fq '${{ secrets.' <<<"$validation_block" || fail 'no-secret job references secrets'
grep -Fq 'contents: read' <<<"$validation_block" || fail 'validation job is not read-only'
grep -Fq 'EVENT_REF_TYPE' <<<"$validation_block" || fail 'manual dispatch ref type is not checked'
grep -Fq '"refs/tags/$release_tag"' <<<"$validation_block" ||
  fail 'manual dispatch is not bound to its exact tag ref'
grep -Fq 'environment:' <<<"$package_block" || fail 'signing job has no protected environment'
grep -Fq 'name: release' <<<"$package_block" || fail 'signing job is not bound to release'
grep -Fq 'contents: write' <<<"$package_block" || fail 'publication job lacks scoped write access'
[[ $(grep -Fc 'bash scripts/release/validate-ref.sh' <<<"$package_block") -eq 2 ]] ||
  fail 'credential job does not revalidate before credentials and publication'

FAKE_BIN="$TEMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

echo "$*" >>"$FAKE_GH_LOG"
command_name="${1:-} ${2:-}"
shift 2 || true

case "$command_name" in
  'release view')
    if [[ "$FAKE_GH_SCENARIO" == public ]]; then
      printf '{"isDraft":false,"assets":[]}\n'
      exit 0
    fi
    if [[ ! -f "$FAKE_GH_STATE" ]]; then
      exit 1
    fi
    state=$(cat "$FAKE_GH_STATE")
    if [[ "$state" != uploaded ]]; then
      printf '{"isDraft":true,"assets":[]}\n'
      exit 0
    fi
    dmg_size=$(wc -c <"$FAKE_GH_DMG" | tr -d '[:space:]')
    zip_size=$(wc -c <"$FAKE_GH_ZIP" | tr -d '[:space:]')
    if [[ "$FAKE_GH_SCENARIO" == mismatch ]]; then
      dmg_size=$((dmg_size - 1))
    fi
    asset_state=uploaded
    if [[ "$FAKE_GH_SCENARIO" == pending ]]; then
      asset_state=new
    fi
    printf '{"isDraft":true,"assets":[{"name":"%s","size":%s,"state":"%s"},{"name":"%s","size":%s,"state":"uploaded"}]}\n' \
      "$(basename "$FAKE_GH_DMG")" "$dmg_size" "$asset_state" \
      "$(basename "$FAKE_GH_ZIP")" "$zip_size"
    ;;
  'release create')
    printf 'draft\n' >"$FAKE_GH_STATE"
    ;;
  'release upload')
    printf 'uploaded\n' >"$FAKE_GH_STATE"
    ;;
  'release edit')
    printf 'published\n' >"$FAKE_GH_STATE"
    ;;
  *)
    echo "unexpected fake gh command: $command_name" >&2
    exit 2
    ;;
esac
FAKE_GH
chmod +x "$FAKE_BIN/gh"

DMG="$TEMP_DIR/Timbre-0.40.4-arm64.dmg"
ZIP="$TEMP_DIR/Timbre-0.40.4-arm64.zip"
printf 'verified dmg bytes\n' >"$DMG"
printf 'verified zip bytes with a different size\n' >"$ZIP"

run_publish() {
  local scenario=$1
  local state=$2
  local log=$3
  FAKE_GH_SCENARIO=$scenario \
    FAKE_GH_STATE=$state \
    FAKE_GH_LOG=$log \
    FAKE_GH_DMG=$DMG \
    FAKE_GH_ZIP=$ZIP \
    PATH="$FAKE_BIN:$PATH" \
    "$PUBLISH" v0.40.4 0.40.4 "$DMG" "$ZIP"
}

public_state="$TEMP_DIR/public.state"
public_log="$TEMP_DIR/public.log"
if run_publish public "$public_state" "$public_log" >"$TEMP_DIR/public.out" 2>"$TEMP_DIR/public.err"; then
  fail 'publisher mutated an already-public release'
fi
! grep -Eq '^release (upload|edit)' "$public_log" || fail 'public release was mutated'

draft_state="$TEMP_DIR/draft.state"
draft_log="$TEMP_DIR/draft.log"
printf 'draft\n' >"$draft_state"
run_publish draft "$draft_state" "$draft_log" >/dev/null || fail 'hidden draft recovery failed'
grep -Fq 'release upload' "$draft_log" || fail 'draft assets were not uploaded'
grep -Fq 'release edit' "$draft_log" || fail 'verified draft was not published'

absent_state="$TEMP_DIR/absent.state"
absent_log="$TEMP_DIR/absent.log"
run_publish absent "$absent_state" "$absent_log" >/dev/null || fail 'new draft publication failed'
grep -Fq 'release create' "$absent_log" || fail 'missing release did not create a draft'

for scenario in mismatch pending; do
  state="$TEMP_DIR/$scenario.state"
  log="$TEMP_DIR/$scenario.log"
  printf 'draft\n' >"$state"
  if run_publish "$scenario" "$state" "$log" \
    >"$TEMP_DIR/$scenario.out" 2>"$TEMP_DIR/$scenario.err"; then
    fail "publisher accepted invalid remote asset state: $scenario"
  fi
  ! grep -Fq 'release edit' "$log" || fail "$scenario draft became public"
done

echo 'release workflow behavior checks passed'
