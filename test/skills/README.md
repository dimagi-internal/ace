# `test/skills/` — per-skill QA + Eval tests

Contains tests for individual ACE skills, organized one directory per skill.

## Convention

```
test/skills/
├── README.md                      (this file)
├── <skill-name>/                  one directory per skill being tested
│   ├── checks.test.ts             unit tests for static QA check functions
│   ├── integration.test.ts        run the skill (or its checks) against fixtures
│   ├── snapshot.test.ts           verdict / QA result schema-drift detection
│   └── README.md                  per-skill notes (what the fixtures cover, etc.)
└── nova-contracts.test.ts         (legacy — pre-dating this convention; will move)
```

## Running

```bash
npm test                              # all vitest
npm run test:skills                   # only test/skills/ subtree
npm run test:skills -- <skill-name>   # specific skill (vitest filename match)
```

## Patterns

### Static QA checks

Each `*-qa` skill defines its static checks as importable TS functions in `skills/<producer>-qa/checks.ts`. Per-skill `checks.test.ts` calls those functions directly with fixture content — no LLM, fast (<1s per file).

```typescript
import { checkAllSectionsPresent } from '../../../skills/idea-to-pdd-qa/checks';
import { loadFixtureText } from '../../lib/fixture-loader';

test('CRISPR-Test-001 PDD has all required sections', () => {
  const pdd = loadFixtureText('CRISPR-Test-001', 'pdd.md');
  expect(checkAllSectionsPresent(pdd).pass).toBe(true);
});

test('CRISPR-Bad-001 PDD missing § Target Population', () => {
  const pdd = loadFixtureText('CRISPR-Bad-001', 'pdd.md');
  const result = checkAllSectionsPresent(pdd);
  expect(result.pass).toBe(false);
  expect(result.detail).toContain('Target Population');
  expect(result.auto_fix_hint).toBeTruthy();
});
```

### Integration: aggregate QA results

`test/lib/qa-runner.ts` runs all of a skill's checks against an artifact and produces a `QAResult` matching the canonical schema. This validates the full output shape, not just individual checks.

```typescript
import { runChecks } from '../../lib/qa-runner';
import { CHECKS } from '../../../skills/idea-to-pdd-qa/checks';
import { expectQAPass, expectQAFailWithCheck } from '../../lib/qa-asserts';

test('CRISPR-Test-001 passes idea-to-pdd-qa end-to-end', async () => {
  const result = await runChecks({
    skill: 'idea-to-pdd-qa',
    target: 'CRISPR-Test-001',
    capture_path: '1-design/idea-to-pdd.md',
    artifact: loadFixtureText('CRISPR-Test-001', 'pdd.md'),
    checks: CHECKS,
  });
  expectQAPass(result);
});

test('CRISPR-Bad-001 fails on missing section', async () => {
  const result = await runChecks({
    skill: 'idea-to-pdd-qa',
    target: 'CRISPR-Bad-001',
    capture_path: '1-design/idea-to-pdd.md',
    artifact: loadFixtureText('CRISPR-Bad-001', 'pdd.md'),
    checks: CHECKS,
  });
  expectQAFailWithCheck(result, 'all_sections_present', 'Target Population');
});
```

### Adversarial fixtures (`CRISPR-Bad-*`)

Fixtures with deliberate defects. Each has an `expected/` subdirectory documenting what QA should catch:

```
test/fixtures/CRISPR-Bad-001/
├── pdd.md                                    artifact with missing section
├── inputs-manifest.yaml                      upstream inputs
└── expected/
    └── idea-to-pdd-qa_result.yaml            expected QA verdict (fail with specific failure ids)
```

The integration test loads the expected result and asserts the actual result matches. Useful for catching regressions when QA logic changes.

### Snapshot tests

For schema drift, snapshot the QA result / verdict YAML structure (not exact scores). Vitest's `toMatchSnapshot()` writes a `.snap` file alongside the test; subsequent runs compare against it.

```typescript
test('idea-to-pdd-qa result shape is stable', async () => {
  const result = await runChecks({ ... });
  // Snapshot only the structure (omit timestamp + dynamic fields).
  expect({
    verdict: result.verdict,
    failureCheckIds: result.failures.map(f => f.check).sort(),
    stats: result.stats,
  }).toMatchSnapshot();
});
```

## What NOT to test here

- Skill body prose / instructions (those are LLM prompts, not logic). Use the canopy holistic-probe loop for prompt quality.
- Live MCP integration (those tests live under `test/mcp/`).
- Cross-skill calibration ranges (those live under `test/calibration/` — see that directory's README).

## Adding a test for a newly-migrated skill

1. Create `test/skills/<skill-name>/` directory.
2. Add `checks.test.ts` for the static-check functions in `skills/<producer>-qa/checks.ts`.
3. Add `integration.test.ts` using `runChecks()` against `CRISPR-Test-*` (good) + `CRISPR-Bad-*` (adversarial) fixtures.
4. (Optional) Add `snapshot.test.ts` for verdict-shape drift detection.
5. Add `README.md` documenting which fixtures cover which scenarios.
