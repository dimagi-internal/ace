# Run shape is structural (in `run_state.yaml`), not a `/ace:run` flag

**Date:** 2026-06-01
**Surfaced by:** `bednet-spot-check/20260601-2009` (seeded run launched on the labs
headless runner via the ace-web seeded-run action with
`/ace:run bednet-spot-check --seed-from 20260531-2258 --only 3,4,6`)
**Class:** behavior-via-markdown isn't reliably honored — especially headless
**Issue:** jjackson/ace#672

## What happened

The first `/ace:iterate` design (spec `2026-06-01-ace-iterate-loop-design.md`)
made "start mid-pipeline with a golden upstream prefix" a pair of `/ace:run`
flags — `--seed-from <golden-run-id>` + `--only 3,4,6` — that the **orchestrator
model interprets at run-setup** (Step 4b: fork the golden, mark phases 1–2
`done`, skip 5/7/8). There was no code enforcing it; the orchestrator markdown
*told* the model to do it.

On the labs headless runner the executing model **silently ignored the flags**
and ran a normal full pipeline from Phase 1: it synthesized a brand-new PDD
(eval 7.73) instead of reusing the golden's (eval 8.46), re-ran Phase 2 fresh,
and would have continued through 5/7/8 with no stop. The headless turn arrived
as an injected user message; the model treated `/ace:run <opp> --seed-from …
--only …` as "do a normal run of `<opp>`" and dropped the rest.

## The lesson

**Don't put run-shape decisions in flags the orchestrator has to notice and
apply.** A flag like `--only 3,4,6` is an instruction the model may or may not
honor. The reliable substrate is **state the model already reads on every
resume**: `run_state.yaml.phases.*.status`.

So run shape became structural:

1. **Seed first, outside `/ace:run`.** The control (`agents/iterate-loop.md`)
   or the ace-web `seeded-run` action **forks** the golden into a new run and
   writes its `run_state.yaml` so the phase statuses encode the shape — seed
   prefix `done`/`verdict: seeded`, target phases `pending`, gap+tail phases
   `skipped`, `seeded_from` at the root.
2. **Then resume.** Dispatch a plain `/ace:run <opp>/<new-run-id>`. The
   orchestrator's resume path (well-exercised, reliable) runs `pending` phases
   in ordinal order, **steps over `skipped`**, and **ends when no `pending`
   phase remains**. Both "seed 1–2" and "only 3,4,6 then stop" fall out of the
   statuses — no flag, no special stop logic.

The `--seed-from`/`--only` flags were **removed** from the orchestrator and
`commands/run.md`. `skipped` was added to `PHASE_STATUSES` in
`lib/run-state-validator.ts` (it had only been a *step* status). Phase-6
app-QA-only mode is now keyed on `phases.ocs-setup.status == skipped` instead of
"`5` absent from `--only`".

## Why this is the same family as other ACE rules

- **"Close the loop to the source of truth — don't guess."** Run shape now lives
  in the one file the resume path authoritatively reads, instead of being
  re-derived from a flag the model might skip.
- **"Phase preconditions are restored, not adapted."** A seeded run is just a
  resume of a run restored to a known precondition (1–2 done, 3 pending); the
  resume path is the single deterministic driver.
- **Structural > instruction.** Like the boundary-fence `classify_phase_writeback`
  check replacing "trust the agent's 'Phase complete' text," the run-shape
  decision moved from prose the model interprets to a status enum it reads.

## Residual

ace-web's `fork_opp` (`apps/opps/opp_forker.py`) synthesizes a per-skill phases
map (`phases.<phase>.<skill>: status`), which is NOT the plugin contract shape
(`phases.<phase>.{status, …}`). The `seeded-run` action therefore writes the
contract-shaped phases map **authoritatively after forking** rather than relying
on `fork_opp`'s synthesized shape. The shape discrepancy in `fork_opp` itself is
tracked separately (a plain `fork-run` produces a run whose seeded phases lack a
phase-level `status`).
