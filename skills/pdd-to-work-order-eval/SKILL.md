---
name: pdd-to-work-order-eval
description: >
  Independent quality re-grade for the Work Order produced by
  pdd-to-work-order. LLM-as-Judge, six quality dimensions: contractual
  clarity, PDD alignment, decisions traceability, verification realism,
  archetype fit, writing style. Skipped if pdd-to-work-order-qa returned
  verdict: incomplete. Verdict shape per lib/verdict-schema.ts.
disable-model-invocation: true
---

# PDD-to-Work-Order Eval

LLM-as-Judge quality re-grade. Six dimensions, each scored `pass | partial | fail` with cited evidence from the work-order body and `decisions.yaml`. Two or more non-pass dimensions → `verdict: fail`. A `verdict: fail` here does NOT halt the run on its own — `[BLOCKER]` concerns pause per the orchestrator's Per-Mode Pause Matrix.

If `pdd-to-work-order-qa` returned `verdict: incomplete`, this skill is **skipped** and emits `verdict: incomplete` mirroring QA's outcome.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-work-order.gdoc` (latest) | the artifact under quality re-grade |
| Phase 1 producer | `1-design/idea-to-pdd.md` | source-of-truth for PDD alignment check |
| Phase 1 producer | `decisions.yaml` | source-of-truth for decisions traceability check |
| Phase 1 QA | `1-design/pdd-to-work-order-qa_result.yaml` | gating signal |

## Products

- `1-design/pdd-to-work-order-eval_verdict.yaml` — verdict per `lib/verdict-schema.ts`

## Dimensions

Each dimension is scored `pass | partial | fail` with a 1-3 sentence rationale citing specific evidence from the artifacts. Two or more non-pass → `verdict: fail`.

### 1. Contractual clarity
*Could the named partner sign this draft without coming back for clarification on scope, deliverables, payment, or roles?*

Common failure modes: scope describes the intervention but omits unit definitions ("samples" without saying what counts as a verified sample); deliverables reference verification criteria that aren't enumerated anywhere; payment per unit not stated; roles RACI omits responsibilities for sample storage or transport.

### 2. PDD alignment
*Do the scope, deliverables, timeline, and payment trace back to the PDD?*

Common failure modes: scope expands beyond PDD ("includes patient-level data collection" when PDD is operational-only); timeline contradicts PDD Timeline section; geographic coverage adds regions the PDD doesn't mention; payment per unit doesn't match the PDD's `payment-rate` decision.

### 3. Decisions traceability
*Do the contractual numerics in the work order match the corresponding rows in `decisions.yaml`?*

Common failure modes: per-visit rate in section 6 differs from `payment-rate` decision row; FLW count in roles section differs from `flw-count` decision row; period of performance in header differs from `wo-period-of-performance` decision row; total NTE in section 6.1 differs from `wo-total-not-to-exceed-usd`.

### 4. Verification realism
*Are the "verified unit" criteria in section 4.2 actually measurable on the Connect platform?*

Common failure modes: criterion requires data not captured by the Connect app (e.g., "temperature logged during transit" without a temperature field); criterion requires audit data the platform doesn't expose; criterion is subjective ("delivered in good condition") without an audit mechanism.

### 5. Archetype fit
*Does the work-order shape match the declared archetype?*

Common failure modes: declared archetype is `focus-group` but scope describes per-visit data collection; declared archetype is `atomic-visit` but payment schedule is per-session; multi-stage PDD with a single-stage work order.

### 6. Writing style
*Does the prose read like a Dimagi external document — voice, modals, terminology, naming?*

Source-of-truth rubric: `skills/pdd-to-work-order/references/writing-style.md`. Grade against the renderable conventions only:

