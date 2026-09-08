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
| live labs | `pipeline_get` + `pipeline_preview` per authored pipeline | check 12: the DECLARED field list, and a fresh extraction to judge it against |
| live labs | `workflow_get` per authored workflow, scoped to its OWNING opp/program | check 10: the definition, plus the `pipeline_sources[].{name, schema_summary}` that says whether each declared id resolves in that scope (ace#1894) |
| `demo-data-setup` | `<demo-run>/7-synthetic/branch-scrub_report.yaml` | check 9: the spec derivation (incl. `unparsed[]`), the branch-scrub ledger, the post-scrub audit, and `declared_omissions[]` |
| `demo-narrative` | `<demo-run>/7-synthetic/<demo-slug>.yaml` | check 14: the authored scenes' `actions[]`, read for the framing of every judged still |
| `demo-data-setup` | `<demo-run>/7-synthetic/dashboard-terms.yaml` | check 15: the coined column/row labels each dashboard renders, and the definition affordance each one carries (written by the producer's step 3d) |

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

| 9 | `dataset_obeys_pdd_constraints` | static | Runs `checkDatasetObeysPddConstraints` (`checks.ts`) over three inputs the producer's step 2c writes: the **derivation** (`specFromDeliverApp(get_opportunity_apps(<opp>, 'deliver'))` — the spec is DERIVED from the app's own `relevant` / `constraint` expressions, and hand-declared currency / cross-field / `uniquePairs` entries are ADDITIONS merged with `mergeDatasetSpecs`, never a replacement), the **branch-scrub report** (`scrubOffBranchFields`), and `auditDataset` over the records as they now stand. Fails on: a clean audit with no derivation behind it and no stated reason; a deliver app that returned 0 questions; any `unparsed[]` gate or bound (an expression the derivation could not read is a gate this run did not audit — a reported finding, never a silent pass); a scrub field that could not be located; and any violation class. **The one escape is `declared_omissions[]`** (step 2c.4, `{field, reason}` per entry): a residual labs STRUCTURALLY cannot emit — a REPEAT-group roster the flat generator cannot produce, a `Trigger` read-aloud label CommCare submits no value for, an image with no labs `ImageConfig` corpus — is exempted from that field's `conditional-missing` violation AND its `unresolvedFields` entry, but from nothing else: an off-branch value, an integrality violation and an `unparsed[]` gate each name a value that IS present and wrong, and stay unexemptible. A blank `reason` exempts nothing and is named in the failure, exactly as check 13 refuses an unevidenced `below_programme_scale`; the exemptions are echoed into the detail string so they reach the run summary rather than vanishing into a green verdict. Without it the check was permanently red on `poverty-graduation/20260908-0510` — zero off-branch, zero integrality, empty `unparsed[]`, six structural residuals — and the only routes to green were narrowing the spec, which is what this check exists to prevent, or a `fail` nobody reads (ace#2225). | **Re-run the branch scrub — do NOT narrow the spec.** `scrubOffBranchFields(records, spec.conditionalFields)` from `lib/dataset-constraints.ts`, then write the scrubbed `user_visits.json` back to the opp's fixture folder before any dashboard run is minted, **then call `mcp__connect-labs__synthetic_reload_fixtures(<opp>)`** — the write-back alone changes nothing labs will read, because `synthetic_generate_from_manifest` primes the fixture cache itself and an in-place edit is invisible until that cache is dropped (ace#1860; measured on `spark-facilitator/20260828-0703`, where a correctly-scrubbed fixture still previewed pre-scrub numbers). Note this check judges the producer's LOCAL records, so a stale cache passes it — and checks 7 and 11 pass too, since both dashboards read the same stale cache and agree with each other. Carry the per-field counts into the run summary. There is **no manifest-side remedy on this path** — though not for the reason this row used to give. `BeneficiaryCohort.relevance_groups` **does** exist (`connect_labs/labs/synthetic/generator/fixtures/manifest.py:300`, shipped in `dimagi-internal/connect-labs#1331`, merged 2026-08-27), and it is **inert here**: relevance is applied only to questions present in the HQ `FormSchema` (per-question inside the schema loop, `fixtures/fields.py:417-422`), while the trailing orphan-write loop is gated by a set computed **once, before it runs** (`fields.py:484`). A labs-only opp has no Connect `app_structure`, so `parse_form_schema_from_app_json` returns `FormSchema(questions=[])`, every declared path is an orphan, and the controller is not in the record when line 484 evaluates the gate. Measured on `bednet-check-2-visit/20260828-0629`: `relevance_groups` was declared and 36 off-branch values were still emitted (#1833). Declare it anyway on a **schema-backed** opp, where it works — and scrub regardless. (`null_rate` is unconditional; `CorrelationSpec` cannot make a field absent on a branch, so neither substitutes.) For an `unparsed[]` entry, hand-declare that gate as an ADDITION and re-run. This gate exists because a run wrote "0 constraint violations, all hand-checked" into run_state for a set with 251 fractional people-counts, 242 fractional Kwacha amounts, 34 off-branch reasons and 22 did-not-happen meetings carrying 41 attendees — and THIS SKILL PASSED (#1346) — and because `bednet-check-2-visit/20260817-1720` then passed check 9 with `conditionalFields: []` on an app whose two observation fields are both gated on consent, which the next run of the same opp measured at 18 of 276 each (#1658). Report the per-class counts so "0" is measured |

| 10 | `dashboard_bindings_are_wired` | static | For each authored workflow, runs `checkDashboardBindings` (`lib/dashboard-bindings.ts`) over **the `workflow_get` response, passed through unchanged**: no pipeline schema still extracting `form.meta.*` (the stock template paths the synthetic generator never writes), `snapshot_inputs.pipelines` covering every alias in `pipeline_sources`, render code that actually READS a declared pipeline rather than a denormalized `worker.visit_count` the generator never back-fills, and — new, ace#1894 — **no declared pipeline id that fails to resolve in the workflow's own scope**, which `workflow_get` reports as `name: null` + `schema_summary.field_count: 0` beside that source. Still zero extra network calls: the resolution metadata rides along on the fetch the producer already made. Pass the raw response, not the stored `{alias: id}` dict — the dict carries no resolution metadata and the scope check silently abstains on it. | ADAPT means RE-POINT — re-point the new pipeline's schema at the same real form paths the scorecard pipeline already resolves, declare the snapshot aliases, and bind the render to the pipeline. Live: workflow 5069 hit the first three at once and rendered `VISITS 0` beside `visits: 835` on data that summed correctly (#1160). For the fourth: **do not `workflow_clone` a dashboard across opps** — pipelines are opportunity-scoped and the clone copies `pipeline_sources` verbatim without the pipelines, so the page renders empty with no error (#1894). Instantiate from template in this opp and re-point. Complements check 7, which catches the same class from the rendered payload; this one catches it from the DEFINITION, before a run is even minted |

| 11 | `cross_dashboard_totals_agree` | static | **Cross-dashboard consistency.** Using the payloads check 7 already fetched: when two or more dashboards read the same `labs_opp_id`, their shared visit total must AGREE. `deriveVisitTotal` takes `sum(total_visits)` from an aggregated pipeline's rows, else the row count of a visit-level pipeline. Program-scoped rollups are excluded (a cross-opp rollup aggregates a different population); a dashboard that deliberately renders a sub-window declares `period_scope: 'partial'` in `source.dashboards[]` and is excluded by name; a dashboard with no visit-shaped rows is reported not-judged, never failed. Pass the manifest's `timeline.end_date` as `opts.timelineEndDate` and a disagreeing dashboard whose `period_end` is at or before it gets the off-by-one named. Importable: `checkCrossDashboardConsistency` in `checks.ts`. | **`period_end` is EXCLUSIVE.** Re-mint the snapshotted run with `period_end = timeline.end_date + 1 day` and repoint its `par_url`. `_date_window_where` (`connect_labs/labs/analysis/backends/sql/query_builder.py`) emits `visit_date >= date_from AND visit_date < date_to`, so a `period_end` equal to the fixture's last `visit_date` drops that whole day — while a live, never-snapshotted sibling is never period-scoped and keeps it. If the two dashboards are MEANT to show different windows, declare `period_scope: 'partial'` on the narrower one rather than tolerating the gap silently |


| 12 | `authored_pipeline_fields_extract` | static | **Every field an authored pipeline DECLARES actually extracts something, judged from a FRESH preview.** For each pipeline the run authored (read the schema with `pipeline_get`, not the columns that came back), call `mcp__connect-labs__synthetic_reload_fixtures(<labs_opp_id>)` once, then `mcp__connect-labs__pipeline_preview(pipeline_id, opportunity_id, sample_size >= 10)`, and pass `{pipeline_id, declared: schema.fields, rows, from_cache: per_opp_metadata[<opp>].from_cache, fields_all_null}` to `checkPipelineFieldsExtract` (`lib/pipeline-field-extraction.ts`). Fails on: a preview served `from_cache: true` (warm rows are not evidence about the saved schema); a declared field no returned row carries; and a declared field that is null/zero for EVERY row with no `filter_path` to explain it. An all-zero **filtered** count is reported, not failed — a filter may legitimately match nothing. Zero-for-SOME-rows is data and is never flagged. The preview's own `fields_all_null` is folded in so this can never fall below labs' detector. | Re-point the named field at a path the fixture actually writes, `synthetic_reload_fixtures`, re-`pipeline_update_schema`, and re-preview until `from_cache: false` AND the column is non-dead on at least one row. **Do not delete the field to clear the check** — the render binds it, so a removed column is the same dead demo |
| 13 | `declared_detection_has_a_cohort` | static | **A demo that DECLARES a detection control must have realized a cohort that makes detection non-trivial.** Runs `checkDetectionCohortFloor` (`lib/ddd-scene-actions.ts`) over the producer's own `source` block: fails when `source.detectable_signal` names a control (step 1c's required authoring output) and `source.data_shape.rows` is below `DETECTION_MIN_ROWS` (24). Silent when no signal is declared, when `detectable_signal.below_programme_scale` carries a PDD quote proving the programme's own roster is under the floor (raising the cohort would misrepresent it, and stripping the signal would make the dashboards less honest — an unevidenced flag is rejected), when the documented `none` escape is recorded ("the PDD declares no verification rules"), or when `rows` is unstated — it never guesses. Zero network calls; both fields are written by step 1c/2b before this gate runs. | **Raise the cohort in the MANIFEST and regenerate** — no narration fixes it, because a detection claims unaided scanning is not viable and that is false the moment the whole cohort fits in one look. If the demo is not really about detection, drop `detectable_signal` or record the `none` escape. Complements `checkSceneCardinality`'s vocabulary rule, which catches the opposite half (a narrative CLAIMING detection the data never declared) — that rule is keyed on words like `flag`/`outlier`/`detect`, so a detection demo written in plain descriptive prose evades it entirely: on `bednet-check-2-visit/20260902-1555` the spec carried ZERO detection tokens over a 5-row cohort, the vocabulary rule found nothing, and Phase 7 ended `stopped_not_converged` at concept 2.0/5 on exactly that objection, raised independently by all five per-scene judges (ace#2131) |
| 14 | `scroll_framing_is_anchored` | static | **Every judged frame is framed by something the PAGE owns, not by a pixel guess.** Runs `checkScrollFraming` (`lib/demo-frame-legibility.ts`) over the authored spec's `scenes[]`. A `kind: scroll` is judged only when a still is actually written at the position it set — a `hold` or `snapshot` follows it, or it ends the scene (the scene's end frame is the canonical still); a scroll the spec navigates away from before any capture is transient and is not judged. **Fails** on a raw pixel `value`. `top` / `bottom` are REPORTED, not failed — they name a landmark the page defines and survive a layout change, but they decide only one edge of the frame. Runs only once `demo-narrative` has written the spec; before that this row is not-yet-judged, and `demo-narrative` § Step 3b runs the same function inline at authoring time. This row is the backstop that does not depend on anyone remembering. **A pass here is not automatically a verdict — read `judged` before you report it.** The check reads pixel scrolls only, so a spec that frames every still with `scroll_to` gives `judged: 0`: it evaluated nothing. That is a legitimate and expected state — `scroll_to` is this row's own remedy — but it is not an approval of how those frames are composed, and it must not be written up as one. When it happens the check now says so itself, with a non-blocking `scroll-to-framing-unjudged` finding naming how many actions it declined to look at (ace#2253). Record it as *passed over N unjudged `scroll_to` frames*, never as *passed*. | Replace the pixel scroll with a `scroll_to` action naming the element the frame is about — canopy resolves and centres it live, so it holds at any page length. **Write only `kind` and `target` on it.** There is no framing key to add: `_ActionBase` sets `extra="forbid"`, which is why the ace#1660 check that demanded one was retracted, and why today's judge remedy ("offset so no partial histogram sits above it") breaks the spec if followed literally. If the header block and the whole table cannot co-exist in one frame, split the beat into two scenes rather than compromising both |
| 15 | `coined_terms_are_defined_on_page` | static | **A term a lay viewer cannot read carries an on-page definition they can reach FROM the term.** **Enumerate every coined term a viewer MEETS on a frame, not only column headers** — KPI subtitles, panel body prose and the explainer panel itself all render into judged frames. On `spark-facilitator/20260907-1120` this check passed both dashboards (13 and 11 labels judged, 0 findings) while the user judge capped `clarity` at 2 on "a repeated entity key", cited independently by six of seven judges — body prose inside the *How to read the columns* panel, i.e. inside the very surface whose job is to remove jargon. An under-enumerated list passes vacuously; the enumeration is the check. Runs `checkCoinedTerms(dashboardTerms, definedTerms)` (`lib/demo-frame-legibility.ts`) over the two lists the producer's step 3d enumerates off the render code it uploaded. Fails on a coined label with no definition anywhere, and on one whose only definition sits in a glossary panel elsewhere on the page (`at_point_of_use` not `true`) while the label renders on a hero surface. An orphan definition matching no label is reported. An EMPTY enumeration is reported, never a silent pass — this check cannot tell a plain-language dashboard from an un-enumerated one, and only one of those is a pass. Deliberately keyed on the ARTIFACT, not on a jargon word list: a vocabulary rule is what ace#1841 pruned for precision and ace#2131 then evaded. | Put the gloss at the point of use — an info affordance on the column header carrying that column's one-line plain read, or a plain-language lead line with the statistics demoted behind it. **Adding another panel is not the fix**, measured: iteration 2 of `poverty-graduation/20260905-1345` added a "What each column means" panel, the judge recorded it VERIFIED PRESENT and correct, and the jargon cap fired on six of seven scenes anyway because the panel is below the fold of every frame that uses the vocabulary. Renaming the label so it needs no gloss is better still where it is available — "Surveys in the 31-point band" → "Small-household surveys (≤3 members)" deletes both the term and the disavowal sentence the glossary had to carry |
| 16 | `rendered_columns_obey_declared_invariants` | static | **Every number a viewer can compare on the page can be true at the same time.** Runs `checkColumnInvariants` (`lib/dashboard-column-invariants.ts`) over each dashboard's declared `column_invariants` and the LIVE `pipeline_preview` rows for its pipeline — the same payload check 12 fetches, judged for RELATIONS rather than extraction. **Fails** on any row breaking a declared relation. Also **fails**, deliberately, when an invariant names a column the payload does not carry, when there are no rows to judge, or when a compared column is null: an invariant that silently does not run reads as a pass it never earned, which is exactly ace#2253. A dashboard that declares NOTHING while rendering two or more comparable numeric columns is REPORTED, not failed — the same posture check 15 takes for `no-terms-enumerated`. This is a different tier from check 9: check 9 derives its spec from the Deliver app and judges RECORDS, and no record was wrong on the run that motivated this (ace#2250) — the contradiction lived between two aggregates, which a form-derived spec cannot express. | Fix the pipeline SCHEMA, not the data. The canonical cause is an aggregation counting RECORDS where the column header promises a count of THINGS — a `count` beside a sibling `count_distinct`, both rendered as the same noun. Re-run `pipeline_update_schema` → `synthetic_reload_fixtures` → `pipeline_preview` and re-judge. If the relation itself was wrong, restate it with the header's own words in `because` |
| 17 | `scenes_show_more_than_one_thing` | static | **The deck shows the viewer more than one thing.** Runs `checkSceneVariety` (`lib/demo-scene-variety.ts`) over the authored spec's `scenes[]`, resolving each scene's surface by carrying the last declared `url` forward. **Fails** when more than half the scenes are one surface, and when a scene follows the previous one on the same surface with no state-changing action — the two deduction rules the arc judge applies literally, each of which caps a dimension at 2 and so holds the whole run at its floor. Judged from the spec alone, before any render. Blocking rather than reported BECAUSE the loop cannot repair it: collapsing or reordering scenes is a narrative change behind canopy's `concept_change` gate, so an unattended run stops instead (`spark-facilitator/20260907-1120`, arc 2 of 5, `stopped_not_converged`). Same relationship to `demo-narrative` § Step 3b as check 14 — the backstop that does not depend on anyone remembering. | Fold the offending beat into the scene before it, or give the scene an action that changes what the page shows — a filter, a selection, a drill-in. For a surface monopoly, give the deck another surface or merge the beats that share one into fewer, denser scenes. Splitting one page across four scenes buys narration, not pictures |

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

## Why check 12 exists — the payoff dies on the NEXT render (#1864)

Check 7 asks whether a rendered dashboard's bound fields carry values. Check 12
asks whether an authored pipeline's DECLARED fields extract. Those sound like
the same question and are not, in three ways that all bit at once on
`spark-facilitator/20260828-0703`.

ACE authored pipeline 5414 with
`{"name": "records", "path": "form.meeting_date.date_of_meeting", "aggregation":
"count"}` on a fixture that carried no such path. An unmatched path is not an
error in labs — it aggregates to `0`. `records` came back `0` for all 12
facilitators, so `verifiedPct = pct(community, records)` rendered `—` on every
row, `judged = records >= MIN_RECORDS` was false everywhere, and the below-floor
filter matched **0 of 12**. The demo's entire payoff — narrow to the three under
the floor, record a decision on one — was dead. `avg_attendance` and
`avg_participation_pct` were null the same way.

Everything passed: this gate 12/12, `recipe_preflight` (targets resolved; it
does not read values), and all six visual judges. The only reason anyone found
out is that preflight happened to re-run on a cold cache 40 minutes later and
the `wait_for text:Showing 3 of 12 facilitators` failed.

Three reasons no existing surface could see it:

1. **labs' own `fields_all_null` is NULL-only.** Verified live 2026-09-06,
   pipeline 5411 / opp 10054, `schema_override` pointing three fields at
   `form.no_such_group.no_such_field`:

   ```
   rows            : records_bad_count 0, steps_bad_distinct 0, avg_bad null
   fields_all_null : ["avg_bad"]
   ```

   `count` and `count_distinct` of nothing are `0`, not `null`. The upstream
   detector misses exactly the field TYPE that gates a filter. Check 12 counts
   zero as dead, which is the single line of judgement the whole issue turns on.

2. **Check 7 enumerates from the RETURNED ROW COLUMNS** (`Object.keys(row)`), so
   a declared field the engine never emitted at all is invisible to it. Check 12
   enumerates from `pipeline_get(...).schema.fields`.

3. **Check 7 reads a completed run's FROZEN SNAPSHOT.** A snapshot minted while
   the values were good keeps rendering them after the binding rots — which is
   the defect's title in one line. Live today: pipeline **5411** still declares
   `records` on the broken `form.meeting_date.date_of_meeting`, and its dashboard
   still renders, because it renders a snapshot. Check 12 previews every
   pipeline the run authored, snapshot or not.

The `from_cache` refusal is the fourth: #1864's first render read a warm cache
and looked perfect. Rows that were not computed against the schema now saved are
not evidence about it, and `synthetic_reload_fixtures` (ace#1860) makes a fresh
one one call away — so a cached preview fails rather than passing.

## Why checks 14 and 15 exist — thirteen checks about DATA, none about READING (ace#2219)

Checks 1–13 are all about whether the numbers are right: bindings, pipelines,
extraction, totals, constraints, cohort size. Not one of them asks whether a
viewer can read those numbers off the frame the render produces. That is not a
gap in any individual check — it is a whole missing tier, and it is the tier
that has now produced five Phase 7 runs at concept **2.0/5**.

The first three (**ace#1841**) were fixed by adding a DETECTION verb to
`checkSceneCardinality`, keyed on the narrative's **vocabulary**. The fourth
(**ace#2131**) evaded that by being written in plain descriptive prose, and was
fixed by `checkDetectionCohortFloor`, keyed on a **declared field**. The fifth,
`poverty-graduation/20260905-1345`, came from a third and unrelated cause that
neither rule can see, because it is not about the data at all:

> The narration is strong throughout; **the frames under-carry it.**

`verdict-user.yaml` returned `projector_test: false` and
`five_second_read_correct: false` on **7 of 7** scenes. Two mechanisms, both
decidable before a single frame is recorded.

**Framing (check 14).** The spec used `kind: scroll` five times — `'400'`,
`'1280'`, `'bottom'`, `'320'`, `'top'` — and `scroll_to` once. Three of the five
are raw pixel guesses about how a page the spec does not own renders at a
viewport it does not control. Scene 5's landed a twelve-row table one row short:
row twelve, Umar Bello, *"sliced through its middle at the bottom edge with its
badge truncated mid-word"* — which, in the judge's words, *"spoils scene 6
without being readable"* — while the same scroll *"puts the title, the
simulated-data disclosure and all four KPI cards off the top"*. Scene 4's
`bottom` *"guillotines the two modal histogram bars (627 and 487) at the frame's
top edge — value labels gone, the two bars rendering at identical heights when
they differ by 140 households"*, while the panel the scene was actually about
sat fully framed below.

This is CLAUDE.md's *"don't guess at what another system owns"*, in the one place
nothing was checking for it. `scroll_to` names an element and lets canopy's
recorder find and centre it; a pixel offset is correct for one row count and one
font stack and reports nothing when it stops being correct.

**This is NOT the retracted ace#1660 check, and it adds no `offset`.** That
check flagged `scroll_to` for LACKING an offset and told authors to write
`offset: 96`, which `_ActionBase`'s `extra="forbid"` REFUSES — following it
turned a passing spec into one canopy rejects. Check 14 inverts it: `scroll_to`
is the remedy, taken exactly as canopy declares it (`kind` + `target`, nothing
else), and what gets flagged is the other action. Worth stating because today's
judge remedy reads *"offset so no partial histogram sits above it"* — literally
the retracted syntax. `test/lib/demo-frame-legibility.test.ts` pins every
remediation string against canopy's own action fields so the class cannot come
back a third time.

**Jargon (check 15).** The `'jargon visible to non-technical users, max 2'` hard
cap fired **independently on six of the seven scenes** — `31-point band`,
`10-point band`, `Surveys in the 31-point band`, `Mean likelihood below the
line`, `Payable` / `Non-payable`, *"coined terms defined nowhere on the page"* —
and *"one percentage column silently switches denominator at row 5"*. The
five-second read of scene 2 came out as *"steady ~460 submissions a week"*
rather than the point of the scene, because *"the grey series carries no number
and reads as chart padding"*.

The second iteration is the measurement that matters. A *"What each column
means"* panel was added; the judge recorded it **VERIFIED PRESENT** and correct,
defining all seven review-table columns; and the cap fired on six of seven
scenes **anyway**, because *"the panel is BELOW THE FOLD of every frame that
uses the vocabulary"*. So check 15 does not ask whether a definition exists on
the page — it asks whether a reader of the LABEL can reach it from the label.
In the judge's own words:

> Expanding an acronym is not the same as glossing it, and moving a definition
> on-screen is not the same as moving it to the point of use.

Both checks take DATA and decide from the artifact. Neither is keyed on a word
list, deliberately: ace#1841 pruned that list FOR precision and ace#2131 evaded
it anyway, so a third vocabulary rule would be the third instance of the same
mistake.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-08 | **Check 9 gains the evidenced `declared_omissions[]` escape (ace#2225).** It had none, so a dataset whose only residual violations were fields labs STRUCTURALLY cannot simulate could never pass — the only routes to green were to narrow the spec (the behaviour ace#1346 / ace#1658 built the check to prevent) or to accept a permanent `fail`, and a permanently-red check is one nobody reads (ace#1744). Measured on `poverty-graduation/20260908-0510`: zero off-branch, zero integrality, empty `unparsed[]`, and six `conditional-missing` residuals that were a REPEAT-group roster, two `Trigger` read-aloud labels, and an image with no labs `ImageConfig` corpus. It takes check 13's shape — evidenced, refused when unevidenced, reported rather than silent — and covers BOTH halves the run tripped, the audit violation and the scrub's `unresolvedFields`; exempting only the first would have left it just as red. Off-branch, integrality and `unparsed[]` stay unexemptible. New producer step 2c.4 writes the list. | ACE team |
| 2026-09-08 | **New check 17 `scenes_show_more_than_one_thing` — the SEQUENCE tier.** Every other check in this skill judges ONE artifact; the arc judge is the only lens in the DDD loop that sees the scenes as a sequence, and it is where `spark-facilitator/20260907-1120` lost two of its three caps. 4 of 7 scenes were the payment ledger at four scroll offsets (`visual_variety` capped at 2, *"more than half the scenes are the same surface"*) and scenes 2, 3 and 4 each followed the previous with nothing but a scroll (`escalation` capped at 2, *"only a scroll between them"*). Both rules are decidable from the scene table before a frame is recorded — and the loop cannot fix either, because collapsing scenes is behind the `concept_change` gate, so the unattended run reported them and terminated `stopped_not_converged`. `checkSceneVariety` + `test/lib/demo-scene-variety.test.ts`, whose fixture is that run's scene table verbatim. | ACE team |
| 2026-09-08 | **New check 16 `rendered_columns_obey_declared_invariants` — the ARITHMETIC tier (ace#2250).** `spark-facilitator/20260907-1120` rendered *Steps closed out* above *Steps covered* on 6 of 12 rows, four of them above the seven-step ceiling the adjacent column header itself declares — while check 9 reported `0 unexempted violations` throughout. Check 9 was not wrong: no RECORD violated anything. The cause was one word in the pipeline schema — `steps_covered` used `count_distinct` over the step path and `steps_completed` used `count` over the completion flag, so three meetings closing one step contributed three — and the relation between two aggregates is not expressible in a spec derived from a form. The user-artifact judge capped `trust` at 2 on it, which alone held the run at 2.0. `checkColumnInvariants` + `test/lib/dashboard-column-invariants.test.ts`, whose fixture is the run's own live pipeline payload. `demo-data-setup` now declares `column_invariants` per dashboard and judges them at authoring time; this check is the backstop that does not depend on anyone remembering. | ACE team |
| 2026-09-08 | **Check 14 now says when it judged nothing (ace#2253).** `checkScrollFraming` reads `kind: scroll` only, so on a spec whose framing is all `scroll_to` it returned `pass: true, judged: 0, findings: []` — and on `spark-facilitator/20260907-1120` that was reported to the operator as "check 14 passed". It had approved nothing: three of those five `scroll_to` actions had silently failed to move the page (it CENTRES, and a centred position outside the page's scroll range clamps back to where the camera already was), the render replaced them with pixel scrolls, and once the spec of record was reconciled to what was actually rendered the same check returned two blocking findings. A non-blocking `scroll-to-framing-unjudged` finding now fires when `judged` is zero AND the spec has `scroll_to` actions framing judged stills — precisely the misleading case, and not on a mixed spec (which did evaluate something) or a spec that frames nothing by scrolling (which declined nothing). Judging `scroll_to` itself is the other half of ace#2253 and is NOT done here: whether a centred target is reachable depends on live page geometry, which a static check over the spec cannot see. | ACE team |
| 2026-09-07 | **New checks 14 `scroll_framing_is_anchored` + 15 `coined_terms_are_defined_on_page` — the LEGIBILITY tier (ace#2219, successor to ace#1841 and ace#2131).** The thirteen checks above are all about DATA; none asks whether a rendered frame can be READ, and that is where the fifth Phase 7 run at concept 2.0/5 came from. `poverty-graduation/20260905-1345` returned `projector_test: false` and `five_second_read_correct: false` on 7 of 7 scenes with the judge's headline "the frames under-carry it" — three raw pixel scrolls slicing a row in half and pushing four KPI cards off the top, and a jargon hard cap firing on six of seven scenes over coined column labels whose glossary panel sat below the fold. `checkScrollFraming` + `checkCoinedTerms` in `lib/demo-frame-legibility.ts` (+ `test/lib/demo-frame-legibility.test.ts`, whose fixtures are the run's own spec values and the judges' own quoted terms). Both read the ARTIFACT, not narrative vocabulary — the two prior fixes were each keyed narrowly and each evaded by the next run. Neither re-adds the retracted ace#1660 check and neither writes `offset`, which is pinned by a test. | ACE team |
| 2026-09-07 | **New check 13 `declared_detection_has_a_cohort` (ace#2131)** — the detection floor was enforced only through `checkSceneCardinality`, which reads the NARRATIVE's vocabulary, so a textbook outlier-detection demo written in plain descriptive language matched nothing. `bednet-check-2-visit/20260902-1555` carried zero detection tokens across its whole spec over a 5-worker cohort; the only cardinality finding was on the unrelated comparison/groups axis, and Phase 7 ended `stopped_not_converged` at 2.0/5 on the very objection the floor exists to pre-empt. Broadening the vocabulary was rejected — ace#1841 pruned that list FOR precision, and a report-only check that cries wolf is how real misses get waved through (ace#1744). The fact was already stated one layer up, without inference: `source.detectable_signal` and `source.data_shape.rows` are written by the same skill into the same block, before `demo-narrative` runs and long before anything renders. `checkDetectionCohortFloor` compares them. | ACE team |
| 2026-09-06 | **New check 12 `authored_pipeline_fields_extract` (ace#1864)** — the first check that judges an authored pipeline's DECLARED field list against a FRESH extraction, rather than a rendered payload's returned columns. Pipeline 5414 declared `records` on a path the fixture never wrote; `count` of nothing is `0`, so labs' null-only `fields_all_null` stayed silent, check 7 saw a warm-cached good snapshot, and the demo's below-floor filter matched 0 of 12 with every gate green. `checkPipelineFieldsExtract` in `lib/pipeline-field-extraction.ts` (+ `test/lib/pipeline-field-extraction.test.ts`), fed by one `pipeline_preview` per authored pipeline. Counts zero as dead, enumerates from the declaration, refuses a `from_cache: true` preview, and folds in `fields_all_null` so it can never fall below the upstream detector. | ACE team |
| 2026-08-26 | **New check 11 `cross_dashboard_totals_agree` (ace#1683)** — the first check that compares dashboards to EACH OTHER rather than inspecting one at a time. Two dashboards over labs opp 10047 disagreed by 51 visits / 29 completed because the snapshotted run's `period_end` equalled the fixture's last `visit_date` and the bound is exclusive; all ten existing checks passed and only the DDD concept judge caught it, after the render. `checkCrossDashboardConsistency` + `deriveVisitTotal` in `checks.ts`, operating on the payloads check 7 already fetches. Excludes program-scoped rollups by construction and honours an explicit `period_scope: 'partial'` declaration, so an intended sub-window is declared rather than silently tolerated. | ACE team |
| 2026-08-26 | Check 7 made runnable against a real payload (ace#1701). It read `instance.snapshot.pipelines` as an array of `{alias, rows}` while labs writes a dict keyed by alias, so it threw `pipelines is not iterable` on every completed run — and the `snapshot-missing-pipelines` branch was unreachable besides. Two further defects found once it could execute: it flagged labs' built-in row columns (null by `terminal_stage`, not by a wrong path — 15 findings on a healthy run) and it demanded a snapshot from the `in_progress` interactive run that check 8 requires, so 7 and 8 could not both pass. Now: both snapshot shapes read, built-ins excluded, and a non-completed run judged from supplied live pipeline rows with a `live-pipelines-unavailable` finding when they are absent. | ACE team |
| 2026-08-26 | Check 9 promoted to an importable `checkDatasetObeysPddConstraints` in `checks.ts`: the spec is derived from the deliver app (hand-declared entries are ADDITIONS), an unparsed `relevant` / `constraint` is a reported finding rather than a silent pass, a clean audit with no derivation behind it fails, and the auto-fix hint points at `scrubOffBranchFields` instead of a manifest constraint that does not exist. ace#1658. | ACE team |
