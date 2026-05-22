---
name: pdd-to-work-order-qa
description: >
  Structural QA on the work-order artifact produced by pdd-to-work-order.
  Binary pass/fail. Catches missing sections, missing wo-* decision rows,
  malformed payment schedule, leaked scaffolding markers, etc. Static-only;
  no LLM. Gates pdd-to-work-order-eval — eval is skipped if QA fails
  irrecoverably.
disable-model-invocation: true
---

# PDD-to-Work-Order QA

Structural correctness checks on the work-order artifact. Binary verdict: pass / fail / incomplete. Eight static checks, all runnable in <100ms via the importable `checks.ts` module — no LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-work-order.gdoc` (latest) | the work order under structural check |
| Phase 1 producer | `decisions.yaml` | required `wo-*` decision-row presence check |

## Products

- `1-design/pdd-to-work-order-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `all_required_sections_present` | static | All 11 required work-order sections present (Background, Scope of Work, Geographic Coverage, Deliverables and Verification, Timeline and Milestones, Payment Terms, Roles and Responsibilities, Permissions/Ethics/Compliance, Data Handling, Signatures, Annexures). | regenerate the missing section(s) with substantive content per templates/work-order-template.md |
| 2 | `required_wo_decisions_present` | static | All four required `wo-*` rows present in decisions.yaml: `wo-number`, `wo-period-of-performance`, `wo-total-not-to-exceed-usd`, `wo-payment-schedule-split`. | append the missing rows with AI's best inference + status: applied/open |
| 3 | `period_of_performance_complete` | static | Header's Period of Performance shows both start and end dates (or explicit placeholder). | render Period of Performance as "YYYY-MM-DD to YYYY-MM-DD" or "[Period of Performance — TBD]" |
| 4 | `payment_schedule_sums_to_100` | static | Milestone percentages in section 6.2 sum to 100. | re-derive percentages from `wo-payment-schedule-split` decision and re-render |
| 5 | `total_nte_present` | static | Total Not-to-Exceed USD value present in section 6.1 (number or `[Placeholder]`). | insert "USD <amount>" from `wo-total-not-to-exceed-usd` or `USD [TBD]` |
| 6 | `signature_blocks_present` | static | Both `**Subcontractor**` and `**Dimagi, Inc.**` signature blocks present. | re-add missing block per templates/work-order-template.md |
| 7 | `archetype_appropriate_scope` | static | Scope of Work language matches declared archetype: atomic-visit references per-visit + photo/GPS; focus-group references per-session + attestation + gdoc; multi-stage references per-stage subsections. | re-draft Scope of Work to match archetype |
| 8 | `no_scaffolding_markers` | static | No leaked `<<...>>` AI scaffolding markers in the work-order body. | resolve each marker with concrete content or `[Placeholder]` bracket |

The static check functions live at `skills/pdd-to-work-order-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/pdd-to-work-order-qa/checks.test.ts`.

## Process

1. **Read the work-order artifact.** Resolve the latest `pdd-to-work-order.gdoc` (the one referenced by `phases.design.products.work_order.file_id` in `run_state.yaml`). Read its body via `drive_read_file`.

2. **Read decisions.yaml** via `drive_read_file`.

3. **Read PDD archetype** from `run_state.yaml.phases.design.products.pdd` (or read the PDD body and parse the `archetype:` frontmatter line).

4. **Save artifact bodies to local temp paths** so the CLI runner can invoke `checks.ts`:
   ```bash
   TMP_WO=$(mktemp); TMP_DEC=$(mktemp)
   # write drive contents to $TMP_WO and $TMP_DEC
   ```

5. **Invoke the check runner** that imports `checks.ts § CHECKS` and runs each against `{workOrderText, decisionsYamlText, archetype}`. Output: a `QACheckResult[]` aligned with the `CHECKS` array.

6. **Compose and write the verdict YAML** to `1-design/pdd-to-work-order-qa_result.yaml` per the QA verdict schema (`lib/qa-types.ts`). `verdict: pass` iff every check passes; `verdict: fail` with `failures[]` array otherwise (each entry: `{check, detail, auto_fix_hint}`). `verdict: incomplete` if a check could not be evaluated (e.g., decisions.yaml unreadable).

7. **Trigger the producer-retry loop on `verdict: fail`** per `agents/idea-to-design.md § Step 2.4`. After retry: re-run QA. Halt with `verdict: incomplete` when the producer can no longer make progress on the same failures.
