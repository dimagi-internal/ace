# ACE Demo Workflow — design spec

**Date:** 2026-07-20
**Status:** Design (approved direction; spec under review)
**Author:** ACE agent + Jon
**Related:** `agents/synthetic-data-and-workflows.md` (Phase 7), canopy DDD (`agents/ddd.md`), connect-labs synthetic engine

## 1. Problem & goal

ACE can build demos, but only inside a full `/ace:run` lifecycle. We need a **standalone, repeatable "demo workflow"** that stands up killer labs dashboards for a stakeholder/funder meeting from either (a) a **cloned real Connect opportunity** or (b) **de-novo synthetic data**, and shows them as **live labs dashboards**. The forcing case is a Friday meeting with a nutrition funder (Operation Ensorvation).

Two goals, one body of work:
1. **Add a demo entry point** — parameterized on data source, *without disrupting* the core `/ace:run` framework.
2. **Make the core `synthetic-*` skills better** as a byproduct — by converging them onto a shared foundation rather than maintaining a parallel path.

Scope of *this* effort: design + plan only. Friday's actual dashboards are built in a follow-up run once the skills exist. (Friday is expected to be a low-risk case — see §9.)

## 2. Corrected mental model (what the system actually is)

The Connect Labs synthetic system is **dynamic at its core**:
- **Data** is generated at runtime — `synthetic_generate_from_manifest` (inline manifest), the `synthetic_clone_*` family (from a real opp), `synthetic_create_labs_only`.
- **Dashboards ("workflows") are authored at runtime** — `workflow_create`, `workflow_update_definition`, `workflow_update_render_code` / `workflow_patch_render_code`, `pipeline_update_schema`. This is exactly what ACE's existing `synthetic-workflow-seed` does today: it builds arbitrary per-opp dashboards dynamically, with **no checked-in template required**.
- A workflow renders as a live dashboard at its run deep-link: `/labs/workflow/<def_id>/run/?run_id=<run_id>&opportunity_id=<opp_id>` (the `par_url` shape). This is the "live labs dashboard" surface.

The checked-in `connect_labs/labs/synthetic/envs/*.yaml` + ensure engine (PAR, campaign) are **not** the system — they are a **durable-capture layer** on top of the dynamic primitives: an idempotent way to persist a reusable composite standing demo. Committing a durable demo's YAML to the connect-labs repo is the correct home for it, not friction.

**Canopy DDD is the demo-production engine.** It owns narrative → render → judge → converge → video → upload, and its narrative models (`WhyBrief`, `UnifiedSpec` in canopy `scripts/narrative/models.py`) are explicitly designed as a neutral, cross-consumer substrate that names an "ACE AI-video pipeline" as an intended consumer, with a published JSON Schema and a validator (`scripts/ddd/validate.py`). DDD renders labs workflow deep-links (`url: ${par_url}`) as a first-class scene surface. The join between a DDD spec and the labs generator is the spec's `setup` block: `command` runs the generator, `outputs` is the realized `${var}` JSON, scenes reference `${par_url}` and drill URLs.

**Implication:** ACE should not rebuild data generation, dashboard authoring, rendering, judging, or video. ACE authors a **DDD narrative** and **sets up the initial dataset** (dynamically), then hands to DDD. This is precisely the original framing: *"the skill is about creating a DDD narrative with specific instructions on how to get the initial data sets set up."*

## 3. Architecture

### 3.1 The data-source seam

Today Phase 7 has exactly one implicit data source: the Connect opportunity ACE created in Phase 4, read inline as `phases.connect-setup.products.connect.opportunity.connect_int_id`. We replace that implicit assumption with an explicit **provider** parameter. Every provider converges on one common handoff: **the realized `${var}` map** (a `realized.json` containing `par_url` + drill URLs) that a DDD `setup` block consumes.

Three providers:
- **`denovo`** — input is a short demo brief (no PDD). Generate synthetic data dynamically + author the dashboard(s) dynamically → realized map.
- **`clone`** — input is a real Connect op ID. `synthetic_clone_profile` → `synthetic_clone_generate` / `synthetic_clone_to_labs_only` produces labs-only opps + fixtures; then author a dashboard over those opp ids (dynamic workflow authoring, same path as denovo) → realized map. Optional fidelity check (`synthetic_fidelity_report`) as a QA gate.
- **`ace-run`** — the existing Phase 7 path: opp from Phase 4 drives the same data + dashboard authoring. Behavior preserved.

Downstream (narrative authoring + DDD) consumes only the realized map + narrative context. It does not know or care which provider produced it. That single seam is simultaneously (a) what makes a standalone demo possible and (b) the core-skill improvement — the synthetic authoring skills become reusable outside `/ace:run`.

### 3.2 The pipeline

