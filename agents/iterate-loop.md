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

## The metric: a rolling window, NOT a frozen-version streak

**Read this before touching the loop.** The original design counted a stored
`streak` of consecutive clean runs "against a `plugin_version`", and zeroed it
on every autofix merge (restamping `plugin_version`). Exit was
`streak >= required_streak` (5).

That exit condition is unreachable in this repo, and it never fired. ACE merges
**~9 VERSION bumps/day** across parallel worktrees, so "5 consecutive clean
end-to-end runs with nothing merging underneath" demands a code freeze that
never happens. The improvement loop and the measurement loop invalidated each
other by construction: **every fix destroyed the evidence that things were
getting better.**

The replacement is structural, not a threshold tweak:

1. **Streak is derived, never stored.** `computeIterateHealth`
   (`lib/iterate-health.ts`) recomputes it from `iterations[]` on every read.
   There is no field for a merge to zero.
2. **The metric is a rolling pass rate over the last `window` iterations,
   version-agnostic.** Shipping a fix mid-window is *expected* — that's the
   point of the loop. `version_at_run` is recorded per iteration for
   **attribution** (`by_version` shows whether a specific bump made things
   worse), never as a gate.
3. **Success = `converged`**: the window is full AND `pass_rate >= pass_target`.
   Not a streak.

Never reintroduce a stored counter that a merge resets. If you find yourself
writing `streak = 0`, you are rebuilding the bug.

## State: `ACE/<opp>/iterate-state.yaml` (client-only)

Written and read ONLY by this procedure. The server-side run never touches it.
Validated by `validateIterateState` (`lib/run-state-validator.ts`).

```yaml
opp: bednet-spot-check
target_phases: [3, 6]          # 4 rides along as a dependency
golden_run_id: 20260601-1252
golden_validated_at_version: 0.13.772   # VERSION whose rubrics the golden PASSED
golden_validated_at: <ISO>              # absent/stale => treat as never validated
runner: web                    # web | local
plugin_version: 0.13.502       # informational attribution ONLY — never a gate
window: 10                     # rolling window: health read over the last N runs
pass_target: 0.8               # converged when pass_rate >= this over a full window
caps: { per_failure_class_fix: 2, max_iterations: 25 }
kill: false                    # operator kill-switch, checked each loop
iterations:
  - run_id: 20260601-1300
    started_at: <ISO>
    verdict: clean             # clean | dirty
    failure_class: null
    fix_pr: null
    version_at_run: 0.13.502   # attribution, not a gate
    seeded_prefix_defect: false # true => blocked by the FIXTURE, not by ACE
```

`streak` / `required_streak` may still appear in an older state file. They are
**legacy and ignored** — the validator warns on them. Never write them.

## Golden prefix resolution

If `--golden` is omitted: read `iterate-state.yaml.golden_run_id` (resume path)
or, on a first run with no state, **halt and ask the operator** to confirm a
golden run-id (per Task 5 of the plan — never silently pick a possibly-stale
run). The golden run must have `phases.idea-to-design` and
`phases.scenarios-and-acceptance` both `done`/`pass`.

## A golden is a snapshot that decays — mint it, don't inherit it

