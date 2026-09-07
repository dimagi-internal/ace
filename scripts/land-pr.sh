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
# ## Merge queues (verified 2026-09-07, BEFORE one was enabled here)
#
# `main` has no merge queue today. It is expected to get one — it is the only
# thing that closes ace#1776's merge-time half, per `lib/version-uniqueness.ts`
# ("the residual that only `strict = true` or a merge queue removes"). This
# script must be correct on both sides of that switch, with no flag day, because
# sessions already running keep using the copy they loaded.
#
# So it DETECTS rather than assumes. `mergeQueueEntry` is null when there is no
# queue, so one read distinguishes both worlds. It has to be a GraphQL read:
# `gh pr view --json` carries neither `isInMergeQueue` nor `mergeQueueEntry`
# (checked against `gh pr view --json` on gh 2.88.1 — the field list has
# `autoMergeRequest`, `mergeStateStatus`, `mergeable`, and nothing queue-shaped).
#
# What actually changes, and what does not — read from gh's own source
# (cli/cli v2.88.1 `pkg/cmd/pr/merge/merge.go`) rather than guessed:
#
#   - **A queued PR must never be disarmed, rebased or force-pushed.** This is
#     the one real hazard, and it is silent. `mergeRun` calls `inMergeQueue()`
#     BEFORE the `--disable-auto` branch (merge.go:543-553), so on a queued PR
#     `gh pr merge --disable-auto` returns `ErrAlreadyInMergeQueue`, which the
#     command maps to `return nil` (merge.go:167) — it prints "already queued to
#     merge", EXITS 0, and never calls `disableAutoMerge`. The disarm this
#     script relies on to stop the race becomes a no-op that reports success.
#     Force-pushing anyway would then rewrite the head of a PR whose queued
#     merge group is already testing the OLD commit — the exact ace#1593 shape
#     the disarm exists to prevent. Hence the queued branch below sits ahead of
#     the DIRTY branch and takes no action at all.
#
#   - **Queued is PROGRESS, not a stall.** The PR stays `state: OPEN` until the
#     queue merges it, and CI now runs on the merge GROUP, not on the PR ("The
#     merge queue will ensure the pull request's changes pass all required
#     status checks when applied to the latest version of the target branch and
#     any pull requests already in the queue" — GitHub docs, managing-a-merge-queue).
#     That is slower than a bare PR check by the depth of the queue. Waiting
#     while queued therefore does NOT consume an attempt; it is bounded instead
#     by its own wall-clock deadline, and it exits 5 (not 3) so "still moving"
#     is never read as the "queued but actually stuck" handoff.
#
#   - **The DIRTY rebase path STAYS.** A queue rebases speculatively, but it
#     cannot resolve a real conflict: "if there are failed required status
#     checks or conflicts with the base branch, the pull request will be removed
#     from the queue" (same doc). The path is unchanged and still correct; it
#     simply must not run while the PR is still IN the queue.
#
#     This paragraph used to add "a VERSION collision is a conflict, so it still
#     surfaces as DIRTY". **That was wrong, and it is the ace#2175 bug** — a
#     collision produces no conflict at all, so an ejection for a failed
#     `check-version-unique` lands the PR at BLOCKED with the merge-group run
#     red, not at DIRTY. See "## A version collision usually is NOT `DIRTY`".
#
#   - **`--auto --merge` is unchanged, deliberately.** Under a queue gh only
#     WARNS that "The merge strategy for <branch> is set by the merge queue"
#     and sets `payload.auto = true` regardless (merge.go:298-304) — a warning
#     on stderr, not an error. Dropping `--merge` would be cosmetically tidier
#     and is the wrong trade: without a queue, `--auto` with no strategy is a
#     HARD failure in a non-interactive shell ("--merge, --rebase, or --squash
#     required when not running interactively", merge.go:310-312), so making the
#     flag conditional turns a false-positive queue detection into a PR that is
#     never armed at all. One unconditional form that warns is safer than two
#     forms where one silently strands the PR.
#
# Not verified here, and unverifiable until a queue exists: everything above is
# read from gh's source, GitHub's documented contract, and a live GraphQL probe
# against a repo with NO queue. No PR in this repo has ever been enqueued.
# See `skills/shipping/SKILL.md § When the merge queue goes live` for the
# falsifier to run on the first queued PR.
#
# ## A version collision usually is NOT `DIRTY` (ace#2175)
#
# Until 2026-09-07 the recovery above had ONE trigger: `mergeStateStatus: DIRTY`.
# That is right for a merge CONFLICT and wrong for the common shape of a version
# collision, which produces no conflict at all. Two PRs that bump to the SAME
# version write byte-identical VERSION files, so git merges them cleanly —
# `lib/version-uniqueness.ts` says exactly that in the error it raises
# ("Nothing will conflict — two identical VERSION files merge cleanly"). The
# collision is caught instead by `check-version-unique` failing inside
# `clean-install`, `main`'s only REQUIRED check, which leaves the PR `BLOCKED`.
#
# Measured 2026-09-07 on PR #2166 (collided with the older #2165 on `0.13.1325`):
# `state=OPEN mergeState=BLOCKED auto=MERGE`, stable, while this script polled it
# for ten minutes and printed nothing. A human recovered it by hand with the
# recipe implemented ten lines away.
#
# **`BLOCKED` on its own must never trigger the rebase.** It is GitHub's general
# "not mergeable yet": checks running, a check FAILED for any reason, a missing
# review. `DIRTY || BLOCKED` would answer a red unit test by force-pushing —
# restarting CI on a failure a rebase cannot fix. So the trigger is `BLOCKED`
# AND a positive VERSION-collision verdict, re-derived by
# `scripts/land-pr-classify.ts` from the SAME functions `check-version-unique`
# runs (`lib/version-uniqueness.ts`) over live evidence. That verdict does not
# look at CI, so no CI failure can produce it; an unreadable one is `unknown`,
# which waits. Full argument: `lib/land-pr-classify.ts`.
#
# ## Silence is a defect too
#
# The ten minutes above printed NOTHING, which is what made a wait read as a
# hang. Every poll now names the state it observed, every BLOCKED attempt names
# the cause and the failing checks, and the give-up line carries them too.
#
# ## Usage
#
#   bash scripts/land-pr.sh <pr-number> [max-attempts]
#
# Exit: 0 merged · 1 closed without merging · 2 non-version conflict (needs a
# human) · 3 attempts exhausted, or the rebase cap was hit · 5 STILL IN THE MERGE
# QUEUE when the queue wait ran out — progress, not a stall; re-run or read the
# queue position. Always verify the merge state yourself after — a turn that
# opened a PR does not close without a read merge state.
#
set -uo pipefail

