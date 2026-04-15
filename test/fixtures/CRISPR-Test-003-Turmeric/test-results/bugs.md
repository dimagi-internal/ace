# Bugs Found — Turmeric Market Survey (SYNTHETIC)

## BUG-001 — Per-market daily cap only enforced per-FLW
**Severity:** HIGH
**Test:** T-05
**Repro:**
1. FLW-A submits 5 deliveries for Market "Nyabugogo".
2. FLW-B submits a 6th delivery for the same market.
3. Connect accepts it.

**Expected:** Connect rejects FLW-B's 6th delivery for that market, since
the cumulative market total is 6 > 5.

**Actual:** Connect counts per-FLW only; total for the market is not
enforced.

**Root cause (probable):** The verification rule in the Deliver app
checks `count_today(flw_id, market_name)` rather than
`count_today(market_name)`.

**Fix direction:** update the verification rule expression in the
Deliver app's market-cap rule. Low-risk change; re-test T-05 after.

**Owner:** app-test (flagged); final fix belongs with the app author.

---

(No other bugs found in this synthetic run.)
