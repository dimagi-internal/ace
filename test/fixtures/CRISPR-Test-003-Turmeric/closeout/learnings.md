# Learnings — Turmeric Market Survey (SYNTHETIC)

**Produced by:** `learnings-summary` (Phase 6 Step 3)
**Source inputs:** `llo-feedback.md`, all data reviews, monitoring
reports, OCS transcripts.

## Process learnings
- **Per-market cap is too rigid for variable market sizes.** The 5/day
  cap was PDD-declared as a floor guarantee but LLOs found it limiting
  in large markets. Next iteration: derive cap from market-size
  estimate at onboarding.
- **MTN card supply chain was under-planned.** ~15 cards across 8 FLWs
  over 10 weeks is significantly more than the operating assumption.
  Add a card-durability line item to the pre-launch LLO checklist.

## Content learnings
- **Shininess as FLW-observed Layer A was the wrong call.** FLWs had
  low confidence; inter-FLW agreement on shininess rating was weak
  (from data review). Move to AI-assessed Layer B using the photo only.
- **The education message was delivered in 88% of visits** — exceeded
  the 85% target. FLWs adapted the script in the field; the adapted
  versions were generally equivalent in content.

## Technical learnings
- **BUG-001 (cross-market cap)** should have been caught during form
  design, not app-test. Next iteration: `pdd-to-deliver-app` should
  flag cross-entity constraints for explicit verification.
- **OCS widget answered 76% of FLW questions without escalation.**
  Remaining 24% were split between out-of-scope (lab confirmation)
  and geography-specific questions the golden RAG didn't cover.

## Relationship learnings
- **Both LLOs want to run a follow-up iteration.** ACE Test LLO 1
  suggested a larger-market version; ACE Test LLO 2 wants to try
  multi-commodity (turmeric + paprika).
