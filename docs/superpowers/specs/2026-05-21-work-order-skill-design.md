# Work-Order Skill — Phase 1 Design

**Date:** 2026-05-21
**Status:** Approved (design phase)
**Phase:** 1 (`idea-to-design`)
**Skills introduced:** `pdd-to-work-order`, `pdd-to-work-order-qa`, `pdd-to-work-order-eval`

## Summary

Phase 1 currently produces the PDD (`idea-to-pdd.md`) and a structured `decisions.yaml` log of load-bearing default-decisions. When an opportunity is going straight to a pre-known LLO without a competitive selection, Dimagi also needs a contractual **Work Order** — a signable document derived from the same source-of-truth (the PDD and the decisions log).

This skill adds that artifact. Generic by default — partner identity is a placeholder unless an LLO is supplied as input. Phase 8 still publishes a solicitation; the work order is parallel, not a replacement.

## Motivation

- Today, work orders are authored manually outside the lifecycle. Numerics (rate, FLW count, geographic coverage, period of performance, NTE budget) get re-derived by the human from the PDD with no traceability.
- The `decisions.yaml` + `decisions-render` pattern already gives us a structured audit surface for every load-bearing choice. The work order is a natural consumer of that surface.
- Reference example: `[Shared] DFHF - RDT Work Order #3` (Malaria RDT POC Sampling Pilot) — sections, payment schedule, RACI table, ethics clauses, signature blocks.

## Scope

In scope:
- New producer skill `pdd-to-work-order` and its `*-qa` / `*-eval` companions.
- Integration into the `idea-to-design` agent as Step 2 (after PDD QA+eval).
- New `wo-*` rows appended to `decisions.yaml` for work-order-specific load-bearing fields.
- New `phases.design.products.work_order` write-back to `run_state.yaml` (typed handoff: `{title, file_id}`).
- Archetype branching across `atomic-visit`, `focus-group`, `multi-stage`.

Out of scope:
- Replacing Phase 8 solicitation. Solicitation still runs; work order is parallel.
- Legal review automation. The skill produces a draft; humans review and sign.
- Live signature workflow / e-signature integration.
- Reading the work order from any downstream phase. Phase 2+ continue to read the PDD; the work order is a human-facing artifact only.

## Skill: `pdd-to-work-order`

### Identity
- **Phase:** `1-design`
- **Skill name:** `pdd-to-work-order`
- **Mode behavior:** runs in both `auto` and `review` modes; review mode pauses for approval after the gdoc is written.
- **Trigger:** auto in `/ace:run`, every run, after `idea-to-pdd` ships and passes QA. Also invokable via `/ace:step pdd-to-work-order <opp>/<run-id>`.

### Inputs
| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | scope, deliverables, timeline, target population, success metrics, evidence model |
| Phase 1 | `decisions.yaml` | load-bearing values (rate, FLW count, language, etc.) |
| Run root | `inputs-manifest.yaml` (read at run start by orchestrator) | optional reference for partner identity if it was supplied |
| Operator (optional) | `--llo <slug>` flag | overrides partner-name placeholder |

All reads use parallel `drive_read_file`; context is trusted across steps per the agent's read-redundancy rules.

### Products
- `ACE/<opp>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` — the contract, formatted as a clean Google Doc.
- `run_state.yaml.phases.design.products.work_order` — `{title, file_id}` typed handoff. This skill is the sole writer.
- `ACE/<opp>/runs/<run-id>/decisions.yaml` — appended `wo-*` rows (merge-only, never overwrites existing rows).

### Decisions log convention

The skill follows the existing bar criterion (load-bearing AND maps to a known surface). Work-order-specific rows use the `wo-` prefix to avoid collisions with future Phase 8 solicitation rows. Rows from earlier in Phase 1 (e.g. `payment-rate`, `flw-count`, `working-language`, `budget-plausibility`, `candidate-llo-roster`) are read as-is — never duplicated, never renamed.

Common `wo-*` rows:

| ID | Question | Map to surface |
|---|---|---|
| `wo-number` | Sequence number for this WO under the MSA | Header (placeholder if unknown) |
| `wo-period-of-performance` | Start + end dates | Header + Timeline section |
| `wo-total-not-to-exceed-usd` | Total NTE budget cap | Payment Terms section |
| `wo-payment-schedule-split` | Milestone payment percentages (e.g., 40/60) | Payment Schedule sub-table |
| `wo-mobilization-advance-pct` | Mobilization advance % of cap | Payment Schedule row 1 |
| `wo-reporting-cadence` | Frequency of progress reports (default: weekly) | Reporting sub-section |
| `wo-ethics-scope` | Operational-only vs patient-level | Ethics section |
| `wo-data-storage-region` | Server region for data storage (default: US) | Data Handling section |

Rows go in with `status: open` when the AI's inference is a best-guess (e.g., dates inferred from Timeline section), `status: applied` when directly derivable from existing decisions or PDD.

### Process

