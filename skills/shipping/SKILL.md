---
name: shipping
description: >
  Ship an ACE change: branch → PR → wait → merge → verify it landed.
  Use whenever a turn opens, waits on, or merges a PR — the wait is
  never a hand-rolled foreground sleep loop.
disable-model-invocation: false
---

# Shipping — ACE (stub over the fleet-canonical core)

How an ACE change gets from a worktree edit to merged `main`, and specifically **how to wait for
the PR without burning the turn**. The procedure is fleet-wide; this stub binds it to ACE.

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE` → tell the human and run `/canopy:update` BEFORE following a stale core.
2. **Read `$CANOPY/agent-core/shipping.md`** and **follow it exactly**, bound to the ACE facts
   below. Step 0 (does this repo even have PR checks?) is the step that pays — run it before any
   wait. Step 3's ship checkpoint is unconditional.

Every ACE agent that opens a PR delegates here: the orchestrator's fix-and-ship dispatches, the
self-heal convention (`CLAUDE.md § Self-heal a filed issue`), `iterate-loop`, and any turn that
lands a repo change. Do not reimplement the wait inline.

## ACE repo facts (measured 2026-08-17 — the core's Step 0 row for this repo)

| Fact | Value | Re-derive |
|---|---|---|
| Workflows on `pull_request` | `clean-install.yml`, `version-check.yml` | `grep -l pull_request .github/workflows/*` |
| **Required** check | **`clean-install` only** | `gh api repos/dimagi-internal/ace/branches/main/protection --jq .required_status_checks.contexts` |
| `enforce_admins` | `true` — no `--admin` force-merge | same call, `.enforce_admins.enabled` |
| Auto-merge | **enabled** | `gh api repos/dimagi-internal/ace --jq .allow_auto_merge` |
| Merge queue | **none** | same call, `.merge_queue_enabled` is `null` |
| Typical create → merge | **~70 seconds** | `gh pr list --state merged --limit 5 --json number,createdAt,mergedAt` |

`version-check` runs on every PR but is **not** required — a red `version-check` will not block the
merge, so read it rather than assuming the merge is stuck on it.

## The ACE ship loop

```bash
bash scripts/version-bump.sh          # worktree-safe: max(local, origin/main) + 1
git add -A && git commit -m "<type>(<scope>): <what>"
git push -u origin "$(git branch --show-current)"
gh pr create --fill                   # origin is the ACE repo; no -R needed
gh pr merge <N> --auto --merge        # arm it, then wait per the core's Step 1
```

Arm auto-merge in the same breath as creating the PR — once armed there is no review gate, so
everything between arming and merging is waiting.

## ACE-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)

- **Post-merge is mandatory: run `/ace:update` in this session.** Without it this session runs
  stale code while new sessions get the bump. This is ACE's instance of the core's "reconcile the
  running session" step.
- **Touched `mcp/`, or ran `/ace:setup --force-env`? Quit and reopen Claude Code.**
  `/ace:update` + `/reload-plugins` do NOT respawn MCP subprocesses — they bind their tool list,
  schemas, and env at spawn. See `CLAUDE.md § MCP changes need a full Claude restart`. Otherwise
  `/reload-plugins` is enough.
- **Version collision** (`mergeStateStatus: DIRTY` from a parallel worktree bump) — **disarm
  auto-merge FIRST, or the recovery races the merge and silently loses** (ace#1593):
  ```bash
  gh pr merge <N> --disable-auto              # STOP the race before touching the branch
  bash scripts/version-bump.sh --rebase-first # auto-resolves the 4 version files
  git push --force-with-lease
  gh pr merge <N> --auto --merge              # re-arm only after the corrected VERSION is pushed
  ```
  Then re-enter the wait. `--rebase-first` aborts cleanly if a non-version file conflicts — those
  need human review.

  **ONE pass often loses the race — use `scripts/land-pr.sh <pr>` rather than doing this by
  hand.** The block above is correct and incomplete: it assumes that by the time you have
  rebased, `main` has not moved again. Measured 2026-09-05 on PR #1962, `main` merged at 06:45,
  06:47, 06:57, 07:13, 07:14, 07:19 and 07:21 — every 2-4 minutes, several sibling sessions
  shipping at once — while a rebase plus `clean-install` takes 1-3 minutes. That PR returned to
  DIRTY twice; four PRs in one session hit it. The script is this recipe in a bounded retry loop,
  and it keeps the disarm/re-arm ordering above, which a hand-rolled loop forgot on the first
  attempt (it landed anyway, purely because CI had not yet greened the pre-rebase head — luck,
  not method). *Enforced:* `test/scripts/land-pr.test.ts` ratchets the disarm-before-rebase
  order; `test/scripts/land-pr-refspec.test.ts` ratchets that the push targets the PR's
  `headRefName` rather than the local branch name (ace#1974 — a bare `HEAD` refspec pushed a
  stray branch and exited 0, so the script re-armed a PR it had not updated). It still does not
  excuse you from reading the merge state yourself afterwards.

  **Why the disarm step is load-bearing.** Auto-merge stays armed while you rebase, and
  `clean-install` (the only REQUIRED check) can go green on the **pre-rebase head** first. The
  merge then wins the race and your `--force-with-lease` is a no-op against an already-merged
  branch. The PR lands carrying the OLD version, `main` shows the same VERSION before and after,
  and because the plugin cache is keyed by version, `/ace:update` can never reach the change.
  Measured 2026-08-24: 4 of ~20 PRs in one sweep collided; the 3 that left auto-merge armed all
  needed a follow-up bump PR (#1597, #1598, #1588); the 1 that disarmed first (#1601) did not.
  `check-version` does NOT save you here — it is advisory, not required.
- **After ANY merge, verify the version actually advanced** — `state: MERGED` is not sufficient:
  ```bash
  git fetch origin main -q && git show origin/main:VERSION
  ```
  If it did not advance past your base, ship an immediate follow-up bump PR and say so in your
  report. An agent that trusts `state=MERGED` alone will report success and leave an unreachable
  fix on `main` (ace#1593).
- **From a worktree, drop `--delete-branch`** — `main` is checked out elsewhere.
- **Shipped into CANOPY? Reinstall the canopy CLI before your next email send.** Merging a
  canopy PR bumps the marketplace clone's VERSION, and the send path is the **`uv`-installed
  `canopy`**, not the plugin cache — so the moment your own bump lands, the installed engine
  lags the clone and `canopy email send` refuses at send-time with an engine-staleness error.
  A turn that ships a canopy fix and *then* tries to reply breaks its own send path, and the
  error names versions rather than the merge that caused it, so it reads as unrelated:
  ```bash
  (cd ~/.claude/plugins/marketplaces/canopy && git pull) \
    && uv tool install --reinstall ~/.claude/plugins/marketplaces/canopy
  canopy --version    # must equal the clone's VERSION
  ```
  `/ace:doctor`'s `canopy_email_engine` probe reports the gap and prints this same command;
  the point of the note is that shipping to canopy is what CREATES the gap, so do it after the
  merge rather than discovering it at the send. (Measured this turn, 2026-09-05: the machine
  started at CLI 0.2.471 vs clone 0.2.472 with the send already blocked; merging canopy#609
  moved the clone to 0.2.473 and would have re-blocked it a second time.)
- **Self-heal PRs additionally close their issue** referencing the PR, then re-run the blocked
  step (`CLAUDE.md § Self-heal a filed issue`).

## MCP Tools Used

None. `git` + `gh` only.

## Mode Behavior

- **Auto / autonomous run:** run the full loop without prompting. Shipping is not a pause point —
  the PR is a CI checkpoint, not a review gate.
- **Review / interactive:** identical mechanics; the operator sees the ship checkpoint line.
- **Dry-run:** stop after `gh pr create`; do not arm auto-merge. Report `state=OPEN` and say
  auto-merge was deliberately not armed.

## Related skills

- `agent-turn-review` — gates the *report* about the merge, never the merge itself.
- `agents/orchestrator-reference.md § Fix-and-ship subagent template` — the dispatch wrapper.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-08-17 | Initial version. Created because ACE had no shipping skill and hand-rolled the wait every time — the canonical `until … sleep 30; done` template in `orchestrator-reference.md` prescribed a shape the harness blocks, and the fallback burned the full 10-min Bash timeout (`Exit code 143`) waiting on PRs that merge in ~70s. | ACE team |
| 2026-08-17 | **Converted to a stub over `canopy agent-core/shipping.md`** (canopy #498). The mechanics were fleet-shared — hal, eva and ACE had each written their own copy — so they were promoted to a first-class agent-core body alongside `turn.md` / `task-tracker.md`, and `turn.md`'s duplicated block was cut (444 → 399 lines). What stays here is only what is ACE-specific: the measured Step 0 row, the version-bump loop, `/ace:update` + the MCP-restart rule, and the `--rebase-first` collision recipe. Fleet-process changes now go to canopy, not here. | ACE team |
