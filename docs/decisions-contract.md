# decisions.yaml review contract (schema v6)

`ACE/<opp>/runs/<run-id>/decisions.yaml` is the run's **review artifact**. It
replaced the per-run build memo on 2026-10-03 (owner decision: *"get rid of the
build memo and improve decisions so it serves the same purpose"*). ace-web's
Decisions view renders against the fields below, so **their names are fixed**;
add a field, never rename one.

Schema authority: `lib/decisions-schema.ts` (`DECISIONS_SCHEMA_VERSION = 6`).
Readers accept v3–v6; every v6 field is optional on read, so older logs keep
parsing. The deterministic parts are computed by `lib/decision-review.ts` and
`lib/decisions-enrich.ts`.

## Fields added in v6

All optional on read. On a **new write** through `decisions_append_rows`,
`plain` is required on every partner-facing row (anything not `audience:
internal`).

| Field | Values | Meaning |
|---|---|---|
| `review_ask` | `recommended-confirmation` | The run is built on this value, but someone with authority should confirm it before launch. Absent = no ask. Never blocks a run. |
| `confirm_reason` | one plain sentence | Why it needs confirming, e.g. *"The design marks the rate as proposed; the build uses 7,500 MWK as a placeholder."* Required with `review_ask`, invalid without it. |
| `plain` | one line | What was chosen, for a programme partner who has never seen ACE. No field ids, no §-references, no ACE jargon (PDD, CCZ, skill names, issue numbers). A rule quoted in double quotes may keep the design's own words — not its field ids or expressions (§ Plain-language gate). |
| `plain_question` | one question | The question as a programme partner would ask it, e.g. *"What should a facilitator be paid per verified community meeting?"*. `question` stays as the build wrote it. Same plain-language rules as `plain`. Derived for every review ask; optional elsewhere. |
| `plain_value` | display text | The effective value formatted for a reader: *"7,500 MWK"* for an `ai-default` of `7500`, *"3,276,000 MWK"*, *"2 November 2026 to 26 February 2027"*. `ai-default` / `override` stay the exact option strings the override UI keys on. Stamped at the write boundary when formatting changes something. **Required whenever `ai-default` is itself jargon** (§ Plain-language gate). |
| `check_at` | a path | Where to spot-check it, e.g. *"Deliver app › Community Meeting Record › meeting photo"*. |
| `correct_looks_like` | one line | What you see at `check_at` when it is right. |
| `audience` | `partner` \| `internal` | `internal` = ACE's own test harness or build infrastructure (scenario counts, smoke recipes, scroll methods). Absent = `partner`. Partner views hide `internal` rows. |
| `scope` | `record` \| `entity` \| `worker` \| `programme` | **Rule rows only.** What one application of the rule limits: one submitted record, one tracked case (a community, a household), one worker, or the programme as a whole (a review sample). |
| `enforcement` | `enforced` \| `by-design` \| `gap` | **Rule rows only.** `enforced`: a Connect rule, a Connect payment limit or an app check holds it at its scope. `by-design`: the design places it off the platform on purpose. `gap`: the design needs it and nothing in the build holds it. Set together with `scope`. |
| `also_raised_by` | list of skills | Other skills that raised the same question with the same answer; their rows are folded into this one (`superseded_by` it). |

### Added 2026-10-04 — asks live on the row (the open-questions ledger is retired)

Still schema v6 (additive; the version number does not move). Spec:
`docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md`,
approved by the owner 2026-10-04.

| Field | Values | Meaning |
|---|---|---|
| `owner` | `partner` \| `implementing-org` \| `dimagi` \| free text | Who must answer the ask (e.g. `Spark M&E`). Distinct from `value_set_by`, which is who sets the value. |
| `needed_by` | `award` \| `go-live` \| `closeout` \| `extension` | When the answer is needed, as a lifecycle gate a reader understands. Replaces the ledger's "Before Phase N". **Required with `review_ask: required-before`.** |
| `answer_channel` | `review` \| `solicitation:<question-id>` \| `call` | Where the answer arrives: the decisions review (saved to `inputs/decision-overrides.yaml`), a question in the published solicitation (the awarded response's answer closes the ask), or a call with Dimagi. |
| `revisit_when` | one plain sentence | **Only with `status: deferred`** (and required on a new deferred row): when to raise the question again, e.g. *"When the programme expands to Rwanda."* Held to the plain-language gate. |

`status` gains **`deferred`** (alongside `ai-default`, `overridden`,
`human-decided`): a question this pilot does not need answered — a future
phase, an expansion. `ai-default` holds the working assumption. A deferred row
carries no `review_ask` and no `override`, and renders **collapsed, never as an
ask**.

`review_ask` gains **`required-before`** — the same meaning as
`recommended-confirmation` (the run is built on this value; confirm it) plus a
gate: the answer is needed before `needed_by`. Use it only where no working
default is safe to build past that gate — an answer that changes who may be
awarded, or what the award commits to. It never blocks a phase. See § Open asks.

**What a partner view shows, in order of preference:** headline =
`plain_question` → `plain` → `question`; value = `plain_value` → `override` →
`ai-default`; then `plain` (when the headline was the question),
`confirm_reason` for an ask, and `check_at` / `correct_looks_like`. Hide
`audience: internal` rows and every row with `superseded_by`.

Existing fields that matter to a reviewer: `superseded_by` (the row is history —
show the row it points to), `inherited_from_run` (the row was carried in from
another run), `status` (`ai-default` / `overridden` / `human-decided` /
`deferred` — collapse deferred rows),
`value_set_by: external` (the value is a projection someone else will fix).

**Live rows** are those without `superseded_by`. Every consumer reads live rows
only.

## Plain-language gate

Every **reviewer-visible** row — live (no `superseded_by`) and not `audience:
internal` (ace-web hides internal rows behind a toggle, `DecisionsReview.tsx`
`isInternal`; an unmarked row `isInternalDecision` recognises counts as
internal) — must:

1. carry `plain` (without it the page's headline is the raw build `question`);
2. carry `plain_value` whenever the un-overridden `ai-default` is itself jargon
   (an overridden row shows the human's answer instead);
3. carry, in none of `plain`, `plain_question`, `plain_value`,
   `confirm_reason`, `check_at`, `correct_looks_like`, `revisit_when`: a field id or other
   snake_case identifier, an `=` / `==` / `!=` / `>=` / `<=` expression,
   upper-case `AND`/`OR`/`NOT`, a run id (`20261001-2208`), a platform record
   id (`ad6c2d40`, a UUID), an issue number (`#2512`, `ace#2419`), "Phase N", a
   code span, or ACE jargon (PDD, CCZ, `§`, skill names, repo paths).
   **Quoting does not exempt identifier shapes** — `"meeting_conducted = yes"`
   is what reached the spark-facilitator/20261001-2208 public page.

The checker is `plainLanguageFindings(text): string[]` (`lib/decision-review.ts`),
whose identifier shapes are the shared table in
`lib/pdd-description-plain-language.ts` (`auditOutsiderText(text,
'decision')`; the PDD-description and open-questions gates are other profiles
of the same table). The whole-log
gate is `auditDecisionsPlainLanguage(log): PlainLanguageGateReport`
(`lib/decisions-enrich.ts`) — `{verdict, findings: [{id, skill, field,
finding}]}`. Where it fires:

- **write boundary** (`decisions_append_rows`, `DecisionRowStrictSchema`):
  per row — `plain` required, and every reviewer-visible field linted;
- **phase end** (`decisions_enrich` → `report.plainLanguageGate`):
  `skills/decisions-render` step 1.5 records a `fail` as the step's FAIL,
  naming each row id + field + token;
- **release** (`assessDecisionsPlainLanguage`, `lib/release-readiness.ts`):
  one `public-summary` blocker per producing skill — the run is NOT READY for
  outside reviewers until the rows are rewritten.

*Enforced:* `test/lib/decisions-plain-language-gate.test.ts` over verbatim
rows in `test/fixtures/decisions-plain/`.

## What earns a `review_ask`

Derived by `deriveReviewAsks` (`lib/decisions-enrich.ts`) from the run's own
records, so it does not depend on a producer remembering:

1. every program parameter the design marks `PROPOSED` that the build
   configured — worker rate, payment to the implementing organisation, total
   budget, delivery dates (the ask lands on the latest-phase row that carries
   the configured value; a row is synthesized when none does);
2. every working language other than the app's default, whose text is machine
   translated and not yet signed off by a native speaker;
3. every rule row with `enforcement: gap`, and a Connect opportunity that saved
   none of the design's payment rules;
4. every live row the build left `OPEN`;
5. every open residual in `run_state.phases.*.residuals` / `open_residuals`
   that a person must decide (a design decision, a sign-off), unless a later
   phase lists it as resolved — synthesized as an `open-question-*` row.

A row a person already ruled on (`overridden`, `human-decided`) never carries an
ask, and neither does a `deferred` row. A producer may set `review_ask` itself
for anything else outside ACE's authority — and must, per § The producer rule.

## The producer rule — a default you build on is a decision row

**This replaces "raise an open question" everywhere.** When a skill builds on
a working answer — a value the source material does not state, a placeholder,
a "we'll assume X until told otherwise" — it writes a decision row for it.
Where the sources do not settle the answer, the row also carries:

- `review_ask` (`recommended-confirmation`, or `required-before` + `needed_by`
  when no default is safe past a gate) and `confirm_reason`;
- `owner` — who must answer;
- `needed_by` — when the answer is needed (optional with
  `recommended-confirmation`);
- `answer_channel` — where the answer arrives.

A question the pilot does not need answered is a `status: deferred` row with
`revisit_when`. Measured on spark-facilitator/20261001-2208: 5 of the
ledger's 32 open rows were defaults the build took with no decision row at all
(`lookup-table-provisioning`, `airtime-payout-channel`, `pilot-data-handover`,
`attendance-list-practice`, `s1-s6-indicators-not-computable`) — this rule is
what closes that class.

**What is NOT a decision row.** A chore (sweep a stale opportunity, distribute
the solicitation, follow up) goes to the canopy-web task board, or to
`phases.<phase>.residuals` when run-scoped. An upstream request (Connect, Nova,
OCS) is an issue in the owning system's tracker, cited from the decision row it
affects. A factual partner input is a solicitation question, referenced from
the row by `answer_channel: solicitation:<question-id>`.

## Open asks

**Open asks are a filter over decision rows, never a file** (operator decision
2026-10-07, ace#2757 — *"why isn't that just a filter of decisions"*). An
**open ask** is a live row (no `superseded_by`) with an unanswered
`review_ask`, or a `status: deferred` row. "Answered" means a person ruled: the
row is `overridden` / `human-decided`, or a saved ruling in
`inputs/decision-overrides.yaml` binds to it (saved rulings are applied before
counting, so a ruling saved after the row was written counts). The predicate
is ONE function, `openAsks` in `lib/open-asks.ts`; every reader goes through
it — the `decisions_open_asks` atom (ace-decisions), Phase 1's carried check,
release readiness and `solicitation-review` — and ace-web computes the run
page's asks the same way from the run's `decisions.yaml`. Nothing writes a
list of asks anywhere: the retired `ACE/<opp>/open-asks.yaml` and the retired
`open-questions.md` ledger are read by no run.

- **Durability across runs.** Answers persist opp-level in
  `inputs/decision-overrides.yaml`. Unanswered asks are re-derived by each
  run's producers from the design and inputs — run independence holds, and the
  ask describes *this* run's design. As a safety net, Phase 1 calls
  `decisions_open_asks(throughPhase: 1)` and the run-end write-back calls
  `decisions_open_asks(checkCarried: true)`: the atom finds the PREVIOUS run
  (the newest older sibling under `runs/` with a `decisions.yaml`; archived
  `superseded-*` folders never count), filters ITS log through `openAsks`, and
  reports any ask this run has no row for (same id, same `feedback_ref`, or a
  re-worded question) as a ready-made run residual. The previous log is read
  only for that check — values are never inherited from it.
- **The only gate.** An unanswered `review_ask: required-before` row is a
  `validate-release-readiness` blocker naming the question
  (`assessRequiredBeforeAsks`, `lib/release-readiness.ts`, via
  `requiredBeforeBlockers` over `openAsks`), and `solicitation-review` refuses
  `award_response` while one with `needed_by: award` is unanswered (step 5b;
  owner decision 2026-10-04 — a hard stop, not a warning). An unanswered
  `recommended-confirmation` is neither. No phase ever blocks on an ask.
- **The review surface.** ace-web's decisions tab is the only place a reviewer
  is asked anything: "Confirm before launch" (`recommended-confirmation`) and
  "Answer before award" (`required-before`, by `needed_by`) groups, filtered
  and grouped by `owner`, with `deferred` rows collapsed.
- **Legacy ledgers.** No run reads `ACE/<opp>/open-questions.md` — not a
  migrated opp's, not an un-migrated one's. `scripts/migrate-open-questions.ts`
  is the only code that opens a ledger: it folds one into decision rows once
  (dry-run by default) and archives it as `open-questions.archived.md`. The
  retired files stay at the opp root only as a quarantine entry in
  `lib/opp-root-files.ts`, so Step 5b never moves ACE's own former prose into
  `inputs/`. *Enforced:* `test/agents/open-questions-location.test.ts`.

## Where each part is filled

| Who | Fills |
|---|---|
| Producer skill (on every `decisions_append_rows`) | `plain`; `check_at` + `correct_looks_like` where there is a place to look; `review_ask` + `confirm_reason` + `owner` + `needed_by` + `answer_channel` for every default it builds on that the sources do not settle (§ The producer rule); `status: deferred` + `revisit_when` for a question the pilot does not need answered; `audience: internal` for harness rows. |
| Orchestrator (after Phase 1, and run end) | `decisions_open_asks` carried check — read-only; dropped asks become run residuals. |
| Write boundary (`decisions_append_rows`, `stampRow`) | `audience: internal` on recognisably-harness rows; `scope` + `enforcement` + a `plain` line on rule rows; `check_at` from a `Spot-check: <where>.` sentence in `reasoning`. Never overwrites a producer's value. |
| `decisions_enrich` atom (every phase end, before `render_decisions_log`) | cross-skill dedupe; every derived `review_ask` above. Idempotent. |
| `scripts/backfill-decisions-contract.ts` | one-time upgrade of a run that finished under the build memo (harvests the memo's choices table, retires stale inherited rows, applies the above). |

## Re-runs (forks, clones)

A row inherited from another run for a phase this run re-runs is history unless
the re-run re-affirmed it. Before a phase re-runs, its inherited rows move to
`<id>-<source-run-id>` with `superseded_by: <id>` and `inherited_from_run`
(`retireForRerun`, `lib/decisions-rerun.ts`; ace-web's fork does the same
server-side). The re-run producer then appends under the canonical id;
re-affirming means writing it again. After the fact, `retireStaleInherited`
supersedes inherited rows onto the row that replaced them.

## Example

```yaml
- id: connect-latitude-payment-amount-spark
  phase: 4-connect
  skill: connect-opp-setup
  question: Which FLW amount within the PDD's proposed MWK 5,000-10,000 band is configured?
  ai-default: "7500"
  options: ["7500", "5000", "10000"]
  source: PDD §10.1 / §14 [PROPOSED]
  status: ai-default
  value_set_by: external
  evidence_basis: inferred
  plain_question: What should a facilitator be paid per verified community meeting?
  plain: Each worker is paid 7,500 MWK per verified community meeting, the middle of the design's proposed range.
  plain_value: 7,500 MWK
  check_at: Connect › opportunity › payment units
  correct_looks_like: 7,500 MWK per verified meeting.
  review_ask: recommended-confirmation
  confirm_reason: The design marks the worker rate as proposed (5,000–10,000 MWK); the build uses 7,500 MWK as a placeholder, and Connect pays whatever figure is set.

- id: connect-rule-daily-limit-spark
  question: Where is the PDD verification rule 'at most 1 payable meeting per CBF per day' enforced?
  ai-default: Connect payment unit limit
  scope: worker
  enforcement: enforced
  plain: '"at most 1 payable meeting per CBF per day" applies to each worker, and is enforced by Connect''s payment limit (at most 1 paid per worker per day).'
  plain_value: Connect's payment limit
```
