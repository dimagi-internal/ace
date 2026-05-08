---
archetype: atomic-visit
opportunity: pdd-qa-pass-fixture
---

# Program Design Document — QA Pass Fixture

## Archetype

**atomic-visit.** Synthetic minimal PDD designed to pass all 6 idea-to-pdd-qa structural checks. Used by `test/skills/idea-to-pdd-qa/integration.test.ts` as the canonical "pass" fixture. Intentionally thin on prose — this fixture exists for QA testing, not eval grading. Real PDDs are richer.

## Problem Statement

A synthetic problem for fixture testing. There is no real-world program here.

## Intervention Design

A synthetic intervention. Single-stage atomic visit per beneficiary; one structured form submission per visit.

## Learn App Specification

The Learn app trains FLWs on the synthetic intervention protocol.

## Deliver App Specification

| # | Field | Type | Required |
|---|---|---|---|
| 1 | beneficiary_id | text | yes |
| 2 | photo | photo | yes |

## Target Population

- **Beneficiary criteria:** synthetic.
- **Geographic scope:** synthetic.
- **Expected reach:** ~10 visits.

## FLW Requirements

- **Number of FLWs:** 2
- **Skills:** smartphone-literate

## LLO Preference

None pre-named — fixture only.

## Success Metrics

| Metric | Target | Method | Layer |
|---|---|---|---|
| Visits completed | ≥ 10 | Form submissions | A |
| Photo pass rate | ≥ 90% | AI photo check | B |

## Evidence Model

| Layer | Purpose | Captured by | Verified by |
|---|---|---|---|
| **A — Delivery proof** | Visit happened | Form submit | Field check |
| **B — Content proof** | Form is correct | Photo + fields | AI photo classifier |
| **C — Cross-delivery** | Aggregate quality | All submissions | Analyst review |

## Reviewer Comments — Disposition

| # | Comment | Disposition |
|---|---|---|
| [a] | Synthetic reviewer comment | Addressed in § Intervention Design |

## Timeline

- **Total:** 2 weeks.

## Stress Test Results

| # | Check | Grade |
|---|---|---|
| 1 | Executability | pass |
| 2 | Verifiability | pass |
| 3 | Measurability | pass |
| 4 | Stage-gate clarity | pass |
| 5 | Resource realism | pass |

**Score: 5/5 pass.**
