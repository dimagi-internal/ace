---
name: pdd-to-work-order-eval
description: >
  Independent quality re-grade for the Work Order produced by
  pdd-to-work-order. LLM-as-Judge, seven quality dimensions: contractual
  clarity, PDD alignment, decisions traceability, verification realism,
  commercial realism, archetype fit, writing style. Skipped if
  pdd-to-work-order-qa returned verdict: incomplete. Verdict shape per
  lib/verdict-schema.ts.
disable-model-invocation: false
---

# PDD-to-Work-Order Eval

LLM-as-Judge quality re-grade. Seven dimensions, each scored `pass | partial | fail` with cited evidence from the work-order body and `decisions.yaml`. Two or more non-pass dimensions → `verdict: fail`. A `verdict: fail` here does NOT halt the run on its own — `[BLOCKER]` concerns pause per the orchestrator's Per-Mode Pause Matrix.

Most dimensions trace the work order back to the PDD and `decisions.yaml` — that's **fidelity to the AI authoring chain**. Per `skills/_eval-template.md § The out-of-chain fitness requirement`, a draft that faithfully renders an unshippable contract must still fail. Two dimensions carry the out-of-chain fitness axis: **`verification_realism`** (0.20 — are the verified-unit criteria actually measurable on the live Connect platform?) and the new **`commercial_realism`** (0.17 — would a real Dimagi contracts person sign this?). Together they ensure a faithful-but-unshippable draft cannot clear `pass`.

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

Each dimension is scored `pass | partial | fail` with a 1-3 sentence rationale citing specific evidence from the artifacts. Two or more non-pass → `verdict: fail`. Either out-of-chain fitness dimension (`verification_realism`, `commercial_realism`) grading `fail` is on its own a `[BLOCKER]` (see step 5) — a faithful-but-unshippable draft must not clear `pass`.

### 1. Contractual clarity
*Could the named partner sign this draft without coming back for clarification on scope, deliverables, payment, or roles?*

Common failure modes: scope describes the intervention but omits unit definitions ("samples" without saying what counts as a verified sample); deliverables reference verification criteria that aren't enumerated anywhere; payment per unit not stated; roles RACI omits responsibilities for sample storage or transport.

### 2. PDD alignment
*Do the scope, deliverables, timeline, and payment trace back to the PDD?*

Common failure modes: scope expands beyond PDD ("includes patient-level data collection" when PDD is operational-only); timeline contradicts PDD Timeline section; geographic coverage adds regions the PDD doesn't mention; payment per unit doesn't match the PDD's `payment-rate` decision.

### 3. Decisions traceability
*Do the contractual numerics in the work order match the corresponding rows in `decisions.yaml`?*

Common failure modes: per-visit rate in section 6 differs from `payment-rate` decision row; FLW count in roles section differs from `flw-count` decision row; period of performance in header differs from `wo-period-of-performance` decision row; total NTE in section 6.1 differs from `wo-total-not-to-exceed-usd`.

### 4. Verification realism *(out-of-chain fitness)*
*Are the "verified unit" criteria in section 4.2 actually measurable on the Connect platform as it really runs — not just as the PDD imagines?*

This is graded against the real platform's capabilities, not against the PDD. A criterion can trace perfectly to the PDD and still be unverifiable in production. Common failure modes: criterion requires data not captured by the Connect app (e.g., "temperature logged during transit" without a temperature field); criterion requires audit data the platform doesn't expose; criterion is subjective ("delivered in good condition") without an audit mechanism. A `fail` here is a `[BLOCKER]` — an unverifiable criterion makes the contract unenforceable regardless of PDD fidelity.

### 5. Commercial realism *(out-of-chain fitness)*
*Would a real Dimagi contracts person sign this draft?*

Graded against external commercial reality, NOT against the PDD or `decisions.yaml`. Two sub-axes:

- **Payment-schedule / NTE sanity against external benchmarks.** Is the per-unit rate, the total-not-to-exceed, and the period-of-performance commercially plausible for the named geography and worker class? Use general domain knowledge of real field-program economics — a per-visit rate so low no FLW would work for it, a total NTE that implies an impossible visit volume for the stated period, or a margin that no real subcontract would carry are each a strike. (A draft can match `decisions.yaml` exactly and still encode a number that makes no commercial sense — `decisions.yaml` is in-chain, the market is not.)
- **Enforceability from a contracts-counsel lens.** Would counsel sign this without rework? Missing or hand-wavy termination / non-performance / IP / liability / data-ownership clauses where a real Dimagi sub-agreement would carry them; payment triggers that aren't tied to an objectively determinable event; obligations on "the partner" with no corresponding remedy if unmet. Each materially unenforceable or missing-standard-clause issue is a strike.

Grading bands: 0 strikes = `pass`; 1–2 strikes = `partial`; 3+ strikes OR any single strike that alone makes the contract unsignable (e.g. rate below a plausible market floor, no payment-trigger event) = `fail`. A `fail` here is a `[BLOCKER]`.

### 6. Archetype fit
*Does the work-order shape match the declared archetype?*

Common failure modes: declared archetype is `focus-group` but scope describes per-visit data collection; declared archetype is `atomic-visit` but payment schedule is per-session; multi-stage PDD with a single-stage work order.

### 7. Writing style
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

