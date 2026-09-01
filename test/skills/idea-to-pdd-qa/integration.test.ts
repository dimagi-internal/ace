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

describe('ACE-PDD-Pass-001 (synthetic clean PDD)', () => {
  test('passes all 10 idea-to-pdd-qa checks', async () => {
    const pdd = loadFixtureText('ACE-PDD-Pass-001', 'pdd.md');
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Pass-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: pdd,
      checks: CHECKS,
      // A real QA run supplies the artifact's Drive mimeType so the format
      // check can verify it (ace#1061). A clean fixture is a native Doc.
      context: { artifactMimeType: 'application/vnd.google-apps.document' },
    });
    expectQAPass(result);
    expect(result.stats.checks_run).toBe(10);
    expect(result.stats.checks_passed).toBe(10);
    expect(result.skill).toBe('idea-to-pdd-qa');
  });
});

describe('ACE-PDD-Bad-001 (adversarial fixture with intentional defects)', () => {
  test('matches the documented expected QA result', async () => {
    const pdd = loadFixtureText('ACE-PDD-Bad-001', 'pdd.md');
    const expected = loadExpectedQAResult('ACE-PDD-Bad-001', 'idea-to-pdd-qa_result.yaml') as ExpectedQA;

    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Bad-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: pdd,
      checks: CHECKS,
      // The adversarial fixture's defects are all CONTENT defects; its format
      // is fine, so the expected-result file stays about content.
      context: { artifactMimeType: 'application/vnd.google-apps.document' },
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
    const pdd = loadFixtureText('ACE-PDD-Bad-001', 'pdd.md');
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Bad-001',
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

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1783 — THE regression case, asserted at the level the
// defect actually lived: the whole CHECKS sweep, not one function.
//
// `bednet-check-2-visit/20260828-0629` was a `longitudinal-visits` PDD with no
// `entity_state_taxonomy` row. It scored 9/9 here and then took a `[BLOCKER]`
// at Phase 3 Step 1, where `pdd-to-learn-app` / `pdd-to-deliver-app` parse
// that row and HALT on `declared: false` (ace#1564). The bug was that this
// sweep returned verdict `pass` — so that is what this test pins. It imports
// nothing the fix introduced, which is what lets it run RED against the code
// that shipped the blocker.
// ---------------------------------------------------------------------------

describe('ace#1783 — a longitudinal PDD with no entity_state_taxonomy', () => {
  // The clean fixture, re-declared as the archetype whose Phase-3 component
  // requires the row. Every other check still sees the same passing PDD, so a
  // failure here can only be the taxonomy gap.
  const asLongitudinal = () =>
    // Both declaration sites — the fixture carries a YAML frontmatter
    // `archetype:` row AND a body `**atomic-visit.**` line, and frontmatter
    // WINS. Substituting only the visible body line leaves the PDD reading as
    // atomic-visit and silently neuters this whole describe block.
    loadFixtureText('ACE-PDD-Pass-001', 'pdd.md').replaceAll(
      'atomic-visit',
      'longitudinal-visits',
    );

  const sweep = () =>
    runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Pass-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: asLongitudinal(),
      checks: CHECKS,
      context: { artifactMimeType: 'application/vnd.google-apps.document' },
    });

  test('the archetype substitution actually took (guards the fixture)', () => {
    expect(asLongitudinal()).toContain('longitudinal-visits');
    expect(asLongitudinal()).not.toContain('atomic-visit');
    expect(asLongitudinal()).not.toContain('entity_state_taxonomy');
  });

  test('FAILS Phase 1 instead of passing through to the Phase 3 halt', async () => {
    const result = await sweep();
    expectQAFailWithCheck(
      result,
      'entity_state_taxonomy_declared_for_longitudinal',
      'longitudinal-visits',
    );
  });

  test('the SAME PDD as atomic-visit still passes — the gate is conditional', async () => {
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Pass-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: loadFixtureText('ACE-PDD-Pass-001', 'pdd.md'),
      checks: CHECKS,
      context: { artifactMimeType: 'application/vnd.google-apps.document' },
    });
    expectQAPass(result);
  });

  test('adding the row clears it — the remediation is reachable', async () => {
    const fixed = asLongitudinal().replace(
      '| entity_id_grain |',
      '| entity_state_taxonomy | 1=Registered (steps 1-2); 2=Followed up (steps 3-4); 3=Closed |\n| entity_id_grain |',
    );
    const result = await runChecks({
      skill: 'idea-to-pdd-qa',
      target: 'ACE-PDD-Pass-001',
      capture_path: '1-design/idea-to-pdd.md',
      artifact: fixed,
      checks: CHECKS,
      context: { artifactMimeType: 'application/vnd.google-apps.document' },
    });
    expectQAPass(result);
  });
});
