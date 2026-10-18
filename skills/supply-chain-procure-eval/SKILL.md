---
name: supply-chain-procure-eval
description: >
  Grade a labs procurement against labs' frozen comparison and the PDD (LLM judge).
disable-model-invocation: false
---

# Supply-chain procure — Eval

LLM-as-judge companion to `supply-chain-procure`. `supply-chain-procure-qa` has already proved the
structure (one award and one matching contract per line, a rankable comparison). This eval judges
the calls a structural check cannot: whether the quotes look like a real market, whether each award
follows from the comparison, and whether the quantities come from the programme's design.

**Where the anchor sits.** Two of the four dimensions are graded against evidence outside ACE's
authoring chain:
- `award_follows_comparison` reads the comparison **labs computed and froze** into each award
  (`comparison_snapshot`). ACE supplied the quotes as stated, but labs ranked them. The judge checks
  ACE's choice against labs' ranking, not against ACE's own account.
- `quantity_traceability` reads the **PDD**, which this skill did not write.

The spread realism and rationale quality are intra-chain craft and weigh less. **Status:**
provisional until calibrated on a real run.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `tender_id` | the tender graded | explicit arg; default: run_state `products.supply_chain.tender_id` |
| `procure_plan` | the intended spread and lines | explicit arg; default: `9-execution-manager/supply-chain-procure_plan.yaml` |
| `procure_record` | the ids and rationales as recorded | explicit arg; default: `9-execution-manager/supply-chain-procure_record.md` |
| `pdd` | the source of every quantity | explicit arg; default: run_state `phases.idea-to-design.products.pdd` |
| `qa_result` | the gate | explicit arg; default: `9-execution-manager/supply-chain-procure-qa_result.yaml` |

Read the labs records fresh, with `program_id`: `supply_chain_award_list({tender_id})` (each award
with its frozen comparison), `supply_chain_quote_list({tender_id})`,
`supply_chain_contract_list({tender_id})`.

## QA gate (run FIRST)

If `supply-chain-procure-qa_result.yaml` is missing or not `pass`, emit `verdict: incomplete`
naming the failed checks, and score nothing. Grading the judgement of a procurement whose structure
is broken grades the wrong thing.

## Rubric

Grade across 4 dimensions, each 0-10.

1. **Award follows the comparison (weight 0.30).** For each award, read its frozen
   `comparison_snapshot`: the `ranked_by` column, each comparable row's figure on it, and each row's
   `specification` outcome. 10 when the awarded quote is the best-ranked comparable quote, or is a
   dearer one whose rationale names a reason the snapshot itself supports (a specification failure,
   a lead time past the need, an unstated freight term the comparison flagged). 5 when the reason is
   plausible but not visible in the snapshot. 0-2 when the award goes to a dearer quote and the
   snapshot shows no reason for it.
2. **Quantity traceability (weight 0.25).** Every tender line's quantity matches a need in the setup
   plan, and that need quotes a sentence of the PDD that gives the number (an enrolment target, a
   per-person allocation times a cohort). 10 when every line traces; deduct per line that does not.
3. **Quote spread realism (weight 0.25).** On the simulated track, do the 3-4 invented offers per
   line look like a market for this commodity in this country: prices in a believable band (no 10x
   outlier unless it is the point), lead times and MOQs that vary, at least one offer silent on
   freight or duties, incoterms that fit the delivery place? Outside a simulation the quotes are
   real; score this dimension `null` and redistribute its weight across the other three.
4. **Rationale quality (weight 0.20).** Each rationale cites the comparison (rank and figure) and,
   for a dearer award, states the reason in one specific sentence. Penalise generic text ("best
   value", "preferred supplier").

## Hard-deduct triggers

- `[BLOCKER]` a tender line's quantity has no PDD source (cap `quantity_traceability` at 2).
- `[BLOCKER]` a rationale contradicts the frozen comparison, e.g. it calls the awarded quote the
  cheapest when the snapshot ranks another below it (cap `award_follows_comparison` at 2).
- `[BLOCKER]` an award to a non-cheapest quote with no stated reason (cap
  `award_follows_comparison` at 3).
- `[WARN]` a simulated supplier name without `[Synthetic]` (QA should have caught it; flag again).

Any `[BLOCKER]` makes the verdict `fail`.

## Verdict shape

Write `9-execution-manager/supply-chain-procure-eval_verdict.yaml` per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: supply-chain-procure-eval
target: <opp-name or program-<id>>
mode: deep
ran_at: <ISO timestamp>
capture_path: 9-execution-manager/supply-chain-procure_record.md

overall_score: <weighted mean, 0-10>
overall_score_pre_cap: <weighted mean before any cap>
verdict: pass | warn | fail | incomplete

dimensions:
  award_follows_comparison: { score: <0-10>, weight: 0.30 }
  quantity_traceability:    { score: <0-10>, weight: 0.25 }
  quote_spread_realism:     { score: <0-10 or null>, weight: 0.25 }
  rationale_quality:        { score: <0-10>, weight: 0.20 }

findings:
  - severity: BLOCKER | WARN | INFO
    dimension: <name>
    detail: <what, citing the award id, quote ids and snapshot figures>
```

`pass` at 7.0 or above with no `[BLOCKER]`; `warn` 5.0-6.9; `fail` below 5.0 or any `[BLOCKER]`.

## Calibration

- **Positive control** (measured_on: 2026-10-18): labs program 10605, award 95. It went to the
  dearer quote (USD 760 vs 590 landed for 20 kits), and the snapshot shows the cheaper kit's
  specification failing ("Range maximum 1.5 mg/L fails: it must be at least 2.0 mg/L"). The rationale
  says "Only kit that reads the 2 mg/L dispenser dose". `award_follows_comparison` must score 9-10 on
  it. The read-only capture is
  `test/skills/supply-chain-procure-qa/fixtures/labs-program-10605-tender-60.json`.
- **Negative control:** the same award with its rationale replaced by "best value" must score
  `award_follows_comparison` at most 3 under the hard-deduct rule.

## MCP Tools Used

- connect-labs: `supply_chain_award_list`, `supply_chain_quote_list`, `supply_chain_contract_list`
- ace-gdrive: `drive_read_file` (plan, record, PDD, QA result), `drive_create_file` (verdict)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR7): 4 dimensions, two anchored outside the authoring chain (labs' frozen comparison, the PDD) | ACE |