PR="${1:?usage: land-pr.sh <pr-number> [max-attempts]}"
MAX="${2:-5}"
REPO="${ACE_REPO:-dimagi-internal/ace}"
# Overridable only so the hermetic tests can drive the loop without sleeping.
# Nothing in a real ship should set these.
POLLS_PER_ATTEMPT="${ACE_LAND_PR_POLLS:-15}"
POLL_SECONDS="${ACE_LAND_PR_POLL_SECONDS:-20}"
# Wall-clock ceiling on time spent waiting while the PR is IN the merge queue.
# Queued time does not consume an attempt (the queue is doing the work), so this
# is what bounds it. 30 min covers a queue several PRs deep with this repo's
# ~2-3 min `clean-install`; past that, report the position and let the caller
# decide rather than holding the turn.
QUEUE_WAIT_SECONDS="${ACE_LAND_PR_QUEUE_WAIT:-1800}"
# Hard ceiling on how many times WE rewrite the PR head. Every rebase consumes an
# attempt, so `MAX` already bounds it — this makes the bound explicit and, more
# to the point, makes hitting it LOUD rather than another exhausted-attempts
# line. A recovery that cannot converge must say what it kept seeing.
REBASE_MAX="${ACE_LAND_PR_REBASE_MAX:-$MAX}"

# Resolved from THIS script's own location, not from `cwd`: the classifier is a
# sibling, and the script is routinely run from a worktree it was copied into.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