**Out of scope (pipeline limitation):** Do NOT grade on bold-span density. The current template uses plain-text `replaceAllText` and there is no bold-finalizer — the producer skill explicitly strips markdown bold from prose tokens. Re-enable the bold dimension once a docs-finalize-bold post-processor ships (*not yet built*).

## Process

1. **Check the gating signal.** Read `pdd-to-work-order-qa_result.yaml`. If `verdict: incomplete`, emit `pdd-to-work-order-eval_verdict.yaml` with `verdict: incomplete` and return. If `verdict: fail`, proceed (QA's failures are auto-fixable; eval still grades the substantive concerns of the latest draft).

2. **Read the artifacts.** Work order body, PDD body, decisions.yaml. Parallel `drive_read_file` block.

3. **Grade each dimension.** For each of the seven dimensions:
   - State the dimension question.
   - Quote 1-3 specific pieces of evidence from the work order, PDD, or decisions.yaml — except the two out-of-chain fitness dimensions (`verification_realism`, `commercial_realism`), which are graded against the real Connect platform and external commercial reality rather than against the in-chain artifacts.
   - Assign `pass | partial | fail` with a 1-3 sentence rationale.

4. **Compute the verdict.** `verdict: pass` if all dimensions pass. `verdict: partial` if exactly one is non-pass. `verdict: fail` if two or more are non-pass.

5. **Surface blockers.** Add `auto_surfaced[]` entries with `severity: BLOCKER` for any dimension grading `fail` where the underlying gap could compromise the contract's enforceability (e.g., verification criteria that aren't measurable, scope mismatches with PDD). **Both out-of-chain fitness dimensions are hard-gated:** a `fail` on `verification_realism` (unverifiable criterion) OR `commercial_realism` (unsignable terms / off-market economics) is on its own a `[BLOCKER]` and must prevent `verdict: pass`, regardless of how faithfully the rest of the draft traces to the PDD. `severity: WARN` for dimensions grading `partial` or `fail` that are recoverable. The orchestrator surfaces `BLOCKER` entries at the Phase 1→2 pause.

6. **Write the verdict YAML** to `1-design/pdd-to-work-order-eval_verdict.yaml` per `lib/verdict-schema.ts`. Required top-level keys: `skill` (`pdd-to-work-order-eval`), `target` (work-order Drive file id), `ran_at` (ISO timestamp), `capture_path` (the verdict's own Drive path), `overall_score` (0–10; map dimension grades to numerics: pass=10, partial=5, fail=0; weighted mean across the seven dimensions), `verdict` (`pass` | `partial` | `fail` | `incomplete`), and `dimensions` (a record keyed by dimension id — `verification_realism`, `commercial_realism`, `contractual_clarity`, `pdd_alignment`, `decisions_traceability`, `archetype_fit`, `writing_style` — each with `{ score: 0–10, weight }` such that weights sum to 1.0). Weights: `verification_realism` 0.20, `commercial_realism` 0.17, `contractual_clarity` 0.15, `pdd_alignment` 0.13, `decisions_traceability` 0.10, `archetype_fit` 0.10, `writing_style` 0.15 (sum = 1.00). Because pass/partial/fail map to 10/5/0, a single fitness-dimension `fail` (0) under a 0.20 or 0.17 weight materially drags `overall_score` toward the gate floor; combined with the hard-gate `[BLOCKER]` in step 5, a faithful-but-unshippable draft cannot reach `verdict: pass`. Optional: `auto_surfaced[]` for blocker/warn entries, `mode`, `overall_score_pre_cap`. Record the per-dimension rationale + evidence quotes as `note:` strings under `per_item[]` if granular auditability is needed, otherwise embed in `auto_surfaced[].message`.

   ```yaml
   dimensions:
     verification_realism:    { weight: 0.20 }   # out-of-chain fitness; fail → BLOCKER
     commercial_realism:      { weight: 0.17 }   # out-of-chain fitness; fail → BLOCKER
     contractual_clarity:     { weight: 0.15 }
     pdd_alignment:           { weight: 0.13 }
     decisions_traceability:  { weight: 0.10 }
     archetype_fit:           { weight: 0.10 }
     writing_style:           { weight: 0.15 }
   # weights sum to 1.00
   ```

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Add `writing_style` 6th dimension scoped to renderable conventions (acronyms, modals, voice, partner-naming, terminology). Reweight: 5 content dims × 0.17 + writing_style × 0.15 = 1.00. Bold deferred until docs-finalize-bold post-processor ships. | ACE team |
| 2026-05-29 | Strengthen the out-of-chain fitness axis per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. (1) Raised `verification_realism` 0.17→0.20 and made it an explicit out-of-chain fitness dimension graded against the live Connect platform (not the PDD); `fail` is now a `[BLOCKER]`. (2) Added `commercial_realism` (0.17, new) — payment-schedule / NTE sanity against external market benchmarks + enforceability from a contracts-counsel "would a real Dimagi contracts person sign this?" lens; `fail` is a `[BLOCKER]`. Reweighted in-chain conformance dims down: contractual_clarity 0.17→0.15, pdd_alignment 0.17→0.13, decisions_traceability 0.17→0.10, archetype_fit 0.17→0.10; writing_style held at 0.15. Seven dimensions; weights sum to 1.00. A faithful-but-unshippable draft can no longer clear `pass`. | ACE team |
