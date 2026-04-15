# Test Results — Turmeric Market Survey (SYNTHETIC)

Produced by `app-test`. Pairs 1:1 with `test-plan.md`.

| ID | Test Case | Result | Notes |
|---|---|---|---|
| T-01 | Happy-path delivery | PASS | Submission accepted; verification rules pass |
| T-02 | Missing MTN card photo | PASS | Flagged at Layer B as expected |
| T-03 | GPS outside bounding box | PASS | Connect rejection observed |
| T-04 | Daily cap hit (per FLW) | PASS | Block observed at attempt #21 |
| T-05 | Daily cap hit (per market) | FAIL | See BUG-001 in `bugs.md` — market cap is enforced per-FLW rather than across all FLWs |
| T-06 | Education not delivered | PASS | Accepted; rate computable |
| T-07 | Learn App completion | PASS | Module unlock flow works |

**Overall:** 6 / 7 PASS, 1 FAIL (daily cap per market).

**Pre-deployment recommendation:** Fix BUG-001 before activating the
opportunity. The per-market cap is a delivery-integrity constraint, not
cosmetic — without it, multiple FLWs can oversaturate a single market
on day one.