**The golden is not a durable asset.** Its phase-1/2 verdicts were written under
the rubrics in force the day it ran; every later eval tightening can turn it
into a permanent hard-fail that no amount of iterating will clear. That is not
hypothetical — `bednet-spot-check`'s golden `20260706-0649` recorded its PDD as
`pass`/7.7 on 2026-07-06 and became an `assessment_discrimination` hard-fail
weeks later, pinning the loop's strict pass rate at 0 for every iteration
seeded from it (dimagi-internal/ace#1031). The frozen `status: done` /
`verdict: pass` that the golden rule checks is exactly the thing that goes
stale, because it records a *past* judgement.

So: **status/verdict is a necessary check, never a sufficient one.**

### `--new-golden` (mint + validate + lock)

1. **Mint.** Create a run on the opp shaped `{idea-to-design,
   scenarios-and-acceptance: pending; 3–10: skipped}` and drive a plain
   `/ace:run <opp>/<new-run-id>` resume. Same structural-shape trick the loop
   uses for seeded runs — the resume path runs the `pending` phases and stops
   when none remain. Two phases, no Nova, no Connect, no device.
2. **Validate against TODAY's rubrics.** Confirm `idea-to-pdd-eval`,
   `pdd-to-test-prompts-eval` and `pdd-to-app-journeys-eval` all `pass` at the
   current plugin VERSION. **Refuse to lock on any failure** and report which
   dimension failed — a golden that cannot pass today's evals will fail every
   iteration seeded from it, and locking it anyway just relocates the failure
   to somewhere more expensive.

2b. **Probe the DOWNSTREAM gate too — phase-1/2 evals cannot see the eval that
   actually kills goldens.** The failure that pinned `bednet-spot-check` at 0
   was `pdd-to-learn-app-eval`'s `assessment_discrimination` hard-gate — a
   **Phase 3** eval. It grades the app built FROM the seeded PDD, but what it
   is really judging is the *PDD's own quiz items*, which are frozen in the
   golden. So a golden can pass every phase-1/2 eval and still hard-fail every
   iteration seeded from it. Checking only steps 1–2 reproduces the exact bug
   this command exists to prevent.

   Run a **blind-guess probe** on the golden PDD's Learn assessment before
   locking: give a fresh context ONLY the item stem and its options — no
   teaching content, no answer key — and record what it picks. Repeat a few
   times per item. `guessable_ratio` = (items answered correctly cold) /
   (total items); the hard gate fires at **>= 0.80**.

   Measured on `bednet-check-2-visit/20260813-1639` (3 trials/item): item 1
   ("How do you earn money on Connect?") was picked correctly **3/3 cold** —
   as guessable as the single item that killed the old golden. Item 2 ("which
   visit earns the payment?") drew the **wrong** answer 3/3, because the
   payable visit is a program-specific fact stated only in the teaching
   content. Ratio 0.50 → passes.

   The structural lesson: **a one-item Learn quiz cannot pass this gate.** At
   n=1 the ratio is 1.00 or 0.00 with nothing in between (ace#1042), so a
   single guessable item is fatal while a second, genuinely program-specific
   item halves the ratio. If a golden's PDD carries only one assessment item,
   treat that as a lock failure and fix the PDD, not the rubric.
3. **Archive, don't delete.** If an `iterate-state.yaml` exists, rename it to
   `iterate-state-legacy-<YYYYMMDD>.yaml` beside it. History is append-only;
   dropping dirty runs to flatter the number is the failure this loop exists to
   detect. Archiving keeps the record while making clear the runs measured a
   different fixture.
4. **Write fresh state** — `iterations: []`, the new `golden_run_id`,
   `golden_validated_at_version`, `golden_validated_at`, and a note naming why
   the prior history was retired.

**`--new-golden` IS the reset — there is no separate `--reset` flag.**
Iterations seeded from golden A are not comparable to iterations seeded from
golden B, so replacing the fixture MUST archive the history. Making that one
operation rather than two removes the state the spot-check loop is in today: a
fixture nobody trusts and a window still counting against it.

`golden_validated_at_version` is written and read here but is **not yet
schema-enforced** by `validateIterateState` — adding it there changes the
`validate_run_state` MCP atom, which needs a full Claude restart to take
effect. Treat a missing value as "never validated", not as "valid".

## Loop

0. **Init / resume.** Read or create `iterate-state.yaml`; validate it loads
   under `validateIterateState`. Read the live plugin version (web: poll the
   ace-web system version endpoint; local: `cat VERSION`). Stamp
   `plugin_version` — for the record only; it gates nothing.
1. **Kill check.** If `kill: true`, stop and report.
2. **Health check.** Compute health and print the one-liner:
   ```bash
   npx tsx -e "
   import {computeIterateHealth} from './lib/iterate-health.js';
   import {readFileSync} from 'node:fs'; import {parse} from 'yaml';
   const s = parse(readFileSync(process.argv[1],'utf8'));
   const h = computeIterateHealth(s.iterations ?? [], {window: s.window, pass_target: s.pass_target});
   console.log(h.summary); console.log(JSON.stringify(h, null, 2));
   " <path-to-local-copy-of-iterate-state.yaml>
   ```
   **Check `h.halt` FIRST — before `h.verdict`.** A non-null `halt` means more
   iterations cannot clear what is blocking:
   - `stale-golden` → stop and tell the operator to re-mint
     (`/ace:iterate <opp> --new-golden`). Do NOT keep seeding from a fixture
     that has already blocked `unfixable_class_cap` runs.
   - `unfixable-class` → stop and surface the class. It has recurred with no
     fix ever landing, so the autofix subagent is not reaching it.

   This is the check the old per-failure-class cap could not make: that cap
   counts iterations *with* a `fix_pr`, so a class that is never fixable at all
   never trips it and burns the whole budget.

   Then branch on `h.verdict`:
   - `converged` → success, go to Exit.
   - `insufficient-data` / `not-converged` → continue.

   Then the hard cap: if `len(iterations) >= caps.max_iterations` →
   halt-and-surface.

   **Set `seeded_prefix_defect: true` on any iteration whose only blocking
   criterion is an artifact frozen in the golden** (a phase-1/2 eval failing on
   the seeded PDD, not on anything this iteration built). That flag is what
   feeds `blocked_by_golden` and the `stale-golden` halt; without it a decayed
   fixture reads as a regressing system.

   **Print `h.summary` every pass, and report it in the final message even on a
   halt.** A halted loop that reports "6/10 clean (60%), trend regressing, top
   failure class X ×3" is a useful reading; a halted loop that reports only
   "stopped at the cap" is the old failure mode in a new costume.
2c. **Every seeded run is headless — say so in the dispatch.** The run
   must never end its turn by asking the operator anything; there is
   nobody to answer, so a question silently costs the rest of the run
   (dimagi-internal/ace#1248, which ate a whole iteration after Phase 3
   had already passed every step). `ace-orchestrator.md § Modes` carries
   the invariant for `mode: auto`; restate it in the dispatch prompt
   along with any decision this campaign has already made — in
   particular **run the phase evals rather than accepting a
   `passed-with-deferred-evals` partial**, since the loop's own judge
   requires the phase verdicts to be `pass` and a partial scores the
   iteration dirty for a reason unrelated to what it was measuring.

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
     `app-screenshot-capture_verdict-shallow.yaml` are all `pass`
     **AND the outcome is confirmed SERVER-SIDE, not from the device** —
     `connect_get_deliver_progress({ domain, opportunity_id })` shows the ACE
     test user with **`approved >= 1`**.

     **Why the server-side term is not optional (dimagi-internal/ace#1066).**
     Every other clause above is satisfiable by a run in which the delivery
     never left the handset. `journey-deliver` returning `pass` proves only
     that the form walked and finalized locally; the plain-form
     `nav_btn_next` branch writes to the local outbox and asserts nothing
     about Connect. Observed live on bednet-spot-check/20260729-1239: the
     Phase 6 shallow verdict was `pass` while the device read `Daily Visits
     0/5` / `last synced: never`. Without this term the loop's headline
     number can climb while the thing the opportunity exists to prove — a
     worker submitted a visit and a payment unit registered — is never
     verified even once. That is exactly the eval-inflation failure this
     loop was built to detect, so it must not live inside the loop's own
     pass criteria.

     Use `approved`, not `delivered`: a delivery can be submitted and then
     **rejected** by verification, so `delivered >= 1` proves transmission
     but not payability, and `app-test-cases.yaml` declares the criterion as
     *"one payment unit registers"*. Record `delivered` / `approved` /
     `rejected` in the iteration entry either way — a run that is
     `delivered >= 1, approved == 0` is **dirty**, with `failure_class`
     naming verification rejection rather than a recipe defect, because the
     walk did its job and the opportunity's wiring did not.
   - **dirty** otherwise. Derive `failure_class` =
     `<failing-skill>: <first failing check + first 200 chars of the
     verdict/transcript>`.
6. **Record** the iteration in `iterate-state.yaml` (append to `iterations`,
   stamp `version_at_run` and `failure_class`). This append is the ONLY state
   mutation the loop makes to its own metrics — there is no counter to update.
7. **Branch:**
   - **clean** → go to 1. (Health recomputes itself at step 2; nothing to
     increment.)
   - **dirty** → run **Autofix** (below); go to 1.

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
4. `gh issue create` against the ACE repo's `origin` (no `-R` needed) (one per distinct finding — the
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
- Stamp `plugin_version` = merged VERSION. **Do not touch any streak or
  pass-rate field** — the merge is a normal event mid-window, not a reason to
  discard history. Iterations before and after the bump both stay in the
  window; `by_version` is what tells you whether the bump helped or hurt.

**If the subagent returns DIRTY-after-rebase-exhausted or CHECK-FAILED**, halt-
and-surface with the PR URL + the failing check name — the operator decides
whether to escalate.

## Exit

Every exit path reports `h.summary` plus the full health block — the number is
the deliverable, not a footnote.

- **Success** (`h.verdict == 'converged'`): report the pass rate over the
  window, `by_version` (which versions the clean runs landed on — they will
  differ, and that's correct), `longest_streak`, and the run-ids. Point the
  operator at `/ace:sweep drive,connect,ocs,hq,opp-runs` to reclaim the
  per-iteration Connect opps / Nova apps / OCS chatbots / run folders.
- **Halt** (cap hit, kill flag, or unfixable failure class): report the health
  block anyway — `pass_rate`, `trend`, `top_failure_classes`, `by_version` —
  plus the last `failure_class` and any open issues/PRs. A halt with a readable
  number is a successful measurement of an unconverged system; that is a real
  result and should be reported as one.
- **Not yet readable** (`insufficient-data` when the operator stops the loop):
  say how many more runs the window needs (`h.runs_until_readable`). Do not
  round an unfilled window up to a verdict.

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
