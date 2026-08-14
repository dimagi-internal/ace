/**
 * dimagi-internal/ace#1031 — `/ace:iterate`'s golden-prefix rule validates
 * only that the seeded phases were RECORDED as good at the time the golden
 * ran:
 *
 *   "The golden run must have `phases.idea-to-design` and
 *    `phases.scenarios-and-acceptance` both `done`/`pass`."
 *
 * Those are frozen `status`/`verdict` fields. Nothing re-checks the seeded
 * artifacts against the CURRENT rubrics — so when a rubric tightens after the
 * golden was recorded, the loop's own judge (which requires
 * `pdd-to-learn-app-eval == pass`) fails DETERMINISTICALLY on every iteration
 * and `pass_rate` is pinned at 0 forever, while measuring nothing about the
 * targeted phases.
 *
 * Self-inflicted, and the cousin of the frozen-`plugin_version` streak bug PR
 * #956 removed, one layer up: the loop exists to keep running while ACE
 * improves, and TIGHTENING AN EVAL RUBRIC IS AN IMPROVEMENT. So the
 * improvement loop silently bricks the measurement loop.
 *
 * Live: `/ace:iterate bednet-spot-check --golden 20260706-0649`. The golden
 * satisfies the documented rule — phases 1 and 2 both `done`/`pass`, and its
 * own run_state records `pdd-to-learn-app-eval` as pass/7.7 on 2026-07-06.
 * Re-run against the same seeded PDD weeks later: overall 6.76, `fail`,
 * `assessment_discrimination` 2.0 with the hard-gate fired.
 *
 * `--new-golden` already validates against today's rubrics (steps 2 + 2b).
 * The hole this closes is the INHERITED golden — `--golden <id>` and the
 * `golden_run_id` resume path — which still only reads the frozen fields.
 */
import { describe, it, expect } from 'vitest';
import { latestRubricRevision, checkGoldenFreshness } from '../../lib/golden-staleness.js';

const RUBRIC_MD = `
# pdd-to-learn-app-eval

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-13 | Retired the blind-guess probe (ace#1206). | ACE team |
| 2026-07-30 | Something older. | ACE team |
| 2026-04-28 | Initial version. | ACE team |
`;

describe('latestRubricRevision', () => {
  it('reads the newest change-log date, not the first row', () => {
    expect(latestRubricRevision(RUBRIC_MD)).toBe('2026-08-13');
  });

  it('is order-independent — change logs are not always newest-first', () => {
    const shuffled = RUBRIC_MD.replace('2026-08-13', '2026-04-01').replace('2026-04-28', '2026-08-13');
    expect(latestRubricRevision(shuffled)).toBe('2026-08-13');
  });

  it('returns null rather than a guess when there is no change log', () => {
    expect(latestRubricRevision('# a skill with no table')).toBeNull();
  });
});

describe('checkGoldenFreshness (#1031)', () => {
  const rubricRevisions = {
    'idea-to-pdd-eval': '2026-07-01',
    'pdd-to-learn-app-eval': '2026-08-13',
  };

  it('flags the bednet golden: its verdict predates the rubric that now fails it', () => {
    const r = checkGoldenFreshness({
      goldenRunId: '20260706-0649',
      verdicts: [
        { skill: 'idea-to-pdd-eval', recordedAt: '2026-07-06T00:00:00Z', verdict: 'pass' },
        { skill: 'pdd-to-learn-app-eval', recordedAt: '2026-07-06T00:00:00Z', verdict: 'pass' },
      ],
      rubricRevisions,
    });
    expect(r.fresh).toBe(false);
    expect(r.stale.map((s) => s.skill)).toEqual(['pdd-to-learn-app-eval']);
    expect(r.detail).toMatch(/2026-08-13/);
    expect(r.detail, 'must say what to do, not just that it is stale').toMatch(/--new-golden|re-validate/i);
  });

  it('passes a golden recorded after every rubric revision', () => {
    const r = checkGoldenFreshness({
      goldenRunId: '20260814-0900',
      verdicts: [
        { skill: 'idea-to-pdd-eval', recordedAt: '2026-08-14T09:00:00Z', verdict: 'pass' },
        { skill: 'pdd-to-learn-app-eval', recordedAt: '2026-08-14T09:00:00Z', verdict: 'pass' },
      ],
      rubricRevisions,
    });
    expect(r.fresh).toBe(true);
    expect(r.stale).toEqual([]);
  });

  it('still refuses a golden whose frozen verdict is not a pass — the old rule is necessary, not sufficient', () => {
    const r = checkGoldenFreshness({
      goldenRunId: 'g',
      verdicts: [{ skill: 'idea-to-pdd-eval', recordedAt: '2026-08-14T00:00:00Z', verdict: 'fail' }],
      rubricRevisions,
    });
    expect(r.fresh).toBe(false);
    expect(r.notPassing.map((v) => v.skill)).toEqual(['idea-to-pdd-eval']);
  });

  it('treats a verdict with no timestamp as UNKNOWN, never as fresh', () => {
    const r = checkGoldenFreshness({
      goldenRunId: 'g',
      verdicts: [{ skill: 'pdd-to-learn-app-eval', verdict: 'pass' }],
      rubricRevisions,
    });
    expect(r.fresh).toBe(false);
    expect(r.unknown.map((u) => u.skill)).toEqual(['pdd-to-learn-app-eval']);
  });

  it('ignores a rubric whose revision date is unknown rather than failing on it', () => {
    const r = checkGoldenFreshness({
      goldenRunId: 'g',
      verdicts: [{ skill: 'some-eval', recordedAt: '2026-01-01T00:00:00Z', verdict: 'pass' }],
      rubricRevisions: { 'some-eval': null },
    });
    expect(r.fresh).toBe(true);
  });

  it('is fresh on an empty verdict list only vacuously, and says so', () => {
    const r = checkGoldenFreshness({ goldenRunId: 'g', verdicts: [], rubricRevisions });
    expect(r.fresh).toBe(true);
    expect(r.detail).toMatch(/no eval verdicts/i);
  });
});
