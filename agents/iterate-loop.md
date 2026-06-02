---
name: iterate-loop
description: >
  Client-side ACE iteration control. Observes first-class seeded runs,
  judges clean/dirty, maintains an N-in-a-row streak, and autonomously
  fixes+ships+refreshes on dirty. Runs at level 0 (dispatches Agent).
model: inherit
---

# iterate-loop (Procedure Document)

Level-0 procedure executed inline by `/ace:iterate`. **NEVER dispatched as a
subagent** — it dispatches `Agent` for the fix+ship cycle, and the `Agent` tool
is unavailable to subagents (see `CLAUDE.md § Agent topology`).

## Invariant: server runs first-class, client observes

The runner executes a **plain resume** — `/ace:run <opp>/<new-run-id>` against a
run that was already forked + shaped (`{3,4,6: pending, 5/7/8+: skipped}`)
before dispatch. It's an ordinary resume that writes a normal `run_state.yaml`;
run shape lives in that file, NOT in a `--seed-from`/`--only` flag (the headless
runner ignored those — jjackson/ace#672). This procedure reads the
`run_state.yaml` + the Claude session transcript and does ALL loop
interpretation (judging, streak, autofix). Never push streak/judge/autofix
logic into the run itself — that would leak loop-awareness into the
first-class operation and break its run-anywhere property. The seeding
(fork-then-shape) is loop-agnostic too — it's just "create a run that starts at
phase 3" — so the run the runner sees is a normal mid-pipeline resume.

## State: `ACE/<opp>/iterate-state.yaml` (client-only)

Written and read ONLY by this procedure. The server-side run never touches it.
Validated by `validateIterateState` (`lib/run-state-validator.ts`).

```yaml
opp: bednet-spot-check
target_phases: [3, 6]          # 4 rides along as a dependency
golden_run_id: 20260601-1252
runner: web                    # web | local
plugin_version: 0.13.502       # version the current streak is counted against
streak: 0
required_streak: 5
caps: { per_failure_class_fix: 2, max_iterations: 25 }
kill: false                    # operator kill-switch, checked each loop
iterations:
  - run_id: 20260601-1300
    started_at: <ISO>
    verdict: clean             # clean | dirty
    failure_class: null
    fix_pr: null
    version_at_run: 0.13.502
```

## Golden prefix resolution

If `--golden` is omitted: read `iterate-state.yaml.golden_run_id` (resume path)
or, on a first run with no state, **halt and ask the operator** to confirm a
golden run-id (per Task 5 of the plan — never silently pick a possibly-stale
run). The golden run must have `phases.idea-to-design` and
`phases.scenarios-and-acceptance` both `done`/`pass`.

## Loop

0. **Init / resume.** Read or create `iterate-state.yaml`; validate it loads
   under `validateIterateState`. Read the live plugin version (web: poll the
   ace-web system version endpoint; local: `cat VERSION`). Stamp
   `plugin_version`.
1. **Kill check.** If `kill: true`, stop and report.
2. **Cap check.** If `streak >= required_streak` → success, go to Exit. If
   `len(iterations) >= caps.max_iterations` → halt-and-surface.
3. **Launch a seeded run** on the runner. Run shape is created by
   **fork-then-resume** (NOT a flag): fork the golden into a new run whose
   `run_state.yaml` already encodes `{seed prefix 1,2: done/verdict:seeded;
   targets 3,4,6: pending; gap+tail 5,7,8,9,10: skipped}`, then drive a plain
   resume. The orchestrator's resume path runs the `pending` phases in order,
   steps over `skipped`, and ends when no `pending` phase remains — so "run
   only 3,4,6 then stop" is structural (§ ace-orchestrator.md § Run shape on
   resume).
   - **web**: POST the **workspace-scoped** `seeded-run` action — it forks +
     shapes the new run + injects the plain resume command, all server-side,
     and drives it headlessly. First resolve the workspace slug:
     `GET <ACE_WEB_BASE_URL>/api/workspaces` (Bearer `ACE_WEB_PAT_TOKEN`) → the
     workspace whose `drive_root_folder_id` matches the ACE root (for
     labs/`dimagi-team` this is the only one). Then:
     `POST <ACE_WEB_BASE_URL>/api/w/<ws>/opps/<opp>/actions/seeded-run`
     with `{"golden_run_id": "<golden>", "only": "3,4,6"}`. Returns **202**
     `{session_slug, assistant_message_id, run_id}` — `run_id` is the **new**
     forked run the action minted (use it directly; do NOT list `runs/` to
     guess it). The action seeds the resume command as a user turn AND starts
     the run headlessly (no workbench needed; ace-web#585). The endpoint is
     also an MCP tool (`x-mcp-expose`) if reaching it via MCP.
   - **local**: do the fork + shape + resume yourself, since no ace-web run
     subprocess is involved:
     1. **Fork** the golden into a fresh run via the `fork-run` skill:
        `fork-run --opp_slug <opp> --from_run_id <golden_run_id>
         --from_skill pdd-to-learn-app --mode keep-all
         --feedback "iterate seeded run (targets 3,4,6)"`. (`pdd-to-learn-app`
        is the first skill of Phase 3 = `min(targets)`; this copies phases 1–2
        in.) Capture the returned `new_run_id`.
     2. **Shape** the new run's `run_state.yaml` via `update_yaml_file` so its
        `phases.*.status` encodes the run: seed prefix (`idea-to-design`,
        `scenarios-and-acceptance`) → `status: done, verdict: seeded,
        completed_at: <now>`; targets (`commcare-setup`, `connect-setup`,
        `qa-and-training`) → `status: pending`; gap+tail (`ocs-setup`,
        `synthetic-data-and-workflows`, `solicitation-management`,
        `execution-management`, `closeout`) → `status: skipped`. Also set
        `seeded_from: <golden_run_id>` at the run-state root. (Pass the COMPLETE
        `phases` block so the merge replaces the forked default cleanly.)
     3. **Resume**: spawn a plain `/ace:run <opp>/<new_run_id>` (fresh local
        `claude -p` / subagent). No flags. The resume path drives the shape.
   Either way the loop's new run-id is known up-front (the action's `run_id`, or
   the local `fork-run` result) — no post-launch folder-listing race.