state() { gh pr view "$PR" -R "$REPO" --json state --jq .state 2>/dev/null; }
mergeability() { gh pr view "$PR" -R "$REPO" --json mergeStateStatus --jq .mergeStateStatus 2>/dev/null; }
head_ref() { gh pr view "$PR" -R "$REPO" --json headRefName --jq .headRefName 2>/dev/null; }
head_oid() { gh pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null; }

# Merge-queue state, in ONE GraphQL read — `gh pr view --json` exposes no
# queue-shaped field, so this cannot fold into the helpers above. Prints four
# space-separated tokens: <queue-enabled> <queued> <entry-state> <position>.
#
# Prints NOTHING on a failed read, and the caller then proceeds exactly as it
# did before this existed (unqueued). That is the deliberate default: pre-queue
# it is always the right answer, so a broken read can never regress today's
# behaviour. Post-queue it is the one residual — a read that fails on a queued
# PR would let the DIRTY path run. Named in the report; the falsifier is the
# first live queued PR.
queue_state() {
  gh api graphql \
    -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isMergeQueueEnabled isInMergeQueue mergeQueueEntry{state position}}}}' \
    -f o="${REPO%%/*}" -f r="${REPO##*/}" -F n="$PR" \
    --jq '.data.repository.pullRequest | "\(.isMergeQueueEnabled) \(.isInMergeQueue) \(.mergeQueueEntry.state // "-") \(.mergeQueueEntry.position // "-")"' \
    2>/dev/null
}

# True iff the PR is sitting in the queue right now.
is_queued() {
  local qe queued rest
  read -r qe queued rest <<<"$(queue_state)" || true
  [ "${queued:-false}" = "true" ]
}

# Why this PR is BLOCKED, and whether we may rebase it (ace#2175). Sets
# cls_action / cls_cause / cls_failing / cls_pending / cls_detail.
#
# The verdict comes from `land-pr-classify.ts`, which re-derives the VERSION
# property from `lib/version-uniqueness.ts` — the same functions
# `check-version-unique` runs inside `clean-install`. It deliberately does NOT
# scrape CI's log text: a regex over another job's prose drifts silently, while
# the library cannot disagree with itself.
#
# A classifier that does not run, or answers nothing, DEFAULTS TO WAIT. Every
# unreadable state must fall on the side of leaving the PR alone: the cost of a
# missed recovery is a bounded wait, the cost of a wrong one is a force-push
# over a PR that never needed it.
classify_blocked() {
  cls_action=""; cls_cause=""; cls_failing=""; cls_pending=""; cls_detail=""
  local out line
  out="$(npx tsx "$SCRIPT_DIR/land-pr-classify.ts" --pr "$PR" --repo "$REPO" 2>/dev/null)"
  while IFS= read -r line; do
    case "$line" in
      action=*)  cls_action="${line#action=}" ;;
      cause=*)   cls_cause="${line#cause=}" ;;
      failing=*) cls_failing="${line#failing=}" ;;
      pending=*) cls_pending="${line#pending=}" ;;
      detail=*)  cls_detail="${line#detail=}" ;;
    esac
  done <<<"$out"
  if [ -z "$cls_action" ]; then
    cls_action="wait"
    cls_cause="classifier-unavailable"
    cls_detail="could not run land-pr-classify.ts — refusing to rebase without a verdict."
  fi
}

