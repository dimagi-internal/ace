/**
 * Custom assertions for QA results in tests.
 *
 * These wrap vitest's `expect` for ergonomic per-skill integration tests.
 * Pair with `test/lib/qa-runner.ts` to exercise QA logic without
 * dispatching the live skill.
 */

import { expect } from 'vitest';
import { QAResult } from '../../lib/qa-types';

/** Assert a QA result is pass with no failures. */
export function expectQAPass(result: QAResult): void {
  expect(result.verdict, 'expected QA verdict pass').toBe('pass');
  expect(result.failures, 'expected zero failures on pass').toEqual([]);
  expect(result.stats.checks_failed).toBe(0);
}

/** Assert a QA result is fail. */
export function expectQAFail(result: QAResult): void {
  expect(result.verdict).toBe('fail');
  expect(result.failures.length).toBeGreaterThan(0);
  expect(result.stats.checks_failed).toBe(result.failures.length);
}

/**
 * Assert a specific check failed.
 *
 * @param result The QA result to inspect.
 * @param checkId The stable id of the check that should have failed.
 * @param detailContains Optional substring assertion against the failure's `detail`.
 */
export function expectQAFailWithCheck(
  result: QAResult,
  checkId: string,
  detailContains?: string,
): void {
  const failure = result.failures.find((f) => f.check === checkId);
  expect(
    failure,
    `expected QA failure with check id '${checkId}', got: [${result.failures
      .map((f) => f.check)
      .join(', ')}]`,
  ).toBeDefined();
  if (detailContains) {
    expect(failure!.detail).toContain(detailContains);
  }
  expect(failure!.auto_fix_hint, `failure '${checkId}' must have auto_fix_hint`).toBeTruthy();
}

/** Assert that NO check with the given id failed (it either passed or wasn't run). */
export function expectQACheckNotFailed(result: QAResult, checkId: string): void {
  const failure = result.failures.find((f) => f.check === checkId);
  expect(
    failure,
    `expected check '${checkId}' to not be in failures (was: ${failure?.detail})`,
  ).toBeUndefined();
}

/**
 * Assert exact failure count.
 *
 * Useful when you've crafted an adversarial fixture with a known number
 * of intentional defects.
 */
export function expectQAFailureCount(result: QAResult, count: number): void {
  expect(result.failures.length, `expected exactly ${count} QA failures`).toBe(count);
  expect(result.verdict).toBe(count === 0 ? 'pass' : 'fail');
}