```
/ace:demo  (or /ace:run Phase 7)
   │
   ├─ demo-data-setup  [provider: clone | denovo | ace-run]
   │     • generate synthetic data (dynamic)         ← labs atoms
   │     • author dashboard(s) (dynamic workflow)    ← labs atoms (reuses workflow-seed engine)
   │     • return realized ${var} map (par_url + drills)
   │
   ├─ demo-narrative
   │     • author DDD WhyBrief + UnifiedSpec          ← canopy narrative models
   │     • scenes target url: ${par_url}
   │     • setup block runs demo-data-setup's command → outputs realized.json
   │     • validate via canopy scripts/ddd/validate
   │
   └─ hand off to canopy:ddd  (full loop)  or  /canopy:ddd-run (single render+judge)
         • render (canopy:walkthrough) → judge → converge → video → upload
         • output: live labs dashboards + canopy-web /ddd/<slug>/<run_id> package
```

### 3.3 What ACE builds (thin)

| Component | Type | Role |
|---|---|---|
| `demo-data-setup` (+`-qa`,`-eval`) | core skill (new; absorbs Phase 7 dynamic authoring) | Parameterized `clone \| denovo \| ace-run`. Generates data + authors dashboards dynamically; returns the realized `${var}` map. Encodes the labs gotchas (§6). |
| `demo-narrative` (+`-qa`,`-eval`) | core skill (new; converges `synthetic-narrative-plan`) | Authors a funder-tuned DDD `WhyBrief` + `UnifiedSpec`; validates against canopy's validator. |
| `demo` procedure doc + `/ace:demo` command | agent layer (new) | Orchestrates setup → narrate → hand to `canopy:ddd`. Runs at level 0 (dispatches the DDD agent). Params: `--source {clone --opp <id> \| denovo --brief <path>} --name <demo-name> [--render]`. |

### 3.4 What ACE reuses unchanged

- Canopy DDD loop + narrative models + validator (`canopy:ddd`, `/canopy:ddd-run`, `/canopy:ddd-ace-render`, `scripts/ddd/validate`).
- Labs dynamic primitives: synthetic data generation (`synthetic_generate_from_manifest`, `synthetic_clone_*`, `synthetic_create_labs_only`) + dynamic workflow authoring (`workflow_*`, `pipeline_*`).
- `canopy:walkthrough` render of `${par_url}` labs dashboards.
- The `hal:synthetic-walkthrough` recipe as a proven reference for auth → ensure/generate → render → upload.

### 3.5 Minimal demo state (structural, not flags)

`/ace:demo` scaffolds `ACE/<demo-name>/runs/<demo-run-id>/` with a `run_state.yaml` where **only** `phases.synthetic-data-and-workflows` is live; other phases are `status: not-applicable`. This reuses the Phase Write-Back Contract, so `/ace:status`, the `-eval` rubrics, and `opp-eval` all keep working on a demo with no new plumbing. A demo is just a run with one live phase. (Per `docs/learnings/2026-06-01-seeded-run-structural-not-flags.md` — run shape lives in `run_state`, not in flags the model may ignore.) No separate demo state model.

## 4. Phase 7 convergence (the go-big payoff)

Phase 7 and `/ace:demo` become the **same pipeline**, differing only by provider and entry point.

- **Reuse (fold into `demo-data-setup`):** `synthetic-data-generate`, `synthetic-workflow-seed`, `synthetic-workflow-polish` — the dynamic data + dashboard authoring engine. These are the value; they are not duplication.
- **Converge:** `synthetic-narrative-plan` → author a DDD `WhyBrief` + `UnifiedSpec` (the shared substrate) instead of the bespoke `synthetic-narrative-plan.yaml`. Becomes `demo-narrative` with `provider: ace-run`.
- **Retire (DDD already owns these):** `synthetic-walkthrough-spec`, `synthetic-walkthrough-run`, `synthetic-summary` → `ddd-run` / `canopy:walkthrough` / `ddd-upload`.
- **`agents/synthetic-data-and-workflows.md`:** rewired to call `demo-data-setup(provider=ace-run)` → `demo-narrative` → DDD. Archetype branching preserved (`atomic-visit`, `multi-stage`; `focus-group` stays a hard skip).

Net: one demo/synthetic pipeline, three providers, two entry points. Fewer bespoke skills, all downstream production on the DDD engine.

## 5. Connect Labs — verify, then enhance only if needed

The plan's **first step is a live audit** against the labs MCP `tools/list` + the connect-labs checkout (`~/emdash/repositories/connect-labs`, `dimagi-internal` remote), because `playbook/integrations/connect-labs.md` is ~20 atoms stale.

