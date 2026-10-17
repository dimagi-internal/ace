---
name: synthetic-data-and-workflows
description: >
  Phase 7 of the ACE lifecycle: produce a stakeholder-ready synthetic-data demo on
  top of the built apps. CONVERGED (Plan C, 2026-07-21) onto the /ace:demo pipeline —
  demo-data-setup(ace-run) generates data + authors dashboards, demo-narrative
  authors the DDD narrative, and the canopy DDD loop renders/judges/uploads. Same
  engine as /ace:demo, differing only by data-source provider. Since ace#2510 the
  ace-run provider builds the semantic-layer cascade: a PDD-authored registry,
  a multi-partner synthetic programme, and the labs indicator report trio.
  No run-time gate.
model: inherit
phase: synthetic-data-and-workflows
phase_display: Synthetic Data and Workflows
phase_ordinal: 7
skills:
  - { name: semantic-registry-author, has_judge: true, qa_skill: semantic-registry-author-qa, eval_skill: semantic-registry-author-eval }
  - { name: demo-data-setup,   has_judge: false, qa_skill: demo-data-setup-qa }
  - { name: demo-narrative,     has_judge: false } # canopy scripts.ddd.validate is the gate
  - { name: ocs-coach-setup,    has_judge: false } # simulated-worker QA inside the skill (Step 1.9)
---

# Synthetic Data and Workflows (Phase 7)

**This file is dispatched as a subagent — `Agent(synthetic-data-and-workflows)`.**
It had been read inline by the top-level session while the depth budget could not
carry the chain below it; that is no longer the constraint. Step 3 dispatches
`canopy:ddd`, which fans out per-scene judges and specialist fixers of its own —
still the deepest chain in ACE. As a subagent that chain computes to depth 4
inside a budget of 5 (`CLAUDE.md § Agent topology`; `lib/agent-depth.ts` holds the
arithmetic), and this phase gets its own context window instead of inflating the
orchestrator's.

Keep the `Agent(canopy:ddd)` dispatch below intact. When that branch is
unreachable the only executable path is a single render+judge with no loop, no
convergence rule and no stopping rule — the failure behind
`spark-facilitator/20260813-2126`, hand-driven for four iterations and ~2M tokens
before a human called a halt. The cause there was an insufficient depth budget,
now pinned at 5.

**Under `/ace:run` you do not wait on that loop — the orchestrator does.** You
build the dispatch and hand it off (Step 3, `ddd_handoff`); the orchestrator runs
`Agent(canopy:ddd)` and re-dispatches you with `mode: finalize` once it has ended.
The loop is hours long, and a phase agent kept alive across it burns its whole
context on every wake (`lib/ddd-handoff.ts` has the measurement).

You run the synthetic-data + demo phase between training (Phase 6) and solicitation
(Phase 8). By phase start, Phases 1–5 have produced an approved PDD, deployed
CommCare apps, a configured Connect opportunity, a quality-gated OCS chatbot, and
training materials. The opportunity is fully prepared — what's missing is **a way to
show what it looks like running well**.

**Plan C convergence (2026-07-21):** Phase 7 is now the `ace-run` provider of the
same pipeline `/ace:demo` uses. It replaces the former 7-skill chain
(`synthetic-narrative-plan` → `-data-generate` → `-workflow-seed` → `-workflow-polish`
→ `-walkthrough-spec` → `-walkthrough-run` → `-summary`) with:

**`demo-data-setup(provider=ace-run)` → `demo-narrative` → canopy DDD.**

The retired skills remain on disk (deprecated fallback) until this converged path is
validated in production; see § Deprecated skills.

## No phase gate

Phase 7 has **no irreversible external action**. The labs `SyntheticOpportunity` is
reversible (`synthetic_disable`); workflows via `workflow_delete`. The orchestrator
does NOT pause at a Phase 7 boundary — `/ace:run` proceeds straight from Phase 6 to
Phase 8.

## Archetype: focus-group is a no-op

**For `focus-group` archetype this entire phase is skipped** (the FGD model captures
qualitative content in gdocs out-of-band; there is no per-FLW KPI scorecard to
populate). Read the PDD's `archetype:` at phase start. If `focus-group`:

1. Write a one-paragraph summary to
   `7-synthetic/synthetic-data-and-workflows_summary.md` with frontmatter
   `{archetype: focus-group, status: skipped, reason: no-stakeholder-value-for-attestation-form-shape}`.
2. Patch `run_state.yaml.phases.synthetic-data-and-workflows` with `status: skipped`,
   `verdict: skipped`, `completed_at: <iso>`, `summary_artifact: <doc-id>`,
   `skip_reason: focus-group-no-op`.
3. Return cleanly. Phase 8 starts.

