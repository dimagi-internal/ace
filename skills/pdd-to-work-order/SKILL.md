---
name: pdd-to-work-order
description: >
  Draft a contractual Work Order from the approved PDD and the run's
  decisions.yaml. Generic by default — partner identity is a placeholder
  unless an LLO was supplied. Renders to a clean Google Doc. Parallel to
  Phase 8 solicitation, not a replacement.
disable-model-invocation: true
---

# PDD to Work Order

Take the approved PDD and decisions.yaml and produce a contractual Work Order draft, rendered as a clean Google Doc suitable for human review and signature.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/idea-to-pdd.md` | scope, deliverables, timeline, target population, success metrics, evidence model |
| Phase 1 producer | `decisions.yaml` | load-bearing values (rate, FLW count, working language, candidate LLO, etc.) — read as-is |
| Run-root | `inputs-manifest.yaml` | optional reference for partner identity if it was supplied as input |
| Operator (optional) | `--llo <slug>` flag | overrides partner-name placeholder |

## Products

- `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` — the work-order Google Doc (re-runs create `pdd-to-work-order-2.gdoc`, `pdd-to-work-order-3.gdoc`, etc.)
- `run_state.yaml.phases.design.products.work_order` — `{title, file_id}` typed handoff. This skill is the sole writer.
- Appended `wo-*` rows in `ACE/<opp-name>/runs/<run-id>/decisions.yaml` (merge-only — never overwrites existing rows).

## Process

1. **Read inputs in parallel.** Issue one `drive_read_file` block for the PDD, decisions.yaml, and inputs-manifest. Trust context across subsequent steps (do not re-read).

2. **Determine archetype** from the PDD's frontmatter (`archetype: atomic-visit | focus-group | multi-stage`). The archetype branches the Scope of Work, Verification, Roles RACI, and Payment per-unit sections.

3. **Resolve contractual fields.** For each work-order field, apply the inference order:

   - (a) If an existing `decisions.yaml` row from an earlier skill covers it (e.g., `payment-rate`, `flw-count`, `working-language`, `budget-plausibility`), use that value as-is. Never duplicate or rename.
   - (b) If inferable from PDD body (Timeline → period of performance; Success Metrics + Budget → NTE; etc.), use the inference and emit a new `wo-*` row capturing it.
   - (c) If genuinely unknowable (partner name absent, WO# unknown, MSA date unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and emit a `wo-*` row with `status: open` + `notes` telling the human what to fill in.

   Common `wo-*` rows to emit when load-bearing:

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

4. **Append `wo-*` rows to `decisions.yaml`** via `update_yaml_file` with merge-only semantics. Never overwrite existing rows. Required keys per row per `lib/decisions-schema.ts`: `id`, `phase: 1-design`, `skill: pdd-to-work-order`, `question`, `default`, `options_considered`, `source`, `status`. Optional `notes`.

5. **Render the work-order template to a Google Doc.**
   - `docs_copy_template(templateId=<WORK_ORDER_TEMPLATE_ID from env>, parent=<run-folder file_id>, name="Work Order — <opp-title>")`. If the run already has a `pdd-to-work-order.gdoc`, name the new one `Work Order — <opp-title> (#2)`, etc.
   - `docs_batch_update` with token replacements. Tokens use `{{...}}` snake_case:
     - `{{wo_number}}`, `{{opp_title}}`, `{{wo_date}}` (today, ISO), `{{wo_period_of_performance}}`
     - `{{background_body}}` (synthesized from PDD's Problem Statement + Intervention Design + any named downstream consumer)
     - `{{scope_body}}` (archetype-branched — see below)
     - `{{geographic_coverage_body}}` (from PDD Target Population; `[Geographic Coverage — Partner to propose]` if not specified)
     - `{{primary_deliverable_body}}`, `{{verified_unit_body}}` (from PDD Success Metrics + Evidence Model)
     - `{{reporting_body}}` (from `wo-reporting-cadence`)
     - `{{timeline_table}}` (markdown table from PDD Timeline)
     - `{{wo_total_not_to_exceed_usd}}`, `{{payment_schedule_table}}`
     - `{{roles_raci_table}}` (archetype-derived RACI)
     - `{{permissions_body}}`, `{{ethics_body}}`, `{{data_handling_table}}`
     - `{{pdd_link}}` (Drive URL of the PDD from `phases.design.products.pdd.file_id`)
     - `{{annexure_b_placeholder}}` ("To be provided" if no opp-specific annexure)

6. **Write `run_state.yaml.phases.design.products.work_order`** via `update_yaml_file` with `merge: 'two-level'`:

   ```yaml
   phases:
     design:
       products:
         work_order:
           title: "Work Order — <opp-title>"
           file_id: <gdoc-id>
   ```

7. **Invoke `decisions-render`** so the human-readable `decisions.gdoc` refreshes with the new `wo-*` rows.

## Archetypes

### `atomic-visit` (default)
- Scope: per-visit data capture with photo + GPS standardization.
- Verification: photo + GPS Layer A on the deliver-app form.
- Payment unit: per visit (rate from existing `payment-rate` decision).
- Roles: Dimagi configures app + verification audit; Partner recruits FLWs, runs field ops, transports samples (if applicable).

### `focus-group`
- Scope: per-session facilitation with attestation form submission and gdoc write-up.
- Verification: attestation submission Layer A + gdoc receipt Layer B; coordinator-graded practice-session-pass gates payment.
- Payment unit: per session (facilitator + notetaker rate from existing `per-session-rate` decision); facilitator training stipend on practice-session-pass.
- Roles: Dimagi configures OCS chatbot + attestation form + gdoc template; Partner recruits facilitators + notetakers, runs sessions, completes gdoc.

### `multi-stage`
- Scope: per-stage sub-section, each with its own archetype-shaped scope.
- Verification: per-stage criteria reflecting the stage's archetype.
- Payment: may mix per-visit and per-session units; stage-gate criteria from PDD.
- Roles: per-stage RACI.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `update_yaml_file`
- Google Docs: `docs_copy_template`, `docs_batch_update`

## Mode Behavior

- **Default (auto):** infer all fields, draft the gdoc, append `wo-*` rows, write `products.work_order`, proceed.
- **Review:** after the gdoc is written, pause and surface the gdoc URL for human approval before proceeding to the next phase.

## Dry-Run Behavior

When `--dry-run` is active:
- Write the work-order gdoc as normal (Drive writes are reversible).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial version | ACE team |
