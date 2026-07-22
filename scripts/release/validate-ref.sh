#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "release ref validation: $*" >&2
  exit 1
}

release_tag=${1:-${RELEASE_TAG:-}}
expected_commit=${2:-${EXPECTED_RELEASE_COMMIT:-}}
main_ref=${RELEASE_MAIN_REF:-refs/remotes/origin/main}

[[ -n "$release_tag" ]] || fail "RELEASE_TAG is required"
[[ "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] ||
  fail "tag is not a valid v-prefixed semantic version: $release_tag"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository"
cd "$repo_root"

tag_ref="refs/tags/$release_tag"
git show-ref --verify --quiet "$tag_ref" || fail "exact tag ref does not exist: $tag_ref"

head_commit=$(git rev-parse --verify 'HEAD^{commit}') || fail "HEAD is not a commit"
tag_commit=$(git rev-parse --verify "$tag_ref^{commit}") || fail "tag does not peel to a commit: $tag_ref"
[[ "$head_commit" == "$tag_commit" ]] ||
  fail "HEAD $head_commit does not match peeled tag commit $tag_commit"

if [[ -n "$expected_commit" ]]; then
  validated_commit=$(git rev-parse --verify "$expected_commit^{commit}") ||
    fail "expected release commit is invalid: $expected_commit"
  [[ "$tag_commit" == "$validated_commit" ]] ||
    fail "tag commit $tag_commit changed from validated commit $validated_commit"
fi

main_commit=$(git rev-parse --verify "$main_ref^{commit}") ||
  fail "approved main ref does not exist: $main_ref"
git merge-base --is-ancestor "$tag_commit" "$main_commit" ||
  fail "tag commit $tag_commit is not contained in approved main $main_commit"

package_version=$(node -p "require(process.argv[1]).version" "$repo_root/package.json")
[[ "$release_tag" == "v${package_version}" ]] ||
  fail "tag $release_tag does not match package version v${package_version}"

echo "Release ref validated: $tag_ref -> $tag_commit"
