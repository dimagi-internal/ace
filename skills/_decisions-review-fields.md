# Decision rows are the review artifact — the v6 review fields

Shared by every skill that appends rows with `decisions_append_rows`. The
decisions log replaced the per-run build memo as what a reviewer reads (owner
decision 2026-10-03), so each row you write must stand on its own for someone
who has never seen ACE. Full field contract: `docs/decisions-contract.md`
(ace-web renders against it, so field names are fixed). Terminology: the
platform is "Connect" in all reviewer-facing text (`skills/_terminology.md`).

## What you write on every row

- **`plain` — REQUIRED on every partner-facing row.** One line saying what was
  chosen, for a programme partner. No field ids (`meeting_conducted`), no
  §-references, no ACE jargon (PDD, CCZ, skill names, issue numbers, `[ACE]` /
  `[FIXED]` tags). Say "the design" for the PDD and "the implementing
  organisation" for the LLO. A rule may be quoted in double quotes to keep the
  design's own WORDS — but quoting does not exempt a field id, an `=`
  expression, a run id, a platform record id (`opportunity ad6c2d40`), an
  issue number or "Phase N": write `"the meeting happened"`, never
  `"meeting_conducted = yes"`. The atom rejects a partner row without it, and
  rejects jargon in it.
  - good: `plain: "Each worker is paid 7,500 MWK per verified community meeting, the middle of the design's proposed range."`
  - bad: `plain: "PU amount 7500 per PDD §14 payment_rate_band [PROPOSED]"`
  - bad (spark-facilitator/20261001-2208, shown on the public page): `plain: '"meeting_conducted = yes" applies to each record'`
- **`plain_value` — REQUIRED whenever your `ai-default` is itself jargon**
  (a field id, an expression, PDD, CCZ, "Phase 4"): the value in words, e.g.
  `ai-default: "payable_slot in key plus Phase 4 rule"` →
  `plain_value: "A paid-slot marker in the record, plus a Connect rule that pays only marked records"`.
  Not needed when the option already reads plainly (`7500` is formatted for
  you).
- **Every reviewer-visible field is held to the same lint** — `plain`,
  `plain_question`, `plain_value`, `confirm_reason`, `check_at`,
  `correct_looks_like`. `check_at` is a path a partner follows: `Connect ›
  opportunity › verification rules`, not `Connect › opportunity ad6c2d40 ›
  verification rules`; `training guide`, not `training LLO guide (Phase 6)`.
  The plain-language gate (`docs/decisions-contract.md § Plain-language gate`)
  fails the phase-end render and blocks release on any of these.
- **`check_at` + `correct_looks_like`** whenever the choice is visible
  somewhere a reviewer can open: `check_at: "Deliver app › Community Meeting
  Record › meeting photo"`, `correct_looks_like: "The form cannot be saved
  without a photo."` If you omit `check_at`, the atom fills it from a
  `Spot-check: <where>.` sentence at the end of `reasoning` — keep writing that
  sentence.
- **`audience: internal`** on ACE's own test-harness or build-infrastructure
  choices (scenario counts, smoke recipes, scroll methods, selector fixes). The
  atom stamps it on recognisable harness rows (`isInternalDecision`,
  `lib/decision-review.ts`); internal rows do not need `plain`.
