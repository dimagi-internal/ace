# OCS Chatbot Config — Turmeric Market Survey (SYNTHETIC)

**Produced by:** `ocs-agent-setup` (Phase 4)
**Cloned from:** OCS golden template (`OCS_GOLDEN_TEMPLATE_ID` env)

## Identifiers (all SYNTHETIC — do not use against real OCS)

| Field | Value |
|---|---|
| `experiment_id` | exp-turmeric-syn-0001 |
| `public_id` | pub-turmeric-syn-0001 |
| `embed_key` | emb-turmeric-syn-0001 |
| `collection_id` | col-turmeric-syn-0001 |
| `pipeline_id` | pipe-turmeric-syn-0001 |
| `version_number` | 1 |

## System Prompt Patch
Opp-specific framing added on top of the golden-template system prompt:
- Archetype: atomic-visit (photo + GPS + form)
- Decline lab-confirmation questions; point FLWs to education framing
- Daily caps: 20/FLW, 5/market
- Opp-specific fields: `shininess`, `vendor_response`

## RAG Collection Contents
- `pdd.md`
- `training-materials/*` (all four)
- `app-summaries/*` (learn + deliver)
- `deployment-summary.md`

## QA Gate Status
- `--quick` smoke: PASS (score 9/10, synthetic)
- `--deep` pre-launch: PASS (score 8.6/10, synthetic) — report at
  `qa-reports/2026-04-16-ocs-qa.md`
