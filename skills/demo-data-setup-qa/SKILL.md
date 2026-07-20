---
name: demo-data-setup-qa
description: >
  Structural QA on the demo-data-setup handoff (realized.json + the source
  block). Binary pass/fail. Catches a dead/blank dashboard BEFORE demo-narrative
  authors scenes against it. Static-only, no LLM.
disable-model-invocation: true
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
| 1 | `realized_json_parses` | static | `realized.json` exists and parses as a JSON object | re-run `demo-data-setup` step 5 — the handoff was never written |
| 2 | `par_url_is_run_deeplink` | static | `par_url` matches `^https://labs\.connect\.dimagi\.com/labs/workflow/\d+/run/\?run_id=[^&]+&opportunity_id=\d+$` (a saved-run deep-link, NOT the bare workflow URL) | rebuild `par_url` from the saved `run_id` — a bare workflow URL renders the picker (learning 2026-06-13) |
| 3 | `opp_is_labs_only` | static | `source.labs_synthetic_opp_id` is an integer **≥ 10000** | regenerate with a labs-only opp id ≥ 10000 — a real HQ-backed opp can't be driven by the generator |
| 4 | `timeline_pinned` | static | the manifest `timeline.start_date` is a fixed ISO Monday (not a relative/sliding expression) and equals the `par_url` opportunity's env anchor | set `--pin-monday` to a fixed Monday; a sliding window breaks idempotency |
| 5 | `flagged_worker_not_pre_seeded` | static | the current-week flagged worker has NO pre-seeded audit/task in the manifest (created on camera) | remove the flagged current-week worker's audit/task from the manifest |
| 6 | `deliver_units_present` | static | `source.deliver_units` is a non-empty array | re-capture `deliver_units` from the `synthetic_generate_from_manifest` response |

All checks are static (<100ms), no LLM. Binary verdict: any BLOCKER fail →
`fail`; else `pass`.

**Promotion note (Plan A):** these checks are defined here and evaluated at gate
time against `realized.json`. Once the live realized-map shape is pinned in the
joint test, promote them to an importable `checks.ts` + unit test (mirroring
`skills/synthetic-narrative-plan-qa/checks.ts`) for static CI enforcement.