## Why the arm is unconditional, and why the guard had to move with it
#
# Until ace#2004 the only `--auto --merge` lived INSIDE the DIRTY branch, so it
# fired purely as a side effect of losing a version race. A PR that was CLEAN on
# the first read fell straight through to the poll loop having armed nothing,
# and waited MAX x POLLS_PER_ATTEMPT for a merge no one would perform.
#
# The tell is that the failure is INVERSELY correlated with contention: a busy
# `main` sends you down the DIRTY path and the script works, while the quiet run
# — the one that needed no rebase at all — hangs. Measured on
# poverty-graduation/20260905-0924: #1988 (DIRTY) and #1999 (BLOCKED then DIRTY)
# both landed because the rebase armed them incidentally; #2003, the only one
# CLEAN on arrival, sat >10 minutes against a repo whose create->merge is ~70s
# and merged seconds after a manual `gh pr merge --auto`.
#
# The obvious one-line fix — hoist a bare arm above the loop — is wrong, and
# wrong in a way that costs more than the bug. The ancestry guard lived in that
# same DIRTY branch, so arming first would arm a PR this checkout has not been
# proven to own: pointed at the wrong worktree the script would merge a
# stranger's PR rather than refuse. (That guard was also, for the same reason,
# never reached on a CLEAN PR at all.) So the GUARD is hoisted too, and runs
# first, every attempt.
#
# Order below is therefore: guard -> (rebase and push, if DIRTY) -> arm -> poll.
# ONE arm call site serves both roles — the initial arm on a clean run, and the
# re-arm against the corrected VERSION after a rebase — and it sits after the
# push either way, which is what "Why disarming is load-bearing" requires.
# `gh pr merge --auto` is idempotent, so a caller that already armed per
# `skills/shipping` loses nothing.
#
# A `while` rather than `for attempt in $(seq ...)` because time spent QUEUED
# must not consume an attempt: the attempt budget exists to bound how many times
# WE rebase against a moving `main`, and a PR sitting in the queue is the queue
# doing that work instead. Queued waiting is bounded by QUEUE_WAIT_SECONDS.
queue_deadline=$(( $(date +%s) + QUEUE_WAIT_SECONDS ))
attempt=0
rebases=0
last_cause="-"; last_failing=""
qenabled=false; queued=false; qstate="-"; qpos="-"

