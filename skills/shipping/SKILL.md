---
name: shipping
description: >
  Ship an ACE change: branch → PR → wait → merge → verify it landed.
  Use whenever a turn opens, waits on, or merges a PR — the wait is
  never a hand-rolled foreground sleep loop.
disable-model-invocation: false
---

# Shipping

How an ACE change gets from a worktree edit to merged `main` — and specifically **how to wait for
the PR without burning the turn**. `CLAUDE.md § Git worktrees and merging to main` and
`§ Plugin updates` own the *policy* (bump the version, never push to `main`, never locally patch
the plugin cache). This skill owns the *mechanics*, because the mechanics — most expensively the
wait — were being re-invented every time a dispatcher shipped something.

Every ACE agent that opens a PR delegates here: the orchestrator's fix-and-ship dispatches, the
self-heal convention (`CLAUDE.md § Self-heal a filed issue`), `iterate-loop`, and any turn that
lands a repo change. Do not reimplement the wait inline.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| working tree | the staged change | what is being shipped |
| repo | `VERSION` (+ the 3 files the pre-commit hook syncs) | the required `clean-install` check |

## Products

No Drive artifacts — this is a utility skill. Its product is a **merged PR plus an explicit
merge-state line** in the calling context's report (see § Step 5).

## Process

### Step 0 — know what you are waiting for

**ACE always has PR checks** — unlike the sibling agent repos (hal, ada, eva, echo), whose only
workflow triggers on `push: main`, so their PRs have nothing to report and merge immediately.
Never carry that habit into ACE. Measured against `dimagi-internal/ace` on 2026-08-17:

| Fact | Value | How to re-derive |
|---|---|---|
| Workflows on `pull_request` | `clean-install.yml`, `version-check.yml` | `grep -l pull_request .github/workflows/*` |
| **Required** status check | **`clean-install` only** | `gh api repos/dimagi-internal/ace/branches/main/protection --jq .required_status_checks.contexts` |
| `enforce_admins` | `true` — no `--admin` force-merge | same call, `.enforce_admins.enabled` |
| Auto-merge | **enabled** (`allow_auto_merge: true`) | `gh api repos/dimagi-internal/ace --jq .allow_auto_merge` |
| Merge queue | **none** | same call, `.merge_queue_enabled` is `null` |
| **Typical create → merge** | **~70 seconds** | see below |

`version-check` runs on every PR but is **not** a required context — a red `version-check` will not
block the merge, so read it rather than assuming the merge is stuck on it.

**The ~70s number is the load-bearing one.** Last five merges before this skill landed: PR #1464
72s, #1463 67s, #1460 81s, #1458 76s, #1459 15m (outlier). Re-derive with:

```bash
gh pr list --state merged --limit 5 --json number,createdAt,mergedAt
```

An ACE PR is normally merged before a 30-second poll loop finishes its third iteration. Design the
wait for ~70s with a bounded tail, not for a long grind.

### Step 1 — bump, commit, push, open, arm

```bash
bash scripts/version-bump.sh          # worktree-safe: max(local, origin/main) + 1
git add -A && git commit -m "<type>(<scope>): <what>"
git push -u origin "$(git branch --show-current)"
gh pr create --fill                   # no -R needed; origin is the ACE repo
gh pr merge <N> --auto --merge        # arm it, then STOP typing and wait per Step 2
```

Arm auto-merge in the same breath as creating the PR. Once armed, the PR lands itself the moment
`clean-install` goes green — there is no review gate. Anything you do between arming and merging is
waiting, and Step 2 is how.

### Step 2 — the wait: never a foreground sleep loop

**A foreground `sleep` used to wait is blocked by the harness.** This is not an ACE gating rail and
not something a config change can exempt — `config/gating.json` carries no `sleep` rule, and
neither does any sibling agent's gating config nor canopy's `gating-baseline.json`. It is the Bash
tool contract itself. Reproducer, run 2026-08-17:

```
$ sleep 30; echo "survived"
Blocked: sleep 30 followed by: echo "survived". To wait for a condition, use Monitor
with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you
started, use run_in_background: true. Do not chain shorter sleeps to work around this
block.
```

Short sleeps pass (`sleep 3; gh pr view …` runs fine), which is exactly why this keeps getting
rediscovered the expensive way: the pattern looks like it works until the interval is long enough
to matter. **Do not chain shorter sleeps to get under the threshold** — the block message names
that workaround specifically, and the real cost is not the block. It is what happens next: the
blocked command dies, the fallback runs in the foreground anyway, and the turn eats the full
10-minute Bash timeout as `Exit code 143 Command timed out` — having waited ten minutes for a merge
that landed in seventy seconds.

**The correct wait is one backgrounded command that exits when the condition holds.** Run this via
**`Bash` with `run_in_background: true`** — the harness re-invokes you when it exits, so you keep
working meanwhile:

```bash
gh pr checks <N> --watch --fail-fast >/dev/null 2>&1
for i in $(seq 1 40); do
  s=$(gh pr view <N> --json state --jq .state 2>/dev/null)
  case "$s" in MERGED|CLOSED) break;; esac
  sleep 15
done
gh pr view <N> --json number,state,mergedAt,mergeStateStatus \
  --jq '"PR #\(.number) state=\(.state) mergedAt=\(.mergedAt // "null") mergeState=\(.mergeStateStatus)"'
```

