# UAT Results — Turmeric Market Survey (SYNTHETIC)

**Produced by:** `llo-uat` (Phase 5 Step 2)
**UAT window:** 2026-04-22 → 2026-04-28

## Per-LLO Sign-off

| LLO | Status | Date | Notes |
|---|---|---|---|
| ACE Test LLO 1 | SIGNED OFF | 2026-04-26 | Ran 8 test deliveries in a local market simulation. All 8 accepted by Connect. Asked one clarifying question via OCS widget ("what happens if GPS drifts") — bot answered correctly. |
| ACE Test LLO 2 | SIGNED OFF (with note) | 2026-04-27 | Flagged confusion about the distinction between `no origin known` and `origin_text empty` in the intake form. Suggested FAQ addition — incorporated into `faq.md`. |

## Issues found during UAT

1. **FAQ gap on origin fields** (from LLO 2). Resolved before go-live
   by updating `training-materials/faq.md`. Low severity.
2. **Cross-market cap (BUG-001)** — still outstanding from Phase 2
   testing. Required hotfix before launch. **Status: fixed prior to
   launch; verified in T-05 rerun.**

## Overall Verdict
PASS (with the pre-existing BUG-001 fix applied). Opportunity is ready
for `llo-launch`.
