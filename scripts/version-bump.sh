#!/usr/bin/env bash
# version-bump.sh — atomically bump VERSION across worktrees.
#
# Mirrors `canopy version bump`: fetches origin/main, picks
# `max(local, origin/main) + patch+1`, writes VERSION, then delegates to
# scripts/sync-version.sh to propagate the new value into the three JSON
# files (package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json).
#
# Why fetch origin first: two parallel emdash worktrees have repeatedly
# bumped VERSION to the same number, producing a deterministic merge
# conflict on every rebase. Pulling origin/main's VERSION before deciding
# the next number lets a sibling worktree's bump be visible.
#
# Doesn't fully solve concurrent pushes — the second push will still need
# a re-bump — but it removes the common case where the user forgot to
# fetch before bumping.
#
# Usage:
#   scripts/version-bump.sh           # fetch origin, compute next, write
#   scripts/version-bump.sh --dry-run # print the next version without writing
#
# Output: prints the new version on the last line of stdout.

set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "version-bump: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/VERSION"

if [ ! -f "$VERSION_FILE" ]; then
  echo "ERROR: VERSION file not found at $VERSION_FILE" >&2
  exit 1
fi

LOCAL_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"

# Validate semver-ish: MAJOR.MINOR.PATCH (digits only, three parts).
_is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

if ! _is_semver "$LOCAL_VERSION"; then
  echo "ERROR: local VERSION '$LOCAL_VERSION' is not MAJOR.MINOR.PATCH" >&2
  exit 1
fi

# Best-effort fetch — never fail the bump if the network is down.
ORIGIN_VERSION=""
if git fetch origin main --quiet 2>/dev/null; then
  if ORIGIN_RAW="$(git show origin/main:VERSION 2>/dev/null)"; then
    ORIGIN_RAW="$(echo "$ORIGIN_RAW" | tr -d '[:space:]')"
    if _is_semver "$ORIGIN_RAW"; then
      ORIGIN_VERSION="$ORIGIN_RAW"
    fi
  fi
fi

# Pick the higher of (local, origin) by numeric comparison of components,
# then bump patch by 1. This is semver-aware: 0.10.10 > 0.10.9 (not lex).
_max_version() {
  local a="$1" b="$2"
  if [ -z "$b" ]; then echo "$a"; return; fi
  if [ -z "$a" ]; then echo "$b"; return; fi
  IFS='.' read -r a1 a2 a3 <<<"$a"
  IFS='.' read -r b1 b2 b3 <<<"$b"
  if   [ "$a1" -gt "$b1" ]; then echo "$a"
  elif [ "$a1" -lt "$b1" ]; then echo "$b"
  elif [ "$a2" -gt "$b2" ]; then echo "$a"
  elif [ "$a2" -lt "$b2" ]; then echo "$b"
  elif [ "$a3" -gt "$b3" ]; then echo "$a"
  else echo "$b"
  fi
}

BASE="$(_max_version "$LOCAL_VERSION" "$ORIGIN_VERSION")"
IFS='.' read -r MAJOR MINOR PATCH <<<"$BASE"
NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))"

ORIGIN_DISPLAY="${ORIGIN_VERSION:-(unreachable)}"

if [ "$DRY_RUN" = "1" ]; then
  echo "would bump to v$NEXT"
  echo "  local=v$LOCAL_VERSION  origin/main=v$ORIGIN_DISPLAY"
  echo "$NEXT"
  exit 0
fi

# Write VERSION first; sync-version.sh propagates to the JSON files. We do
# this in the same process so a partial write (VERSION updated, JSONs not)
# is the only failure mode worth thinking about — and sync-version.sh runs
# with `set -e` so any propagation error surfaces immediately.
echo "$NEXT" > "$VERSION_FILE"
"$REPO_ROOT/scripts/sync-version.sh" >/dev/null

echo "Bumped to v$NEXT"
echo "  was: local=v$LOCAL_VERSION  origin/main=v$ORIGIN_DISPLAY"
echo "  wrote: $VERSION_FILE"
echo "  wrote: $REPO_ROOT/package.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/plugin.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/marketplace.json"
echo "$NEXT"
