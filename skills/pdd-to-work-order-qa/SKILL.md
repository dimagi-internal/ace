---
name: pdd-to-work-order-qa
description: >
  Pass/fail structural check of a Work Order: sections, decision rows, payment schedule, leftover
  scaffolding.
disable-model-invocation: false
---

# PDD-to-Work-Order QA

Structural correctness checks on the work-order artifact. Binary verdict: pass / fail / incomplete. 17 static checks, all runnable in <100ms via the importable `checks.ts` module — no LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-work-order.gdoc` (latest) | the work order under structural check |
| Phase 1 producer | `decisions.yaml` | required `wo-*` decision-row presence check |
| Phase 1 producer | `1-design/idea-to-pdd` (the PDD body) | the `entity_id_grain` the payment-unit check compares the quoted rate against |

## Products

- `1-design/pdd-to-work-order-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 0 | `rendered_from_template` | static | The artifact was rendered by `docs_copy_template` from `WORK_ORDER_TEMPLATE_ID`, not synthesized into a blank doc. Fails on (a) any degradation confession in the body, or (b) missing template-only boilerplate (the hardcoded Dimagi signatory cell, the legal contact line). **Runs first on purpose** — a negative result explains every other row below it. | re-render via `docs_copy_template` and discard the doc; do NOT delete the confession note and re-run. If the copy itself fails, HALT — see `pdd-to-work-order § The render path is not optional` |
| 1 | `all_required_sections_present` | static | All 11 required work-order sections present (Background, Scope of Work, Geographic Coverage, Deliverables and Verification, Timeline and Milestones, Payment Terms, Roles and Responsibilities, Permissions/Ethics/Compliance, Data Handling, Signatures, Annexures). | regenerate the missing section(s) with substantive content per templates/work-order-template.md |
| 2 | `required_wo_decisions_present` | static | All four required `wo-*` rows present in decisions.yaml: `wo-number`, `wo-period-of-performance`, `wo-total-not-to-exceed-usd`, `wo-payment-schedule-split`. | append the missing rows with AI's best inference + status: applied/open |
| 3 | `period_of_performance_complete` | static | Header's Period of Performance shows both start and end dates (or explicit placeholder). | render Period of Performance as "YYYY-MM-DD to YYYY-MM-DD" or "[Period of Performance — TBD]" |
| 4 | `payment_schedule_sums_to_100` | static | Milestone percentages in section 6.2 sum to 100. | re-derive percentages from `wo-payment-schedule-split` decision and re-render |
| 5 | `total_nte_present` | static | Total Not-to-Exceed present in section 6.1 as `<CUR> <amount>` (number or `[Placeholder]`), where `<CUR>` is **the programme's own currency** — `ctx.currency`, else the PDD's `opportunity_currency` row via `--pdd`, else `USD` when no context reaches this QA. A USD cap on a non-USD programme fails unless § 6 states a conversion rule naming the local currency. Hardcoding `USD` made this gate UN-PASSABLE for a correct contract: on `turmeric-market-study-ghana/20261012-1749` the only way to satisfy it was to write `USD 11,000` for a GHS 11,000 cap, a ~15x overstatement in a signable document (ace#2583). | insert "`<CUR> <amount>`" from `wo-total-not-to-exceed-usd` or "`<CUR> [TBD]`" — **relabel, never convert**; the PDD's figure is already in `<CUR>` |
| 6 | `signature_blocks_present` | static | Both `**Subcontractor**` and `**Dimagi, Inc.**` signature blocks present. | re-add missing block per templates/work-order-template.md |
| 7 | `archetype_appropriate_scope` | static | Scope of Work language matches declared archetype **shape only**: atomic-visit references a visit-shaped unit of work; **longitudinal-visits** references that **and** a longitudinal marker (the followed entity, or its phase/sequence/follow-up cadence); focus-group references per-session + attestation + gdoc; multi-stage references per-stage subsections. Says nothing about the evidence mechanism — photo/GPS is a per-opp Layer A choice the archetype does not determine (ace#1771). | re-draft Scope of Work to match archetype |
| 8 | `no_renderer_instructions` | static | No renderer instructions survived into the delivered contract — "per archetype", an unrendered payment-unit alternation, or a TODO/TBD/FIXME marker (dimagi-internal/ace#1004). | resolve the instruction into the one sentence that actually applies |
| 9 | `no_scaffolding_markers` | static | No leaked `<<...>>` AI scaffolding markers in the work-order body. | resolve each marker with concrete content or `[Placeholder]` bracket |
| 10 | `advance_contingent_when_cap_unresolved` | static | A milestone percentage stated against an UNRESOLVED § 6.1 cap must say that nothing is payable until the cap is fixed (ace#2007). "Resolved" is read from the amount itself in any currency ACE recognises, plus the programme's own declared code — it does **not** cascade off `total_nte_present`. Before ace#2583 it did, so a resolved `GHS 11,000` cap read as a placeholder and the hint told the producer to write the opposite of the truth into a contract. | add one sentence to § 6.2: "These percentages are indicative of the agreed split only. No amount is payable under this schedule until the total not-to-exceed in § 6.1 is fixed at contract execution." |
| 14 | `payment_unit_matches_entity_grain` | static | The rate unit quoted in § 6 Payment Terms is not finer than the `entity_id` grain that actually resolves payable units. The grain comes from `ctx.entityIdGrain`, else the PDD's `\| entity_id_grain \|` row via `--pdd`, else the work order's own payable-unit declaration; skips silently when none is available. Shares `lib/payment-grain.ts` with the PDD-side counterpart `idea-to-pdd-qa § payment_unit_matches_entity_grain` (ace#1420), so the two documents cannot disagree about what a payable unit is (ace#1946). | re-derive § 6 against the grain — quote the rate per the payable unit the opportunity actually resolves, and restate the caps and the not-to-exceed total in those units |
| 15 | `commercial_terms_match_solicitation` | static | The work order's rate framing and device terms agree with the LIVE (not superseded) `sol-*` / `solicitation-*` decision rows. Fails, quoting the work-order sentence and naming the row, when e.g. the work order costs devices separately / "in addition to the not-to-exceed" while the solicitation recorded an all-in rate with devices inside it (`spark-facilitator/20261001-2208`). Not applicable (pass) when no solicitation row fixes rate framing or devices yet — the normal Phase 1 order — so it bites on any later re-run (re-render, clone, release readiness). Logic: `lib/commercial-terms-consistency.ts`. | re-render the work order so § 2 and § 6 follow the solicitation row (`pdd-to-work-order § Commercial terms follow the solicitation`); never defer the reconciliation to contract execution |
| 16 | `annexures_exclude_internal_documents` | static | The § Annexures section does not annex a Dimagi-internal document — the PDD, an internal design or technical document, `run_state.yaml`, `decisions.yaml`, or a QA/eval verdict — by live Drive link **or** by title. Scoped to the Annexures section only: body prose citing the design is normal contract language, whereas the annexure list is a promise to hand the document over. An absent heading is not this check's failure (that is check 1). `N/A` passes. Until 2026-10-14 the template hardcoded an `Annexure A: Program Design Document` line carrying a `pdd_link` token, so EVERY work order ACE rendered carried a live link to its own internal PDD (ace#2906, caught on `tekzal/20261013-2314` after one had been mailed to a real partner). | remove the internal entries from § Annexures but KEEP the heading; annex only what the partner is a party to or must act on, and render `N/A` when nothing qualifies |

The static check functions live at `skills/pdd-to-work-order-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/pdd-to-work-order-qa/checks.test.ts`.

## Process

1. **Read the work-order artifact.** Resolve the latest `pdd-to-work-order.gdoc` (the one referenced by `phases.idea-to-design.products.work_order.file_id` in `run_state.yaml`). Read its body via
   `drive_read_file(file_id=<pdd-to-work-order.gdoc drive id>, exportAs: 'text/plain')`.

   **`exportAs: 'text/plain'` is REQUIRED here, not optional — and it is the
   OPPOSITE of what the sibling skill `idea-to-pdd-qa` requires.** That skill
   mandates `text/markdown` (its checks anchor on markdown syntax); this one
   needs plain text, because every matcher in `checks.ts` is written against
   the unescaped gdoc form. Drive's markdown exporter ESCAPES
   markdown-significant punctuation, so `## 1. Background` arrives as
   `## **1\. Background**` and `[TBD]` as `\[TBD\]`.

   Both skills are steps of Phase 1 (`agents/idea-to-design.md` §§ 1.4 and
   2.4), so carrying the sibling's convention across is the easy mistake — and
   it is expensive rather than merely noisy: on a real, CORRECT work order the
   markdown export scored **4/9 instead of 9/9**, and the five spurious
   failures' `auto_fix_hint`s instructed the producer to *regenerate a sound
   contract* to fix a reader bug (dimagi-internal/ace#1609).

   `checks.ts` now normalises markdown-export escaping defensively, so passing
   the wrong format no longer produces spurious failures. That is a safety net,
   not a licence — pass `text/plain` and keep the checks matching what they were
   written against.

2. **Read decisions.yaml** via `drive_read_file`.

3. **Read the PDD body** (`run_state.yaml.phases.idea-to-design.products.pdd.file_id`) via `drive_read_file(..., exportAs: 'text/markdown')`. Two things come out of it: the `archetype:` frontmatter line, and the `| entity_id_grain | ... |` row in § Program Parameters that `payment_unit_matches_entity_grain` compares the quoted rate against. Save the body to a temp path and pass it as `--pdd` in step 5.

4. **Save artifact bodies to local temp paths** so the CLI runner can invoke `checks.ts`:
   ```bash
   TMP_WO=$(mktemp); TMP_DEC=$(mktemp); TMP_PDD=$(mktemp)
   # write drive contents to $TMP_WO, $TMP_DEC and $TMP_PDD
   ```

5. **Invoke the check runner** that imports `checks.ts § CHECKS` and runs each against `{workOrderText, decisionsYamlText, archetype}`. Output: a `QACheckResult[]` aligned with the `CHECKS` array.
   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" --skill pdd-to-work-order-qa --artifact "$TMP_WO" --target "<opp-name>/<run-id>" --capture-path "1-design/pdd-to-work-order.gdoc" --decisions "$TMP_DEC" --archetype "<archetype from step 3>" --pdd "$TMP_PDD" --include-passed
   ```

   **All five of `--target`, `--capture-path`, `--decisions`, `--archetype` and
   `--pdd` matter here.** The first two are hard-required — omit either and
   `qa-run.ts` exits with `missing required --target` having run zero checks
   (dimagi-internal/ace#1775). The other three are optional to the runner but
   load-bearing for THIS skill: its checks read `ctx.decisionsYaml` for the
   `wo-*` decision rows, `ctx.archetype` for the archetype-fit checks, and
   `ctx.pddText` for the `entity_id_grain` that `payment_unit_matches_entity_grain`
   judges the quoted rate against — so dropping them silently degrades real
   checks into unevaluable ones. Dropping `--pdd` in particular leaves the grain
   check with only the work order's own payable-unit declaration to work from,
   which catches a self-contradicting § 6 but not a uniformly-per-visit § 6
   against a day-scoped grain (ace#1946).

   **`--pdd` takes the `text/markdown` export, even though `--artifact` takes
   `text/plain` (ace#2398).** The two flags legitimately want different formats,
   because the grain lives in a TABLE and the work-order checks do not. A
   `text/plain` export of a native gdoc flattens every table to one cell per
   line, so `| entity_id_grain | … |` does not survive it at all and the grain
   check degrades to `not applicable` — which PASSES, silently, with `--pdd`
   correctly supplied. That is how ace#1946's check shipped inert a second time
   (measured on `poverty-graduation/20260915-1518`; the first was ace#2124).
   `readProgramParameter` now normalises the markdown export's backslash
   escaping (`entity\_id\_grain`) itself, so the markdown form works; nothing
   can rescue the plain form, because the table is gone before the parser runs.
   **If the check reports `not applicable`, treat it as a defect to investigate,
   not as a clean pass** — a run that genuinely has no grain to check should be
   rare.

6. **Compose and write the verdict YAML** to `1-design/pdd-to-work-order-qa_result.yaml` per the QA verdict schema (`lib/qa-types.ts`). `verdict: pass` iff every check passes; `verdict: fail` with `failures[]` array otherwise (each entry: `{check, detail, auto_fix_hint}`). `verdict: incomplete` if a check could not be evaluated (e.g., decisions.yaml unreadable).

7. **Trigger the producer-retry loop on `verdict: fail`** per `agents/idea-to-design.md § Step 2.4`. After retry: re-run QA. Halt with `verdict: incomplete` when the producer can no longer make progress on the same failures.

## MCP Tools Used

- Google Drive: `drive_read_file` — **always with `exportAs: 'text/plain'`** for the work-order gdoc (the PDD body read in step 3 takes `text/markdown`, per its own sibling's convention) (see § Process step 1; the inverse of `idea-to-pdd-qa`, which requires `text/markdown`), and the default for `decisions.yaml`, `drive_create_file`
- Bash: `node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" ...` (runs static checks via `lib/qa-runner.ts`)

## Writing the result (shared writer — every `-qa` skill)

Write the result file through the shared writer, never by hand:
collect one outcome per check you evaluated (`{check, type, result: {pass,
detail, auto_fix_hint}}`, or `{check, not_judged: "<why>"}` for a check whose
input does not exist yet) into a local JSON file, then

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-result.ts" write \
  --skill <this skill> --target <opp>/<run-id> --capture-path <artifact path> \
  --outcomes <outcomes.json> --out <local result.yaml>
```

and upload that file. It derives `stats` from the outcomes and a result that
evaluated nothing is a FAIL (`aggregateQAResult`, `lib/qa-types.ts`); ACE's own
ace-gdrive write guard turns a `*-qa_result.yaml` in any other shape into an
`INVALID_QA_RESULT` error (`lib/qa-result-write-guard.ts`). A hand-written shape reads on ace-web as
"Passed (0/0 checks)" — `skills/_qa-template.md § QA result YAML contract`.

