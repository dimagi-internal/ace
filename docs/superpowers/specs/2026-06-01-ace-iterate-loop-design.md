# ACE Iteration Loop — `/ace:iterate` design

**Date:** 2026-06-01
**Status:** Design — pending implementation plan
**Author:** ACE (with Jonathan Jackson)

## Problem

Phases 3 (commcare-setup: Nova build → deploy → release) and 6 (qa-and-training:
mobile app QA + recipe/selector work) are where ACE runs keep failing, and the
operator is stuck in mechanical loops: run the pipeline, hit the same Phase-3 or
Phase-6 class, fix code, re-run the whole expensive pipeline to get back to the
failing phase. We want a tight, mostly-autonomous loop that exercises **only**
phases 3 and 6 (with 4 riding along as a dependency), reuses a frozen upstream
prefix as a proxy, and runs until we get **5 clean runs in a row** on one
unchanged plugin version.

`bednet-spot-check` (one-question Learn, one-question Deliver) is the loop
fixture — the cheapest possible app, so each iteration pays the minimum.

## Why the loop shape is forced (not a free choice)

Two CLAUDE.md constraints mean you **cannot** freeze Phase 3/4 and re-loop only
Phase 6:

1. **Connect Learn-completion is one-way per `(test-user, opp)`.** A *clean*
   Phase-6 pass completes Learn, consuming the opp. Five clean runs ⇒ five fresh
   opps.
