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

# Pre-edit guard: bail before any sed if a target file still has unresolved
# git merge-conflict markers. Without this, sync-version.sh happily writes a
# corrupted "version" line into a half-merged JSON file and stages it — which
# is exactly how 0.10.61 (5fbd80d) shipped a hotfix to strip markers post-hoc
# instead of preventing them. Anchor at start-of-line so legitimate `=======`
# inside string content can't false-positive (the three JSON targets never
# legitimately contain those marker patterns at column 0).
_check_no_conflict_markers() {
  local file="$1"
  if [[ ! -f "$file" ]]; then return 0; fi
  local hit
  hit="$(grep -nE '^(<{7}|={7}|>{7})( |$)' "$file" || true)"
  if [[ -n "$hit" ]]; then
    echo "ERROR: Unresolved git merge-conflict markers in $file:" >&2
    echo "$hit" | sed "s|^|  $file:|" >&2
    echo "Resolve the conflict before re-running sync-version.sh." >&2
    exit 1
  fi
}
_check_no_conflict_markers "$REPO_ROOT/package.json"
_check_no_conflict_markers "$REPO_ROOT/.claude-plugin/plugin.json"
_check_no_conflict_markers "$REPO_ROOT/.claude-plugin/marketplace.json"

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