`gh pr checks --watch` blocks correctly on its own and exits when the checks settle; the bounded
loop then catches the auto-merge that follows a moment later. The `sleep 15` inside is fine — the
block is on *foreground* sleeps, and this whole command is backgrounded. The bound (40 × 15s ≈ 10
min after checks settle) means a stuck PR surfaces as a **result** instead of a hang.

**Do not schedule a wakeup to poll a backgrounded task** — the harness notifies you when it exits.

**`run_in_background`, not `Monitor`.** The two read as if they disagree; they don't. `Monitor` is
for *one notification per occurrence* (each check as it individually lands). Its own guidance sends
the one-notification-at-the-end case back to `Bash` + `run_in_background` with a command that exits
on the condition — which is exactly this. Reach for `Monitor` only if you actually want running
commentary on a long multi-check run.

### Step 3 — verify it actually landed

A merged PR does not mean *your* commits landed:

```bash
git fetch origin main && git log --oneline origin/main..HEAD    # expect EMPTY
```

Anything listed is unlanded and reachable only from the branch — open another PR. Nothing errors
when work strands, which is what makes this check load-bearing.

**From a worktree, drop `--delete-branch`.** ACE turns run in an emdash worktree while `main` is
checked out elsewhere, so `gh pr merge --delete-branch` and `git checkout main` fail with "main
already checked out."

### Step 4 — reconcile the running session

After the merge lands, **run `/ace:update` in this session** (mandatory — without it this session
runs stale code while new sessions get the bump). Then:

- Touched anything under `mcp/`, or ran `/ace:setup --force-env`? **Quit and reopen Claude Code.**
  `/ace:update` + `/reload-plugins` do NOT respawn MCP subprocesses — they bind their tool list,
  schemas, and env at subprocess start. See `CLAUDE.md § MCP changes need a full Claude restart`.
- Otherwise `/reload-plugins` is enough for agents, skills, and hooks.

### Step 5 — the ship checkpoint (unconditional)

**A PR-related turn never closes on an implicit "done."** Before returning, state — explicitly, in
the report, every time:

1. **Merge state**, one of `MERGED` / `OPEN` / `CLOSED`, taken from `gh pr view --json state`, not
   inferred from the fact that you armed auto-merge.
2. **`mergedAt`** when MERGED; **why it is still open** when OPEN (checks running / DIRTY /
   check-failed).
3. **The next planned action** — `/ace:update` run, restart needed, issue closed, blocked step
   re-run, or "nothing further."

Required shape:

```
Ship: PR #1465 state=MERGED mergedAt=2026-08-17T16:32:32Z
Next: /ace:update run in-session; no MCP change, so no restart needed.
```

"Auto-merge armed", "checks running", and "PR queued" are **not** terminal states and must never be
the last word on a turn. Armed-but-stuck is indistinguishable from merged to whoever reads the
report next, and the caller either re-polls by hand (defeating the point) or silently builds on
unmerged work. This is `canopy:agent-turn-review` § B applied to shipping: a done-claim gets
verified, not asserted.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `mergeStateStatus: DIRTY` | version-file conflict from a parallel worktree bump | `bash scripts/version-bump.sh --rebase-first && git push --force-with-lease`, re-enter Step 2. Aborts cleanly if a non-version file conflicts — those need human review. |
| `clean-install` FAILURE | real breakage | Read the log (`gh run view <id> --log-failed`) before touching the diff. Fix, push, re-enter Step 2. |
| `version-check` red, `clean-install` green | advisory only — not a required context | The PR can still merge. Fix the bump in a follow-up rather than blocking. |
| PR still `OPEN` after the bound | stuck, not slow | Report `state=OPEN` with `mergeStateStatus` and the failing check name. Do **not** reach for `--admin` — `enforce_admins` is on. |
| `gh pr create` errors | ambiguous — the PR may exist anyway | Confirm before retrying: `gh api repos/dimagi-internal/ace/pulls --jq '.[] | "#\(.number) \(.head.ref)"'`. Blind retry is how one branch gets two PRs. |

## MCP Tools Used

None. This skill is `git` + `gh` only.

## Mode Behavior

- **Auto / autonomous run:** run Steps 0–5 without prompting. Shipping is not a pause point — the
  PR is a CI checkpoint, not a review gate.
- **Review / interactive:** identical mechanics; the operator sees the Step 5 checkpoint line.
- **Dry-run:** stop after Step 1's `gh pr create`; do not arm auto-merge. Report `state=OPEN` and
  say auto-merge was deliberately not armed.

## Related skills

- `agent-turn-review` — gates the *report* about the merge, never the merge itself.
- `agents/orchestrator-reference.md § Fix-and-ship subagent template` — the dispatch wrapper that
  delegates its wait here.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-08-17 | Initial version. Created because ACE had no shipping skill and hand-rolled the wait every time — the canonical `until … sleep 30; done` template in `orchestrator-reference.md` prescribed a shape the harness blocks, and the fallback burned the full 10-min Bash timeout (`Exit code 143`) waiting on PRs that merge in ~70s. Modelled on `hal:shipping` (eva#154 lineage), adapted to ACE: real required check (`clean-install` only), auto-merge enabled, no merge queue, worktree + `/ace:update` + MCP-restart reconcile. Sleep-block mechanism corrected — it is the harness Bash contract, not a fleet gating rail (no `sleep` rule exists in any agent's `gating.json` or canopy's `gating-baseline.json`); reproducer captured inline. Adds the unconditional Step 5 ship checkpoint. | ACE team |