while [ "$attempt" -lt "$MAX" ]; do
  s="$(state)"
  case "$s" in
    MERGED) echo "attempt $((attempt + 1)): MERGED"; exit 0 ;;
    CLOSED) echo "attempt $((attempt + 1)): CLOSED without merging"; exit 1 ;;
  esac

  m="$(mergeability)"
  q="$(queue_state)"
  if [ -z "$q" ]; then
    qenabled=false; queued=false; qstate="-"; qpos="-"
    echo "  merge-queue read unavailable — proceeding as unqueued (pre-queue this is always correct)"
  else
    read -r qenabled queued qstate qpos <<<"$q"
  fi
  echo "attempt $((attempt + 1))/$MAX: state=$s mergeable=$m queue=$qenabled queued=$queued entry=$qstate pos=$qpos"

  # Resolve the push target from the PR, never from local state — and prove this
  # checkout is the PR's work before touching auto-merge or rewriting anything.
  # See "The head branch is not the local branch" above. Re-read every attempt:
  # our own force-push moves the head.
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

  # QUEUED — the PR is in the merge queue. Do NOTHING to it: no disarm (gh's
  # `--disable-auto` is a no-op that exits 0 on a queued PR, merge.go:543), no
  # rebase, no force-push (that rewrites a head whose merge group is already
  # under test). It is progressing on our behalf; the only correct action is to
  # wait, and to SAY that it is progressing. This block sits ahead of the DIRTY
  # branch for exactly that reason. See "## Merge queues" above.
  if [ "$queued" = "true" ]; then
    now="$(date +%s)"
    if [ "$now" -ge "$queue_deadline" ]; then
      echo "  PR #$PR is STILL IN THE MERGE QUEUE (entry=$qstate position=$qpos) after"
      echo "  ${QUEUE_WAIT_SECONDS}s of queued waiting. This is PROGRESS, NOT A STALL — the queue is"
      echo "  testing it against main plus everything ahead of it. Nothing was rebased,"
      echo "  disarmed or pushed. Re-run this script, or watch the position."
      exit 5
    fi
    echo "  in the merge queue (entry=$qstate position=$qpos) — waiting; this attempt is not consumed"
    for _ in $(seq 1 "$POLLS_PER_ATTEMPT"); do
      s="$(state)"
      [ "$s" = "MERGED" ] && { echo "merged from the queue"; exit 0; }
      [ "$s" = "CLOSED" ] && { echo "CLOSED without merging"; exit 1; }
      is_queued || { echo "  ejected from the queue — re-reading at the top"; break; }
      sleep "$POLL_SECONDS"
    done
    continue                    # deliberately does NOT increment `attempt`
  fi

  attempt=$((attempt + 1))

  # WHY we would rebase, or empty for "we would not". Two ways in, and only two:
  # a real merge conflict (DIRTY), or a BLOCKED PR whose VERSION the authority
  # says is not viable (ace#2175). Everything else waits — see the classifier.
  rebase_reason=""
  if [ "$m" = "DIRTY" ]; then
    rebase_reason="merge conflict (DIRTY)"
  elif [ "$m" = "BLOCKED" ]; then
    classify_blocked
    last_cause="$cls_cause"; last_failing="$cls_failing"
    echo "  BLOCKED: cause=$cls_cause failing=${cls_failing:-none} pending=${cls_pending:-none}"
    echo "  $cls_detail"
    [ "$cls_action" = "recover" ] && rebase_reason="VERSION collision (BLOCKED)"
  fi

  if [ -n "$rebase_reason" ]; then
    # Bounded, and loud at the bound. Every rebase already consumes an attempt,
    # so this can only be reached by a recovery that keeps re-colliding — which
    # is a human's call, not another force-push.
    if [ "$rebases" -ge "$REBASE_MAX" ]; then
      echo "  REBASE CAP REACHED ($rebases/$REBASE_MAX) and the PR is still blocked by: $rebase_reason"
      echo "  Last observed: mergeStateStatus=$m cause=$last_cause failing=${last_failing:-none}"
      echo "  Not rebasing again. Resolve it by hand, or raise ACE_LAND_PR_REBASE_MAX knowing why."
      exit 3
    fi
    rebases=$((rebases + 1))
    echo "  recovering: $rebase_reason — rebase $rebases/$REBASE_MAX"

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
    echo "  pushed $ref"
  fi

  # ARM — the initial arm on a clean run, the re-arm against the corrected
  # VERSION after a rebase. Always after the guard, always after any push.
  gh pr merge "$PR" -R "$REPO" --auto --merge >/dev/null 2>&1 || true
  echo "  auto-merge armed"

  # A line PER POLL. The ten silent minutes of ace#2175 were half the defect:
  # a wait that prints nothing is indistinguishable from a hang, and the reader
  # kills it rather than letting it work. `mergeability` was already read here,
  # so saying what it returned costs nothing.
  for poll in $(seq 1 "$POLLS_PER_ATTEMPT"); do
    s="$(state)"
    [ "$s" = "MERGED" ] && { echo "attempt $attempt: MERGED"; exit 0; }
    [ "$s" = "CLOSED" ] && { echo "attempt $attempt: CLOSED without merging"; exit 1; }
    if is_queued; then                         # entered the queue — stop polling
      echo "  poll $poll/$POLLS_PER_ATTEMPT: entered the merge queue — re-reading at the top"
      break                                    # blind and re-read at the top
    fi
    mm="$(mergeability)"
    echo "  poll $poll/$POLLS_PER_ATTEMPT: state=$s mergeable=$mm"
    [ "$mm" = "DIRTY" ] && break                # collided again — next attempt
    sleep "$POLL_SECONDS"
  done
done

# Report whether auto-merge was actually armed AND whether a merge queue is in
# play. "OPEN CLEAN" gives the reader nothing to act on; "OPEN CLEAN
# auto-merge=false" names the cause (ace#2004), and "queue=true queued=false"
# says the PR never reached the queue at all — a different problem with a
# different fix from one that is queued and merely slow.
echo "gave up after $MAX attempts: $(gh pr view "$PR" -R "$REPO" --json state,mergeStateStatus,autoMergeRequest --jq '.state+" "+.mergeStateStatus+" auto-merge="+(.autoMergeRequest != null | tostring)') queue=$qenabled queued=$queued entry=$qstate pos=$qpos"
# ...and WHAT was blocking it. "OPEN BLOCKED auto-merge=true" was the whole
# report for the ten minutes of ace#2175; "cause=checks-failed failing=unit-tests"
# is a next step. `rebases=` says whether the recovery ever ran at all.
echo "  cause=$last_cause failing=${last_failing:-none} rebases=$rebases/$REBASE_MAX"
exit 3
