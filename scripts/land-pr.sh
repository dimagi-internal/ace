#!/usr/bin/env bash
#
# Land a PR against a fast-moving `main`: rebase the version files, re-push,
# wait — and do it again when `main` moves underneath you.
#
# ## Why this is a script and not two lines in a runbook
#
# `skills/shipping` already carries the version-collision recipe, and it is
# correct: disarm auto-merge, `version-bump.sh --rebase-first`, force-push,
# re-arm. What it does not say is that ONE pass frequently loses the race.
#
# Measured 2026-09-05 on PR #1962: `main` merged at 06:45, 06:47, 06:57, 07:13,
# 07:14, 07:19 and 07:21 — a merge every 2-4 minutes, from several sibling
# sessions shipping at once. A rebase plus `clean-install` takes 1-3 minutes, so
# `main` moves again inside the window and the PR returns to DIRTY. That PR
# collided twice; four PRs in one session hit it. Done by hand it is four
# rebases and a lot of polling; the loop is mechanical work a human should not
# be doing.
#
# ## The two halves that were never in the same place
#
#   - The RECIPE knew to disarm auto-merge before rebasing, and why (below), but
#     assumed one rebase suffices.
#   - The first hand-rolled retry loop (this script's ancestor, 2026-09-05)
#     knew to retry but FORGOT to disarm — and landed anyway, purely because CI
#     had not yet gone green on the pre-rebase head. That is luck, not method.
#
# Both together is the only correct version, which is why it is code.
#
# ## Why disarming is load-bearing
#
# Auto-merge stays armed while you rebase, and `clean-install` (the only
# REQUIRED check) can go green on the PRE-rebase head first. The merge then
# wins the race, your `--force-with-lease` is a no-op against an already-merged
# branch, and the PR lands carrying the OLD version. `main` shows the same
# VERSION before and after — and because the plugin cache is keyed by version,
# `/ace:update` can never reach the change. `check-version` does not save you:
# it is advisory, not required. Measured 2026-08-24: 3 PRs that left auto-merge
# armed all needed a follow-up bump (#1597, #1598, #1588); the 1 that disarmed
# first (#1601) did not.
#
# ## The head branch is not the local branch
#
# git refuses to check out a branch that is already checked out in another
# worktree. So "the PR's head branch is unavailable locally" is the NORMAL
# condition whenever a self-heal ships alongside a live `/ace:run` — exactly
# when this script is most wanted — and the landing agent works from a
# differently-named branch.
#
# A bare `git push origin HEAD` resolves the remote ref from the LOCAL branch
# name. Measured 2026-09-05 (ace#1974): pushing from `ship/1967-rebase` while
# the PR head was `fix/1966-longitudinal-program-naming` created a stray
# `origin/ship/1967-rebase`, left the PR head untouched, and EXITED 0 — so the
# script re-armed auto-merge on a PR it had not updated and reported success.
# That re-arms the pre-rebase VERSION, which is the very failure the disarm step
# below exists to prevent.
#
# So: resolve the destination from the PR (`headRefName`), push an explicit
# `HEAD:refs/heads/<ref>`, and — because the script also rebases whatever is in
# `cwd` and reads whatever `VERSION` is there — assert first that the PR's head
# commit is an ancestor of this checkout. Pointed at the wrong worktree the
# script must refuse, not rewrite a stranger's branch.
#
# ## Why the lease needs an explicit sha
#
# A bare `--force-with-lease` takes its expected value from the remote-TRACKING
# ref for the destination. With an explicit refspec that ref usually does not
# exist (a worktree branched from `main` has never fetched the PR branch), and
# git then fails CLOSED: `! [rejected] ... (stale info)`. Fetching the ref first
# to create it would make the lease worthless — it would compare a value just
# read against itself.
#
# `--force-with-lease=<ref>:<sha>` with `headRefOid` read from the PR at the top
# of the attempt is the correct form, and a STRONGER lease than the original:
# the expected value comes from GitHub rather than a possibly-stale local ref.
# Measured: it succeeds with no remote-tracking ref present, and still rejects
# when a third party moved the head first.
#
# ## Usage
#
#   bash scripts/land-pr.sh <pr-number> [max-attempts]
#
# Exit: 0 merged · 1 closed without merging · 2 non-version conflict (needs a
# human) · 3 attempts exhausted. Always verify the merge state yourself after —
# a turn that opened a PR does not close without a read merge state.
#
set -uo pipefail

PR="${1:?usage: land-pr.sh <pr-number> [max-attempts]}"
MAX="${2:-5}"
REPO="${ACE_REPO:-dimagi-internal/ace}"
POLLS_PER_ATTEMPT=15
POLL_SECONDS=20

