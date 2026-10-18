---
name: simulated-weekly-review-eval
description: >
  Grade a weekly program review against labs' own figures.
disable-model-invocation: false
---

# Simulated weekly review — Eval

LLM-as-judge companion to `simulated-weekly-review`. The review is prose over numbers; what can go
wrong is a number that is not labs', a target quietly dropped, or actions nobody could carry out.

**Where the anchor sits.** The heaviest dimension is graded against figures **labs computed** for
the same week: `workflow_run_indicators` on the week's saved run and the stock reads `as_of` its last
day. ACE wrote the review, but it did not grade the indicators. The PDD (coverage) is also outside
the review's chain. Actionability and honesty are intra-chain craft and weigh less. **Status:**
provisional until calibrated on a run.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `review` | the file graded | explicit arg; default: `9-execution-manager/simulated-week-<w>_review.md` |
| `run_id`, `opportunity_id` | re-read labs' figures | explicit arg; default: as `simulated-weekly-review` resolved them |
| `stock_file` | the stock figures | explicit arg; default: `9-execution-manager/supply-chain-operate_week-<w>_stock.yaml` |
| `pdd_targets` | the targets the review must cover | explicit arg; default: the PDD's Performance Measures |

Re-read `workflow_run_indicators` for the run yourself; never trust the review's copy.

## Rubric

Four dimensions, each 0-10.

1. **Figure fidelity (0.40).** Every number in the review appears in labs' read for that week
   (indicator value, `n`, band; stock figure). 10 when all do; deduct per figure that does not.
2. **Target coverage (0.20).** Every PDD target is reported, or marked "not measured" when the report
   has no indicator for it.
3. **Actionability (0.25).** Each next action names who does it and ties to a figure in the review
   (a worker, a store, an indicator). Penalise generic advice ("keep monitoring").
4. **Honesty (0.15).** On the simulated track the first line states the backdating and the
   real-dated award. Unconfirmed and cold-cache figures are called that. Nothing claims a real
   person or organisation did something.

## Hard-deduct triggers

- `[BLOCKER]` a number not in labs' read for that week (cap figure fidelity at 2).
- `[BLOCKER]` the review says a real LLO, worker or official acted (cap honesty at 0).
- `[WARN]` the simulation note missing from the first line on the simulated track.

Any `[BLOCKER]` makes the verdict `fail`.

## Verdict shape

Write `9-execution-manager/simulated-weekly-review-eval_verdict-week-<w>.yaml` per
`lib/verdict-schema.ts` (`skill: simulated-weekly-review-eval`, `mode: deep`, dimensions as above,
`findings` citing the figure and its labs source). `pass` at 7.0 or above with no `[BLOCKER]`;
`warn` 5.0-6.9; `fail` below 5.0 or any `[BLOCKER]`.

## Calibration

- **Positive control:** a review whose every figure is copied from the week's
  `workflow_run_indicators` read, covering each PDD target, must score figure fidelity 9-10.
- **Negative control:** the same review with one enrolment figure changed by one must hit the
  `[BLOCKER]` and fail.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR10), anchored on labs' own weekly figures | ACE |
