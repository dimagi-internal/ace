---
name: demo-data-setup-qa
description: >
  Structural QA on the demo-data-setup handoff (realized.json + the source
  block). Binary pass/fail. Catches a dead/blank dashboard BEFORE demo-narrative
  authors scenes against it. Static-only, no LLM.
disable-model-invocation: false
---

# Demo Data Setup QA

Structural correctness checks on the `demo-data-setup` handoff — the
`7-synthetic/realized.json` map and the `run_state` `source` block. A demo whose
`par_url` renders the run picker (not the dashboard), or whose opp isn't
labs-only, or whose timeline slides, is a broken funder demo — this gate catches
that before `demo-narrative` builds scenes on top of it.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format,
auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `demo-data-setup` | `<demo-run>/7-synthetic/realized.json` | the handoff under check |
| `demo-data-setup` | `run_state.yaml…products.synthetic.source` | provider + labs opp id + deliver units |
| `demo-data-setup` | `<demo-run>/7-synthetic/demo-data-setup_manifest.yaml` | timeline pin + flagged-worker check; `timeline.end_date` feeds check 11's `opts.timelineEndDate` |
| `demo-data-setup` | `<demo-run>/7-synthetic/branch-scrub_report.yaml` | check 9: the spec derivation (incl. `unparsed[]`), the branch-scrub ledger, and the post-scrub audit |

## Products