- **`review_ask: recommended-confirmation` + `confirm_reason`** when the run is
  built on a value that someone with authority should confirm before launch and
  the standard derivation will not catch it — a value outside ACE's authority,
  an open design question you could not settle. `confirm_reason` is one plain
  sentence ("The design marks the rate as proposed; the build uses 7,500 MWK as
  a placeholder."). You do NOT need to mark the standard ones:
  `decisions_enrich` derives asks for every `PROPOSED` program parameter the
  build configured, every machine-translated language, every enforcement gap,
  every `OPEN` row and every open residual a person must decide. It never
  blocks a run. Every such row also follows § The producer rule below.

## The producer rule — a default you build on is a decision row

**This replaces "raise an open question" in every skill.** There is no
open-questions ledger to write to any more (`ACE/<opp>/open-questions.md` is
retired; owner decision 2026-10-04). When you build on a working answer — a
value no source states, a placeholder, an assumption you will hold until told
otherwise — write a decision row for it. When the sources do not settle it,
the row also carries who answers, by when, and where:

- **`review_ask`** + **`confirm_reason`** — `recommended-confirmation` by
  default. Use **`required-before`** (which REQUIRES `needed_by`) only when no
  working default is safe past a lifecycle gate: an answer that changes who may
  be awarded or what the award commits to (`needed_by: award`), or what may go
  live. It is the only ask that gates anything — release readiness blocks on
  it, and `solicitation-review` will not award while a `needed_by: award`
  one is unanswered. It never blocks a phase.
- **`owner`** — who must answer: `partner`, `implementing-org`, `dimagi`, or
  their name as the reader knows it (`Spark M&E`).
- **`needed_by`** — `award` | `go-live` | `closeout` | `extension` (optional
  with `recommended-confirmation`). Never "Before Phase N".
- **`answer_channel`** — `review` (the decisions review), `call`, or
  `solicitation:<question-id>` when a question in the published solicitation
  asks it.

A question this pilot does not need answered (a future phase, an expansion,
instrumenting the partner's own app) is a row with **`status: deferred`** and
**`revisit_when`** (one plain sentence: *"When the programme expands to
Rwanda."*) — no `review_ask`. `revisit_when` is held to the plain-language
gate like `plain`.

Not a decision row: a chore (sweep, distribute, follow up) → the task board or
`phases.<phase>.residuals`; an upstream request → an issue in the owning
system's tracker, cited from the row it affects; a factual partner input → a
solicitation question, named in `answer_channel`.

```
{ id: "rct-sample-overlap", phase: "1-design", skill: "idea-to-pdd",
  question: "May the pilot work in communities that are in the impact study's sample?",
  "ai-default": "Exclude study communities", options: ["Exclude study communities", "Allow study communities"],
  source: "PDD § Evaluation design", status: "ai-default", evidence_basis: "inferred", value_set_by: "external",
  plain: "The pilot assumes it will not work in communities that are part of the impact study.",
  plain_question: "May the pilot work in communities that are part of the impact study?",
  review_ask: "required-before", needed_by: "award", owner: "partner", answer_channel: "review",
  confirm_reason: "The award could pick study communities, and nothing in the sources says whether that is allowed." }
```

Full contract: `docs/decisions-contract.md § The producer rule` and § Open asks.

## Rule rows (`Where is the PDD verification rule '<rule>' enforced?`)

Write `scope` (`record` | `entity` | `worker` | `programme`) and `enforcement`
(`enforced` | `by-design` | `gap`) — or leave both out and the atom computes
them from the rule text and your `ai-default` + `reasoning`
(`classifyRule`, `lib/decision-review.ts`). The rules that computation applies,
which you must not contradict:

- a per-worker limit ("per CBF per day", "total cap 21 per CBF") is held by
  Connect's payment unit `max_daily` / `max_total`, never first by an app
  check — an app check is keyed on one case (one community), so it cannot bound
  a worker across cases. A per-worker rule held only by an app check is a `gap`;
- a rule Connect refused to save is a `gap`; a rule the design itself places
  off the platform (a review sample, a call procedure) is `by-design`. Never
  give both the same label.

## Re-runs

When a phase re-runs (a fork, a clone that rebuilds Phase 4), the inherited
rows of that phase are retired before it runs (`retireForRerun`,
`lib/decisions-rerun.ts`, or ace-web's fork). Re-emit every row whose choice
still holds under its canonical id — re-affirming a choice means writing it
again; a row you do not re-emit stays history.

## Worked row

```
{
  id: "connect-latitude-payment-amount",
  phase: "4-connect",
  skill: "connect-opp-setup",
  question: "Which single worker amount does the payment unit carry within the proposed band?",
  "ai-default": "7500",
  options: ["7500", "5000", "10000"],
  source: "PDD §10.1 / §14 [PROPOSED]",
  status: "ai-default",
  evidence_basis: "inferred",
  value_set_by: "external",
  reasoning: "Band midpoint; the awarded rate replaces it. Spot-check: Connect › opportunity › payment units.",
  plain: "Each worker is paid 7,500 MWK per verified community meeting, the middle of the design's proposed range.",
  check_at: "Connect › opportunity › payment units",
  correct_looks_like: "7,500 MWK per verified meeting."
}
```

(`decisions_enrich` adds the `review_ask` for this one, because the design
marks the rate `PROPOSED`.)
