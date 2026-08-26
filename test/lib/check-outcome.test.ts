/**
 * `lib/check-outcome.ts` — the union that makes "checked and fine" and
 * "never looked" impossible to confuse.
 *
 * The class it closes: four ACE helpers returned `{ checked: boolean; ok:
 * boolean }` with `ok: true` on the not-run path, so `.ok` read `true` from a
 * check that matched nothing. Live cost: ace#1634 on
 * `bednet-check-2-visit/20260825-1310` (the fourth instance — #1332 → #1538 →
 * #1576 → #1634).
 */

import { describe, expect, it } from 'vitest';
import {
  assertChecked,
  assertUnable,
  checked,
  formatUnable,
  isPass,
  isUnable,
  unable,
  type CheckOutcome,
} from '../../lib/check-outcome.js';

type Finding = { kind: string };
type Report = CheckOutcome<Finding, { extras: string[] }>;

describe('CheckOutcome', () => {
  it('an unable outcome is NOT a pass', () => {
    // The whole point. Under the old shape this was `ok: true`.
    expect(isPass(unable('nothing matched'))).toBe(false);
    expect(isUnable(unable('nothing matched'))).toBe(true);
  });

  it('a checked-and-clean outcome is a pass; a checked-with-findings one is not', () => {
    expect(isPass(checked(true, []))).toBe(true);
    expect(isPass(checked(false, [{ kind: 'x' }]))).toBe(false);
  });

  it('refuses to construct an unable outcome with no reason', () => {
    // "I could not check" is only useful if it says why: an unexplained
    // not-applicable is indistinguishable from a broken matcher, which is
    // what all four cited issues were.
    expect(() => unable('')).toThrow(/non-empty reason/);
    expect(() => unable('   ')).toThrow(/non-empty reason/);
    expect(() => unable('\n\t')).toThrow(/non-empty reason/);
  });

  it('carries the check-specific extras on the checked branch only', () => {
    const r: Report = { ...checked(true, []), extras: ['a'] };
    assertChecked(r);
    expect(r.extras).toEqual(['a']);
    expect(r.ok).toBe(true);
  });

  it('assertChecked throws and names the reason when the check never ran', () => {
    const r: Report = unable('the ITEM_SCORE regex matched zero binds');
    expect(() => assertChecked(r)).toThrow(/UNABLE: the ITEM_SCORE regex matched zero binds/);
  });

  it('assertUnable throws when the check DID run', () => {
    const r: Report = { ...checked(true, []), extras: [] };
    expect(() => assertUnable(r)).toThrow(/expected the check to report UNABLE/);
  });

  it('formatUnable never renders as a pass', () => {
    const text = formatUnable('scoring-arithmetic', 'no item-score binds matched');
    expect(text).toMatch(/UNABLE TO CHECK/);
    expect(text).toMatch(/NOT a pass/);
    expect(text).toMatch(/no item-score binds matched/);
    // The two green-looking strings the old branches emitted.
    expect(text).not.toMatch(/\bclean\b/i);
    expect(text).not.toMatch(/not applicable/i);
  });

  it('points a reader at the matcher, which is what the four issues all were', () => {
    expect(formatUnable('x', 'y')).toMatch(/the matcher is the bug/);
  });
});
