# Connect Opportunity — Turmeric Market Survey (SYNTHETIC)

**Opportunity ID:** OPP-TURMERIC-SYN-0001 (fake)
**Program:** PRG-TURMERIC-SYN-0001 (see `program.md`)
**Created:** 2026-04-16 (synthetic)
**Connect URL:** https://connect.dimagi.com/a/crispr-connect/opportunities/OPP-TURMERIC-SYN-0001/ (fake)

## Verification Rules (Layer A)
Derived from `pdd.md` Evidence Model + `deployment-summary.md`.

- `photo` field must be present and non-empty
- `gps` must be within configured bounding box
  (coords TBD — set by LLO at onboarding)
- All `required: true` fields on the Vendor Intake form must be
  populated
- Education interaction form must be submitted alongside the intake
  (paired submission)

## Delivery Units
| Unit | Payment amount | Count cap per FLW/day | Count cap per market/day |
|---|---|---|---|
| Verified vendor observation | $2.50 | 20 | 5 |

**Note:** Per-market cap has a known bug in the initial build — see
`test-results/bugs.md` BUG-001. Must be fixed before activation.

## Payment Units
| Currency | Total budget | Expected disbursements |
|---|---|---|
| USD | $5,000 (synthetic) | ~2,000 deliveries × $2.50 |

## Widget
The OCS chatbot widget is attached separately in Phase 4 (see
`ocs-setup/widget-handoff.md`). Operator pastes credentials into
this opportunity's widget configuration until `update_opportunity`
API support lands (CCC-301).
