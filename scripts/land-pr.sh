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

for attempt in $(seq 1 "$MAX"); do
  s="$(state)"
  case "$s" in
    MERGED) echo "attempt $attempt: MERGED"; exit 0 ;;
    CLOSED) echo "attempt $attempt: CLOSED without merging"; exit 1 ;;
  esac

  m="$(mergeability)"
  echo "attempt $attempt/$MAX: state=$s mergeable=$m"

  if [ "$m" = "DIRTY" ]; then
    # DISARM FIRST — see "Why disarming is load-bearing" above. Without this the
    # rebase can be silently discarded by a merge that is already in flight.
    gh pr merge "$PR" -R "$REPO" --disable-auto >/dev/null 2>&1 || true

    if ! bash scripts/version-bump.sh --rebase-first >/dev/null 2>&1; then
      echo "  rebase ABORTED: a non-version file conflicts. That needs human review —"
      echo "  re-arm auto-merge yourself once it is resolved."
      exit 2
    fi
    echo "  rebased to $(cat VERSION)"

    git push --force-with-lease origin HEAD --quiet 2>/dev/null || {
      echo "  force-push rejected — someone else moved the branch. Stopping."
      exit 2
    }

    # RE-ARM only now, against the corrected VERSION.
    gh pr merge "$PR" -R "$REPO" --auto --merge >/dev/null 2>&1 || true
    echo "  pushed, auto-merge re-armed"
  fi

  for _ in $(seq 1 "$POLLS_PER_ATTEMPT"); do
    s="$(state)"
    [ "$s" = "MERGED" ] && { echo "attempt $attempt: MERGED"; exit 0; }
    [ "$s" = "CLOSED" ] && { echo "attempt $attempt: CLOSED without merging"; exit 1; }
    [ "$(mergeability)" = "DIRTY" ] && break   # collided again — next attempt
    sleep "$POLL_SECONDS"
  done
done

echo "gave up after $MAX attempts: $(gh pr view "$PR" -R "$REPO" --json state,mergeStateStatus --jq '.state+" "+.mergeStateStatus')"
exit 3
