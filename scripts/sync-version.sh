#!/usr/bin/env bash
# sync-version.sh — read VERSION and patch the three JSON files to match.
# Called by the pre-commit hook. Can also be run manually.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION="$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')"

if [[ -z "$VERSION" ]]; then
  echo "ERROR: VERSION file is empty" >&2
  exit 1
fi

# Portable in-place sed (macOS + Linux)
_sed_i() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# package.json — top-level "version"
_sed_i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/package.json"

# .claude-plugin/plugin.json — top-level "version"
_sed_i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/.claude-plugin/plugin.json"

# .claude-plugin/marketplace.json — two "version" fields
_sed_i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/g" "$REPO_ROOT/.claude-plugin/marketplace.json"

# Stage the updated files so the commit includes them
git add \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/.claude-plugin/plugin.json" \
  "$REPO_ROOT/.claude-plugin/marketplace.json"

echo "Synced version → $VERSION"
