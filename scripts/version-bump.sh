#!/usr/bin/env bash
# version-bump.sh — bump VERSION across the four files that carry it.
#
# ## A PR DOES NOT RUN THIS ANY MORE (since 0.13.10xx)
#
# `.github/workflows/auto-version-bump.yml` bumps on every merge to `main`, so
# a PR must NOT touch VERSION / package.json / plugin.json / marketplace.json.
# Bare invocation is therefore a NO-OP that says so and exits 0 — deliberately,
# so an agent following a cached older copy of `skills/shipping` still works and
# gets told why rather than silently reintroducing the conflict.
#
#   --ci      the post-merge bump, run by the workflow on `main`. Plain
#             patch+1 off the local VERSION; no origin fetch (it IS origin).
#   --force   a deliberate manual bump — a minor/major, or a hotfix that must
#             carry its own version. Rare. The old behaviour verbatim.
#
# Why the change: the plugin cache is keyed by version, so two trees under one
# version means the second is unreachable by /ace:update (ace#1593). That was
# defended by a CHECK that every PR had bumped; the check was right and the cost
# was five files conflicting on every pair of concurrent PRs. Bumping after the
# merge satisfies the same invariant by construction. See the workflow header.
#
# (Original description, still accurate for --force:)
# Atomically bump VERSION across worktrees.
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
#   scripts/version-bump.sh                 # fetch origin, compute next, write
#   scripts/version-bump.sh --dry-run       # print the next version without writing
#   scripts/version-bump.sh --rebase-first  # rebase onto origin/main (auto-resolving
#                                           # the 4 version files via --ours), then bump
#
# Output: prints the new version on the last line of stdout.

set -euo pipefail

DRY_RUN=0
REBASE_FIRST=0
CI_MODE=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rebase-first) REBASE_FIRST=1 ;;
    --ci) CI_MODE=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "version-bump: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/VERSION"

# The no-op gate. A bare run used to be the first line of the ship loop; it is
# now the wrong thing to do, and the loudest place to say so is here rather than
# in a doc the caller may not have re-read.
if [ "$CI_MODE" = "0" ] && [ "$FORCE" = "0" ] && [ "$DRY_RUN" = "0" ] && [ "$REBASE_FIRST" = "0" ]; then
  cat >&2 <<'MSG'
version-bump: no-op — version bumps are AUTOMATIC on merge since 0.13.10xx.

  .github/workflows/auto-version-bump.yml bumps VERSION, package.json,
  plugin.json and marketplace.json on every push to main. A PR must NOT
  touch them: doing so puts all four back into every concurrent PR's
  conflict set, which is the tax this replaced (six collisions in one day,
  2026-08-27).

  Just commit and open the PR. Nothing else to do.

  If you genuinely need a deliberate bump (a minor/major, or a hotfix that
  must carry its own version), re-run with --force.
MSG
  # Exit 0, not 1: a cached older `skills/shipping` still opens with this
  # command, and failing there would break shipping for anyone who has not
  # picked up the new plugin version yet.
  exit 0
fi

# --rebase-first is still useful (rebasing onto a moved main), but it must not
# bump any more — the version files are main's now.
if [ "$REBASE_FIRST" = "1" ] && [ "$FORCE" = "0" ]; then
  REBASE_ONLY=1
else
  REBASE_ONLY=0
fi

# Version files that have deterministic rebase conflicts when parallel
# worktrees bump in parallel. --rebase-first auto-resolves these with
# --ours, then re-runs the bump (so the new version is computed against
# the freshly-rebased origin/main).
VERSION_FILES=(
  "VERSION"
  "package.json"
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
)

