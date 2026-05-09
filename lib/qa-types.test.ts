/**
 * Schema validation tests for QA result shape.
 *
 * Mirrors `lib/verdict-schema.test.ts` for the eval verdict side. Catches
 * schema drift when QA results change shape.
 */

import { describe, expect, test } from 'vitest';
import {
  QAResultSchema,
  QACheckResultSchema,
  validateQAResult,
} from './qa-types';

describe('QAResultSchema', () => {
  const validPass = {
    skill: 'idea-to-pdd-qa',
    target: 'turmeric',
    ran_at: '2026-05-08T19:00:00Z',
    capture_path: '1-design/idea-to-pdd.md',
    verdict: 'pass',
    stats: { checks_run: 11, checks_passed: 11, checks_failed: 0 },
    failures: [],
  };

  const validFail = {
    ...validPass,
    verdict: 'fail',
    stats: { checks_run: 11, checks_passed: 10, checks_failed: 1 },
    failures: [
      {
        check: 'all_sections_present',
        type: 'static',
        detail: 'missing § Target Population',
        auto_fix_hint: 'regenerate PDD with explicit instruction to add a Target Population section',
        severity: 'blocker',
      },
    ],
  };

  test('accepts incomplete verdict', () => {
    const incomplete = { ...validPass, verdict: 'incomplete', failures: [] };
    expect(() => QAResultSchema.parse(incomplete)).not.toThrow();
  });

  test('rejects unknown verdict tiers', () => {
    expect(() => QAResultSchema.parse({ ...validPass, verdict: 'warn' })).toThrow();
  });

  test('failure severity must be blocker (no warn/info tier)', () => {
    expect(() =>
      QAResultSchema.parse({
        ...validFail,
        failures: [{ ...validFail.failures[0], severity: 'warn' }],
      }),
    ).toThrow();
  });

  test('failure detail and auto_fix_hint are required', () => {
    expect(() =>
      QAResultSchema.parse({
        ...validFail,
        failures: [{ check: 'x', type: 'static', severity: 'blocker', detail: '', auto_fix_hint: 'hint' }],
      }),
    ).toThrow();
    expect(() =>
      QAResultSchema.parse({
        ...validFail,
        failures: [{ check: 'x', type: 'static', severity: 'blocker', detail: 'd', auto_fix_hint: '' }],
      }),
    ).toThrow();
  });

  test('check type must be static or llm', () => {
    expect(() =>
      QAResultSchema.parse({
        ...validFail,
        failures: [{ ...validFail.failures[0], type: 'manual' }],
      }),
    ).toThrow();
  });

  test.each([
    ['pass', () => validPass, 'pass', 11],
    ['fail', () => validFail, 'fail', 10],
  ] as const)('validateQAResult round-trips a valid %s result', (_label, build, verdict, passed) => {
    const out = validateQAResult(build());
    expect(out.verdict).toBe(verdict);
    expect(out.stats.checks_passed).toBe(passed);
  });
});

describe('QACheckResultSchema', () => {
  test('accepts pass with no detail', () => {
    expect(() => QACheckResultSchema.parse({ pass: true })).not.toThrow();
  });

  test('accepts fail with detail and hint', () => {
    expect(() =>
      QACheckResultSchema.parse({
        pass: false,
        detail: 'missing section',
        auto_fix_hint: 'add the section',
      }),
    ).not.toThrow();
  });

  test('rejects non-boolean pass', () => {
    expect(() => QACheckResultSchema.parse({ pass: 'yes' })).toThrow();
  });
});
