/**
 * ace#2061 — a certification gate defeatable by answering a pattern.
 *
 * The positive control is the REAL key built on
 * poverty-graduation/20260905-1345, read out of the built blueprint's
 * `qN_score` calculates. Not a constructed fixture: the point of this class is
 * that it shipped while every existing assessment check passed.
 *
 * ace#2179 — and the check that caught it was unsatisfiable for short banks.
 * The `describe` block at the bottom is the regression suite for that: it
 * asserts the verdict tracks the key's CONTENT at every bank length, which is
 * exactly what the shipped version could not do. Every one of those cases is
 * red against the pre-fix `period <= min(maxPeriod, n)` loop.
 */
import { describe, expect, it } from 'vitest';
import { checkAnswerKeyPattern } from '../../lib/answer-key-pattern.js';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';

// The live key. From q5 it is (a,d,c,b) seven times without deviation.
const POVGRAD_KEY = [
  'c', 'a', 'd', 'b', 'a', 'd', 'c', 'b',
  'a', 'd', 'c', 'b', 'a', 'd', 'c', 'b',
  'a', 'd', 'c', 'b', 'a', 'd', 'c', 'b',
  'a', 'd', 'c', 'b', 'a', 'd', 'c', 'b',
];

describe('checkAnswerKeyPattern — the reproducer (ace#2061)', () => {
  it('fails the real 32-item key that shipped', () => {
    const r = checkAnswerKeyPattern({ key: POVGRAD_KEY, passMark: 80 });
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.best?.hits).toBe(29);
    expect(r.best?.percent).toBeCloseTo(90.625, 2);
    expect(r.detail).toMatch(/clears the 80% gate/);
  });

  it('reports the offending cycle as a finding', () => {
    const r = checkAnswerKeyPattern({ key: POVGRAD_KEY, passMark: 80 });
    assertChecked(r);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toEqual(r.best);
  });

  it('names a fix that moves the OPTION, not the score literal', () => {
    // Re-pointing the calculate at another letter would make a wrong answer
    // correct — the one repair that must not be suggested.
    const r = checkAnswerKeyPattern({ key: POVGRAD_KEY, passMark: 80 });
    assertChecked(r);
    expect(r.fix).toMatch(/move the correct option TEXT/i);
    expect(r.fix).toMatch(/do not\s+simply point the calculate at a different letter/i);
  });

  // The distribution is PERFECT — 8 of each. This is why a frequency check
  // could never have caught it, and why the test says so out loud.
  it('is not detectable from letter frequencies', () => {
    const counts = POVGRAD_KEY.reduce<Record<string, number>>((m, k) => {
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    expect(counts).toEqual({ a: 8, b: 8, c: 8, d: 8 });
  });
});

describe('checkAnswerKeyPattern — negative controls', () => {
  it('passes an irregular key no short cycle predicts', () => {
    const key = [
      'a', 'a', 'c', 'b', 'd', 'b', 'a', 'd',
      'c', 'c', 'b', 'a', 'd', 'a', 'b', 'c',
      'd', 'd', 'a', 'b', 'c', 'a', 'b', 'd',
      'b', 'c', 'a', 'c', 'd', 'b', 'd', 'a',
    ];
    const r = checkAnswerKeyPattern({ key, passMark: 80 });
    assertChecked(r);
    expect(r.ok).toBe(true);
  });

  it('catches the crudest case — every answer the same letter', () => {
    const r = checkAnswerKeyPattern({ key: Array(20).fill('b'), passMark: 80 });
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.longestConstantRun).toBe(20);
  });

  it('catches a two-letter alternation', () => {
    const key = Array.from({ length: 24 }, (_, i) => (i % 2 ? 'b' : 'a'));
    const r = checkAnswerKeyPattern({ key, passMark: 80 });
    assertChecked(r);
    expect(r.ok).toBe(false);
  });

  // A visible pattern that does NOT reach the mark is allowed through: the
  // question is operational (can the gate be cleared?), not aesthetic.
  it('allows a partial pattern that cannot reach the pass mark', () => {
    const key = [
      'a', 'd', 'c', 'b', 'a', 'd', 'c', 'b',
      'c', 'a', 'b', 'd', 'b', 'c', 'd', 'a',
      'd', 'b', 'a', 'c', 'b', 'a', 'd', 'c',
    ];
    const r = checkAnswerKeyPattern({ key, passMark: 80 });
    assertChecked(r);
    expect(r.best!.percent).toBeLessThan(80);
    expect(r.ok).toBe(true);
  });
});

/**
 * ace#2179 — a period the key cannot repeat is not a pattern.
 *
 * Shipped bound: `period <= Math.min(maxPeriod, n)`. At `period === n` the
 * "cycle" is the key, so `hits === n` and every bank of `n <= DEFAULT_MAX_PERIOD`
 * (6) failed at exactly 100% regardless of content. The degeneracy does not
 * stop there — at `period === n - 1` the floor is `(n - 1) / n`, so a 7-item
 * key fails an 80% gate at 85.7% on arithmetic alone. Fixed bound is
 * `floor(n / 2)`: the cycle must fit at least twice.
 */