if [ "$REBASE_FIRST" = "1" ]; then
  echo "version-bump: --rebase-first set; fetching + rebasing onto origin/main"
  git fetch origin main --quiet
  if ! git rebase origin/main; then
    # Inspect which files are in conflict. If they're all version files,
    # auto-resolve. Otherwise abort cleanly — real conflicts need a human.
    CONFLICTED="$(git diff --name-only --diff-filter=U || true)"
    if [ -z "$CONFLICTED" ]; then
      echo "version-bump: rebase failed but no conflict files reported" >&2
      git rebase --abort 2>/dev/null || true
      exit 1
    fi
    NON_VERSION=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      MATCH=0
      for vf in "${VERSION_FILES[@]}"; do
        if [ "$f" = "$vf" ]; then MATCH=1; break; fi
      done
      if [ "$MATCH" = "0" ]; then
        NON_VERSION="$NON_VERSION $f"
      fi
    done <<<"$CONFLICTED"
    if [ -n "$NON_VERSION" ]; then
      echo "version-bump: real conflicts outside version files — aborting rebase:" >&2
      echo "$NON_VERSION" | tr ' ' '\n' | sed 's/^/  /' >&2
      git rebase --abort
      exit 1
    fi
    echo "version-bump: auto-resolving version-file conflicts with --ours"
    for vf in "${VERSION_FILES[@]}"; do
      if echo "$CONFLICTED" | grep -qx "$vf"; then
        git checkout --ours -- "$vf"
        git add -- "$vf"
      fi
    done
    GIT_EDITOR=true git rebase --continue
  fi
fi

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
# Skipped in --ci: the workflow runs ON main, so local IS origin, and fetching
# would race the very push that triggered it.
ORIGIN_VERSION=""
if [ "$CI_MODE" = "0" ] && git fetch origin main --quiet 2>/dev/null; then
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

# --ci also stamps the CHANGELOG. Authors write under `## Unreleased` because a
# PR cannot know its own number any more — the number is decided here, ~30s
# after the merge. Without this the heading would sit at "Unreleased" forever
# and the changelog would stop being a version history.
#
# Only ever rewrites a heading that is literally `## Unreleased`; if a PR
# hand-wrote a version heading, it is left exactly as-is.
if [ "$CI_MODE" = "1" ] && [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  TODAY="$(date -u +%Y-%m-%d)"
  if grep -qE '^## Unreleased' "$REPO_ROOT/CHANGELOG.md"; then
    if [ "$(uname)" = "Darwin" ]; then
      sed -i '' "s/^## Unreleased.*$/## ${NEXT} — ${TODAY}/" "$REPO_ROOT/CHANGELOG.md"
    else
      sed -i "s/^## Unreleased.*$/## ${NEXT} — ${TODAY}/" "$REPO_ROOT/CHANGELOG.md"
    fi
    echo "  stamped: CHANGELOG.md '## Unreleased' -> '## ${NEXT} — ${TODAY}'"
  fi
fi

# In --rebase-first mode the rebased tip carries origin/main's (old) version,
# because the version-file conflicts were auto-resolved with --ours (which, in a
# rebase, means upstream/origin-main). The bump above was written to the WORKING
# TREE only — so without this step the pushed branch ships the code with the OLD
# version, /ace:update sees "up to date", and the new code never re-installs
# (jjackson/ace#578). Fold the bump into the rebased tip so it's part of the push.
if [ "$REBASE_FIRST" = "1" ]; then
  for vf in "${VERSION_FILES[@]}"; do
    git add -- "$vf"
  done
  GIT_EDITOR=true git commit --amend --no-edit >/dev/null
  # Guard: after committing, the version files MUST be clean. If they're still
  # dirty the bump didn't make it into the commit — fail loudly rather than let
  # a no-bump branch get pushed.
  DIRTY="$(git status --porcelain -- "${VERSION_FILES[@]}" || true)"
  if [ -n "$DIRTY" ]; then
    echo "version-bump: ERROR — version files still dirty after --rebase-first amend:" >&2
    echo "$DIRTY" | sed 's/^/  /' >&2
    echo "  the bump was NOT committed; do not push." >&2
    exit 1
  fi
  echo "version-bump: folded bump into rebased tip (amended); version files committed"
fi

echo "Bumped to v$NEXT"
echo "  was: local=v$LOCAL_VERSION  origin/main=v$ORIGIN_DISPLAY"
echo "  wrote: $VERSION_FILE"
echo "  wrote: $REPO_ROOT/package.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/plugin.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/marketplace.json"
echo "$NEXT"
