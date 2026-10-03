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
| `plain` | one line | What was chosen, for a programme partner who has never seen ACE. No field ids, no §-references, no ACE jargon (PDD, CCZ, skill names, issue numbers). A rule quoted in double quotes may keep the design's own words. |
| `check_at` | a path | Where to spot-check it, e.g. *"Deliver app › Community Meeting Record › meeting photo"*. |
| `correct_looks_like` | one line | What you see at `check_at` when it is right. |
| `audience` | `partner` \| `internal` | `internal` = ACE's own test harness or build infrastructure (scenario counts, smoke recipes, scroll methods). Absent = `partner`. Partner views hide `internal` rows. |
| `scope` | `record` \| `entity` \| `worker` \| `programme` | **Rule rows only.** What one application of the rule limits: one submitted record, one tracked case (a community, a household), one worker, or the programme as a whole (a review sample). |
| `enforcement` | `enforced` \| `by-design` \| `gap` | **Rule rows only.** `enforced`: a Connect rule, a Connect payment limit or an app check holds it at its scope. `by-design`: the design places it off the platform on purpose. `gap`: the design needs it and nothing in the build holds it. Set together with `scope`. |
| `also_raised_by` | list of skills | Other skills that raised the same question with the same answer; their rows are folded into this one (`superseded_by` it). |

Existing fields that matter to a reviewer: `superseded_by` (the row is history —
show the row it points to), `inherited_from_run` (the row was carried in from
another run), `status` (`ai-default` / `overridden` / `human-decided`),
`value_set_by: external` (the value is a projection someone else will fix).

**Live rows** are those without `superseded_by`. Every consumer reads live rows
only.

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
ask. A producer may set `review_ask` itself for anything else outside ACE's
authority.

## Where each part is filled

| Who | Fills |
|---|---|
| Producer skill (on every `decisions_append_rows`) | `plain`; `check_at` + `correct_looks_like` where there is a place to look; `review_ask` + `confirm_reason` for anything else outside ACE's authority; `audience: internal` for harness rows. |
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
  plain: Each worker is paid 7,500 MWK per verified community meeting, the middle of the design's proposed range.
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
```
