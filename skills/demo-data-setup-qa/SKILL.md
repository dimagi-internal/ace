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
| `demo-data-setup` | `<demo-run>/7-synthetic/demo-data-setup_manifest.yaml` | timeline pin + flagged-worker check |

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
| 7 | `par_url_payload_is_populated` | static | **Fetches each `par_url` with the labs session**, parses the embedded `#workflow-data` script, and fails when (a) `definition.pipeline_sources` is non-empty while `instance.snapshot.pipelines` is empty, or (b) any bound field is null/zero for EVERY row. Judgement is pure — `checkParUrlPayloadPopulated` in `checks.ts` takes the parsed payload, so only the fetch is the skill's job. | re-point the pipeline schema at the REAL form paths the generator writes (not the stock template's `form.meta.*`), and declare `snapshot_inputs.pipelines` for every alias in `pipeline_sources` before completing the run (#1160). A field zero for SOME rows is data, not a dead binding, and is not flagged |

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

**Not covered here, on purpose:** whether a `review-action` dashboard's run
should be `completed` at render time. Completing a run is how a `par_url`
becomes a stable idempotent deep-link, and it is also what makes the review
decision the narrative demonstrates unperformable ("Decisions are read-only").
That collision is a product-taste call tracked in **#1162** — once it is
decided, express it as an eighth check here rather than leaving it to prose.
