#!/usr/bin/env bash
# version-bump.sh — bump VERSION across the four files that carry it.
#
# ## A bare run BUMPS. It is the first line of the ship loop.
#
# 0.13.1042 made a bare invocation a no-op, on the assumption that the post-merge
# auto-bump was about to take over. It could not: `github-actions[bot]` cannot
# push to a protected `main` (run 33072248319, GH006 — required status check
# "clean-install" is expected). Meanwhile `check-version-unique.ts` still
# REQUIRES every PR to advance VERSION, and it runs inside `clean-install`, the
# one required check. A no-op bump plus a gate that demands a bump is a repo
# where nothing can merge.
#
# So the no-op is reverted and the status quo restored: every PR bumps, this
# script does it, and the gate enforces it. `--ci` and `--force` stay — they are
# harmless and `--ci` is what the (still inert) workflow would call if the
# settings question is ever answered.
#
# The lesson worth keeping: a script that a cached older copy of the ship loop
# still invokes cannot change behaviour ahead of the thing that replaces it.
#
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
#   scripts/version-bump.sh --expect-branch <name>
#                                           # refuse (exit 4) unless HEAD is still on
#                                           # <name>. See § Shared-worktree guard below.
#
# Env:
#   ACE_VERSION_CLAIMS  unset  -> ask GitHub which versions OPEN PRs have already
#                                 claimed, and bump past those too (see § Claimed
#                                 versions below)
#                       <list> -> use exactly these space/newline-separated versions
#                                 as the claim set; skip the GitHub scan (tests, and
#                                 anyone scripting the bump)
#                       none   -> no claim awareness at all; pre-ace#1914 behaviour
#
# Output: prints the new version on the last line of stdout.

set -euo pipefail

DRY_RUN=0
REBASE_FIRST=0
CI_MODE=0
FORCE=0
EXPECT_BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rebase-first) REBASE_FIRST=1 ;;
    --ci) CI_MODE=1 ;;
    --force) FORCE=1 ;;
    --expect-branch)
      shift
      EXPECT_BRANCH="${1:-}"
      [ -n "$EXPECT_BRANCH" ] || { echo "version-bump: --expect-branch needs a branch name" >&2; exit 2; }
      ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "version-bump: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

## Shared-worktree guard (ace#2001) — FIRST, before any git read or write.
#
# A dispatched subagent inherits its dispatcher's working directory. Without
# `isolation: "worktree"` on the Agent call it runs `git checkout -b`,
# `git add -A` and THIS SCRIPT inside the orchestrator's own worktree, at the
# same time as the orchestrator. Measured on poverty-graduation/20260905-0924:
# a Phase 1 subagent's checkout at 09:48:13 moved the branch under a live
# `/ace:run`, and the orchestrator's next commit at 10:08:16 landed on the
# subagent's branch — PRs #1995 and #1999 still share one head branch under
# unrelated titles. Nothing errored, which is why it survived: both actors run
# `git add -A`, which cannot tell whose file it is staging.
#
# The real fix is the isolation flag. This is the backstop for any dispatch
# path that forgets it, and it is placed at the START of the ship loop's first
# command so it fires BEFORE `git add -A` — the step that does the damage.
# It catches both sides of that incident: the subagent that checked out under
# someone, and the orchestrator that was checked out from under.
#
# Opt-in on purpose: a bare run behaves exactly as before, so no existing
# caller (including `--rebase-first` from land-pr.sh, which has its own,
# stronger ancestry guard) changes behaviour.
if [ -n "$EXPECT_BRANCH" ]; then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if [ "$CURRENT_BRANCH" != "$EXPECT_BRANCH" ]; then
    echo "version-bump: REFUSING to bump — branch is '$CURRENT_BRANCH', caller expected '$EXPECT_BRANCH'." >&2
    echo "  Someone checked out under you, or you are in the wrong worktree (ace#2001)." >&2
    echo "  Do NOT 'git add -A' here — it would stage another agent's in-progress edits." >&2
    echo "  Dispatch fix-and-ship subagents with isolation: \"worktree\"." >&2
    exit 4
  fi
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/VERSION"