1. **Read inputs in parallel** — PDD + `decisions.yaml` + run-folder context. Trust context across subsequent steps.
2. **Determine archetype** from PDD frontmatter. Branches Section content (see "Section template" below).
3. **Resolve contractual fields.** For each work-order field:
   - (a) If a relevant `decisions.yaml` row exists from an earlier skill, use it.
   - (b) If inferable from PDD body (Timeline → period of performance; Success Metrics + Budget → NTE; etc.), use that and emit a `wo-*` row capturing the inference.
   - (c) If unknowable (partner name absent, WO# unknown, MSA date unknown), insert a bracketed placeholder like `[Partner Name]` and emit a `wo-*` row with `status: open` + `notes` telling the human what to fill in.
4. **Append `wo-*` rows to `decisions.yaml`** via `update_yaml_file` with merge-only semantics. Never overwrite existing rows.
5. **Render work-order template** to a Google Doc:
   - `docs_copy_template` from a stored template (file_id in `.env` as `WORK_ORDER_TEMPLATE_ID`, fallback path documented in the skill).
   - `docs_batch_update` with token replacements (`{{wo_number}}`, `{{title}}`, `{{period_of_performance}}`, `{{scope_body}}`, `{{payment_schedule_table}}`, `{{roles_raci_table}}`, `{{signature_dimagi}}`, `{{signature_partner}}`, etc.).
   - Sections that branch on archetype receive archetype-specific token bodies generated by the skill.
6. **Write `run_state.yaml.phases.design.products.work_order`** — `{title, file_id}` via `update_yaml_file` with `merge: 'two-level'`.
7. **Invoke `decisions-render`** so the human-readable `decisions.gdoc` refreshes with the new `wo-*` rows.

### Section template

Fixed structure mirroring the malaria example, with archetype-aware sub-content:

1. **Header** — WO Number, WO Date (today, ISO), Title (from PDD H1), Period of Performance.
2. **Background** — synthesized from PDD's Problem Statement + Intervention Design. References the downstream consumer if `named-downstream-consumer` decision is named (e.g., GiveWell RFI).
3. **Scope of Work** — archetype-branched:
   - `atomic-visit`: per-visit data capture, photo standardization, GPS, sample handling.
   - `focus-group`: per-session facilitation, attestation form submission, gdoc write-up obligations.
   - `multi-stage`: per-stage sub-section with each stage's archetype-shaped scope.
4. **Geographic Coverage** — from PDD Target Population. If the PDD names states/regions, use them; otherwise `[Geographic Coverage — Partner to propose]`.
5. **Deliverables and Verification**:
   - 5.1 Primary Deliverable (target count + verification criteria from PDD Evidence Model).
   - 5.2 Definition of a Verified Unit (Layer A criteria from Evidence Model).
   - 5.3 Reporting Deliverables (weekly + end-of-pilot; `wo-reporting-cadence`).
6. **Timeline and Milestones** — from PDD Timeline, week-by-week table.
7. **Payment Terms**:
   - 7.1 Total Not-to-Exceed (from `wo-total-not-to-exceed-usd`).
   - 7.2 Payment Schedule (table from `wo-payment-schedule-split` + `wo-mobilization-advance-pct`; per-unit rate from existing `payment-rate` / `per-session-rate` rows).
   - "Dimagi will pay only for verified units" clause.
8. **Roles and Responsibilities** — archetype-derived RACI table (Dimagi vs Partner) covering protocol design, app configuration, FLW recruitment/training, field ops, permissions, transport, verification, reporting.
9. **Permissions, Ethics, Compliance** — template clauses; ethics scope from `wo-ethics-scope`; private-retail engagement clauses included only if PDD scope touches private retail.
10. **Data Handling** — standard Dimagi clauses; Data Subjects + Personal Information pre-filled from PDD's data-subject treatment.
11. **Signatures** — Dimagi block prefilled (Lucina Tse, COO, address); partner block left blank for `[Partner Name]`, `[Title]`, `[Date]`, `[Address for correspondence]`.
12. **Annexures** — Annexure A pointer to the PDD (file_id from `phases.design.products.pdd`). Placeholder for opp-specific annexures (e.g., sampling protocols).

### Archetype branching

| Section | `atomic-visit` | `focus-group` | `multi-stage` |
|---|---|---|---|
| Scope of Work | per-visit, photos, GPS, samples | per-session, attestation form, gdoc | per-stage with each stage's archetype shape |
| Verification | photo + GPS Layer A | attestation submission + gdoc receipt Layer A/B | per-stage verification criteria |
| Payment unit | per visit | per session (facilitator + notetaker + training stipend) | per stage, may mix per-visit and per-session |
| Roles RACI | FLW recruitment + supervision | Facilitator + notetaker recruitment + practice-session sign-off | per-stage RACI |
| Ethics | operational data only | consent + audio recording protocol | stage-dependent |

## Skill: `pdd-to-work-order-qa`

Static structural checks. Uniform verdict shape with `failures[].auto_fix_hint` for the producer-retry loop.

Checks:

1. All required headings present (sections 1–12 above).
2. Required `wo-*` rows present in `decisions.yaml`: `wo-number`, `wo-period-of-performance`, `wo-total-not-to-exceed-usd`, `wo-payment-schedule-split`.
3. Period of Performance has start + end dates (or explicit placeholder text — not silently missing).
4. Payment schedule percentages sum to 100%.
5. Total NTE present (number or placeholder, not silently missing).
6. Signature blocks present for both parties.
7. Archetype-appropriate scope language:
   - `atomic-visit`: scope references "per visit" or equivalent + photo + GPS.
   - `focus-group`: scope references attestation form + gdoc.
   - `multi-stage`: at least one per-stage subsection.
8. No leaked AI scaffolding markers (`<<TBD>>`, `<<unclear>>`, `<<>>`).

Output: `1-design/pdd-to-work-order-qa_result.yaml`. `verdict: fail` triggers the producer-retry loop with `auto_fix_hint` per failure.

## Skill: `pdd-to-work-order-eval`

LLM-as-judge, quality-only re-grade. Skipped if QA verdict is `incomplete`. A `verdict: fail` here does NOT halt the run on its own — `[BLOCKER]` concerns pause per the orchestrator's Per-Mode Pause Matrix.

Dimensions:

1. **Contractual clarity** — could a partner sign without follow-up questions on scope, deliverables, or payment?
2. **PDD alignment** — do scope / deliverables / timeline / payment trace back to the PDD?
3. **Decisions traceability** — do contractual numerics match their corresponding `decisions.yaml` rows?
4. **Verification realism** — are "verified unit" criteria measurable on the Connect platform?
5. **Archetype fit** — does the contract shape match the declared archetype?

Per-dimension `pass | partial | fail`. Two or more non-pass → `verdict: fail` for the rubric. Eval verdict written to `1-design/pdd-to-work-order-eval_verdict.yaml` per `lib/verdict-schema.ts`.

## Agent integration

`agents/idea-to-design.md` gains a new Step 2 block after Step 1.5:

```
### Step 2: PDD → Work Order
Invoke the `pdd-to-work-order` skill.
- Inputs: PDD + decisions.yaml (already in subagent context from Step 1 — do NOT re-read).
- Output: 1-design/pdd-to-work-order.gdoc, products.work_order in run_state.yaml,
  appended wo-* rows in decisions.yaml.
- Gate (review mode): present the work-order URL for approval.

### Step 2.4: Work-Order QA (structural pass/fail)
Invoke `pdd-to-work-order-qa`. Same producer-retry loop semantics as Step 1.4.

### Step 2.5: Work-Order eval (independent quality re-grade)
Unless --no-evals AND QA pass, invoke `pdd-to-work-order-eval`.
- Skipped if QA verdict is incomplete (eval mirrors with verdict: incomplete).
```

Agent frontmatter `skills:` array grows by one entry:

```yaml
skills:
  - { name: idea-to-pdd, has_judge: true, qa_skill: idea-to-pdd-qa, eval_skill: idea-to-pdd-eval }
  - { name: pdd-to-work-order, has_judge: true, qa_skill: pdd-to-work-order-qa, eval_skill: pdd-to-work-order-eval }
```

Phase summary at completion lists both PDD and work-order URLs.

## Write-back contract

Existing `phases.design.products.pdd` block is unchanged. New sibling:

```yaml
phases:
  design:
    products:
      pdd:
        title: ...
        description: ...
        file_id: ...
      work_order:
        title: "Work Order — <PDD Title>"
        file_id: <gdoc-id>
```

`pdd-to-work-order` is the sole writer of `products.work_order`.

## Template artifact

A Google Docs template lives at a known file_id (stored in `.env` as `WORK_ORDER_TEMPLATE_ID`, sourced from 1Password vault). Template content mirrors the malaria example with token markers for replacement. The template file_id is per-deployment configuration, not committed in the repo. Bootstrapping the template is documented in `playbook/integrations/work-order-template.md` (or a similar location) — out of scope for this design doc.

## Dry-run behavior

When `--dry-run` is active:
- Write the work-order gdoc as normal.
- Skip emailing any admin-group summary if relevant.
- State tracks as `dry-run-success`.

## Resolved decisions

- **Template provisioning:** bootstrapped via `scripts/bootstrap-work-order-template.ts` (mirrors `scripts/bootstrap-ocs-golden-template.ts`). One-time per deployment; writes the resulting template file_id to `.env` as `WORK_ORDER_TEMPLATE_ID`.
- **Re-runs:** each invocation creates a NEW gdoc. Older work-order drafts remain in the run folder as `pdd-to-work-order.gdoc`, `pdd-to-work-order-2.gdoc`, etc. Sole writer of `products.work_order` in `run_state.yaml` updates the pointer to the latest one. New `wo-*` decision rows are still merge-only (no duplicates).
- **Signature block:** Dimagi signatory is hardcoded to Lucina Tse, COO (with the Cambridge MA address from the malaria example) for now. Revisit if/when a second signatory is needed.

## Non-goals

- This is a Phase 1 artifact only. No downstream phase reads it.
- No e-signature workflow. The gdoc is a draft for humans to download, route, and sign offline.
- No automatic emailing of the WO to a partner. Phase 8 / Phase 9 handle LLO contact.
