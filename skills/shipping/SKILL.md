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
- **Version collision** (`mergeStateStatus: DIRTY` from a parallel worktree bump):
  `bash scripts/version-bump.sh --rebase-first && git push --force-with-lease`, then re-enter the
  wait. It auto-resolves the 4 version files and aborts cleanly if a non-version file conflicts —
  those need human review.
- **From a worktree, drop `--delete-branch`** — `main` is checked out elsewhere.
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
