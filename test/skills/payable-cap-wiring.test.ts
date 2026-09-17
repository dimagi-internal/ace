/**
 * The capped-index gate must stay WIRED (dimagi-internal/ace#2148).
 *
 * `lib/payable-cap-arithmetic.ts` is falsifiable — `test/lib/…` proves that
 * against two real released forms. The other way a gate dies is by having no
 * caller, and that failure is silent: the module keeps passing its own tests
 * while nothing runs it on a build. So this file pins the callers rather than
 * the arithmetic.
 *
 * Three surfaces, and each one is load-bearing for a different reason:
 *
 * - `pdd-to-deliver-app` — the BUILD side. Catching it here costs one bounded
 *   repair loop; catching it downstream costs a Nova build and a Phase-3 halt.
 * - `app-release-qa` — the RELEASED-artifact backstop, on the same input
 *   (`entity_id` binds in the CCZ form XML) as `checkEntityIdGrain`.
 * - `_app-component-library § payability-scoped-key` — the prose the architect
 *   is briefed from. ace#2148 happened because the component described the
 *   mechanism correctly and never stated the counter-timing invariant, so the
 *   builder implemented "clamp at 3 for a cap of 3", which is the reading
 *   almost anyone takes.
 *
 * Observed on `spark-facilitator/20260906-2233`: a declared per-step cap of 3
 * shipped binding at 4 — 4 x 7 steps = 28 payable events against a declared
 * `total_cap_per_flw` of 21 — on released Deliver build
 * `0cb63a78fd9949b696876ee7a642b685`, with every build-time gate green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

const DELIVER = read('skills/pdd-to-deliver-app/SKILL.md');
const RELEASE_QA = read('skills/app-release-qa/SKILL.md');
const COMPONENTS = read('skills/_app-component-library.md');
const EVAL = read('skills/pdd-to-deliver-app-eval/SKILL.md');

describe('the capped-index gate has callers', () => {
  it('app-release-qa runs the checker over the released form', () => {
    expect(RELEASE_QA).toContain('checkPayableCapArithmetic');
    expect(RELEASE_QA).toContain('lib/payable-cap-arithmetic');
  });

  it('app-release-qa treats a finding as a BLOCKER, not a warn', () => {
    // It errs toward paying for work outside the agreed cap — partner-facing.
    expect(RELEASE_QA).toMatch(/\[BLOCKER\]`? `?payable-cap-arithmetic/);
  });

  it('app-release-qa records the verdict field, so the trace survives the run', () => {
    expect(RELEASE_QA).toContain('payable_cap_arithmetic:');
  });

  it('pdd-to-deliver-app checks it at BUILD time, where the repair is cheap', () => {
    expect(DELIVER).toContain('lib/payable-cap-arithmetic');
    expect(DELIVER).toContain('payableCapacity');
  });

  it('the eval points at the helper instead of re-deriving the arithmetic', () => {
    // A judge tracing it by hand is how ace#2148 was caught, and is not a
    // gate anyone can rely on twice.
    expect(EVAL).toContain('checkPayableCapArithmetic');
  });
});

describe('the component states the invariant the architect is briefed from', () => {
  const section = (() => {
    const start = COMPONENTS.indexOf('### payability-scoped-key');
    expect(start, 'payability-scoped-key section is gone').toBeGreaterThan(-1);
    const end = COMPONENTS.indexOf('\n### ', start + 1);
    return COMPONENTS.slice(start, end === -1 ? undefined : end);
  })();

  it('says WHEN the counter is read, not only what the clamp does', () => {
    expect(section).toMatch(/casedb/i);
    expect(section).toMatch(/BEFORE this submission/i);
  });

  it('gives both correct spellings, so the constant is not mistaken for the rule', () => {
    expect(section).toContain('cap - 1');
    expect(section).toContain('+ 1');
  });

  it('says the app\'s own is_payable flag does not save you', () => {
    expect(section).toMatch(/is_payable/);
  });

  it('names the mechanical trace rather than leaving it to the eye', () => {
    expect(section).toContain('checkPayableCapArithmetic');
  });
});