- `<demo-run>/7-synthetic/demo-data-setup-qa_result.yaml` — QA result per `lib/qa-types.ts`

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `realized_json_parses` | static | `realized.json` exists and parses as a **flat** JSON object (no nested values — DDD substitutes `${var}` verbatim) | re-run `demo-data-setup` step 5 — the handoff was never written / was nested |
| 2 | `every_par_url_is_run_deeplink` | static | `primary_par_url` is present, and every `<key>_par_url` is a run deep-link `/labs/workflow/<id>/run/?run_id=<id>&(opportunity_id|program_id)=<id>` **whose scope param matches the dashboard's OWNERSHIP** — `program_admin_report` / `audit_par` are program-owned and MUST carry `&program_id=`; every opp-owned dashboard MUST carry `&opportunity_id=`. Importable: `checkParUrlScope` in `checks.ts`. | fix the scope, not just the shape. Verified live (workflow 5040 / run 5048 / program 10037): `&program_id=` renders the SOP grid, `&opportunity_id=` returns **200** with body "Workflow definition 5040 not found" — so a 200 is not evidence. Pre-#1037 this row demanded `&opportunity_id=` on everything, which failed a correctly-built program rollup and could only be satisfied by emitting the verified-broken URL. Other verified-live traps: `/run/?opportunity_id=` with no `run_id` → workflow LIST; `/workflow/<def>/?opportunity_id=` (no `/run/`) → DEFINITION page |
| 2b | `dashboards_match_realized` | static | `source.dashboards[]` is non-empty; each has `key` + `template` + `role` + `shape` (`run`\|`action`); and every `<key>` has a matching `<key>_par_url` in `realized.json` (plan ↔ handoff agree) | ensure every planned dashboard was built and its `${key}_par_url` written; drop any dashboard that failed to seed |
| 3 | `opp_is_labs_only` | static | `source.labs_synthetic_opp_id` is an integer **≥ 10000** | regenerate with a labs-only opp id ≥ 10000 — a real HQ-backed opp can't be driven by the generator |
| 4 | `timeline_pinned` | static | the manifest `timeline.start_date` is a fixed ISO Monday (not a relative/sliding expression) and equals the `par_url` opportunity's env anchor | set `--pin-monday` to a fixed Monday; a sliding window breaks idempotency |
| 5 | `flagged_worker_not_pre_seeded` | static | the current-week flagged worker has NO pre-seeded audit/task in the manifest (created on camera) | remove the flagged current-week worker's audit/task from the manifest |
| 6 | `deliver_units_present` | static | `source.deliver_units` is a non-empty array | re-capture `deliver_units` from the `synthetic_generate_from_manifest` response |
| 7 | `par_url_payload_is_populated` | static | **Fetches each `par_url` with the labs session**, parses the embedded `#workflow-data` script, and fails when (a) `definition.pipeline_sources` is non-empty while the run's pipeline rows are empty, or (b) any bound field is null/zero for EVERY row. `instance.snapshot.pipelines` arrives as a **dict keyed by alias** (what labs writes) or as an array of `{alias, rows}`; both are read (ace#1701). labs' own built-in row columns (`id`, `status`, `flagged`, `visit_date`, `total_visits`, the `*_visits` counters, `first/last_visit_date`) are **excluded** from (b) — whether they are filled is decided by `terminal_stage`, not by a schema path, so they fire on every entity-stage and visit-level pipeline and evidence nothing. For the **interactive** dashboard, whose run check 8 requires to stay `in_progress`, there is no snapshot by design and the server-rendered payload carries `pipeline_data: {}` (the page fills it over SSE after mount) — fetch `GET /labs/workflow/api/<definition_id>/pipeline-data/?opportunity_id=<opp>` and pass it as `livePipelines`; not doing so is a reported `live-pipelines-unavailable` finding, never a silent pass. Judgement is pure — `checkParUrlPayloadPopulated` in `checks.ts` takes the parsed payload, so only the fetch is the skill's job. | re-point the pipeline schema at the REAL form paths the generator writes (not the stock template's `form.meta.*`), and declare `snapshot_inputs.pipelines` for every alias in `pipeline_sources` before completing the run (#1160). A field zero for SOME rows is data, not a dead binding, and is not flagged |

| 8 | `interactive_run_is_live` | static | Using the payload check 7 already fetched: the dashboard whose `role` is interactive (`review-action` / `review` / `decision`) MUST have `instance.status != completed`, and every OTHER dashboard MUST have `instance.status == completed`. Importable: `checkInteractiveRunsLive` in `checks.ts`. | a completed run renders "This run is completed… Decisions are read-only" with the status control disabled, so the decision the narrative demonstrates cannot be performed on camera — skip `workflow_save_snapshot` for the interactive dashboard only. The reverse half matters too: a non-interactive run left `in_progress` has no snapshot, so its `par_url` is not a stable deep-link. A payload with no `instance.status` is reported, not failed (#1162) |

| 9 | `dataset_obeys_pdd_constraints` | static | Runs `checkDatasetObeysPddConstraints` (`checks.ts`) over three inputs the producer's step 2c writes: the **derivation** (`specFromDeliverApp(get_opportunity_apps(<opp>, 'deliver'))` — the spec is DERIVED from the app's own `relevant` / `constraint` expressions, and hand-declared currency / cross-field / `uniquePairs` entries are ADDITIONS merged with `mergeDatasetSpecs`, never a replacement), the **branch-scrub report** (`scrubOffBranchFields`), and `auditDataset` over the records as they now stand. Fails on: a clean audit with no derivation behind it and no stated reason; a deliver app that returned 0 questions; any `unparsed[]` gate or bound (an expression the derivation could not read is a gate this run did not audit — a reported finding, never a silent pass); a scrub field that could not be located; and any violation class. | **Re-run the branch scrub — do NOT narrow the spec.** `scrubOffBranchFields(records, spec.conditionalFields)` from `lib/dataset-constraints.ts`, then write the scrubbed `user_visits.json` back to the opp's fixture folder before any dashboard run is minted, and carry the per-field counts into the run summary. There is **no manifest-side remedy**: `BeneficiaryCohort` in `connect_labs/labs/synthetic/generator/fixtures/manifest.py` has no conditional / relevant / branch primitive (`null_rate` is unconditional; `CorrelationSpec` cannot make a field absent on a branch), so the pre-#1658 hint ("regenerate with the constraint applied at the manifest") named a knob that does not exist and left under-declaring the spec or hand-patching records as the only routes to green. For an `unparsed[]` entry, hand-declare that gate as an ADDITION and re-run. This gate exists because a run wrote "0 constraint violations, all hand-checked" into run_state for a set with 251 fractional people-counts, 242 fractional Kwacha amounts, 34 off-branch reasons and 22 did-not-happen meetings carrying 41 attendees — and THIS SKILL PASSED (#1346) — and because `bednet-check-2-visit/20260817-1720` then passed check 9 with `conditionalFields: []` on an app whose two observation fields are both gated on consent, which the next run of the same opp measured at 18 of 276 each (#1658). Report the per-class counts so "0" is measured |

| 10 | `dashboard_bindings_are_wired` | static | For each authored workflow, runs `checkDashboardBindings` (`lib/dashboard-bindings.ts`) over its definition: no pipeline schema still extracting `form.meta.*` (the stock template paths the synthetic generator never writes), `snapshot_inputs.pipelines` covering every alias in `pipeline_sources`, and render code that actually READS a declared pipeline rather than a denormalized `worker.visit_count` the generator never back-fills. | ADAPT means RE-POINT — re-point the new pipeline's schema at the same real form paths the scorecard pipeline already resolves, declare the snapshot aliases, and bind the render to the pipeline. Live: workflow 5069 hit all three at once and rendered `VISITS 0` beside `visits: 835` on data that summed correctly (#1160). Complements check 7, which catches the same class from the rendered payload; this one catches it from the DEFINITION, before a run is even minted |

| 11 | `cross_dashboard_totals_agree` | static | **Cross-dashboard consistency.** Using the payloads check 7 already fetched: when two or more dashboards read the same `labs_opp_id`, their shared visit total must AGREE. `deriveVisitTotal` takes `sum(total_visits)` from an aggregated pipeline's rows, else the row count of a visit-level pipeline. Program-scoped rollups are excluded (a cross-opp rollup aggregates a different population); a dashboard that deliberately renders a sub-window declares `period_scope: 'partial'` in `source.dashboards[]` and is excluded by name; a dashboard with no visit-shaped rows is reported not-judged, never failed. Pass the manifest's `timeline.end_date` as `opts.timelineEndDate` and a disagreeing dashboard whose `period_end` is at or before it gets the off-by-one named. Importable: `checkCrossDashboardConsistency` in `checks.ts`. | **`period_end` is EXCLUSIVE.** Re-mint the snapshotted run with `period_end = timeline.end_date + 1 day` and repoint its `par_url`. `_date_window_where` (`connect_labs/labs/analysis/backends/sql/query_builder.py`) emits `visit_date >= date_from AND visit_date < date_to`, so a `period_end` equal to the fixture's last `visit_date` drops that whole day — while a live, never-snapshotted sibling is never period-scoped and keeps it. If the two dashboards are MEANT to show different windows, declare `period_scope: 'partial'` on the narrower one rather than tolerating the gap silently |

All checks are static (<100ms), no LLM. Binary verdict: any BLOCKER fail →
`fail`; else `pass`.

**Promotion note (Plan A):** these checks are defined here and evaluated at gate
time against `realized.json`. Once the live realized-map shape is pinned in the
joint test, promote them to an importable `checks.ts` + unit test (mirroring
`skills/synthetic-narrative-plan-qa/checks.ts`) for static CI enforcement.

## Why check 7 exists — and what it deliberately does not cover

This skill's job, per `lib/artifact-manifest.ts`, is that **"a dead dashboard
must not reach a stakeholder."** Run as a boundary-fence heal against
`hh-poverty-targeting/20260730-2210` it returned **7/7 pass** — on a demo whose
review dashboard was analytically dead and whose walkthrough scored concept
2.0/5, user 1.0/5, arc 1.0/5 with 21 findings. Every check inspected the
HANDOFF (realized.json's shape, a URL against a regex, plan↔handoff agreement,
an integer, a date); none looked at what a `par_url` renders, and a regex cannot
tell a real run from a fabricated id. The gate would have passed in sequence and
prevented nothing (dimagi-internal/ace#1161).

**Check 8 — the decision behind it (#1162).** Two legitimate requirements
collide: a **completed** run carries a snapshot, which is what makes a `par_url`
a stable idempotent deep-link; an **`in_progress`** run is the only state in
which the review decision the narrative demonstrates can actually be taken.
Phase 7 completed BOTH runs on `hh-poverty-targeting/20260730-2210`, ~14 minutes
before the render, so the payoff scene had nothing to click — all 10 spec
actions degraded to `wait_for`/`hold`, 7 scenes produced 2 distinct images, arc
scored 1.0/5.

Resolved (Jon, 2026-08-14) as **option 1: leave only the interactive
dashboard's run live.** `source.dashboards[].role` already carries the signal,
so the producer needs no new plumbing, and the stability loss is confined to the
one dashboard whose entire point is that a stakeholder acts on it. Check 8 is
two-sided so the opposite sloppiness — every run left `in_progress`, silently
giving up snapshot stability on links a stakeholder keeps — fails too.

## Why check 9 derives its spec instead of accepting one (#1658)

`auditDataset` is only as good as the `DatasetSpec` handed to it, and the spec
used to be built by reading the PDD's prose. Under-declare one entry and the
gate reports a **measured** zero over a spec narrowed to exclude the finding —
#1346's failure mode displaced one level up, into the spec instead of the count.

Measured, same opp / same app / same generator:
`bednet-check-2-visit/20260817-1720` recorded check 9 `pass` justified as "no
counts, no currency, no conditional blocks", while
`get_opportunity_apps(2214, 'deliver')` returned
`"relevant": "/data/agree_again/consent_confirmed = 'yes'"` on both observation
fields verbatim. `20260825-1310` declared them honestly and measured **18 of
276** off-branch on each — the same 18 records. The difference between `pass`
and `fail` was the spec, not the data.

So the derivation is mechanical (`specFromDeliverApp`), and this check refuses
the two shapes that would restore the old behaviour: a clean audit with no
derivation behind it, and an `unparsed[]` expression treated as absence. The
second half of #1658 is why the auto-fix changed: the old hint demanded a
manifest-side constraint that connect-labs does not implement, so an honest run
on any gated form failed for a cause it could not remedy — and the only way to
green was to narrow the spec. The remedy is now the branch scrub, which is a
declared, reproducible, idempotent generator post-step.

## Why check 11 exists — one dataset, two totals, ten passing checks (#1683)

Checks 1–10 each inspect ONE dashboard: its URL, its payload, its bindings, its
run status, the dataset behind it. None of them can see a *disagreement*, because
a disagreement is not a property of any single dashboard — and a disagreement is
the one defect that makes a rendered page **misleading** rather than broken. A
broken page announces itself; a page that renders confidently and states
something untrue does not.

`hh-poverty-targeting/20260824-1404` built two dashboards over one synthetic
fixture (labs opp 10047) and they disagreed on 13 of 14 workers. From each page's
own `#workflow-data`:

```
run 5245 snapshot (period_end 2026-08-30) : total=2186 completed=1563 non_payable=623
run 5249 live                             : total=2237 completed=1592
fixture on Drive                          : total=2237 completed=1592 non_payable=645
run 5250 snapshot (period_end 2026-08-31) : total=2237 completed=1592 non_payable=645
```

Everything passed. Both runs reported their status cleanly, both pages rendered,
`fields_all_null` was empty, and this gate returned green — check 7 asks whether
bound fields are populated, not whether two dashboards over one dataset agree.
The only thing that noticed was the DDD **concept judge**, reading the numbers
off rendered frames and finding they contradicted the narrative's own figures
(the why-brief cites 1,592/645/2,237; the page rendered 1,563/623/2,186). That is
an expensive detector, and it fires only after a render.

The cause is a half-open window. `_date_window_where` in
`connect_labs/labs/analysis/backends/sql/query_builder.py` emits `visit_date >=
date_from AND visit_date < date_to` — correct for back-to-back weekly periods,
which is what its docstring justifies, and a trap for a whole-timeline window,
because the natural authoring move is to pass the manifest's own
`timeline.start_date` / `timeline.end_date`. Period scoping applies only on the
snapshot path (`get_snapshot_pipeline_data`, *"re-aggregated to that half-open
`[period_start, period_end)` visit-date window"*), so the live sibling keeps the
final day and the snapshot loses it. The producer-side fix is
`demo-data-setup` § Process step 3 (`period_end = timeline.end_date + 1 day`);
this check is the backstop that does not depend on anyone remembering it.

It is deliberately a check about AGREEMENT, not about any absolute number: it
needs no fixture, no manifest and no expected total — only two payloads claiming
to describe the same opportunity. And it is cheap: check 7 already fetched both.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-26 | **New check 11 `cross_dashboard_totals_agree` (ace#1683)** — the first check that compares dashboards to EACH OTHER rather than inspecting one at a time. Two dashboards over labs opp 10047 disagreed by 51 visits / 29 completed because the snapshotted run's `period_end` equalled the fixture's last `visit_date` and the bound is exclusive; all ten existing checks passed and only the DDD concept judge caught it, after the render. `checkCrossDashboardConsistency` + `deriveVisitTotal` in `checks.ts`, operating on the payloads check 7 already fetches. Excludes program-scoped rollups by construction and honours an explicit `period_scope: 'partial'` declaration, so an intended sub-window is declared rather than silently tolerated. | ACE team |
| 2026-08-26 | Check 7 made runnable against a real payload (ace#1701). It read `instance.snapshot.pipelines` as an array of `{alias, rows}` while labs writes a dict keyed by alias, so it threw `pipelines is not iterable` on every completed run — and the `snapshot-missing-pipelines` branch was unreachable besides. Two further defects found once it could execute: it flagged labs' built-in row columns (null by `terminal_stage`, not by a wrong path — 15 findings on a healthy run) and it demanded a snapshot from the `in_progress` interactive run that check 8 requires, so 7 and 8 could not both pass. Now: both snapshot shapes read, built-ins excluded, and a non-completed run judged from supplied live pipeline rows with a `live-pipelines-unavailable` finding when they are absent. | ACE team |
| 2026-08-26 | Check 9 promoted to an importable `checkDatasetObeysPddConstraints` in `checks.ts`: the spec is derived from the deliver app (hand-declared entries are ADDITIONS), an unparsed `relevant` / `constraint` is a reported finding rather than a silent pass, a clean audit with no derivation behind it fails, and the auto-fix hint points at `scrubOffBranchFields` instead of a manifest constraint that does not exist. ace#1658. | ACE team |