# Version files that have deterministic rebase conflicts when parallel
# worktrees bump in parallel. --rebase-first auto-resolves these with --ours,
# then re-runs the bump (so the new version is computed against the freshly
# rebased origin/main) and folds it into the rebased tip.
#
# Deleted by accident in 0.13.1046 and restored in 0.13.10xx. `set -u` turned
# every one of the four references below into an unbound-variable error, which
# meant --rebase-first stopped `git add`-ing the bump AND stopped running the
# guard that exists to catch exactly that (jjackson/ace#578). The recovery
# command in skills/shipping produced a branch whose code was new and whose
# VERSION still matched main's — silently, because the loud half died too.
#
# package-lock.json IS here, and the reasoning that once excluded it was
# backwards (dimagi-internal/ace#1778). It used to read "sync-version.sh rewrites
# it from VERSION rather than merging it, so it does not take a rebase conflict"
# — but being rewritten from VERSION is precisely what MAKES it conflict: two
# parallel branches rewrite the same two lines to different values, the identical
# mechanism as the other four. It is tracked, carries "version" at the top level
# and at packages[""], sync-version.sh rewrites and `git add`s it, and it changes
# in every bump commit. So a real parallel collision conflicted in FIVE files
# while this list covered four, the all-conflicts-are-version-files test below
# failed, and --rebase-first aborted on the exact scenario it exists to handle.
#
# --ours is safe here for the same reason as the other four: sync-version.sh
# rewrites it from the recomputed VERSION immediately afterward, and it touches
# only the two top-level version keys, never dependency versions.
VERSION_FILES=(
  "VERSION"
  "package.json"
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
  "package-lock.json"
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

# ## Claimed versions (ace#1914)
#
# `max(local, origin/main) + 1` is computed at COMMIT time, and a sibling
# worktree's bump is invisible until its PR MERGES. So two branches that bump in
# the same window pick the SAME number, the first merges, and the second's
# `clean-install` fails with "VERSION <n> is ALREADY on origin/main".
#
# Measured on the 60 clean-install runs ending 2026-09-04: 12 failures (20% red),
# 11 of them VERSION contention, and **9 of those 11 were literally this** —
# `ALREADY on origin/main`, twice with two branches on the same number
# (0.13.1115 x2, 0.13.1122 x2). Only 1 was a stale branch (`BEHIND`).
#
# A competing branch's claim IS visible before it merges: the ship loop pushes
# before it opens the PR, so the number it took is readable off the open PR's
# head. Reading it here removes the duplicate-number case, which is the case
# nine failures in ten actually were.
#
# Best-effort by construction: no `gh`, no network, no permission, a malformed
# answer — any of those and we fall through to exactly the pre-ace#1914
# behaviour. This must never be able to FAIL a bump; it can only ever raise the
# floor.
_claim_is_sane() {
  # A claim only counts if it is plausibly the same release line as BASE and
  # within a small distance of it. Without this one typo'd 0.99.0 on some open
  # PR would poison every bump in the repo until that PR closed.
  local c="$1" b="$2"
  _is_semver "$c" || return 1
  IFS='.' read -r c1 c2 c3 <<<"$c"
  IFS='.' read -r b1 b2 b3 <<<"$b"
  [ "$c1" = "$b1" ] || return 1
  [ "$c2" = "$b2" ] || return 1
  [ "$c3" -gt "$b3" ] || return 0   # at or below BASE: harmless, max() ignores it
  [ $((c3 - b3)) -le 500 ]
}

_scan_open_pr_claims() {
  # No remote -> no GitHub -> no claims. Checked first so a fixture or an
  # offline clone never pays for a `gh` round-trip that can only fail.
  git remote get-url origin >/dev/null 2>&1 || return 0
  command -v gh >/dev/null 2>&1 || return 0
  local slug
  slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  [ -n "$slug" ] || return 0
  # OUR OWN open PR is not a competitor, and counting it inflates the bump by one
  # on every recovery. Observed 2026-09-04 shipping ace#1776: origin/main was
  # 0.13.1151 and PR #1938's own head already read 0.13.1152, so
  # `--rebase-first` "bumped past v0.13.1152, already claimed by an open PR" and
  # produced 0.13.1153 — correct-but-wasteful once, and +1 more on every
  # subsequent rebase of the same PR. Exclude the PR whose head branch is the
  # branch we are standing on.
  local self_branch
  self_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  local rows
  rows="$(gh pr list --repo "$slug" --state open --limit 50 \
            --json headRefName,headRefOid \
            -q '.[] | "\(.headRefName)\t\(.headRefOid)"' 2>/dev/null || true)"
  [ -n "$rows" ] || return 0
  local name oid v
  while IFS="$(printf '\t')" read -r name oid; do
    [ -n "$oid" ] || continue
    if [ -n "$self_branch" ] && [ "$name" = "$self_branch" ]; then
      continue
    fi
    v="$(gh api "repos/$slug/contents/VERSION?ref=$oid" \
           -H "Accept: application/vnd.github.raw" 2>/dev/null | tr -d '[:space:]' || true)"
    [ -n "$v" ] && echo "$v"
  done <<<"$rows"
}

CLAIMS_RAW=""
CLAIMS_SOURCE="none"
# --ci runs ON main, where "open PRs" is not a meaningful question and the extra
# round-trips would only slow the post-merge job. Everywhere else, including
# --dry-run, resolve claims so the number printed is the number you would get.
if [ "$CI_MODE" = "0" ]; then
  case "${ACE_VERSION_CLAIMS-}" in
    none) CLAIMS_SOURCE="disabled" ;;
    "")   CLAIMS_RAW="$(_scan_open_pr_claims || true)"; CLAIMS_SOURCE="open-prs" ;;
    *)    CLAIMS_RAW="${ACE_VERSION_CLAIMS}"; CLAIMS_SOURCE="ACE_VERSION_CLAIMS" ;;
  esac