describe('checkAnswerKeyPattern — degenerate periods (ace#2179)', () => {
  const ok = (key: string[], passMark: number) => {
    const r = checkAnswerKeyPattern({ key, passMark });
    assertChecked(r);
    return r;
  };

  it('never tests a period the key cannot fit twice', () => {
    for (let n = 2; n <= 20; n++) {
      const key = Array.from({ length: n }, (_, i) => 'abcd'[i % 4]);
      const r = ok(key, 80);
      expect(r.maxTestablePeriod, `n=${n}`).toBe(Math.min(6, Math.floor(n / 2)));
      // The reported cycle is a real repeating unit, never a copy of the key.
      expect(r.best!.cycle.length, `n=${n}`).toBeLessThanOrEqual(Math.floor(n / 2));
    }
  });

  // The heart of it: on the shipped version these three 3-item keys returned
  // IDENTICAL verdicts (fail @ 100%) because only length mattered.
  it('a 3-item bank is judged on its content, not its length', () => {
    expect(ok(['b', 'c', 'a'], 67).ok).toBe(true);
    expect(ok(['a', 'b', 'd'], 67).ok).toBe(true);
    expect(ok(['d', 'a', 'c'], 100).ok).toBe(true);
    // …and a 3-item bank that IS cold-guessable still fails.
    const bad = ok(['a', 'a', 'a'], 67);
    expect(bad.ok).toBe(false);
    expect(bad.best!.percent).toBe(100);
  });

  // Length sweep 3..8: at every length, a well-mixed key passes and a
  // short-cycle key fails. `ok` must vary with content at EVERY length.
  it.each([
    { n: 3, pass: ['c', 'a', 'b'], fail: ['a', 'a', 'a'], gate: 67 },
    { n: 4, pass: ['a', 'c', 'b', 'd'], fail: ['a', 'b', 'a', 'b'], gate: 75 },
    { n: 5, pass: ['b', 'd', 'a', 'c', 'a'], fail: ['a', 'b', 'a', 'b', 'a'], gate: 80 },
    { n: 6, pass: ['a', 'b', 'c', 'd', 'a', 'c'], fail: ['c', 'a', 'd', 'b', 'a', 'd'], gate: 80 },
    { n: 7, pass: ['d', 'a', 'b', 'c', 'a', 'c', 'b'], fail: ['a', 'b', 'c', 'a', 'b', 'c', 'a'], gate: 80 },
    { n: 8, pass: ['c', 'a', 'd', 'b', 'b', 'd', 'a', 'c'], fail: ['a', 'd', 'c', 'b', 'a', 'd', 'c', 'b'], gate: 80 },
  ])('length $n: a mixed key passes at a $gate gate and a cyclic one fails', ({ pass, fail, gate }) => {
    expect(ok(pass, gate).ok, `mixed key ${pass.join(',')}`).toBe(true);
    expect(ok(fail, gate).ok, `cyclic key ${fail.join(',')}`).toBe(false);
  });

  // The specific reason the filed remedy (`n - 1`) was under-scoped. This key
  // is the one that shipped green on bednet-check-2-visit/20260907-1126 only
  // because its gate was 100; at any gate at or below 85.7% the shipped check
  // — and a `n - 1` bound — fails it on arithmetic, not on its content.
  it('does not fail a 7-item key on the (n-1)/n floor', () => {
    const key = ['d', 'a', 'b', 'c', 'a', 'c', 'b'];
    const r = ok(key, 80);
    expect(r.ok).toBe(true);
    expect(r.best!.percent).toBeLessThan(80);
    expect(r.best!.cycle.length).toBeLessThanOrEqual(3);
  });

  // Detection strength is unchanged where it matters: every real instance of
  // this class is short-period, so the tightened bound costs nothing.
  it('still catches a short cycle inside a short bank', () => {
    expect(ok(['a', 'b', 'a', 'b', 'a', 'b'], 80).ok).toBe(false);
    expect(ok(['a', 'b', 'c', 'a', 'b', 'c'], 80).ok).toBe(false);
    expect(ok(['b', 'b', 'b', 'b'], 75).ok).toBe(false);
  });
});

/**
 * A bank too short to carry any period is UNABLE, not a pass (ace#1634 class).
 */
describe('checkAnswerKeyPattern — banks too short to judge', () => {
  it('reports unable for an empty bank rather than passing it', () => {
    const r = checkAnswerKeyPattern({ key: [], passMark: 80 });
    assertUnable(r);
    expect(r.reason).toMatch(/0 items/);
    expect(r.reason).not.toMatch(/\bpass\b/i);
  });

  it('reports unable for a single-item bank', () => {
    const r = checkAnswerKeyPattern({ key: ['a'], passMark: 80 });
    assertUnable(r);
    expect(r.reason).toMatch(/1 item;/);
  });

  it('a 2-item bank IS checked — period 1 is a real question there', () => {
    const same = checkAnswerKeyPattern({ key: ['a', 'a'], passMark: 80 });
    assertChecked(same);
    expect(same.ok).toBe(false);

    const mixed = checkAnswerKeyPattern({ key: ['a', 'b'], passMark: 80 });
    assertChecked(mixed);
    expect(mixed.ok).toBe(true);
  });
});
