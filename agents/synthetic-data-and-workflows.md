---
name: synthetic-data-and-workflows
description: >
  Phase 7 of the ACE lifecycle: produce a stakeholder-ready synthetic-data demo on
  top of the built apps. CONVERGED (Plan C, 2026-07-21) onto the /ace:demo pipeline —
  demo-data-setup(ace-run) generates data + authors dashboards, demo-narrative
  authors the DDD narrative, and the canopy DDD loop renders/judges/uploads. Same
  engine as /ace:demo, differing only by data-source provider. No run-time gate.
model: inherit
phase: synthetic-data-and-workflows
phase_display: Synthetic Data and Workflows
phase_ordinal: 7
skills:
  - { name: demo-data-setup,   has_judge: false, qa_skill: demo-data-setup-qa }
  - { name: demo-narrative,     has_judge: false } # canopy scripts.ddd.validate is the gate
---

# Synthetic Data and Workflows (Phase 7 Procedure Document)

**This file is read and executed inline by the top-level Claude Code session — it
is NOT dispatched as a subagent.** Step 3 dispatches `canopy:ddd`, which fans out
per-scene judges of its own — the deepest chain in ACE. Running inline costs no
dispatch depth, which is what keeps that chain at depth 2 inside a budget of 3
(`CLAUDE.md § Agent topology`; `lib/agent-depth.ts` holds the arithmetic).

The constraint is a budget, not a ban: dispatching this node is legal, it just
spends a level that its own fan-out below can use. Past the budget the `Agent`
tool is withheld silently rather than erroring — the per-scene judging collapses
into one context and still emits a full set of verdicts, correlated and
optimistic.

Keep the `Agent(canopy:ddd)` dispatch below intact. When that branch is
unreachable the only executable path is a single render+judge with no loop, no
convergence rule and no stopping rule — the failure behind
`spark-facilitator/20260813-2126`, hand-driven for four iterations and ~2M tokens
before a human called a halt. The frontmatter is retained for tooling
introspection (`/ace:status`, `/ace:eval`, `/ace:doctor`, `/ace:docs`).

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

## Workflow (every archetype except focus-group)

### Step 0: Phase folder setup (FIRST)

`drive_create_folder({name: '7-synthetic', parentFolderId: <run-folder id>, findOrCreate: true})`
— idempotent. Every artifact this phase produces writes into THIS `7-synthetic/`
folder id (never the run-folder root — fails `verify_phase_artifacts`, jjackson/ace#791).

### Step 1: Data + dashboards — `demo-data-setup(provider=ace-run)`

Invoke `demo-data-setup` with `{provider: ace-run, name: <opp>, runId: <run-id>}`.
It reads the run's Phase-4 opp (`phases.connect-setup.products.connect.opportunity`,
`connect_int_id`) + the PDD/app structure, authors a story-coherent manifest keyed on
the real deliver-app form paths, generates fixtures via
`synthetic_generate_from_manifest`, and authors the demo dashboards dynamically
(`workflow_create_from_template` → `pipeline_update_schema` → render → **`workflow_create_run`**
→ `workflow_save_snapshot`). Returns the realized `${var}` map (one
`/labs/workflow/<def>/run/?run_id=<id>&opportunity_id=<opp>` URL per dashboard) and
writes `7-synthetic/realized.json` + the `products.synthetic` block.

**Gate:** `demo-data-setup-qa` (structural — every dashboard URL is a valid run
deep-link, labs-only opp, timeline pinned). On `fail`, apply auto-fix hints and
re-run before proceeding — a dead dashboard must not reach a stakeholder.

### Step 2: Narrative — `demo-narrative`

Invoke `demo-narrative` with `{brief: <PDD-derived>, realizedRef: 7-synthetic/realized.json, runId}`.
It authors a DDD `WhyBrief` + `UnifiedSpec` (scenes on `${…_par_url}`, honest gaps)
and **validates both via canopy `scripts.ddd.validate`** — do not proceed until both
validate. Writes `7-synthetic/why_brief.yaml` + `<slug>.yaml`.

### Step 3: Render + converge — canopy DDD

**Dispatch `Agent(canopy:ddd)`** — the full converge → video → upload loop. This is
the default and the only path that terminates on its own. Pass the run id, the
unified spec, and the why-brief.

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

The verified render mechanics (labs-session refresh precondition,
`record_video --storage-state`, the `workflow_create_run` run_id URL model) live
in `agents/demo.md § Render` — follow them. Screenshots are the fallback if
canopy's `webm→mp4` conversion fails.

**On a non-`converged_clean` ending, do not halt the run.** Phase 7 has no gate.
Record the terminal status and any open strategy findings in the phase write-back
(`verdict: passed-with-deferred-evals`), publish the `--stuck` package URL as the
`summary_artifact`, and proceed to Phase 8.

### Step 4: Write-back + summary

Write the `phases.synthetic-data-and-workflows` block per
[`§ Phase Write-Back Contract`](../agents/orchestrator-reference.md#phase-write-back-contract).
**Populate `products.synthetic` in the shape ace-web reads**
(`apps/opps/summary.py::_read_walkthroughs`): `labs_opp_id`, `workflows{}` (one per
dashboard `demo-data-setup` built — map `dashboards[]` to `{workflow_id, run_url}`),
and `walkthroughs[]` (one entry per DDD render — `{web_view_link: <deck/package URL>,
eval_score}`). `summary_artifact:` = the DDD package (or a one-page summary) file id.
Use `update_yaml_file({merge: 'deep'})` — never `two-level` (drops siblings, #572).

```yaml
phases:
  synthetic-data-and-workflows:
    status: <done|partial>
    completed_at: <ISO>
    verdict: <pass|passed-with-deferred-evals>
    summary_artifact: <DDD package / summary doc id>
    products:
      synthetic:
        provider: ace-run
        labs_opp_id: <int>
        source: { dashboards: [...], realized_vars_ref: 7-synthetic/realized.json }
        workflows: { <key>: { workflow_id: <id>, run_url: <par_url> } }
        walkthroughs:
          - web_view_link: <DDD /ddd/<slug>/<run_id> package URL>
            eval_score: <0-5 or omit>
        # canopy's own ending for the DDD loop — never collapse these to pass/fail:
        # converged_clean | converged_with_open_questions | stopped_not_converged | diverging
        ddd_terminal_status: <status>
        ddd_open_strategy_findings: <int>
    steps:
      demo-data-setup: { status: done }
      demo-narrative:   { status: done }
      ddd-run:          { status: done }
```

## Preconditions

- [ ] `phases.connect-setup.products.connect.opportunity(.connect_int_id)` present
  (Phase 4 ran this run) — the opp + apps the manifest is derived from.
- [ ] `LABS_MCP_TOKEN` set in `${CLAUDE_PLUGIN_DATA}/.env`.
- [ ] Labs gdrive parent shared with the ACE SA (fixture verification).
- [ ] For Step 3 render: labs browser session (ACE self-logins per `agents/demo.md §
  Preconditions`; needs shell-safe `.env` + `ACE_HQ_USERNAME/PASSWORD`), canopy
  checkout + `uv` reachable.

## Re-runnability

Each step is independently re-runnable via `/ace:step <skill> --opp <slug>/<run-id>`
(`demo-data-setup`, `demo-narrative`). Regenerate data → dashboards pick up the new
fixtures on next render. Full disable → `synthetic_disable(opp_int_id)`.

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
