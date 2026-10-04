#!/usr/bin/env bash
# Make a release tag:  ./scripts/tag-release.sh 0.1.0-rc.6
#
# A downloaded release installs the ready-made images because its VERSION file holds the version (the development branch has "local" there
# and builds from source). So the tag points at a commit made on the side with VERSION set; your branch is not changed, and nothing is
# pushed. Push the tag yourself when you are ready:  git push origin v0.1.0-rc.6
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "Usage: $0 VERSION   (for example 0.1.0 or 0.1.0-rc.6)" >&2
  exit 2
fi
tag="v$version"
if ! git diff --quiet || ! git diff --cached --quiet; then echo "Commit or stash your changes first." >&2; exit 1; fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists." >&2; exit 1; fi

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "HEAD" ] && { echo "Check out a branch first." >&2; exit 1; }
git checkout -q --detach
printf '%s\n' "$version" > VERSION
git add VERSION
git commit -q -m "Release $version"
git tag -a "$tag" -m "$tag"
git checkout -q "$branch"
echo "Created $tag with VERSION=$version. $branch is unchanged ($(cat VERSION))."
echo "Push it with:  git push origin $tag"
