---
name: reconcile-outputs
description: >
  Internal /ace:run step — Report any fact a run's artifacts state two ways.
user-invocable: false
disable-model-invocation: false
---

# Reconcile Outputs

Read a run's generated artifacts together and report any fact that two of them state differently.
Binary verdict: pass / fail / incomplete. Ten checks, all static and runnable in <100ms via the
importable `checks.ts` module — no LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol,
static-vs-LLM rules).

## Why this exists

Every other `-qa` and `-eval` skill judges **one artifact against the PDD**. That is a vertical
check, and it cannot see a contradiction between two documents that are each individually
defensible. `opp-eval` does not close the gap either — it aggregates verdicts, not content.

On `tekzal/20261013-2314` the partner's Round 1 review rated the round 2/4 and opened with:

> *"What stops us is that the outputs disagree with each other on things we would act and spend
> on. The sharpest is who pays the field worker."*

The work order said FLW payments are disbursed through Connect directly to the worker. All four
training documents said the partner pays. The partner treated the contract as authoritative, which
made it a question of who funds the float. Their first recommendation, ahead of everything else
they found:

> *"Check the generated outputs against each other before release… One comparison pass would have
> caught every one."*

This skill is that pass.

## When it runs

After Phase 6, once the work order (Phase 1) and the full training set (Phase 6) both exist —
every artifact that asserts a shared fact has been written by then. Runs before anything is sent
to a partner.

Also runnable standalone via `/ace:step reconcile-outputs <opp>/<run-id>` when artifacts are
regenerated out of band.

## Inputs

Pipeline-only: reconciliation is a property of one run's artifact SET, so there is no parameterized form — a caller cannot hand it two documents from different runs and get a meaningful answer. Its inputs are that run's artifacts (below) and the facts its PDD settled.

| Input | Where from |
|---|---|
| Work order | `1-design/pdd-to-work-order.gdoc` |
| Manager / LLO guide | `6-qa-and-training/training-llo-guide.gdoc` |
| FLW guide | `6-qa-and-training/training-flw-guide.gdoc` |
| Quick reference card | `6-qa-and-training/training-quick-reference.gdoc` |
| FAQ | `6-qa-and-training/training-faq.gdoc` |
| Training deck spec | `6-qa-and-training/training-deck-generate.yaml` |
| Settled facts | the PDD — worker cap, per-worker cap, campaign total, payment condition count, field alias groups |

An artifact that does not exist is skipped, not failed. A run with fewer than two artifacts
returns `incomplete` — there is nothing to reconcile.

## Checks

All static. Each takes **more than one artifact**; a check that reads a single document belongs in
that document's own `-qa` skill.

| Check | Fails when |
|---|---|
| `no_direct_flw_payment` | any artifact says money reaches the worker from Dimagi, or through Connect as payer |
| `payment_condition_count_agrees` | two artifacts enumerate the payment test with different numbers of conditions |
| `caps_reach_the_coordinator` | worker cap × per-worker cap is below the campaign total, or the worker cap is absent from the manager guide |
| `consent_precedes_questions` | a numbered step list asks or photographs before it consents |
| `contingent_phase_not_called_separate` | "separate engagement" is used for a phase inside this contract |
| `no_device_or_camera_guidance` | a partner-facing artifact recommends a handset or a camera setting |
| `approvals_stay_generic` | a named permission, authority, fee or lead time appears |
| `one_name_per_field` | the same captured field is called different things in different artifacts |
| `support_route_agrees` | escalation addresses use more than one domain, or reply-time commitments differ |
| `floor_taught_with_target` | training teaches a minimum visit length without the target range |

Each check's docstring in `checks.ts` names what it deliberately does **not** catch. Those
carve-outs are load-bearing: Connect legitimately *records* payments the partner makes, and the
FLW guide legitimately tells a worker to hold the phone steady. A broad rule here becomes the
always-fires check that gets routed around inside one run.

## Process

1. Resolve the run folder and read each artifact above that exists. Export Docs as `text/plain` —
   `text/markdown` escapes characters and corrupts the matching.
2. Read the settled facts from the PDD. A fact the PDD has not settled is passed as `undefined`
   and its check no-ops rather than guessing.
3. Run every check in `RECONCILE_CHECKS`.
4. Write `6-qa-and-training/reconcile-outputs_result.yaml` per `lib/qa-types.ts`.
5. On any failure, report to the orchestrator with the `auto_fix_hint` naming the producer to
   regenerate. **Do not fix the artifact in place** — the producer that wrote the wrong value will
   write it again next run unless the producer is the thing that changes.

## Program facts

The facts this skill reconciles, and the invariants it enforces, are defined in
[`skills/_program-facts.md`](../_program-facts.md). Read it before changing a check — the
contract is the source of truth and the test suite asserts the two stay in step.

## Terminology

Follows [`skills/_terminology.md`](../_terminology.md).

## Verification

`test/skills/reconcile-outputs.test.ts` runs every check against **Round 1's actual wording**,
quoted from tekzal's review. Those fixtures must FAIL — a reconciliation check that passes the
artifacts which caused the incident is a green tick over the same defect. Paired corrected
fixtures must pass, and a third group asserts the checks do not over-fire on legitimate prose.
