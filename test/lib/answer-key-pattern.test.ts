/**
 * ace#2061 — a certification gate defeatable by answering a pattern.
 *
 * The positive control is the REAL key built on
 * poverty-graduation/20260905-1345, read out of the built blueprint's
 * `qN_score` calculates. Not a constructed fixture: the point of this class is
 * that it shipped while every existing assessment check passed.
 */
import { describe, expect, it } from 'vitest';
import { checkAnswerKeyPattern } from '../../lib/answer-key-pattern.js';

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
    expect(r.ok).toBe(false);
    expect(r.best?.hits).toBe(29);
    expect(r.best?.percent).toBeCloseTo(90.625, 2);
    expect(r.detail).toMatch(/clears the 80% gate/);
  });

  it('names a fix that moves the OPTION, not the score literal', () => {
    // Re-pointing the calculate at another letter would make a wrong answer
    // correct — the one repair that must not be suggested.
    const r = checkAnswerKeyPattern({ key: POVGRAD_KEY, passMark: 80 });
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
    expect(checkAnswerKeyPattern({ key, passMark: 80 }).ok).toBe(true);
  });

  it('catches the crudest case — every answer the same letter', () => {
    const r = checkAnswerKeyPattern({ key: Array(20).fill('b'), passMark: 80 });
    expect(r.ok).toBe(false);
    expect(r.longestConstantRun).toBe(20);
  });

  it('catches a two-letter alternation', () => {
    const key = Array.from({ length: 24 }, (_, i) => (i % 2 ? 'b' : 'a'));
    expect(checkAnswerKeyPattern({ key, passMark: 80 }).ok).toBe(false);
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
    expect(r.best!.percent).toBeLessThan(80);
    expect(r.ok).toBe(true);
  });

  it('is empty-safe', () => {
    expect(checkAnswerKeyPattern({ key: [], passMark: 80 }).ok).toBe(true);
  });
});