- **Acronyms expanded on first use** — `Insecticide-Treated Net (ITN)`, `Knowledge, Attitudes, Practices (KAP)`, `Locally-Led organization (LLO)`, `Household (HH)`, `Behavior Change (BC)`, `Frontline Worker (FLW)`, etc. Each unexpanded acronym on first appearance is one strike.
- **Modal verbs** — `will` / `may` / `must` only. Any `shall` is a strike.
- **Voice** — active by default. Avoidable passives like `"Verification will be performed via X"` (→ `"Dimagi will perform verification via X"`) are strikes.
- **Partner-naming convention** — first reference defines `[Partner Name] (henceforth, referred to as "partner")`, then lowercase `the partner` throughout. Mixing `Partner` / `the Partner` / `the partner` / `the vendor` / `the subcontractor` is a strike. (For unnamed-partner drafts: the first-reference definition still has to land — typically as `[Partner Name] (henceforth, referred to as "partner")` with the bracket as a placeholder.)
- **Terminology** — `the partner` not `the vendor`/`the subcontractor`; `Frontline Worker`/`FLW` not `Community Health Worker`; `Connect` not `CommCare Connect`/`the platform`; `Dimagi` not `Dimagi, Inc.`/`we`/`our team` (outside the parties block + signature block).
- **No marketing/hyperbole** — `"world-class"`, `"best-in-class"`, `"exciting opportunity"`. Each is a strike.
- **No vague commitments** — `"best efforts"`, `"as soon as practicable"`, `"from time to time"`. Each is a strike.

Grading bands: 0 strikes = `pass`; 1–3 strikes = `partial`; 4+ strikes = `fail`. Count multiple instances of the same class as one strike each (e.g., 11 unexpanded acronyms = 11 strikes → `fail`).

**Out of scope (pipeline limitation):** Do NOT grade on bold-span density. The current template uses plain-text `replaceAllText` and there is no bold-finalizer — the producer skill explicitly strips markdown bold from prose tokens. Re-enable the bold dimension once a `docs_finalize_bold` post-processor ships.

## Process

1. **Check the gating signal.** Read `pdd-to-work-order-qa_result.yaml`. If `verdict: incomplete`, emit `pdd-to-work-order-eval_verdict.yaml` with `verdict: incomplete` and return. If `verdict: fail`, proceed (QA's failures are auto-fixable; eval still grades the substantive concerns of the latest draft).

2. **Read the artifacts.** Work order body, PDD body, decisions.yaml. Parallel `drive_read_file` block.

3. **Grade each dimension.** For each of the five dimensions:
   - State the dimension question.
   - Quote 1-3 specific pieces of evidence from the work order, PDD, or decisions.yaml.
   - Assign `pass | partial | fail` with a 1-3 sentence rationale.

4. **Compute the verdict.** `verdict: pass` if all dimensions pass. `verdict: partial` if exactly one is non-pass. `verdict: fail` if two or more are non-pass.

5. **Surface blockers.** Add `auto_surfaced[]` entries with `severity: BLOCKER` for any dimension grading `fail` where the underlying gap could compromise the contract's enforceability (e.g., verification criteria that aren't measurable, scope mismatches with PDD). `severity: WARN` for dimensions grading `partial` or `fail` that are recoverable. The orchestrator surfaces `BLOCKER` entries at the Phase 1→2 pause.

6. **Write the verdict YAML** to `1-design/pdd-to-work-order-eval_verdict.yaml` per `lib/verdict-schema.ts`. Required top-level keys: `skill` (`pdd-to-work-order-eval`), `target` (work-order Drive file id), `ran_at` (ISO timestamp), `capture_path` (the verdict's own Drive path), `overall_score` (0–10; map dimension grades to numerics: pass=10, partial=5, fail=0; weighted mean across the six dimensions), `verdict` (`pass` | `partial` | `fail` | `incomplete`), and `dimensions` (a record keyed by dimension id — `contractual_clarity`, `pdd_alignment`, `decisions_traceability`, `verification_realism`, `archetype_fit`, `writing_style` — each with `{ score: 0–10, weight }` such that weights sum to 1.0). Weights: the five content dimensions at 0.17 each (0.85 total), `writing_style` at 0.15. Optional: `auto_surfaced[]` for blocker/warn entries, `mode`, `overall_score_pre_cap`. Record the per-dimension rationale + evidence quotes as `note:` strings under `per_item[]` if granular auditability is needed, otherwise embed in `auto_surfaced[].message`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial version | ACE team |
| 2026-05-21 | Add `writing_style` 6th dimension scoped to renderable conventions (acronyms, modals, voice, partner-naming, terminology). Reweight: 5 content dims × 0.17 + writing_style × 0.15 = 1.00. Bold deferred until `docs_finalize_bold` ships. | ACE team |
