# Fold the open-questions ledger into decisions

**Status:** proposed, awaiting owner approval (Jonathan). Nothing here is built.
**Date:** 2026-10-04
**Evidence run:** spark/spark-facilitator/20261001-2208 (Spark workspace clone)

## The claim

By the time a run reaches a review, every "open question" has either been
built on a working default or does not need an answer yet. An open question is
therefore not a different kind of thing from a decision: it is a decision whose
default someone outside ACE should confirm. ACE already has the machinery for
that — decision rows with `review_ask: recommended-confirmation`, `plain`
language, the plain-language gate, the ace-web decisions review, and
`inputs/decision-overrides.yaml` for attributed human rulings. Keeping a second
ledger (`ACE/<opp>/open-questions.md`) duplicates it, drifts from it, and asks
reviewers twice.

## Evidence (measured, not estimated)

Each of the 32 open rows in spark-facilitator's ledger was classified against
the run's 198-row `decisions.yaml`, its PDD and its build:

| Category | Count | Meaning |
|---|---|---|
| A. Already a decision | 14 | A live decision row covers it — often with more current text than the ledger. |
| B. Implicit default, not logged | 5 | The build took a working answer, but no decision row records it (`lookup-table-provisioning`, `airtime-payout-channel`, `pilot-data-handover`, `attendance-list-practice`, `s1-s6-indicators-not-computable`). |
| C. Not needed for this pilot | 5 | Future phase or expansion (Rwanda, Proposal Development, end-state instrumentation of Spark's app, the post-Planning income cliff). |
| D. Not a decision | 7 | Chores (sweep a stale opportunity, distribute the solicitation), upstream requests (Connect delivery type, Nova item rotation), or factual partner inputs already asked in the solicitation. |
| E. Genuinely open and blocking | 1 | `rct-sample-overlap`: no default anywhere, and it gates the award (Phase 8 could pick trial communities). |

31 of 32 support the claim. The one exception is a decision that *should* have
had a default and a gate, not a reason to keep a separate ledger.

What the duplication cost, on this run alone:

- The device question lived as an open question **and** two decision rows;
  resolving it meant editing both and keeping them consistent.
- The release-readiness repair rewrote plain-language text twice, against two
  different checkers (`checkOpenQuestionsPlainLanguage`,
  `auditDecisionsPlainLanguage`).
- The review page asked for "6 to confirm before launch" (decisions) and "28
  questions for you" (ledger); the outsider eval deducted for the split ask.
- The ledger is opp-level and accumulates across runs, so it drifted from the
  run it was shown with: rows cite PDD sections and design facts from run
  20260926-1413 that this run's PDD (seeded from 20260925-1536) does not carry
  (`airtime-payout-channel` cites a "§3.4" that does not exist here;
  `rct-sample-overlap` claims a solicitation requirement this solicitation does
  not have). Three A rows contradict their decision rows outright
  (`payment-schedule-undefined`, `savings-indicator-denominator-bias`,
  `phase-pointer-maintenance`).
- Ten rows carried "Before Phase 3/4" deadlines on a run past both phases —
  labels that never gated anything.

## Design

### 1. One store: decision rows, with four additions

Add to the decision row schema (`lib/decisions-schema.ts`, documented in
`docs/decisions-contract.md`):

| Field | Values | Purpose |
|---|---|---|
| `owner` | `partner` \| `implementing-org` \| `dimagi` \| free text | Who must answer the ask. Distinct from `value_set_by`, which is who set the value. |
| `needed_by` | `award` \| `go-live` \| `closeout` \| `extension` | When the answer is needed, as a lifecycle gate a reader understands — replaces the ledger's `blocking` ("Before Phase N"). |
| `answer_channel` | `review` \| `solicitation:<question-id>` \| `call` | Where the answer arrives. A solicitation question id lets an award close the ask from the response. |
| `revisit_when` | one plain sentence | Only with the new status below. |

And one status: `deferred` (alongside `ai-default`, `overridden`,
`human-decided`) for category-C questions — "not needed for this pilot;
revisit when <condition>". Deferred rows render collapsed, never as an ask.

`review_ask` keeps its meaning (the run is built on this value; confirm it) and
gains one gated variant, `review_ask: required-before: <needed_by>`, for the
E case. It never blocks a phase; `validate-release-readiness` reads it — an
unanswered `required-before: award` row is a release warning naming the
question, and `solicitation-review` refuses to award while one is open.

### 2. Producers log every default they build on

The B category exists because a skill took a working answer without writing a
row. Add to the producer contract (`skills/_decisions-review-fields.md`): **a
default you build on is a decision row.** Where the source material does not
settle it, the row carries `review_ask`, `owner`, `needed_by` and
`answer_channel`. This is the write-side rule that replaces "raise an open
question".

### 3. Durability across runs without a second ledger

The ledger's one real job was carrying unanswered asks from run to run. Two
existing mechanisms cover it:

- **Answers** already persist opp-level in `inputs/decision-overrides.yaml`
  (attributed rulings, applied to every run by `applyDecisionOverrides`).
- **Unanswered asks** are re-derived by each run's producers from the PDD and
  inputs — which keeps run independence and makes them describe *this* run's
  design (the drift above is what a carried ledger produces). As a safety net,
  the run-end write-back emits `ACE/<opp>/open-asks.yaml`: a generated,
  read-only list of the run's live rows with an unanswered `review_ask` or
  `deferred` status. Phase 1 reads it to check nothing was dropped (a missing
  ask becomes a run residual), never to inherit values.

### 4. Everything that is not a decision leaves the store

| Kind | Goes to |
|---|---|
| Chores (sweep, distribute, follow up) | the canopy-web task board, or `phases.<phase>.residuals` when run-scoped |
| Upstream requests (Connect, Nova, OCS) | an issue in the owning system's tracker, cited from the decision row it affects |
| Factual partner inputs | a solicitation question, referenced by `answer_channel` |

### 5. One review surface in ace-web

The decisions tab becomes the only place a reviewer is asked anything:
"Confirm before launch" and "Answer before award" groups, filtered and grouped
by `owner`, with `deferred` rows collapsed. The Overview's "Questions for you"
section and the open-questions parser (`_read_open_questions`,
`_parse_open_questions`, `OpenQuestionsList`) are retired once no live run
depends on them; until then the page reads `open-asks.yaml` if present, else
the legacy ledger.

### 6. Migration

`scripts/migrate-open-questions.ts`, run once per opp, dry-run by default:

1. Parse `open-questions.md`; for each open row, find matching live decision
   rows (id and text similarity, then a human pass on the proposed matches).
2. A → mark the ledger row superseded by the decision row; copy any
   owner/needed_by onto it.
3. B → append the missing decision row with the default the build took, quoted
   from its source, plus `review_ask`.
4. C → append a `deferred` row with `revisit_when`.
5. D → print the task / issue / solicitation question to create; nothing is
   written to decisions.
6. E → append a row with `review_ask: required-before: award`.
7. Archive the ledger as `open-questions.archived.md`; resolved rows stay
   readable as history.

The plain-language gate and the new ledger check from PR #2628 apply to every
row it writes.

## What this does not change

- No phase blocks on a review ask (the "never blocks a run" contract stands);
  the only gate is the explicit `required-before`, read by release readiness
  and award.
- Decision values, the override UI, and `decision-overrides.yaml` semantics are
  unchanged.

## Rollout

1. Schema + contract + producer rule (ACE), with tests on the spark fixtures.
2. `open-asks.yaml` emission at run end; release-readiness and
   `solicitation-review` read `required-before`.
3. ace-web merged review surface, legacy-ledger fallback kept.
4. Migration script; run it on spark-facilitator first, then every opp with a
   ledger.
5. Retire ledger writers (`idea-to-pdd` step, orchestrator run-end, `inbox-triage`
   2g, `feedback-ledger`) and the ledger checks; remove the ace-web fallback
   once no ledger is read.

## Decisions needed from the owner

1. Approve folding the ledger into decisions as above (vs. keeping it for C/D
   rows only).
2. `needed_by: award` as a hard stop in `solicitation-review` — yes, or warn
   only?
3. Whether `open-asks.yaml` should exist at all, or producers' re-derivation is
   trusted alone.
