# `test/calibration/` — cross-skill calibration corpus

Curated artifacts at known viability levels. When a rubric is migrated or expanded, run it against this corpus and verify scores fall in expected ranges. If they don't, the rubric is mis-calibrated.

This is **distinct from `test/fixtures/`**: fixtures are full opp-shaped scenarios used for per-skill integration testing. Calibration entries are **artifact-shaped** (just the PDD, just the app summary, etc.) and explicitly tagged with expected score ranges.

## Layout (planned)

```
test/calibration/
├── README.md
├── pdds/
│   ├── strong-pdd.md                  designed to score ≥9 in all evals
│   ├── viable-but-thin.md             designed to score 6-7 (structurally OK, viability questionable)
│   ├── structurally-bad.md            QA should fail outright
│   └── viability-broken.md            QA passes but eval scores ≤4 on viability dimensions
├── apps/
│   └── ...                            (Phase 2 calibration — TBD)
└── expected.yaml                      one entry per artifact: expected QA + per-eval score ranges
```

## Calibration entry format (`expected.yaml`)

```yaml
strong-pdd.md:
  applies_to: [idea-to-pdd-qa, idea-to-pdd-eval]
  qa:
    idea-to-pdd-qa: { verdict: pass }
  eval:
    idea-to-pdd-eval:
      overall_score: { min: 8.5, max: 10.0 }
      dimensions:
        demand_reality: { min: 8.0 }
        mission_alignment: { min: 8.0 }
  provenance: |
    Hand-crafted by ACE team 2026-05-08 to span all viability anchors at ≥9.
    Named consumer (LEEP) with explicit pre-committed action; budget realistic
    against South Asia minimum wage; primary metrics measure adulteration outcome.

viability-broken.md:
  applies_to: [idea-to-pdd-qa, idea-to-pdd-eval]
  qa:
    idea-to-pdd-qa: { verdict: pass }       # structurally fine
  eval:
    idea-to-pdd-eval:
      overall_score: { min: 4.0, max: 6.0 }
      dimensions:
        demand_reality: { max: 4.0 }         # specifically broken on this dimension
        resource_realism: { max: 5.0 }
  provenance: |
    Adapted from turmeric run 20260507-1733 — well-formed PDD with no named
    downstream consumer, $3/visit budget below recruitment floor, primary
    metrics measure process not outcome. Anchors the "viability axis" calibration
    target for idea-to-pdd-eval (post-PR-#145).
```

## Running calibration

```bash
npm run test:calibration                # planned — runs every entry against applicable rubrics
```

Each calibration test:

1. Loads the artifact text.
2. For each `applies_to:` rubric, runs the QA + eval skill against it.
3. Asserts QA verdict matches.
4. Asserts each dimension's score falls in `{min, max}` from `expected.yaml`.
5. Asserts overall score falls in range.

Mis-calibration shows up as a failed range assertion. The fix is either:
- Tighten the rubric's anchors (rubric is too lenient/strict on a dimension).
- Update the calibration entry's expected range (the artifact's intent shifted).
- Add a new dimension to the rubric (the artifact's defect doesn't map to any current dimension).

## Why corpus over fixtures

- **Fixtures are scenario-based** (`CRISPR-Test-001` represents a full atomic-visit opp; `CRISPR-Bad-001` represents one with a structural defect). They test integration of one skill in context.
- **Calibration is range-based** (every PDD in `pdds/` is a real PDD shape; the corpus spans good→thin→broken). It tests rubric discrimination across artifacts.

A rubric that scores every fixture identically passes integration tests but is mis-calibrated. A rubric that fails every fixture passes calibration tests on `structurally-bad.md` but is broken in integration. Both views are needed.

## Status

This directory is currently **empty**. The first entries will be added during Phase 1 of the QA/Eval migration (see `docs/superpowers/specs/2026-05-08-qa-eval-migration.md` § Test harness reorganization).

Initial corpus targets (PDD-shaped):
- 1 strong PDD (9-10 range)
- 1 viable-but-thin PDD (6-7 range)
- 1 structurally bad PDD (QA fails)
- 1 viability-broken PDD (QA passes, eval ≤6)

App, OCS, training corpus entries are added as those rubrics are migrated.
