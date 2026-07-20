# Demo workflow is DDD-native + the labs synthetic system is dynamic

**Date:** 2026-07-20
**Context:** Designing/building `/ace:demo` — a standalone funder-demo pipeline (spec + Plan A in `docs/superpowers/{specs,plans}/2026-07-20-*`).

## The corrected mental model (an over-rotation to avoid)

When you look at the Connect Labs synthetic engine, the checked-in
`connect_labs/labs/synthetic/envs/*.yaml` + ensure engine (PAR, campaign) *look*
like "the system," and its ensurers hard-code the CHC-nutrition / program-admin
templates. **That is a durable-capture convenience layer, not the system.** The
system is **dynamic at the core**:

- **Data** is generated at runtime — `synthetic_generate_from_manifest`,
  `synthetic_clone_*`, `synthetic_create_labs_only`.
- **Dashboards ("workflows") are authored at runtime** — `workflow_create`,
  `workflow_update_render_code` / `workflow_patch_render_code`,
  `pipeline_update_schema`. This is exactly what Phase 7's
  `synthetic-workflow-seed` already does: arbitrary per-opp dashboards, **no
  checked-in template required**.

So a novel-KPI demo dashboard does NOT require checked-in labs Python — you author
it dynamically. You only commit a `<name>.yaml` env (+ template) when you want to
**persist** a demo as reusable — and committing that to the connect-labs repo is
correct, not friction. Don't mistake the env-ensure layer's PAR/CHC hard-coding
for the system's capability, and don't invent a "dynamic manifest" labs
enhancement — the dynamism is already there.

## ACE delegates the demo *engine* to canopy DDD

Canopy DDD owns narrative → render → judge → converge → video → upload, and its
narrative models (`WhyBrief`, `UnifiedSpec` in canopy `scripts/narrative/
models.py`) are explicitly designed as a neutral cross-consumer substrate (they
name an ACE consumer) with a published JSON Schema + validator (`scripts/ddd/
validate.py`). DDD renders labs workflow deep-links (`url: ${par_url}`) as a
first-class scene surface. So ACE authors a **DDD narrative** + **sets up the
dataset**, then hands off — it does not rebuild generation, rendering, judging,
or video.

## The single handoff: the realized `${var}` map

Three data-source providers — `denovo`, `clone`, `ace-run` — all converge on ONE
handoff: the realized map (`realized.json`) whose key value is
`par_url = /labs/workflow/<def>/run/?run_id=<rid>&opportunity_id=<opp>` (the
polished dashboard deep-link; the bare workflow URL renders the run *picker* —
see `2026-06-13-labs-workflow-run-deeplink.md`). The DDD spec's `setup` block
runs the generator and reads this map; scenes reference `${par_url}` + drills.
Phase 7 becomes the `ace-run` provider on the same pipeline (convergence = Plan C).

## Bonus: PAR is already a nutrition demo

The `program-admin-report` demo is CHC nutrition screening (MUAC, SAM/MAM,
gender). A nutrition-funder demo is very likely a **scenario reuse** of that
dashboard (new opps/workers/flagged-weeks/coaching-arcs), authored dynamically or
as a committed env — not a new-domain build.
