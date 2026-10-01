---
name: build-memo-eval
description: >
  Grade the run's build memo against what was actually built, and for a reviewer who has never seen ACE.
disable-model-invocation: false
---

# Build Memo — Eval

Grades `4-connect/build-memo.md`, the run's review artifact. ace-web's public
run summary renders it FIRST, and the PDD names it as the thing a human reviews
*instead of every screen* — so a memo that misstates the build sends the review
to the wrong place. `build-memo` itself checks only completeness (every
producer section present, every row cited), which a memo that says the wrong
thing passes. This is the quality grade.

**Fitness axis (out-of-chain anchor).** The memo is composed from the
producers' own memo sections, so grading it against those sections is grading
the chain against itself. The load-bearing dimension, `accuracy_against_build`,
grades it against **what was built**: the fact sheet `lib/build-memo-facts.ts`
assembles from `run_state.yaml` (each id and setting recorded as it was minted)
and from LIVE Connect reads — never from the memo's own claims. It carries a
hard gate. See `skills/_eval-template.md § The out-of-chain fitness requirement`.

See `skills/_eval-template.md` for the shared contracts. Provisional rubric —
calibration TBD until 3+ graded memos produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 4 | `4-connect/build-memo.source.md` (else `build-memo.md`, `exportAs: text/markdown`) | the artifact under judgment |
| Run state | `run_state.yaml` | the fact sheet's recorded half: apps (name, released version, build status), opportunity, orgs, payment units, verification rules written / persisted / not-applied reason, test-user invite |
| Live Connect | `connect_get_opportunity`, `connect_list_payment_units` on the holding org | the fact sheet's live half: active, is_test, dates, budget, currency, program name, the units Connect actually holds |
| Phase 4 | `4-connect/connect-opp-setup.md` | the producer's own record — context for a disagreement, never the anchor |
| Run root | `decisions.yaml` (rows with `phase: 3-commcare` / `4-connect`) | whether every latitude / ambiguity the build took is surfaced in the memo |
| Phase 1 | the PDD | which places the PDD left to ACE ([ACE] latitude) and which it fixed — what an honest memo must surface |

## Products

- `4-connect/build-memo-eval_verdict.yaml` — verdict YAML per
  `_eval-template.md § Verdict YAML contract` / `lib/verdict-schema.ts`, with the
  fact sheet's contradictions listed in `per_item`.

## Process

1. **Read** the memo (`build-memo.source.md` — byte-exact; else the Doc as
   `text/markdown`), `run_state.yaml` (`writeToPath`, default export), the
   Phase 3–4 `decisions.yaml` rows, and the PDD.
2. **Read Connect live** — in one parallel message, at the holding org
   (`products.connect.holding_org_slug`, legacy `organization_slug`):
   `connect_get_opportunity` and `connect_list_payment_units`. Save each JSON
   response locally. A failed read is noted in the verdict; the recorded half of
   the fact sheet still stands.
3. **Build the fact sheet:**
   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/build-memo-facts.ts" \
     --run-state <run_state.yaml> --live-opportunity <opp.json> --live-payment-units <pus.json>
   ```
4. **Cross-check every factual claim in the memo** against the fact sheet — app
   names and versions, dates, budget, amounts, caps, which verification rules are
   enforced on Connect and which are NOT, the test-user state. For each claim
   record `matches` / `contradicted` (quote both sides) / `not on the sheet`. A
   claim the sheet cannot settle is not a contradiction; a claim the sheet
   contradicts is, whatever the producer section said. Also check the memo's
   title / run label against `run.run_id` — a forked run inherits its source's
   memo, and one still labelled with the source run misattributes everything in
   it. For a claim that a rule is enforced **in the app** (the sheet cannot settle
   these), check its SCOPE against the released form: a check keyed on a case
   (per community, per household) does not enforce a per-worker cap. Overstated
   app-side enforcement is an accuracy finding, not a sheet contradiction.
5. **Read it as a reviewer who has never seen ACE**, then for honesty and
   actionability (rubric below).
6. **Write the verdict** (`drive_upload_binary`, `mimeType: text/yaml`, into
   `4-connect/`; read it back) and surface concerns per
   `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Accuracy against the build** (fitness — out-of-chain) | 0.35 | Judge every factual claim against the FACT SHEET, not against the producer sections it was composed from. 10 = every checkable claim matches what run_state recorded and what Connect holds now. 6 = a minor mismatch a reviewer would not act on (a rounded figure, a stale label). 3 = a reviewer would act on a wrong fact — a cap, an amount, a date, an app version, or a verification rule described as enforced that Connect does not hold. **Hard gate: any claim that a verification rule is enforced on Connect when the sheet says it was NOT applied (or 0 persisted), or any payment amount / cap that contradicts Connect, scores ≤ 3 → suite verdict `fail`.** |