The one thing to **verify (not assume):** clone → dashboard. Clone yields labs-only opps + fixtures under a `program_id` but does not itself produce a workflow/rollup. The hypothesis is that authoring a dashboard over cloned opp ids is **pure orchestration** — point a dynamically-created workflow (+ pipeline schema) at those opp ids, exactly as denovo does. If that holds, no labs change is needed. If a genuine gap surfaces (e.g. the workflow authoring path can't target clone-produced opp ids cleanly), file it in `connect-labs` and build the minimal bridge — but do not spec a labs enhancement on speculation.

Refreshing `playbook/integrations/connect-labs.md` to match the live atom set (clone/profile/fidelity/pages/env/bulk families) is a supporting task.

## 6. Labs gotchas the demo skills must encode

(From the live engine; `demo-data-setup` must know these.)
- **Labs-only opp ids ≥ 10,000 have no CommCare HQ app.** Anything needing a real HQ app (deliver-unit introspection, "Create Review") can't be driven for a synthetic opp — use the synthetic generator, which writes records directly.
- **Pin the demo timeline** (a fixed Monday). An unpinned trailing window slides off "today" and breaks idempotency of already-seeded runs/flags/audits/tasks.
- **Live-demo "on camera" records** (the flagged current-week worker's audit/task) are deliberately *not* pre-seeded — the walkthrough creates them live. Get this wrong and the demo scene has nothing to click.
- **First persona = network manager** (flag-rate 0) across flags/tasks/rollup label.
- **A "resolved" cluster needs every audit completed AND every task closed**; the rollup drill selector needs one fully-resolved cluster and one still-open cluster in a different opp.
- Anomaly week indices are 0-based (audits); coaching-arc weeks are 1-based (tasks); out-of-window anomalies are silently skipped.

## 7. Cross-repo dependencies

- **canopy** — ACE authors against canopy's narrative models and invokes its validator + DDD loop. ACE shells to the canopy checkout (as `hal:synthetic-walkthrough` does via `uv`) for `scripts/ddd/validate` and dispatches the `canopy:ddd` agent for the loop. Handoff points: `canopy:ddd` (full), `/canopy:ddd-run` (single pass), `/canopy:ddd-ace-render` (video bridge to `/ace:video-render-local`).
- **connect-labs** — durable demo envs (and any confirmed clone→dashboard bridge) land as PRs in `dimagi-internal/connect-labs`.
- **ace** — the new skills, procedure doc, command, and Phase 7 rewiring.

## 8. Non-goals (YAGNI)

- No `pages_*` self-contained shareable page in this effort (surface is live dashboards; note it as the future leave-behind path).
- No new labs "dynamic manifest" MCP enhancement — the system is already dynamic; durable demos are committed YAML.
- No speculative clone→env bridge — build it only if the §5 live audit proves a gap.
- No FGD (`focus-group`) demo path — stays a hard skip, as in Phase 7.
- No rebuild of DDD rendering/judging/video.

## 9. Friday (Operation Ensorvation) — risk note

Not built in this effort, but de-risked: the existing `program-admin-report` demo *is already a nutrition demo* (CHC nutrition screening, MUAC, SAM/MAM, gender KPIs). A nutrition-funder demo is very likely a **scenario reuse** of the CHC nutrition dashboard — new opps/workers/flagged-weeks/coaching-arcs, authored dynamically or as a new committed env — not a new-domain dashboard build. That is the fast path once the skills exist.

## 10. Open questions (resolve in the plan)

1. **Clone → dashboard orchestration** — confirm live (§5). Determines whether any labs change is needed at all.
2. **Canopy invocation mechanics** — exactly how ACE shells to the canopy checkout for `validate` and dispatches `canopy:ddd` from a level-0 procedure (path discovery, auth/session, `uv` availability). Mirror `hal:synthetic-walkthrough`.
3. **Durable vs ephemeral demos** — when a demo is captured as a committed `envs/*.yaml` vs. authored fresh each run. Propose: canonical/reusable demos (a nutrition-funder demo) get committed; one-off demos are authored fresh into the demo run's state.
4. **Eval/QA rubrics** — new `demo-data-setup-eval` / `demo-narrative-eval` (or lean on DDD's own judges: `ddd-concept-eval`, `ddd-narrative-actionability-eval`, `ddd-video-judge`). Prefer reusing DDD judges where they fit; add ACE rubrics only for the data-setup step DDD doesn't cover.
5. **Phase 7 migration sequencing** — build `/ace:demo` DDD-native first and prove it (clone + denovo), then rewire Phase 7 onto `demo-data-setup`/`demo-narrative`, then retire the superseded skills last with the old path intact until the new one is green.

## 11. Sequencing (for the implementation plan)

1. Live labs audit (§5) + refresh `connect-labs.md`; confirm clone→dashboard.
2. `demo-data-setup` (denovo first, then clone) → returns a realized `${par_url}` map; verify a live dashboard renders.
3. `demo-narrative` → valid DDD `WhyBrief`+`UnifiedSpec` against the realized map; canopy validator green.
4. `/ace:demo` procedure + command → end-to-end `denovo` demo handed to `/canopy:ddd-run`; live dashboard + rendered walkthrough.
5. `clone` provider end-to-end (+ fidelity gate).
6. Phase 7 convergence: rewire `agents/synthetic-data-and-workflows.md` onto the new skills; retire superseded skills; keep old path until new path is green.
7. (If worth persisting) commit a canonical nutrition-funder demo env to connect-labs.