2. **One `DeliverUnit` is shared across opps wired to the same released Deliver
   app (`cc_app_id`)** (jjackson/ace#573). A fresh opp needs a fresh Deliver
   release ⇒ a fresh `cc_app_id` ⇒ Phase 3 must run fresh each iteration.

So the **minimal honest iteration** is: `proxy(1,2) → run 3 → run 4 → run 6`,
skipping 5 and 7, never touching 8–10. Phase 4 is a dependency of 6, not a
target. Phase 6's app-QA path doesn't need OCS (only the training docs reference
the chatbot URL), so Phase 5 is skipped and Phase 6 runs in **app-QA-only mode**.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Form factor | Reusable `/ace` command(s) + a path-agnostic single-iteration skill |
| Dirty-run behavior | **Autonomous self-fix** (investigate → fix → ship → refresh → resume) |
| Clean bar | Phase 3 verdicts pass (`app-release-qa` + `app-connect-coverage` + `pdd-to-*-app` evals) **AND** Phase 6 shallow app-QA passes |
| Execution | **Path-agnostic.** Same skill runs local or on ace-web. Web is the default *observable* runner |
| Plugin freshness | `POST /system/refresh-plugin` fan-out on ace-web (re-runs `refresh-ace-plugin.sh` across running tasks) — **no image rebuild** |
| Golden prefix | Establish/curate a fresh, current-schema golden (Phase 1 PDD + Phase 2 scenarios), lock it, fork every iteration from it |

## Architecture

Two principles drive the shape:

1. **Path-agnostic core.** The unit of work is one skill that runs identically on
   a laptop or inside an ace-web `claude -p` subprocess. It has no
   local-vs-web knowledge.
2. **Web is just the observable runner.** ace-web already drives runs via
   `claude -p` (CLIBackend + turn_driver) and exposes the run state on Drive +
   a version endpoint. The loop control offloads run *execution* to it for
   observability, but the loop *brain* and the autofix live in the local
   control.

**Hard separation of concerns — this is the load-bearing invariant:**

- **The server runs ONE first-class, self-contained run operation.** It is told
  "do a run that starts at phase 3, substituting phases 1–2 from golden run G."
  It does the substitution at run-setup, executes phases 3→4→6 like any normal
  run, and writes the **normal `run_state.yaml`** with normal per-phase verdicts.
  It has **zero** awareness of the loop: no streak, no clean-bar, no
  judging-for-the-loop, no autofix, and it never reads `iterate-state.yaml`. It
  thinks it's an ordinary run that happens to start mid-pipeline with a seeded
  prefix. This is exactly what makes it runnable anywhere (local or web)
  unchanged.
- **The client only observes + drives the loop.** It launches the first-class
  run on a runner, then reads two things the run already produces: the
  `run_state.yaml` verdicts (on Drive) and the Claude session transcript
  (progress + failure detail). From those observations it *interprets*
  clean/dirty, owns the streak, runs autofix, triggers `refresh-plugin`, and
  launches the next run. All loop intelligence lives here.

```
SERVER (runner — local or ace-web): one first-class operation, loop-blind
  /ace:run <opp> --seed-from <golden-run-id> --start-phase 3   [--only 3,4,6]
    setup: copy golden phases 1-2 into the new run (fork mechanic), mark done
    run:   execute phases 3 → 4 → 6  (Phase 6 = app-QA-only)
    write: normal run_state.yaml verdicts   ← the only output the client reads

CLIENT (/ace:iterate <opp> — LOCAL control, level-0): observer + loop brain
  loop:
    1. launch the first-class run on the runner (web: trigger; local: spawn)
    2. OBSERVE: poll run_state.yaml + read the Claude session transcript
    3. JUDGE clean/dirty from observed verdicts (client-side interpretation)
    4. clean → streak++   |   dirty → streak=0 + AUTOFIX (fix → ship → refresh)
    5. record observation in iterate-state.yaml (CLIENT-ONLY log)
    6. stop when streak == 5  (or cap/kill)
```

### Components

#### 1. First-class "seeded run" capability (`/ace:run`, server-side, loop-blind)
`/ace:run` gains two composable flags so "start mid-pipeline with a golden
upstream prefix" is a **first-class run operation**, independently useful for
manual re-runs — not loop plumbing:

- `--seed-from <golden-run-id>` — at run-setup, substitute the phases *before*
  the start phase by copying them from the golden run (the existing fork/copy
  mechanic: copy `<N>-<phase>/` folders + the matching
  `phases.<phase>.products.*` blocks into the new run's `run_state.yaml`, mark
  them `done`). Reuses `fork-run`'s server-side Drive copy.
- `--start-phase <N>` / `--only <phases>` — execute exactly the listed phase
  ordinals (here `3,4,6`); skip the rest; never run anything outside the
  allowlist. Phase-boundary fence + write-back contract still apply to the
  phases that run, and the orchestrator **fails loud** if the allowlist leaves a
  run-phase's required input unproduced.
- Phase 6 runs in **app-QA-only mode** (mobile app QA; skip the OCS-dependent
  training-doc skills) when OCS (Phase 5) is not in the allowlist.

Lives in `agents/ace-orchestrator.md` + `commands/run.md`. **Runner-agnostic and
loop-blind**: the run writes only the normal `run_state.yaml`. This is the
*entire* server-side surface — there is no iteration-specific skill on the
runner.

#### 2. (removed)
There is intentionally **no** `/ace:iterate-once` skill on the runner. Folding
judging + loop-state into a server-dispatched skill would leak loop-awareness
into the server. Judging is a client-side *interpretation* of the standard
verdicts the first-class run already writes.

#### 3. `/ace:iterate` (CLIENT control — observer + loop brain + autofix)
`commands/iterate.md` + `agents/iterate-loop.md` (level-0 procedure doc — must
be level-0 because it dispatches `Agent` for the fix+ship subagent, per
CLAUDE.md agent topology). This is the **only** loop-aware code, and it runs
on the client. Per iteration:

- **Launch** the first-class seeded run on the selected runner
  (`--runner web` default | `local`):
  - **web**: trigger ace-web (new `run-phases` action, or existing
    working-session message-inject) to run
    `/ace:run <opp> --seed-from <golden> --only 3,4,6`.
  - **local**: spawn the same first-class run (fresh local `claude -p` /
    subagent). Identical operation.
- **Observe** (the loop's only inputs — both are things the run already
  produces): poll `runs/<new-run-id>/run_state.yaml` on Drive until phases 3+6
  reach terminal; read the Claude session transcript (web: `/sessions/<slug>/
  messages`; local: the session `.jsonl`) for progress + failure detail.
- **Judge** clean/dirty — a client-side interpretation of the observed
  verdicts: clean iff Phase 3 producer/eval verdicts pass
  (`app-release-qa` + `app-connect-coverage` + `pdd-to-*-app` evals) AND Phase 6
  shallow app-QA verdict passes. On dirty, derive `failure_class` from the
  failing verdict + transcript.
- **Streak**: `streak++` on clean; `streak = 0` on dirty **or** on any plugin
  refresh. Stop at `streak == 5`.
- **Autofix on dirty** (always local, against the ACE checkout):
  1. `investigate` (root-cause; Iron Law: no fix without root cause).
  2. Minimal fix in the failing skill / recipe / atom.
  3. `scripts/version-bump.sh` → commit → PR → arm auto-merge →
     **poll until MERGED** (canonical fix-and-ship template,
     `orchestrator-reference.md § Fix-and-ship subagent template`).
  4. **`POST /system/refresh-plugin`** → poll the system version endpoint until
     the new `VERSION` is live across runner tasks. (Local runner: `/ace:update`
     / fresh process gets it for free.)
  5. `gh issue create` against `jjackson/ace` (one per distinct finding — the
     "file mid-run" rule).
  6. `streak = 0`; resume.

#### 4. `iterate-state.yaml` (CLIENT-ONLY observation/resume log)
`ACE/<opp>/iterate-state.yaml` — written and read **only by the client control**.
The server-side run never reads or writes it (it's not part of the first-class
run contract). It lives on Drive purely so the control survives restarts and the
loop is observable; it could equally be local. Schema validated in
`lib/run-state-validator.ts`.

```yaml
opp: bednet-spot-check
target_phases: [3, 6]          # 4 always rides along as a dependency
golden_run_id: 20260601-xxxx
runner: web                    # web | local
plugin_version: 0.13.502       # version the current streak is counted against
streak: 0
required_streak: 5
caps:
  per_failure_class_fix: 2     # same class recurs after N fixes → halt
  max_iterations: 25
kill: false                    # operator kill-switch, checked each loop
iterations:
  - run_id: 20260601-yyyy
    started_at: ...
    verdict: dirty             # clean | dirty
    failure_class: "app-release: CCZ validate failed on Deliver form 2"
    fix_pr: https://github.com/jjackson/ace/pull/NNN
    version_at_run: 0.13.502
```

`/ace:iterate --resume` reads this and continues the streak.

#### 5. `POST /system/refresh-plugin` (ace-web)
New endpoint that re-runs `scripts/refresh-ace-plugin.sh` across running tasks
(or marks them refresh-on-next-run), so a merged ACE fix reaches server-side
runs **without an image rebuild or a full deploy**. Small ace-web PR
(`apps/system/api.py` + the refresh wiring). The control polls the existing
system version endpoint (`apps/system/version.py`) to confirm the new `VERSION`
is live before resuming. Fan-out detail (one-task-per-request behind the LB vs
all tasks) is an implementation decision for the ace-web plan; the contract the
control needs is: *"trigger → poll version → all runner tasks are on VERSION X."*

#### 6. `seeded-run` ace-web action (optional, recommended)
`POST /opps/<slug>/runs/<golden-run-id>/actions/seeded-run` → injects
`/ace:run <slug> --seed-from <golden-run-id> --only 3,4,6` into the working
session (extends `apps/opps/actions.py` `_phrase` + `inject_action`). The
`<run_id>` path segment carries the **golden** run-id; the first-class run mints
its own fresh run-id at setup. Auditable trigger. If deferred, the control
reuses the existing working-session message-inject path with the same prompt.

## Streak semantics

"5 clean in a row" is **keyed to plugin VERSION**: the streak counts consecutive
clean iterations with **no intervening code change**. A plugin refresh (i.e. a
shipped fix) resets the streak to 0 and re-stamps `plugin_version`. This makes
the terminal condition a real stability proof: *five fresh, end-to-end Phase
3+4+6 runs succeeded back-to-back on one unchanged plugin version.*

## Guardrails

- **Per-failure-class fix cap** (default 2): if the same `failure_class` recurs
  after N fixes, halt-and-surface — don't churn versions on a fix that isn't
  working.
- **Global iteration cap** (default 25) and **kill-switch** (`kill: true` in
  state, checked each loop).
- **CI-green gate** before refresh; **version-live gate** before resuming.
- **One `gh` issue per distinct finding** (audit trail; pairs with class-level
  preventers).
- **Cleanup**: each iteration spawns a fresh Connect opp + Nova app + HQ builds +
  (Phase 6) a cloud-emu session. Loop end points the operator at `/ace:sweep`
  (drive/connect/ocs/hq/opp-runs) to reclaim the per-iteration artifacts.

## Cost model (corrected)

- A **clean** iteration pays: fork (cheap Drive copy) + Phase 3 (Nova build of a
  1Q/1Q app + HQ deploy/release) + Phase 4 (opp + payment unit + invite) +
  Phase 6 (cloud-emu cold-boot ~60–90s + a short Learn+Deliver walk). No
  redeploy.
- A **dirty** iteration additionally pays: investigate + fix + PR-merge +
  `refresh-plugin` (seconds–low-minutes; **not** an image rebuild — that was a
  wrong earlier assumption) + issue-file.
- Five clean-in-a-row on a stable version = five minimum-cost iterations
  back-to-back with no refresh between them.

## Open implementation questions (for the plan, not blocking design)

- Exact `--only` semantics when a skipped phase is a hard input dependency of a
  run phase (should be none for {3,4,6}, but the orchestrator must fail loud if
  an allowlist leaves a run-phase's required artifact unproduced).
- `refresh-plugin` fan-out across >1 ECS task (per-request vs service-wide
  signal) — ace-web plan owns this.
- Whether the control should `/ace:update` itself between fixes (only matters if
  a fix touches a skill the *control* uses — `fork-run`, gdrive MCP — vs the
  *runner* phase skills; usually the latter).
- Concurrency guard if/when `refresh-before-run` is added as a tightening
  (deferred): must not swap the plugin out from under a concurrent session.

## Build surface summary

**ACE plugin (this repo):**
1. First-class seeded run: `--seed-from <golden-run-id>` + `--start-phase`/`--only <phases>`
   + Phase-6 app-QA-only mode (orchestrator + `commands/run.md`). **This is the
   entire server-side surface** — loop-blind, writes only normal `run_state.yaml`.
2. `commands/iterate.md` + `agents/iterate-loop.md` — CLIENT control: observe →
   judge → streak → autofix (level-0). The only loop-aware code.
3. `iterate-state.yaml` (client-only) schema in `lib/run-state-validator.ts` + a test.
4. Establish/curate the golden `bednet-spot-check` prefix.

**ace-web (sibling repo, separate PR):**
5. `POST /system/refresh-plugin` fan-out + version-live polling contract.
6. (optional) `seeded-run` opp action that injects
   `/ace:run <slug> --seed-from <golden> --only 3,4,6` into the working session.