| **Gaps and decisions surfaced honestly** | 0.25 | Does the memo surface every place the build took [ACE] latitude or hit an ambiguity, and every rule it could NOT apply, where a reviewer will see it (not buried in a footnote)? A fact on the sheet a reviewer needs and the memo never states (an organisation amount, the test flag, a pending invite, an app version) is an omission scored HERE. A label that makes a real gap read the same as a by-design non-issue (one "not configurable" for both) is understating. Cross-check against the Phase 3–4 `decisions.yaml` rows and the PDD's [ACE] markers. 10 = every latitude / ambiguity / not-applied rule appears, with what was chosen and why. 6 = present but some are understated ("minor") or only in an appendix. 3 = a not-applied rule or a material latitude is missing or presented as settled. PDD silence is a finding, not a pass. |
| **Clarity for a non-ACE reviewer** | 0.20 | Could a programme partner who has never heard of ACE read it and know what was built and what to check? 10 = plain language; every term a partner would not know is explained where used; no internal ids, skill names or file paths in the body (links are fine); no rows that are ACE's own test-harness choices; no section repeating another. 6 = understandable with effort; some ACE jargon, raw identifiers or repetition. 3 = written for ACE — skill names, run-state keys, un-glossed abbreviations dominate. |
| **Actionability** | 0.20 | Does each item tell the reviewer what to spot-check and where (the app screen, the Connect page, the decision row)? 10 = every row names the place to look and what "correct" looks like there. 6 = most rows do; some are statements with no way to verify. 3 = a list of facts with no review path. |

Weights sum to 1.0: 0.35 + 0.25 + 0.20 + 0.20 = 1.00.

**Hard-deduct rules:**
- The accuracy hard gate above → BLOCKER; suite verdict `fail`.
- `products.connect.build_memo.complete: false` with `gaps[]` the memo does not
  itself state at the top → cap `gaps_surfaced_honestly` at 3.
- Any dimension ≤ 3 → suite verdict `fail`.

**Verdict bands** (overall, post-cap): ≥ 7.0 `pass`; 5.0–6.9 `warn` (gate
`iterate` — surfaced, not blocking); < 5.0 `fail`. A hard gate or a dimension ≤ 3
is `fail` at any overall.

**No self-eval to inflation-guard.** `build-memo` writes none; the guard is a
no-op.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued memo defects in
  `eval-calibration/known-issues.md § Build memo` (catalogue TBD — seed it with
  any reviewer comment on a memo that a grade here passed).
- Inter-run variance ≤ 0.5 across 3 same-model runs.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. |
| `longitudinal-visits` | Accuracy also covers per-case caps and sequencing rules (e.g. per-step caps) — they live in the payment units and the Deliver app, and a memo that states a different cap is a contradiction. |
| `focus-group` / `multi-stage` | Gaps dimension expects the per-session / per-stage payment logic and its verification to be stated per stage. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. Plus
`connect_get_opportunity` and `connect_list_payment_units` (read-only) for the
live half of the fact sheet, and `drive_upload_binary` for the verdict.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-10-01 | First live grade (spark-facilitator/20260926-1800): 6.2 `warn`. The judge's notes on the rubric are folded in: verdict bands stated (it only said when to fail); `run.run_id` / `run.forked_from` on the fact sheet (the memo was titled with the fork's SOURCE run); app-side enforcement claims checked for scope (two caps were credited to per-community form checks); omissions scored under gaps; harness-only rows and repetition under clarity. | ACE team |
| 2026-10-01 | Initial version. The build memo is the review artifact ace-web renders first, and nothing graded its quality — `build-memo`'s checks are completeness only. Four dimensions: `accuracy_against_build` (0.35, out-of-chain: the memo against a fact sheet of run_state + live Connect reads, `lib/build-memo-facts.ts`, with a hard gate on a verification rule or payment fact that contradicts Connect), `gaps_surfaced_honestly` (0.25), `reviewer_clarity` (0.20), `actionability` (0.20). Dispatched by `agents/connect-setup.md` Step 3b. | ACE team |