4. **Observe** until phases 3 + 6 reach a terminal state — the loop's only
   inputs, both produced by the run itself:
   - Poll `ACE/<opp>/runs/<new-run-id>/run_state.yaml` on Drive.
   - Read the Claude session transcript for progress + failure detail
     (web: `GET /api/w/<ws>/sessions/<slug>/messages`; local: the `.jsonl`).
5. **Judge** (client-side interpretation of the standard verdicts):
   - **clean** iff `classifyPhaseWriteBack(run_state, 'commcare-setup') == 'ok'`
     AND `classifyPhaseWriteBack(run_state, 'qa-and-training') == 'ok'` AND the
     Phase 3 verdicts (`app-release-qa`, `app-connect-coverage`,
     `pdd-to-learn-app-eval`, `pdd-to-deliver-app-eval`) and the Phase 6
     `app-screenshot-capture_verdict-shallow.yaml` are all `pass`.
   - **dirty** otherwise. Derive `failure_class` =
     `<failing-skill>: <first failing check + first 200 chars of the
     verdict/transcript>`.
6. **Record** the iteration in `iterate-state.yaml` (append to `iterations`,
   stamp `version_at_run`).
7. **Branch:**
   - **clean** → `streak += 1`; go to 1.
   - **dirty** → `streak = 0`; run **Autofix** (below); go to 1.

## Autofix (on dirty — always local, against the ACE checkout)

**Per-failure-class cap.** If this `failure_class` has already been fixed
`caps.per_failure_class_fix` times (count matching `iterations[].failure_class`
with a non-null `fix_pr`), halt-and-surface — don't churn versions on a fix
that isn't landing the class.

Dispatch ONE `Agent` (a level-1 fix+ship subagent) with the failing verdict's
Drive `fileId` + the transcript excerpt **inline** (do NOT paraphrase — see
`orchestrator-reference.md § On phase retry, pass the verdict fileId inline`).
The subagent:

1. Root-causes via the `investigate` skill (Iron Law: no fix without root
   cause).
2. Makes the **minimal** fix in the failing skill / recipe / atom.
3. Ships per the canonical poll-loop
   (`orchestrator-reference.md § Fix-and-ship subagent template`):
   `bash scripts/version-bump.sh` → commit → push → `gh pr create` →
   `gh pr merge <pr> --auto --merge` → **poll until terminal state**
   (MERGED / DIRTY / CHECK-FAILED).
4. `gh issue create` against `jjackson/ace` (one per distinct finding — the
   "file ACE issues mid-run" rule).
5. Returns: PR URL, final state, merged VERSION (if MERGED), issue URL.

**After the subagent returns MERGED:**
- **Refresh the runner to the new plugin version** ("trigger a plugin update
  across all tasks"):
  - **web**: `POST <ACE_WEB_BASE_URL>/system/refresh-plugin`; poll the ace-web
    system version endpoint until it reports the merged VERSION across runner
    tasks.
  - **local**: `/ace:update` (the next fresh local run binds the new code; if
    the fix touched `mcp/`, a full Claude restart is required — halt-and-surface
    that, since this session can't restart itself).
- Stamp `plugin_version` = merged VERSION. `streak` is already 0.

**If the subagent returns DIRTY-after-rebase-exhausted or CHECK-FAILED**, halt-
and-surface with the PR URL + the failing check name — the operator decides
whether to escalate.

## Exit

- **Success** (`streak == required_streak`): report the N clean run-ids + the
  stable VERSION they all ran on. Point the operator at
  `/ace:sweep drive,connect,ocs,hq,opp-runs` to reclaim the per-iteration
  Connect opps / Nova apps / OCS chatbots / run folders.
- **Halt** (cap hit, kill flag, or unfixable failure class): report the current
  state, the last `failure_class`, and any open issues/PRs.

## Notes

- The control's own orchestration tools are the gdrive MCP + `gh` + the ace-web
  API. A shipped fix to a *phase* skill/recipe/atom does not affect the
  control; a fix to a skill the control itself uses (`fork-run`, gdrive MCP)
  may — run `/ace:update` between fixes if the control's own surface changed.
- `--runner local` does not require ace-web for *execution* (the resume runs in
  a local process), but the **seed step still calls the ace-web fork endpoint**
  (via the `fork-run` skill — the shipped fork path); the local control then
  shapes `run_state.yaml` and spawns the plain resume. A pure-local fork
  (manual phase-folder copy per `orchestrator-reference.md § Fork at phase
  boundary`) is a possible future fallback.
- **Web vs local seeding parity.** On `web`, the `seeded-run` action does the
  fork + shape + plain-resume server-side and returns the new `run_id`. On
  `local`, this procedure does the same three steps client-side. Both end at an
  identically-shaped `run_state.yaml` driven by the orchestrator's resume path —
  the runner only ever sees a plain `/ace:run <opp>/<run-id>`. Neither passes a
  `--seed-from`/`--only` flag (jjackson/ace#672).
