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

# package-lock.json — the top-level "version" and packages[""]."version", and
# ONLY those two. A `sed` like the ones above would rewrite every dependency's
# version in the file, so this is a structured edit via node.
#
# This file was missed until 0.13.10xx and had drifted to 0.13.935 while every
# other file read 0.13.1045 — 110 releases behind, silently. Nothing failed:
# `npm ci` installs from the `packages` tree and does not compare the root
# `version` to package.json, and `npm ls` does not either. So it is cosmetic
# TODAY. It is included because the whole point of the four-file gate in
# version-check.yml is that a version file drifting unnoticed is how ace#987
# happened, and "this one doesn't matter yet" is the same reasoning that let
# plugin.json sit one version back for four PRs.
if [[ -f "$REPO_ROOT/package-lock.json" ]]; then
  _check_no_conflict_markers "$REPO_ROOT/package-lock.json"
  node -e '
    const fs = require("fs");
    const path = process.argv[1], version = process.argv[2];
    const raw = fs.readFileSync(path, "utf8");
    const lock = JSON.parse(raw);
    lock.version = version;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
    // npm writes 2-space indent + trailing newline; this round-trips
    // byte-identically, so the diff is exactly the two version lines.
    const out = JSON.stringify(lock, null, 2) + "\n";
    if (out !== raw) fs.writeFileSync(path, out);
  ' "$REPO_ROOT/package-lock.json" "$VERSION"
fi

# Stage the updated files so the commit includes them
git add \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/.claude-plugin/plugin.json" \
  "$REPO_ROOT/.claude-plugin/marketplace.json"
[[ -f "$REPO_ROOT/package-lock.json" ]] && git add "$REPO_ROOT/package-lock.json"

echo "Synced version → $VERSION"
