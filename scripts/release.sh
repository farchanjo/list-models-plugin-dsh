#!/usr/bin/env bash
# Cut a release: bump, check, tag, publish the tarball to GitHub Releases.
#
# Distribution is GitHub Releases only. Nothing here is published to npm.
# The tarball in the release is the install unit; consumers pin its URL.
#
#   ./scripts/release.sh [patch|minor|major]     # default: patch
#
# Refuses to run on a dirty tree, off main, or behind origin.
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "usage: $0 [patch|minor|major]" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."
NAME="$(node -p 'require("./package.json").name')"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

[ "$BRANCH" = "main" ] || {
  echo "release from main, not '$BRANCH'" >&2
  exit 1
}
[ -z "$(git status --porcelain)" ] || {
  echo "working tree is not clean" >&2
  exit 1
}
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "local main is not origin/main" >&2
  exit 1
}

if [ -f pnpm-lock.yaml ]; then
  pnpm install --ignore-scripts --frozen-lockfile
fi
if node -p 'process.exit(require("./package.json").scripts?.test ? 0 : 1)'; then
  node --test "test/*.test.js"
fi
if node -p 'process.exit(require("./package.json").scripts?.lint ? 0 : 1)'; then
  npx --no-install biome check lib test
fi

npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"

# dsh-plugin.json mirrors the package version; the mount rejects a mismatch.
node -e '
  const fs = require("node:fs");
  const path = "dsh-plugin.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.version = process.argv[1];
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$VERSION"

git add package.json dsh-plugin.json
[ -f pnpm-lock.yaml ] && git add pnpm-lock.yaml
git commit -q -m "chore(release): $TAG"
git tag -a "$TAG" -m "$TAG"
git push -q origin main
git push -q origin "$TAG"

DIST="$(mktemp -d)"
trap 'rm -rf "$DIST"' EXIT
npm pack --pack-destination "$DIST" >/dev/null
ASSET="$DIST/$NAME-$VERSION.tgz"
( cd "$DIST" && (sha256sum "$NAME-$VERSION.tgz" 2>/dev/null || shasum -a 256 "$NAME-$VERSION.tgz") >"$NAME-$VERSION.tgz.sha256" )

URL="https://github.com/farchanjo/$NAME/releases/download/$TAG/$NAME-$VERSION.tgz"
NOTES="$DIST/notes.md"
{
  node -p 'require("./package.json").description'
  printf '\n## Install\n\n```sh\ndsh plugin --profile <profile> add %s\n```\n' "$URL"
  printf '\n## Verify\n\n```\n'
  cat "$DIST/$NAME-$VERSION.tgz.sha256"
  printf '```\n\nFull documentation: https://github.com/farchanjo/%s#readme\n' "$NAME"
} >"$NOTES"

gh release create "$TAG" -R "farchanjo/$NAME" --target "$(git rev-parse HEAD)" \
  --title "$TAG" --notes-file "$NOTES" "$ASSET" "$ASSET.sha256"

echo "released $TAG"
