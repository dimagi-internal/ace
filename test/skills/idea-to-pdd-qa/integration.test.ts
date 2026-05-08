/**
 * Integration tests for idea-to-pdd-qa.
 *
 * Runs the full CHECKS array via lib/qa-runner against fixture PDDs and
 * asserts the QAResult matches expectations. Distinguishes between the
 * unit-tests in checks.test.ts (which exercise individual functions with
 * inline strings) by validating end-to-end output shape.
 */

import { describe, expect, test } from 'vitest';
import { CHECKS } from '../../../skills/idea-to-pdd-qa/checks';
import { runChecks } from '../../../lib/qa-runner';
import { loadFixtureText, loadExpectedQAResult } from '../../lib/fixture-loader';
import {
  expectQAPass,
  expectQAFail,
  expectQAFailWithCheck,
  expectQACheckNotFailed,
} from '../../lib/qa-asserts';

interface ExpectedQA {
  skill: string;
  verdict: 'pass' | 'fail' | 'incomplete';
  expected_failures?: { check: string; detail_contains?: string }[];
  expected_passes?: string[];
}

describe('CRISPR-PDD-Pass-001 (synthetic clean PDD)', () => {
  test('passes all 6 idea-to-pdd-qa checks', async () => {
    const pdd = loadFixtureText('CRISPR-PDD-Pass-001', 'pdd.md');
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'CRISPR-PDD-Pass-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: pdd,
      checks: CHECKS,
    });
    expectQAPass(result);
    expect(result.stats.checks_run).toBe(6);
    expect(result.stats.checks_passed).toBe(6);
    expect(result.skill).toBe('idea-to-pdd-qa');
  });
});

describe('CRISPR-PDD-Bad-001 (adversarial fixture with intentional defects)', () => {
  test('matches the documented expected QA result', async () => {
    const pdd = loadFixtureText('CRISPR-PDD-Bad-001', 'pdd.md');
    const expected = loadExpectedQAResult('CRISPR-PDD-Bad-001', 'idea-to-pdd-qa_result.yaml') as ExpectedQA;

    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'CRISPR-PDD-Bad-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: pdd,
      checks: CHECKS,
    });

    // Verdict matches.
    expect(result.verdict).toBe(expected.verdict);

    // Every expected failure is present with detail substring.
    for (const exp of expected.expected_failures ?? []) {
      expectQAFailWithCheck(result, exp.check, exp.detail_contains);
    }

    // Every expected pass did NOT fail.
    for (const checkId of expected.expected_passes ?? []) {
      expectQACheckNotFailed(result, checkId);
    }

    // Failure count matches.
    expect(result.failures.length).toBe(expected.expected_failures?.length ?? 0);
  });

  test('every failure has a non-empty auto_fix_hint', async () => {
    const pdd = loadFixtureText('CRISPR-PDD-Bad-001', 'pdd.md');
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'CRISPR-PDD-Bad-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: pdd,
      checks: CHECKS,
    });
    for (const failure of result.failures) {
      expect(
        failure.auto_fix_hint,
        `failure '${failure.check}' must have an actionable auto_fix_hint`,
      ).toBeTruthy();
    }
  });
});