Do NOT run the pipeline below for `focus-group`. **For every other archetype —
`atomic-visit`, `multi-stage`, `longitudinal-visits`, and any archetype added
later — proceed.** The gate names the one exception rather than enumerating the
archetypes that pass, because an enumeration silently omits new archetypes: this
doc listed only `atomic-visit` / `multi-stage` while `longitudinal-visits` was
live, so that archetype hit neither branch and the phase's behaviour was
undefined (ace#1691). Adding an archetype stays purely additive, per
`CLAUDE.md § Conventions`. See
`docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.

## Scale: a single-worker or no-partner design is a no-op (ace#2806)

The cascade this phase builds needs partners, each with a roster of workers,
followed over weeks (`lib/cascade-story.ts` `DEFAULT_FLOORS` and the four required
signals). A design with **one worker**, or with **no partner organisation at
all** (a platform test, a staff pilot), has nothing for that cascade to show, and
every route to green would invent partners, workers or weeks (§ No inferred
backstory). **Operator decision (Jonathan, 2026-10-16): skip the phase and record
why. There is no reduced-floor mode** — do not lower a floor, declare a "scale"
exemption or build a one-partner cascade to get around it.

After the focus-group check, and before Step 0, write the PDD to a local file and run:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/phase7-applicability.ts" <local-pdd.md>
```

Exit 0 means the phase applies, so proceed to § Workflow. Exit 3 means skip. The
printed JSON carries `skip_reason` (`design-below-cascade-scale`), `reasons[]`
(`single-worker` / `no-partner`, each with the PDD line it rests on, verbatim) and
`detail`. The rule reads only what the PDD says: `§ FLW Requirements` "Number of
FLWs" ≤ 1, or `§ LLO Preference` stating there is **no** partner / implementing
organisation / LLO. "None pre-named" is not that (the LLO is simply unchosen, and
Phase 8 picks one), so such a design keeps Phase 7. Logic:
`lib/phase7-applicability.ts`. *Enforced:* `test/lib/phase7-applicability.test.ts`,
against the real PDD of `group-payment-test/20261007-1700`.

On exit 3:

1. Write `7-synthetic/synthetic-data-and-workflows_summary.md` with frontmatter
   `{status: skipped, reason: design-below-cascade-scale}`, then one paragraph: the
   `detail` sentence followed by each `reasons[].evidence` line quoted.
2. Patch `run_state.yaml.phases.synthetic-data-and-workflows` (`merge: 'deep'`) with
   `status: skipped`, `verdict: skipped`, `completed_at: <iso>`,
   `summary_artifact: <doc-id>`, `skip_reason: design-below-cascade-scale`,
   `skip_detail: <detail>` and `skip_evidence: <reasons[]>`.
3. Return cleanly. Do not create a synthetic opp, registry or Coach. Phase 8 then
   starts. `skipped` is terminal everywhere downstream: `phase7DddStep` returns
   `done`, so no DDD loop is dispatched; the boundary fence steps over it; the run
   README marks Phase 7's rows `skipped`.

## Workflow (every archetype except focus-group, at cascade scale)

### Step 0: Phase folder setup (FIRST)

`drive_create_folder({name: '7-synthetic', parentFolderId: <run-folder id>, findOrCreate: true})`
— idempotent. Every artifact this phase produces writes into THIS `7-synthetic/`
folder id (never the run-folder root — fails `verify_phase_artifacts`, jjackson/ace#791).

### Step 1: The semantic-layer cascade — registry, programme, trio (ace#2510)

Operator decision (Jon, 2026-09-26): every run produces a **cascade story** a
viewer can drill — programme → partner → opportunity → worker → case — and the
same programme seen two ways: the programme manager's programme report and one
partner's (network manager's) opportunity report with its anonymous benchmark.
*"The synthetic data is going to prove to be a key part of people wrapping their
head around the system."*

Invoke `demo-data-setup` with `{provider: ace-run, name: <opp>, runId: <run-id>}`.
Its § Process (ace-run) C0–C7 runs, in order:

1. **C1** — one labs-only synthetic opportunity per partner (default and floor
   5, ace#2727) under one labs-only program, each partner a realistic invented
   organisation name with a trailing `(example)` marker. The run's real
   network-manager org is never touched.
2. **C2 — `semantic-registry-author`** (gated by `semantic-registry-author-qa`;
   then graded by `semantic-registry-author-eval` — run it, do not defer it: a
   deferred eval is a gate validate-release-readiness reports as never run, as it did on
   spark-facilitator/20260926-1800): the registry from the
   PDD — the followed entity as the model, one indicator per PDD success metric /
   payment rule / review signal with its PDD section, targets only where the PDD
   states them, the PDD's own nouns, `llo_map` over the partners.

   **Registry gate — before ANY data is generated.** The order is fixed:
   `semantic-registry-author` → `semantic-registry-author-qa` →
   `semantic-registry-author-eval` (verdict written to
   `7-synthetic/semantic-registry-author-eval_verdict.yaml`) → **gate** → C3 story
   and data generation → C4–C5 dashboards. The gate is code, not this sentence:
   `scripts/run-labs-synthetic-generate.ts` refuses to send a manifest (exit 3)
   unless `--registry-eval-verdict <local copy of that verdict file>` passes
   `checkRegistryEvalGate` (`lib/registry-eval-gate.ts`: present, this skill's,
   graded, not `fail` — `warn` proceeds). A `fail` means fix the registry
   (`semantic_registry_update`), re-run QA and the eval, then generate. Why: on
   all three 2026-10-15 runs (`noora-health/20261015-1129`,
   `kaduna-graduation/20261015-1411`, `smallholder-seasonal/20261015-1402`) the
   registry eval ran AFTER data and dashboards, so any finding meant rebuilding
   the cascade — the story signals, manifests, report trio and history are all
   authored against the registry's indicator ids.
3. **C3** — `7-synthetic/cascade-story.yaml` (four authored signals: lagging
   partner, standout worker, data-quality problem, trend; a display roster
   naming every worker and community; headline indicators that differ across
   partners; `review_routing` — what the PDD does with each flagged record;
   `single_child_levels` the PDD fixes, cited), gated by `checkCascadeStoryPlan`
   and `checkPlannedWorkerRates`, then one mirror-mode manifest per partner keyed
   on the released Deliver app's form paths.
4. **C4** — `indicator_programme_report` bound to the registry (its companion
   `indicator_worker_review` comes with it), its `visits` pipeline set to the
   registry's Layer-1 fields.
5. **C5** — benchmark cohort → `indicator_opp_report` per partner
   (`benchmarks_create_opp_reports`, sharing the programme's pipelines and
   registry) → `workflow_rebuild_history` weekly (handed down to every opp report)
   → `benchmarks_publish` per saved run, oldest first.
6. **C6** — `verifyCascadeStoryLanded` against the saved runs, then
   `cascadeBuildOutcomes` (`lib/cascade-build-qa.ts`, ace#2735): flagged records
   follow the PDD's review route, no worker-table rate is binary, no displayed
   column is constant, no drill level has one child everywhere. These were DDD
   findings on `spark-facilitator/20261004-1706`; they are build defects, fixed
   here — the DDD loop cannot write to labs (ace#2337), so handing them over only
   pays for a render to re-find them. `demo-data-setup-qa` checks 24–27 re-run them.
7. **C7** — `realized.json` + `products.synthetic.cascade` + `workflows{}`.

Worked live example: `spark-facilitator/20260926-1800` (program 10082, registry
6369, programme report 6371, opp reports 6376/6378/6380).

**Gate:** `demo-data-setup-qa` — every run URL is a correctly scoped deep-link
(the programme report is program-owned, `&program_id=`), and check 21: the story
plan holds AND every signal landed in the saved runs. On `fail`, apply the
auto-fix hints and re-run before proceeding — a partner table where nothing
stands out must not reach a stakeholder.

**The gate is not optional, and it always leaves a result.** Run it for every
provider, including a "proof" run that skips the render: invoke
`demo-data-setup-qa`, which writes `7-synthetic/demo-data-setup-qa_result.yaml`
through `scripts/demo-data-setup-qa.ts` (canonical `lib/qa-types.ts` shape, every
check that applies to the provider evaluated or failed), and record
`steps.demo-data-setup-qa: {status: done, verdict: <pass|fail>}` in this phase's
write-back. `spark-facilitator/20260926-1800` skipped it and has no result;
`bednet-check-2-visit/20260908-1544` hand-wrote one ace-web read as "Passed (0/0)".

**Bounded run-time.** Generation is three `synthetic_generate_from_manifest`
calls; history is one `workflow_rebuild_history` call (13 weekly periods in
~1 min on the proof); the trio is five creates. The cascade adds minutes, not
hours — the DDD render (Step 3) is still the long pole.

**Legacy path.** The single-opportunity template dashboards (`demo-data-setup`
§ Legacy single-opportunity path) remain for an operator who asks for them
(`--legacy-dashboards`); they are no longer the default.

### Step 1.9: The OCS Coach — `ocs-coach-setup` (required)

Once Step 1 has authored the registry and the programme report, build this run's
Coach: invoke `ocs-coach-setup` (`skills/ocs-coach-setup/SKILL.md`). It clones the
Phase 5 Q&A bot, installs the coaching script with indicator cards from THIS run's
registry (the Coach's topic keys are the registry's indicator ids), QAs it with a
simulated worker over the OCS API, and puts coaching on the reports Step 1 built:
the programme report and each partner's opportunity report get the
`start_ocs_outreach` action (bot = this Coach) and the canopy panel. Those are the
pages Step 3 films, so coaching appears in the demo as part of the report. It never
sends to a worker; a person starts coaching from those pages. What the WORKER sees next
— the conversation in the Connect app — is footage `skills/coach-session-capture`
records on the AVD by sending to ACE's own test user (mobile mode; owner carve-out
2026-10-07). Use it when the narrative has a coaching cut.

It is **required**: Phase 7 cannot be `done` without the Coach. The phase boundary
checks `products.ocs_coach.experiment_id` and `products.ocs_coach.coaching_on`
(`REQUIRED_PRODUCT_KEYS` in `lib/phase-products-schema.ts`). A failure here —
including the OCS team lacking the `flag_commcare_connect` feature flag, which
means coaching could never reach a worker — is a defect to fix and re-run, not a
residual. It writes `phases.synthetic-data-and-workflows.products.ocs_coach` and
records `steps.ocs-coach-setup: {status: done}` here.

### Step 2: Narrative — `demo-narrative`

Invoke `demo-narrative` with `{brief: <PDD-derived>, realizedRef: 7-synthetic/realized.json, runId}`.
That means `style: explainer`, the default. Pass `style: recorded` only when your dispatch
explicitly carries it (ace#2789, `demo-narrative` Step 3r). Never infer it from the PDD.
It authors a DDD `WhyBrief` + `UnifiedSpec` (scenes on `${…_par_url}`, honest gaps)
and **validates both via canopy `scripts.ddd.validate`** — do not proceed until both
validate. Writes `7-synthetic/why_brief.yaml` + `<slug>.yaml`.

**The gap-copy check runs here, not in Step 1** (`demo-narrative` step 3d,
ace#2244): it needs the brief's `gaps[]`, which do not exist until this step, so
`demo-narrative` reads each Step 1 dashboard's uploaded render_code back with
`workflow_get` and scans it with the narrative. Its result is
`steps.demo-narrative.gap_copy_check`.

**Before the DDD dispatch, the pre-render arc check must pass** (`demo-narrative`
step 3c, ace#2735): `scripts/demo-arc-precheck.ts` over the spec + `realized.json`
(blocks same surface + component in consecutive scenes and a finale claim that
only restates scene 1's), then its single text-only judge pass gated by
`gateArcPrecheckVerdict`. It mirrors canopy's `ddd-arc-eval` on text and never
replaces it — the post-render arc judge still runs inside `canopy:ddd`. Record
the result as `steps.demo-narrative.arc_precheck: {pass, blocking, reported}`.

On the cascade (every ace-run since ace#2510) the scenes follow `demo-narrative`
step 2c's **cascade scene ladder**: programme headline → the lagging partner →
one of its facilitators → a community's visit history → the data-quality worker
→ the partner's network-manager view of its opportunity report and anonymous
benchmark. The DDD pipeline is unchanged; only what the scenes render changed.

**Confirm the tree you were handed is the INSTALLED one before you author (ace#2349).**
`Skill()` resolves to the `installPath` bound when the session started, so after an
`/ace:update` it can serve an older copy — and a stale `demo-narrative` silently drops
whole rule sections rather than failing. Measured on `spark-facilitator/20260910-0541`:
installed was `0.13.1426`, `Skill(ace:demo-narrative)` reported base directory
`0.13.1413`, and the 96-line delta between them was exactly the ace#2339 scene ladder
plus the ace#2347 finale rules — the two things that dispatch existed to apply. **No
gate can catch this**: every authoring check (`checkSceneActions`, `checkArcLadder`,
`checkSceneVariety`, `scripts.ddd.validate`, `narrative_coherence`) reads the authored
spec and none can tell what guidance produced it, so the deck passes them all and dies
at the judge having burned a render. So:

```bash
INSTALLED="$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")"
grep -c -E 'ace#2339|ace#2347' "$INSTALLED/skills/demo-narrative/SKILL.md"
```

If the base directory `Skill()` reports differs from `$INSTALLED`, **read
`$INSTALLED/skills/demo-narrative/SKILL.md` from disk and follow that** — you cannot
rebind your own skills mid-run (ace#1729), and reading the file is the whole fix. Say
in the phase summary which tree you actually authored from.

### Step 3.0: Restore the labs session (FIRST, unconditionally)

The render authenticates to labs with a stored Playwright `storageState`, and that
session expires (~6 days). **Restore it before dispatching — never probe first, and
never assume a prior phase left one behind.** Plan C retired the
`synthetic-walkthrough-*` skills that used to make this call and did not re-home it,
so for a while nothing in the converged path ran it at all (ace#2255).

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/bin/labs-walkthrough-login.ts" \
  --connect-base-url https://connect.dimagi.com \
  --labs-base-url https://labs.connect.dimagi.com
# → rewrites ~/.ace/labs-session.json; that path is what canopy gets as
#   `record_video --storage-state`.
```

Needs `ACE_HQ_USERNAME`/`ACE_HQ_PASSWORD`. If the `bin/ace-labs-walkthrough-login`
wrapper dies on a non-shell-safe `.env`, export the two creds by safe parse
(`sed -n 's/^ACE_HQ_USERNAME=//p' <plugin-data>/.env`) and run the `tsx` above —
never `source`. `labs probe returned 302 — running OAuth flow` in the output means
the stored session **was** stale and has just been replaced; that is the normal,
healthy path, not a warning.

**Why this is a step and not a checkbox.** A stale labs session fails silently, not
loudly: labs renders the context selector ("No organizations found") and strips
`?opportunity_id=`, so every scene captures a plausible-looking wrong page and each
judge scores it as though it were the dashboard (ace#842 § failure mode 2).
`Agent(canopy:ddd)` cannot cover for you — canopy is handed a storage-state path,
not a way to mint one.

### Step 3.1: Adopt an existing DDD run before dispatching (resumes + forks)

**The DDD run dir is NOT worktree-portable.** canopy keeps run artifacts out of the
repo and keys the runs root on the git worktree basename
(`RUNS_DIR="$HOME/.canopy/ddd/runs/$(basename "$REPO_ROOT")"`, `resolve_ddd_dir.sh`).
So a Phase 7 **resume or fork from a different worktree** resolves to a different,
empty runs root: `resolve_narrative` returns `decision: new`, `Agent(canopy:ddd)`
starts a FRESH run, and every completed render is discarded. Nothing halts and
nothing warns.

**So pin the runs root to THIS RUN, and stop depending on the worktree.**
`resolve_ddd_dir.sh` consults `CANOPY_DDD_RUNS_DIR` before it falls back to the
worktree basename, so exporting a run-scoped root for every canopy command makes
the run dir survive a fork with nothing to hand-copy:

```bash
export CANOPY_DDD_RUNS_DIR="$HOME/.canopy/ddd/runs/ace-<opp-slug>-<run-id>"
# e.g. ace-bednet-check-2-visit-20260908-1544
# Pin DDD_DIR too and write the loop config into it (prints the two exports).
# $WS = the canopy-web workspace, resolved as in Step 3 § What the dispatch carries.
eval "$(node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/write-ddd-loop-config.ts" \
  --runs-dir "$CANOPY_DDD_RUNS_DIR" --workspace "$WS")"
# -> DDD_DIR=$HOME/.canopy/ddd/ace-<opp-slug>-<run-id>, config.yaml written there
```

**`DDD_DIR` is where canopy reads the loop's config** (`<ddd_dir>/config.yaml`:
`loop.fixed_surfaces`, `loop.product_repo`, `product.lint.jargon`). Unset, canopy
falls back to `~/.canopy/ddd/<cwd-basename>` — a different dir per machine and
per run (`runtime/`, `ace-kaduna-graduation-20261015-1411/` were both observed),
so ACE's config never reached the loop: on `noora-health/20261015-1129` the
unfixable 'Ask an agent' launcher held the floor at 2.0 for six iterations while
`out_of_scope.json` grew to 145 one-off declines. The config is versioned in
`config/ddd-loop.yaml` (owners, issues and regexes, each pinned against real
findings by `test/lib/ddd-loop-config.test.ts`); never hand-write a
`config.yaml` in a run — change the template. Why the dir sits beside the runs
root and not inside it: `lib/ddd-loop-config.ts`.

Pass **both exports** (the script's stdout, verbatim) to `Agent(canopy:ddd)`
explicitly — a subagent does not inherit your shell.

Then resolve whether a run for this narrative slug already exists **anywhere on
this machine** — `lib/ddd-run-adoption.ts::resolveDddRunAdoption`
(`test/lib/ddd-run-adoption.test.ts`) returns one of:

- `resume-in-place` — a LIVE run sits under this run's root. Dispatch normally.
  An ended run under this root (a Phase 7 re-run inside the same ACE run) is
  skipped like any other, so all-ended in place means `start-fresh` (ace#2745).
- `adopt-from-other-worktree` — move/copy the named `runDir` into this run's runs
  root FIRST, then dispatch with `--resume <run_id>`.
- `start-fresh` — no adoptable run for this slug anywhere. A fresh run is correct.

**Pass `readRunLiveness` — the resolver is only safe with it.** The slug is
derived from the narrative, so every `/ace:run` of an opp mints the SAME slug,
and without liveness the resolver happily recommends a run belonging to a
different ACE run. Read each candidate's `run_state.yaml` and hand back its
`terminal_status` + `auto_iterate_next_action`; the resolver then skips any run
canopy has already ended, and says so in `reason`. Adoption rescues INTERRUPTED
work — a finished run is not interrupted, and inheriting its `score_history`
makes the stall detector fire on the first render and report
`stopped_not_converged` over renders this run never performed.

Measured on `bednet-check-2-visit/20260908-1544`: two runs named
`bednet-two-visit-spot-check-*` sat under `bednet-u12df` and `bednet-2syps` from
the 2026-08-19 and 2026-08-26 runs of the same opp, each already ended
`stopped_not_converged` with `score_history` `[2.0, 2.0, 2.0]` and `[2.0, 3.0]`
over a dataset that no longer existed. The resolver recommended
adopting one, and pinning the root did NOT change that verdict — it only changes
where a new run lands. ace#2315.

The cost of getting this wrong is not just the re-render. `compute_auto_iterate`
terminates on a noise-banded score **stall** and a finding **plateau** computed over
`score_history`; a history reset to `[]` cannot detect the stall it was about to
detect, so a silent restart changes the loop's **terminal verdict**, not only its
runtime. Measured on `spark-facilitator/20260908-2215`, where a rate-limit-killed
session's run (iteration 2, `score_history: [2.0, 2.0]`, 18 findings, three
verdicts) sat under the ORIGINATING worktree's root and had to be hand-copied
across. ace#2287.

### Step 3: Render + converge — canopy DDD (hand off; never sleep on it)

**Who runs the loop depends on who dispatched you — read your dispatch prompt.**

- **`/ace:run` — the prompt carries `ddd: orchestrator-owned`. Hand off and
  return.** Build the dispatch described below exactly as if you were sending it,
  but do not call `Agent(canopy:ddd)`. Instead:
  1. Upload the complete prompt as `7-synthetic/ddd-dispatch-prompt.md`
     (`drive_upload_binary`, `mimeType: text/markdown` — never `drive_create_file`,
     whose Doc export mangles the newlines the prompt depends on).
  2. Write `products.synthetic.ddd_handoff` with `update_yaml_file({merge: 'deep'})`
     and keep `status: in_progress`:
     `{prompt_file_id, runs_dir: $CANOPY_DDD_RUNS_DIR, ddd_dir: $DDD_DIR, narrative_slug,
     resume_run_id: <Step 3.1's run id, or null>, workspace: $WS, prepared_at}`.
     The prompt file must open with the two `export` lines Step 3.1 printed.
     The shape is `lib/ddd-handoff.ts` (`handoffProblem` rejects a half-written one).
  3. Return. Your summary says `DDD hand-off ready: <narrative_slug>` and lists
     what Steps 0–3.1 produced. The orchestrator dispatches the loop, waits on its
     completion notification, records `ddd_run_id` + `ddd_terminal_status`, and
     dispatches you again with `mode: finalize`.
- **`mode: finalize`.** Do NOT redo Steps 0–3.1 — their products are in
  `run_state.yaml` and regenerating them would invalidate the render the loop
  just judged. Read `products.synthetic.ddd_handoff` + `ddd_run_id` +
  `ddd_terminal_status`, export `CANOPY_DDD_RUNS_DIR` and `DDD_DIR` from the
  hand-off's `runs_dir` / `ddd_dir`, run `bin/ace-canopy-web --workspace "$WS" verify narrative <slug>`,
  then Steps 3.9 → 4.5 against `<runs_dir>/<ddd_run_id>/` (3.92 freezes the pages). Step 4 flips
  `status: done`.
- **Any other dispatcher (no `ddd: orchestrator-owned` line).** Dispatch
  `Agent(canopy:ddd)` yourself, then **wait on its completion notification: end
  your turn with one line** (`Waiting on the DDD loop.`). A subagent with a child
  in flight is resumed by that child's notification — measured on
  `kaduna-graduation/20261015-1411` Phase 3, a 43-minute wait on the Nova
  architect with no timer and no poll. **Never sleep-poll the loop.** The prompt
  cache expires after 5 idle minutes; `noora-health/20261015-1129` slept
  540–595 s seven times here and re-wrote its whole context on every wake.
  canopy's `sleep_cap_guard` refuses a foreground wait over 270 s for that reason.
  If you must look at progress, one read of the DDD `run_state.yaml` per wake,
  never a sleep.

**What the dispatch carries** — the full converge → video → upload loop. This is
the default and the only path that terminates on its own. Pass the run id, the
unified spec, and the why-brief. **Pin who writes and where** (ace#2805): set `WS` to
the opp's `opp.yaml` `canopy_web.workspace`, else `config/canopy-web.json`
`ddd_workspace`; run `"$ACE_ROOT/bin/ace-canopy-web" --workspace "$WS" check`; put the
wrapper and `$WS` in the dispatch prompt and require every canopy-web write to run as
`bin/ace-canopy-web --workspace "$WS" -- <command>`; after it returns (in
`mode: finalize`, when the orchestrator ran it),
`verify narrative <slug>` before the phase summary names any canopy-web URL.
Contract: `playbook/integrations/canopy-web.md`. **On a resume, pass `--resume <run_id>` explicitly
and say so** — an unqualified dispatch is what starts a fresh run. **Open the prompt
with Step 3.1's two `export` lines** (`CANOPY_DDD_RUNS_DIR`, `DDD_DIR`) and require
every canopy command to run under them — without `DDD_DIR` the loop reads no
`config.yaml` and every labs-template finding is re-declined by hand again.

**Give the loop its write path to the report pages (2026-10-16).** The cascade
reports follow ACE's Labs template workflows (`demo-data-setup` § C7,
`config/labs-report-templates.yaml`), so a page finding is fixed IN the loop:
edit the template draft, preview it on this run's page, publish only when the
affected cells do not regress, otherwise discard. `config/ddd-loop.yaml` keeps
only Labs chrome, engine-boundary findings (a figure Labs does not compute) and
the registry out of scope. Generate the block for THIS run and paste it into the
prompt verbatim, above the locked-claims ledger:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-report-templates.ts" dispatch-block \
  --run-state <local run_state.yaml>
```

It names each page's template and the procedure — `draft-begin` (a lease: `busy`
means another run holds the draft; the finding waits for the next pass, never a
poll), render-only `workflow_template_update_draft` edits chained on
`expected_revision`, `draft-capture` before/after on the affected scenes,
`draft-decide`, then `draft-publish` or `draft-discard`. Deterministic parts are
code (`lib/labs-template-draft.ts`); the judging of before/after stays the loop's.
A publish reaches every OTHER run still following the template too — that is why
nothing is published unproven, and why finished runs are frozen (Step 3.92).

Do NOT substitute a bare `canopy:ddd-run` invocation as the phase's render step.
`ddd-run` is ONE render+judge pass: it returns a verdict and a findings list and
nothing else. It does not apply fixes, does not iterate, and does not decide when
to stop — the caller has to, and a caller that invents its own stopping rule is
the failure this phase already paid for. Use `ddd-run` directly only for a
deliberate single-pass smoke check, never as the phase's convergence step.

**What the loop guarantees (canopy ≥ 0.2.409) — read it, don't re-derive it:**

- **Accuracy findings are fixed, never escalated.** A finding where the narration
  asserts something the artifact itself contradicts (a wrong word over a labelled
  panel; a claim that exceeds its own n) is forced to `fix_kind: mechanical` by
  `scripts/ddd/finding_class.py` and cannot reach the `concept_change` gate. Only
  **strategy** findings — where the artifact is wrong, not the wording — surface.
- **The loop owns its termination.** `compute_auto_iterate` stops on convergence,
  a noise-banded score stall, a finding plateau, or the hard cap, and stamps
  `state.terminal_status`: `converged_clean` / `converged_with_open_questions` /
  `stopped_not_converged` / `diverging`. Report that status verbatim in the phase
  summary — "converged, good" and "converged, still failing" must not print the same.
- **No gate hangs an unattended run.** `scripts/ddd/gates.py` gives each gate a
  no-human default (`concept_change` → `defer`, `external_release` → `hold`), so
  an `/ace:run` with nobody watching finishes and reports instead of stalling.
- **The verdict is de-noised.** Per-cell judge variance is ±1 on identical frames,
  so a capping cell is re-judged (k=3, median) before it blocks, and the verdict
  carries the distribution, not just the floor.

**A page edit under a LOCKED narration must keep every claim that page carries
true (ace#2727).** The loop now edits the report pages itself (the template
write path above), so this guard is load-bearing on every page fix. The loop fixes report pages (labs template workflows) while
the narration is locked, and canopy's fix direction is "when narration and
product disagree, the narration moves" — but a locked narration cannot move
silently. On `spark-facilitator/20261004-1706` a page fix merged two identical
peer-median columns (a fair product change) under narration that said *"both
peer medians"*, and the claim went false with nobody re-reading it. So build the
per-page ledger of locked claims and hand it to the loop **in the dispatch
prompt**, with the rule stated there:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/narration-claims.ts" \
  --spec <demo-run>/7-synthetic/<slug>.yaml --ledger
```

Paste its output into the `Agent(canopy:ddd)` prompt under this instruction,
verbatim: *"Before ANY edit to a report page, re-read the locked narration
claims listed under that page below. If the edit would make any of them false —
a figure, a count, a column or panel the narration names ('both peer medians'),
an order — do NOT make the edit; route the finding as NARRATION (propose the
narration change; mechanical → edit + `ddd-spec-qa`, story-changing →
`concept_change`). After every page edit you do make, re-check the claims of
every scene that page appears in against the new capture."* `narrationClaimsBySurface`
(`lib/narration-on-screen.ts`) groups scenes by page — a follow-on scene with no
`url` is on the previous scene's page — so the fixer sees every scene a page
edit can falsify, not just the one whose finding it is fixing. On a resume,
rebuild the ledger from the current spec; it is not cached.

The verified render mechanics (labs-session refresh precondition,
`record_video --storage-state`, the `workflow_create_run` run_id URL model) live
in `agents/demo.md § Render` — follow them. Screenshots are the fallback if
canopy's `webm→mp4` conversion fails.

**On a non-`converged_clean` ending, do not halt the run.** Phase 7 has no gate.
Record the terminal status and any open strategy findings in the phase write-back
with a verdict that NAMES the outcome — `verdict: partial-ddd-<terminal_status>`
(e.g. `partial-ddd-stopped_not_converged`, the status copied verbatim) — keep
`status: done`, publish the `--stuck` package URL as the `summary_artifact`, and
proceed to Phase 8. **Never `passed-with-deferred-evals` here:** the judges ran
and the loop stopped short of its bar, so nothing was deferred, and ace-web's
`_verdict_caveat` reads any verdict containing `deferred` as "Built; some quality
checks were deferred" on the anonymous run-summary page — the only ending signal
an outside reader gets, since `ddd_terminal_status` renders to members only. A
`partial-…` verdict renders "Only partly finished — some of this stage's checks
did not pass", which is true (ace#2995). `passed-with-deferred-evals` stays
reserved for evals that genuinely did not run.

**Dashboard defects the loop found but could not apply are their own outcome:
`found_not_fixed` (ace#2337).** Page defects are now fixable in-loop (the
template write path), but two kinds still are not: a figure Labs does not
compute (`config/ddd-loop.yaml` `labs-engine`, a connect-labs change) and the
registry's own labels/names (`labs-semantic-registry`). A defect on one of them is
rediscovered every pass and never applied. (Runs before 2026-10-16 recorded
`labs-report-template` here; it is still read.) Folded into `stopped_not_converged`,
it reads as "the demo is bad" when the truth is "the fixer cannot reach that
page". Those are opposite remedies. So, on EVERY ending, before the write-back, run:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/ddd-unapplied-findings.ts" \
  <runs_dir>/<ddd_run_id>/run_state.yaml --spec <demo-run>/7-synthetic/<slug>.yaml
```

It prints `{ddd_terminal_status, outcome, verdict, unapplied_dashboard_findings}`.
Use its `verdict` as the phase verdict: `partial-ddd-found_not_fixed` when the loop
did not converge clean AND left dashboard defects unapplied; otherwise
`partial-ddd-<terminal_status>` as above, or `pass` on `converged_clean`. Write
`products.synthetic.ddd_outcome: <outcome>` and
`products.synthetic.unapplied_dashboard_findings: <the list>`. Each row names the
dashboard (`dashboard_url`, `scene`), the defect, its `owner` / `issue`, and
`pinned` (that row alone holds a below-bar cell). Keep `ddd_terminal_status`
verbatim, since it is canopy's word, not ours. The phase summary gets a
**Found, not fixed** section listing every row as `dashboard — defect`, separate
from the open strategy findings. A `converged_clean` run records its rows too.
Logic: `lib/ddd-unapplied-findings.ts`. *Enforced:*
`test/lib/ddd-unapplied-findings.test.ts`, on the real findings of the 2026-10-15 runs.

### Step 3.5: Carry the converged narrative back to the artifacts of record (EVERY terminal status)

**Runs after `Agent(canopy:ddd)` returns, whatever its `terminal_status` —
`converged_clean`, `stopped_not_converged`, `stop_concept_change`, anything.**
The loop edits ITS OWN copies — `$REPO_ROOT/docs/walkthroughs/<slug>.yaml` and
`$CANOPY_DDD_RUNS_DIR/<ddd_run_id>/why_brief.yaml` (+ the run dir's
`unified_spec.yaml`) — and nothing in canopy writes them back: its DDD runtime
has no Drive write path, and `narrative post` runs only at the narrative-review
gate, BEFORE the loop iterates; later revisions are recorded under
`<run_dir>/narrative-versions/` and never posted (ace#2254). On
`spark-facilitator/20260907-1120` the loop withdrew an honesty claim (*"who
decided it"*, over a build that captures no actor) and both stores a human opens
kept it — Drive rev 10 byte-identical to rev 7, canopy-web still at v1 — until an
operator pushed by hand. Check 14 then passed the stale Drive spec over zero
evaluations while the corrected spec fails it. So, in order:

1. **Drive — overwrite both artifacts of record from the loop's final copies.**
   `mcp__plugin_ace_ace-gdrive__drive_update_file({fileId, localFilePath})` for
   the spec (`fileId` = `products.synthetic.narrative.unified_spec_ref`,
   `localFilePath` = the loop's `docs/walkthroughs/<slug>.yaml`) and for the
   why-brief (`why_brief_ref` ← the run dir's `why_brief.yaml`). `localFilePath`,
   never inline `content` — the spec is large and must arrive byte-identical.
   Skip a file only when it is byte-identical to Drive (`drive_read_file` with
   `writeToPath`, then `cmp`), and say so.
2. **canopy-web — post the converged story** through the Step 3 wrapper:
   `bin/ace-canopy-web --workspace "$WS" -- uv run python -m scripts.ddd.narrative post "$REPO_ROOT/docs/walkthroughs/<slug>.yaml" "<ddd_run_id>"`
   (run from `$CANOPY_RT`). Exit 3 = this run's narrative review is still
   pending: do NOT `--force`; record the revision instead with
   `scripts.ddd.narrative_guard check <spec> --run <ddd_run_id> --reason "post-loop write-back (ace#2254)"`
   and name the pending review in the phase summary. Never `narrative pull` here
   — `pull` is web → local, and would overwrite the loop's corrections with the
   pre-loop text. Then `verify narrative <slug>` (Step 3).
3. **Re-run check 14 on the PUSHED spec.** `demo-data-setup-qa` check 14
   (`checkScrollFraming`, `lib/demo-frame-legibility.ts`) over the spec read
   back from Drive by `unified_spec_ref`, not the local copy — the point is that
   the artifact of record now reproduces the video. Record its `judged` count
   with the result (a `judged: 0` pass is not an approval).
4. Record `steps.ddd-run.writeback: {drive_spec_rev, drive_why_brief_rev, narrative_version | pending_review, check14: {pass, judged}}`
   in the phase write-back. A run that skips this step has not finished Phase 7.

### Step 3.9: Promote a dashboard that EARNED it (the learning loop)

**Not for the cascade.** The indicator trio follows ACE's template workflows,
so a page fix is already shared by publishing it (Step 3) — there is nothing to
promote; skip this step when `products.synthetic.cascade` is set. (A template
fix that should reach NEW template workflows too goes back to connect-labs via
`workflow_template_export` + `tools/promote_template_workflow.py`.)

**Only when the loop ended `converged_clean`.** Reuse in this phase currently
flows one way — every run instantiates from the same fixed palette of
checked-in templates, and a dashboard ACE authors well dies with its run. So
the palette never learns, and the next opp of the same shape starts from the
same eight families (`demo-data-setup` § Step 0's taxonomy) rather than from the
best thing ACE has actually built.

On `converged_clean`, promote the dashboard that carried the payoff:

```
mcp__connect-labs__workflow_set_template_flag({
  workflow_id: <the interactive dashboard>,
  is_template: true,
  template_scope: 'program:<connect program id>',   # NOT 'global' — admin-only
  opportunity_id: <labs_synthetic_opp_id>,
})
```

Record it in the phase write-back as
`products.synthetic.promoted_template: {workflow_id, scope, ddd_run_id}` so the
next run can find it and the promotion is auditable.

**Two constraints that decide whether this is safe, and neither is optional.**

1. **Scope it to the program, never `global`.** `global` is admin-only and puts
   a per-opp demo dashboard in every labs user's clone picker.
2. **A promoted template is a RENDER-CODE pattern, not a wired dashboard.**
   `workflow_clone` copies `pipeline_sources` verbatim and — by its own atom
   description — does **not** clone the linked pipelines, and pipelines are
   opportunity-scoped. So a cross-opp clone declares ids it cannot read and
   renders **empty with no error** (ace#1894). Whoever reuses it must re-point
   the schema in their own opp and pass `checkDashboardBindings`, exactly as
   `demo-data-setup` § Step 3 already requires of a template instantiation.
   That is why this step promotes a PATTERN and the reuse path stays
   instantiate-then-re-point — never a blind clone.

**Do NOT promote a non-converged dashboard.** `stopped_not_converged` means the
judges found defects that were never fixed; promoting it propagates them to
every future run of that shape, which is strictly worse than not learning. The
gate is the loop's own `terminal_status`, not anyone's read of the screenshots.

### Step 3.92: Freeze the report pages (EVERY terminal status)

**Runs once the DDD loop has ended — whatever its `terminal_status` — before any
preview, write-back or release.** While a run is live its reports follow ACE's
template workflows, so a later run's publish would change this run's pages: the
ones its narration was judged against and the ones a release or a clone copies.
Fork every report off its template, recording the version each kept:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-report-templates.ts" freeze \
  --run-state <local run_state.yaml> --out <patch.json>
```

`update_yaml_file({merge: 'deep', localFilePath: <patch.json>})` records
`cascade.report_templates` with `state: frozen` and each report's
`frozen_version` (`frozen_version_uncertain: true` when a publish raced the fork).
It is idempotent — re-run it on a resume. The page does not change at the fork.
`state: partial` (a report not on an ACE template, e.g. built before 2026-10-16)
goes in the phase summary with the script's reason. A phase that skips this has
not finished: its pages keep moving.

`lib/clone-run.ts` (§ 4c) copies each frozen page onto the clone's reports, so a
release or `/ace:clone-to-new-workspace` shows exactly the page the run froze.
**To put a finished run back on the templates** (it then picks up every later
publish — only for a run nobody relies on as a fixed record):
`labs-report-templates.ts refollow --run-state <rs> [--apply]` prints (or makes)
one `workflow_follow_template({workflow_id, <scope>, template_workflow_id,
template_program_id, follow: true})` per report.

### Step 3.95: Dashboard previews — one or two render frames per dashboard (best effort)

Every dashboard this phase built is an OUTPUT, and the DDD render has already
photographed it. Put a picture of each next to it, so ace-web can show what the
dashboard looks like where it lists it (output previews contract v1, ace-web
`docs/specs/2026-09-29-output-previews-design.md`; helpers `lib/output-previews.ts`,
pinned by `test/lib/output-previews.test.ts`):

```
<run>/7-synthetic/previews/<slug of synthetic.workflows.<key>>/_previews.yaml
<run>/7-synthetic/previews/<slug of synthetic.workflows.<key>>/<NN>-scene-<N>.png
```

**Where the frames are.** canopy's render writes one frame per scene to the DDD
run dir, `$CANOPY_DDD_RUNS_DIR/<ddd_run_id>/snapshots/scene_<N>.png` (`N` = the
scene's 1-based ORIGINAL spec index; `canopy:ddd-run` passes
`--snapshots "<run_dir>/snapshots/"`). A scene dropped by `--skip-empty-scenes`
has no frame; ignore `scene_<N>_before.png` / `*_page_text.json` / `*_visual.json`.
The snapshots dir holds the LATEST render's frames — the one the loop ended on.

**Which scene shows which dashboard.** Each scene's OPENING url, from
`<run_dir>/walkthrough-run-data.json` (`slides[]` with `type: scene` carry
`scene_index` + the resolved `url`), else from the unified spec
(`7-synthetic/<narrative-slug>.yaml` `scenes[i].url`, or a leading `goto`'s
target) resolved through `7-synthetic/realized.json`. Then:

```ts
import { pickDashboardScenes, workflowOutputKey, previewsFolderPath,
         previewFileName, buildPreviewsIndex, serializePreviewsIndex,
         assertPreviewsIndexReadable, outputSlug } from '../lib/output-previews';

const picks = pickDashboardScenes({
  scenes,                                   // [{scene_index, url}]
  workflows: products.synthetic.workflows,  // the map Step 4 writes — cascade trio included
  vars: realized,                           // resolves ${…_par_url} in a spec url
  available: sceneIndicesWithAPng,
  perOutput: 2,
});
```

It matches by the labs workflow id in the url (`…/labs/workflow/<id>/run/…`)
against each dashboard's `workflow_id` / `run_url` — NOT by var name: the
cascade's programme report is `programme_par_url` in realized.json but
`programme_report` in `workflows`. It returns at most two scenes per dashboard,
in spec order (the first scene on a dashboard is usually its headline).

**For each dashboard with picks**, in this order:

1. Folder `previewsFolderPath('7-synthetic', workflowOutputKey(key))` — create
   `previews/` then `<slug>/` under the run's `7-synthetic` folder
   (`drive_create_folder`, find-or-create).
2. **Clear it:** `drive_list_folder` + `drive_trash_file` every child. A
   re-render replaces; frames of two renders never mix. This phase is the only
   writer of `7-synthetic/previews/`.
3. Upload each frame as `previewFileName(n, 'scene-<N>')` → `01-scene-3.png`
   (`drive_upload_binary`, `mimeType: image/png`, `shareAnyoneWithLink: true`,
   `localFilePath` = the snapshot).
4. Write the index: `buildPreviewsIndex({phase: 'synthetic-data-and-workflows',
   outputKey: workflowOutputKey(key), capturedBy: 'ddd-run', capturedPhase:
   'synthetic-data-and-workflows', capturedAt: <ISO>, frames})` with each frame's
   `caption` = the scene's `title`. `captured_by: ddd-run` is the render step in
   this phase's `steps` block — the replay reveals the frames at that beat.
   Serialize to a LOCAL file and upload it as `_previews.yaml` with
   `drive_upload_binary({mimeType: 'text/yaml'})` — **never** `drive_create_file`
   (a Google Doc, whose export mangles every newline).
5. `drive_read_file` it back and run `assertPreviewsIndexReadable(text,
   {folderSlug, phase, outputKey, capturedBy: 'ddd-run', expectedCount})`. A
   finding is logged in the phase summary and that dashboard's previews are
   re-written or dropped — it never fails the phase.

**Best effort — this step can never fail Phase 7.** No render, no snapshots,
a scene set that lands on none of the dashboards (e.g. a legacy-path narrative),
a Drive error: write nothing for the affected dashboards and SAY SO in the phase
summary (`Dashboard previews: 3 of 4 dashboards; worker_review had no scene`).
**Nothing about previews goes under `products.synthetic`** — ace-web reads any
mapping in products with a `file_id` as an output, so a pointer to an index
would render as a bogus one. The index is found by its folder.

### Step 4: Write-back + summary

**Write each external identifier the moment its create call returns — do NOT batch
it into this block (ace#2412).** The labs env, `labs_opp_id`, workflow and run ids are external labs objects that a re-run duplicates. A phase killed before reaching this
section leaves `products: null` while the external object already exists, and the
resume path then reads the run as having created nothing.
`verify_phase_products` validates an in-flight phase for shape only
(`mode: fragment`), so the incremental write passes the fence. Rationale:
`agents/orchestrator-reference.md § Write an EXTERNAL identifier in the step that
mints it`.

Write the `phases.synthetic-data-and-workflows` block per
[`§ Phase Write-Back Contract`](../agents/orchestrator-reference.md#phase-write-back-contract).
**Populate `products.synthetic` in the shape ace-web reads**
(`apps/opps/summary.py::_read_walkthroughs`): `labs_opp_id`, `workflows{}` (one per
dashboard `demo-data-setup` built — map `dashboards[]` to `{workflow_id, run_url}`),
and `walkthroughs[]` (one entry per DDD render — `{web_view_link: <deck/package URL>,
eval_score}`). `summary_artifact:` = the DDD package (or a one-page summary) file id. The phase
summary also states Step 3.95's outcome — how many dashboards got previews, and
why any did not.
Use `update_yaml_file({merge: 'deep'})` — never `two-level` (drops siblings, #572).

```yaml
phases:
  synthetic-data-and-workflows:
    status: <done|partial>
    completed_at: <ISO>
    verdict: <pass|partial-ddd-found_not_fixed|partial-ddd-<terminal_status>|passed-with-deferred-evals>  # partial-ddd-… on a non-converged_clean DDD ending (found_not_fixed when dashboard defects were left unapplied, ace#2337); deferred ONLY when an eval did not run (ace#2995)
    summary_artifact: <DDD package / summary doc id>
    products:
      synthetic:
        provider: ace-run
        labs_opp_id: <int>                 # the first partner's labs-only opp
        cascade:                           # ace#2510 — every id written as it is minted
          registry: { registry_id: <int>, program_id: <int>, version: <int>, indicators: [<id>, ...] }
          program_id: <int>
          partners: [{ label: "Tiyende Community Trust (example)", opportunity_id: <int> }, ...]
          programme_report: { workflow_id: <int>, run_id: <latest saved run>, url: <programme_par_url> }
          worker_review: { workflow_id: <int>, run_id: <int> }
          opp_reports: [{ partner: "Tiyende Community Trust (example)", opportunity_id: <int>, workflow_id: <int>, run_id: <int>, url: <url> }, ...]
          cohort_id: <int>
          history: { first_period_end: <date>, last_period_end: <date>, run_ids: [<int>, ...] }
          story_verified: true             # demo-data-setup-qa check 21
          report_templates:                # demo-data-setup § C7 follow → Step 3.92 freeze (lib/labs-report-templates.ts)
            home: { program_id: 10157 }
            state: <following|frozen|partial>
            reports: [{ role: programme_report, workflow_id: <int>, program_id: <int>, template_workflow_id: 11281, state: frozen, followed_version: <n>, frozen_version: <n>, frozen_at: <ISO> }, ...]
        source: { dashboards: [...], realized_vars_ref: 7-synthetic/realized.json }
        # ace-web's run summary renders this map — mirror the trio into it:
        # programme_report, worker_review, <partner>_opp_report
        workflows: { <key>: { workflow_id: <id>, run_url: <par_url> } }
        walkthroughs:
          - web_view_link: <DDD /ddd/<slug>/<run_id> package URL>
            eval_score: <0-5 or omit>
        # canopy's own ending for the DDD loop — never collapse these to pass/fail:
        # converged_clean | converged_with_open_questions | stopped_not_converged | diverging
        ddd_terminal_status: <status>
        ddd_open_strategy_findings: <int>
        # Phase 7's reading of that ending (scripts/ddd-unapplied-findings.ts, ace#2337):
        # found_not_fixed when the loop left dashboard defects unapplied, else the terminal status
        ddd_outcome: <found_not_fixed|<terminal_status>>
        unapplied_dashboard_findings:      # found, not fixed — every ending, [] when none
          - { finding_id: <id>, scene: "<n>", dimension: <dim>, dashboard_url: <url>, surface: <labs-engine|labs-semantic-registry>, owner: <owner>, issue: <repo#n>, defect: "<what is wrong>", pinned: <bool> }
    steps:
      semantic-registry-author:    { status: done }
      semantic-registry-author-qa: { status: done }
      demo-data-setup: { status: done }
      demo-narrative:   { status: done }
      ocs-coach-setup:  { status: done }   # required — no partial (Step 1.9)
      ddd-run:          { status: done, writeback: { drive_spec_rev: <rev>, drive_why_brief_rev: <rev>, narrative_version: <n>, check14: { pass: <bool>, judged: <n> } } }   # Step 3.5
```

### Step 4.5: Output previews for everything Step 3.95 did not cover (best effort)

Step 3.95 previews the dashboards in `products.synthetic.workflows` from the
render's own frames. The phase builds more outputs than that — the cascade's
`programme_report`, `worker_review` and `opp_reports`, `source.dashboards`, the
DDD package in `walkthroughs` — and any dashboard 3.95 could not match. **After**
the Step 4 write-back (ace-web reads the outputs from `run_state.yaml`), invoke
`Skill(output-preview-capture)` with `opp`, `run_id`,
`captured_phase: synthetic-data-and-workflows` and the phase filter
`synthetic-data-and-workflows`. It works from ace-web's gap list, so a dashboard
3.95 already previewed is not in it and its folder is never touched; each labs
report is photographed with the rendered data loaded, and the DDD package at its
walkthrough's first scene (canopy PAT, not the labs session). It **never fails
or blocks the phase**: put its one line — `previews: N captured, M gaps left
(<why>)` — in `synthetic-data-and-workflows_summary.md` next to Step 3.95's line,
and in the text you return.

## Preconditions

- [ ] `phases.connect-setup.products.connect.opportunity(.connect_int_id)` present
  (Phase 4 ran this run) — the opp + apps the manifest is derived from.
- [ ] `LABS_MCP_TOKEN` set in `${CLAUDE_PLUGIN_DATA}/.env`.
- [ ] Labs gdrive parent shared with the ACE SA (fixture verification).
- [ ] For Step 3 render: `ACE_HQ_USERNAME`/`ACE_HQ_PASSWORD` readable, canopy
  checkout + `uv` reachable. The labs browser session itself is **not** a
  precondition to check — Step 3.0 restores it unconditionally every time.
- [ ] `CANOPY_DDD_RUNS_DIR` exported to this run's own runs root
  (`ace-<opp-slug>-<run-id>`) — it is what makes the DDD run dir survive a fork,
  and what lets Step 3.1 tell this run's work from another run's (ace#2287,
  ace#2315).
- [ ] `DDD_DIR` exported beside it (`~/.canopy/ddd/ace-<opp-slug>-<run-id>`) with
  `config.yaml` written by `scripts/write-ddd-loop-config.ts`, and both exports
  at the top of the dispatch prompt.

## Re-runnability

Each step is independently re-runnable via `/ace:step <skill> --opp <slug>/<run-id>`
(`demo-data-setup`, `demo-narrative`). Regenerate data → dashboards pick up the new
fixtures on next render. Full disable → `synthetic_disable(opp_int_id)`.

**One exception, and it is the expensive one: the canopy DDD run does not travel
across worktrees.** `skills/fork-run` is precisely the operation that changes the
worktree, and the runs root is keyed on the worktree basename — so re-running Step 3
from a fork silently restarts the render loop from iteration 0 rather than resuming
it. Run Step 3.1 first.

## What this phase does NOT do

No solicitation handoff (Phase 8 is not gated on Phase 7); no real OCS sessions
(coaching arcs are transcript JSON on labs Task records); no production Connect
mutations (labs-only); no automatic recurring regeneration.

## Deprecated skills (retired by Plan C — kept as fallback until validated)

`synthetic-narrative-plan`, `synthetic-workflow-seed`, `synthetic-workflow-polish`,
`synthetic-walkthrough-spec`, `synthetic-walkthrough-run`, `synthetic-summary` (+ their
`-qa`/`-eval`) are superseded by the converged pipeline above. `synthetic-data-generate`
+ `synthetic-workflow-seed` remain the atom-level engine that `demo-data-setup` cites
by reference. The deprecated skills stay on disk (marked in their descriptions) so the
old path is a fallback until the converged path is validated end-to-end in a real
`/ace:run`; their deletion + the artifact-manifest/decisions cleanup is the staged
follow-up (see `docs/superpowers/plans/2026-07-20-ace-demo-workflow-plan-b-clone.md`
sibling Plan C notes).

## History

See [`docs/agent-history.md § Phase 7`](../docs/agent-history.md#phase-7-synthetic-data-and-workflows).