fi

CLAIMED_MAX=""
if [ -n "$CLAIMS_RAW" ]; then
  for c in $CLAIMS_RAW; do
    if _claim_is_sane "$c" "$BASE"; then
      CLAIMED_MAX="$(_max_version "$c" "$CLAIMED_MAX")"
    fi
  done
fi
if [ -n "$CLAIMED_MAX" ]; then
  BASE="$(_max_version "$BASE" "$CLAIMED_MAX")"
fi

IFS='.' read -r MAJOR MINOR PATCH <<<"$BASE"
NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))"

ORIGIN_DISPLAY="${ORIGIN_VERSION:-(unreachable)}"

if [ "$DRY_RUN" = "1" ]; then
  echo "would bump to v$NEXT"
  echo "  local=v$LOCAL_VERSION  origin/main=v$ORIGIN_DISPLAY"
  if [ -n "$CLAIMED_MAX" ]; then
    echo "  highest version claimed by an open PR=v$CLAIMED_MAX (source: $CLAIMS_SOURCE)"
  fi
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
    # Guard on existence: VERSION_FILES now includes package-lock.json, which is
    # optional (sync-version.sh guards it the same way). Under `set -e` an
    # unguarded `git add` on a missing path exits 128 and kills the bump.
    if [ -e "$REPO_ROOT/$vf" ]; then
      git add -- "$vf"
    fi
  done
  # WHICH commit the bump lands in is not the same question as WHETHER it
  # landed, and until ace#1852 only the second was asked. `git commit --amend`
  # assumes the rebased tip is one of YOUR commits. When the branch has ZERO
  # unmerged commits — its previous PR already merged and you are starting fresh
  # work on the same branch name — the rebased tip IS `origin/main`'s own commit,
  # and the amend rewrites it: HEAD becomes a new-sha copy of someone else's
  # merge commit, carrying your bump, under their authorship. Silently: the
  # script printed its success line and exited 0. Observed on emdash/spark-iyg5w
  # while shipping ace#1851.
  #
  # So: if HEAD is contained in origin/main, there is nothing of ours to fold
  # into. Commit the bump as its OWN commit rather than rewriting upstream
  # history. The bump still lands (jjackson/ace#578's invariant holds), it just
  # lands somewhere honest.
  UPSTREAM_TIP="$(git rev-parse --verify --quiet origin/main || true)"
  if [ -n "$UPSTREAM_TIP" ] && git merge-base --is-ancestor HEAD "$UPSTREAM_TIP" 2>/dev/null; then
    echo "version-bump: branch has no unmerged commits — HEAD is origin/main's own tip."
    echo "  Committing the bump as a NEW commit rather than amending upstream history (ace#1852)."
    git commit -q -m "chore: bump version to $NEXT"
  else
    GIT_EDITOR=true git commit --amend --no-edit >/dev/null
  fi
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
  echo "version-bump: bump committed onto the rebased tip; version files committed"
fi

echo "Bumped to v$NEXT"
echo "  was: local=v$LOCAL_VERSION  origin/main=v$ORIGIN_DISPLAY"
if [ -n "$CLAIMED_MAX" ]; then
  echo "  bumped past v$CLAIMED_MAX, already claimed by an open PR ($CLAIMS_SOURCE) — ace#1914"
fi
echo "  wrote: $VERSION_FILE"
echo "  wrote: $REPO_ROOT/package.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/plugin.json"
echo "  wrote: $REPO_ROOT/.claude-plugin/marketplace.json"
echo "$NEXT"