state() { gh pr view "$PR" -R "$REPO" --json state --jq .state 2>/dev/null; }
mergeability() { gh pr view "$PR" -R "$REPO" --json mergeStateStatus --jq .mergeStateStatus 2>/dev/null; }
head_ref() { gh pr view "$PR" -R "$REPO" --json headRefName --jq .headRefName 2>/dev/null; }
head_oid() { gh pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null; }

# NOTE (ace#2004, OPEN): the only `--auto --merge` below lives inside the
# DIRTY branch, so a PR that is CLEAN on first read is polled to exhaustion for
# a merge nothing performs. The initial arm CANNOT simply be hoisted here: the
# ancestry guard ("refusing to land ... not an ancestor of this checkout") also
# lives inside that branch, and test/scripts/land-pr-refspec.test.ts pins that
# a wrong-worktree invocation "must bail BEFORE disarming auto-merge — nothing
# was touched". Arming first would merge a PR this checkout was never proven to
# own. The fix is to hoist the GUARD too, and to make the test stub's `--auto`
# mergeability-aware (today it merges unconditionally, which real GitHub does
# not). See ace#2004.
for attempt in $(seq 1 "$MAX"); do
  s="$(state)"
  case "$s" in
    MERGED) echo "attempt $attempt: MERGED"; exit 0 ;;
    CLOSED) echo "attempt $attempt: CLOSED without merging"; exit 1 ;;
  esac

  m="$(mergeability)"
  echo "attempt $attempt/$MAX: state=$s mergeable=$m"

  if [ "$m" = "DIRTY" ]; then
    # Resolve the push target from the PR, never from local state — and prove
    # this checkout is the PR's work before rewriting anything. See "The head
    # branch is not the local branch" above.
    ref="$(head_ref)"
    oid="$(head_oid)"
    if [ -z "$ref" ] || [ -z "$oid" ]; then
      echo "  could not read headRefName/headRefOid for PR #$PR. Stopping."
      exit 2
    fi
    if ! git merge-base --is-ancestor "$oid" HEAD 2>/dev/null; then
      echo "  refusing to land PR #$PR: its head ($ref @ ${oid:0:7}) is not an"
      echo "  ancestor of this checkout ($(git rev-parse --short HEAD 2>/dev/null))."
      echo "  Wrong worktree, or someone pushed to the PR branch. Nothing changed."
      exit 2
    fi

    # DISARM FIRST — see "Why disarming is load-bearing" above. Without this the
    # rebase can be silently discarded by a merge that is already in flight.
    gh pr merge "$PR" -R "$REPO" --disable-auto >/dev/null 2>&1 || true

    if ! bash scripts/version-bump.sh --rebase-first >/dev/null 2>&1; then
      echo "  rebase ABORTED: a non-version file conflicts. That needs human review —"
      echo "  re-arm auto-merge yourself once it is resolved."
      exit 2
    fi
    echo "  rebased to $(cat VERSION)"

    # Explicit DESTINATION and explicit LEASE VALUE. Both are load-bearing:
    # see "The head branch is not the local branch" and "Why the lease needs an
    # explicit sha" above.
    if ! git push --force-with-lease="$ref:$oid" origin "HEAD:refs/heads/$ref" --quiet; then
      echo "  force-push to $ref rejected — the PR head moved under us. Stopping."
      exit 2
    fi

    # RE-ARM only now, against the corrected VERSION.
    gh pr merge "$PR" -R "$REPO" --auto --merge >/dev/null 2>&1 || true
    echo "  pushed $ref, auto-merge re-armed"
  fi

  for _ in $(seq 1 "$POLLS_PER_ATTEMPT"); do
    s="$(state)"
    [ "$s" = "MERGED" ] && { echo "attempt $attempt: MERGED"; exit 0; }
    [ "$s" = "CLOSED" ] && { echo "attempt $attempt: CLOSED without merging"; exit 1; }
    [ "$(mergeability)" = "DIRTY" ] && break   # collided again — next attempt
    sleep "$POLL_SECONDS"
  done
done

# Report whether auto-merge was actually armed. "OPEN CLEAN" gives the reader
# nothing to act on; "OPEN CLEAN auto-merge=false" names the cause (ace#2004).
echo "gave up after $MAX attempts: $(gh pr view "$PR" -R "$REPO" --json state,mergeStateStatus,autoMergeRequest --jq '.state+" "+.mergeStateStatus+" auto-merge="+(.autoMergeRequest != null | tostring)')"
exit 3
