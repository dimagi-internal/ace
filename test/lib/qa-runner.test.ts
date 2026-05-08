/**
 * Tests for the runChecks utility.
 *
 * Validates that the runner produces canonically-shaped QAResults
 * regardless of which skill's checks are passed in.
 */

import { describe, expect, test } from 'vitest';
import { runChecks } from '../../lib/qa-runner';
import { QACheck, validateQAResult } from '../../lib/qa-types';
import { expectQAPass, expectQAFail, expectQAFailWithCheck, expectQAFailureCount, expectQACheckNotFailed } from './qa-asserts';

const passCheck: QACheck = {
  id: 'always_passes',
  type: 'static',
  description: 'returns pass',
  run: () => ({ pass: true, detail: 'ok' }),
};

const failCheck: QACheck = {
  id: 'always_fails',
  type: 'static',
  description: 'returns fail',
  run: () => ({ pass: false, detail: 'broken', auto_fix_hint: 'fix it' }),
};

const failNoHintCheck: QACheck = {
  id: 'fails_without_hint',
  type: 'static',
  description: 'returns fail without hint',
  run: () => ({ pass: false, detail: 'broken' }),
};

const asyncCheck: QACheck = {
  id: 'async_check',
  type: 'llm',
  description: 'async fail',
  run: async () => ({ pass: false, detail: 'async broken', auto_fix_hint: 'await fix' }),
};

describe('runChecks', () => {
  test('all-pass produces verdict: pass', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: '1-design/test.md',
      artifact: 'irrelevant',
      checks: [passCheck, passCheck],
    });
    expectQAPass(result);
    expect(result.stats.checks_run).toBe(2);
    expect(result.stats.checks_passed).toBe(2);
  });

  test('any-fail produces verdict: fail', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: '1-design/test.md',
      artifact: 'irrelevant',
      checks: [passCheck, failCheck],
    });
    expectQAFail(result);
    expectQAFailWithCheck(result, 'always_fails', 'broken');
    expectQACheckNotFailed(result, 'always_passes');
    expectQAFailureCount(result, 1);
  });

  test('failure without explicit auto_fix_hint gets a default', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: 'a.md',
      artifact: '',
      checks: [failNoHintCheck],
    });
    expect(result.failures[0].auto_fix_hint).toBeTruthy();
    expect(result.failures[0].auto_fix_hint).toContain('broken');
  });

  test('async checks are awaited', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: 'a.md',
      artifact: '',
      checks: [asyncCheck],
    });
    expectQAFailWithCheck(result, 'async_check', 'async broken');
    expect(result.failures[0].type).toBe('llm');
  });

  test('output passes schema validation', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: '1-design/test.md',
      artifact: '',
      checks: [passCheck, failCheck],
    });
    // Round-trip through Zod to catch any shape drift.
    expect(() => validateQAResult(result)).not.toThrow();
  });

  test('include_passed populates the passed list', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: 'a.md',
      artifact: '',
      checks: [passCheck, failCheck],
      include_passed: true,
    });
    expect(result.passed).toBeDefined();
    expect(result.passed).toHaveLength(1);
    expect(result.passed![0].check).toBe('always_passes');
  });

  test('ran_at override is honored', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: 'a.md',
      artifact: '',
      checks: [passCheck],
      ran_at: '2026-01-01T00:00:00Z',
    });
    expect(result.ran_at).toBe('2026-01-01T00:00:00Z');
  });

  test('empty checks list produces verdict: pass with stats 0/0/0', async () => {
    const result = await runChecks({
      skill: 'test-qa',
      target: 'test-target',
      capture_path: 'a.md',
      artifact: '',
      checks: [],
    });
    expect(result.verdict).toBe('pass');
    expect(result.stats).toEqual({ checks_run: 0, checks_passed: 0, checks_failed: 0 });
  });
});
