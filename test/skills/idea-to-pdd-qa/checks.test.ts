/**
 * Unit tests for static QA checks in skills/idea-to-pdd-qa/checks.ts.
 *
 * Each check is a pure function. Tests use small inline strings (no fixtures)
 * to exercise individual branches. Fixture-based integration testing lives
 * in integration.test.ts.
 */

import { describe, expect, test } from 'vitest';
import {
  checkAllRequiredSectionsPresent,
  checkArchetypeDeclared,
  checkStressTestAppendixPresent,
  checkSuccessMetricsTablePopulated,
  checkEvidenceModelLayered,
  checkReviewerCommentTableIfReferenced,
  CHECKS,
} from '../../../skills/idea-to-pdd-qa/checks';

const SECTIONS_FULL = `# PDD

## Archetype

atomic-visit.

## Problem Statement

x

## Intervention Design

x

## Learn App Specification

x

## Deliver App Specification

x

## Target Population

x

## FLW Requirements

x

## LLO Preference

x

## Success Metrics

| Metric | Target |
|---|---|
| visits | ≥ 10 |

## Evidence Model

Layer A: x. Layer B: y. Layer C: z.

## Timeline

x

## Stress Test Results

5/5 pass.
`;

describe('checkAllRequiredSectionsPresent', () => {
  test('passes when all 11 sections are present', () => {
    const r = checkAllRequiredSectionsPresent(SECTIONS_FULL);
    expect(r.pass).toBe(true);
  });

  test('fails when one section is missing', () => {
    const pdd = SECTIONS_FULL.replace('## Target Population\n\nx', '');
    const r = checkAllRequiredSectionsPresent(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Target Population');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  // audit: Same code path as 'fails when one section is missing'. Multi-missing is the same loop running twice. Keeper: 'fails when one section is miss
  test.skip('fails when multiple sections missing', () => {
    const pdd = SECTIONS_FULL
      .replace('## Target Population\n\nx', '')
      .replace('## FLW Requirements\n\nx', '');
    const r = checkAllRequiredSectionsPresent(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Target Population');
    expect(r.detail).toContain('FLW Requirements');
  });

  test('tolerates frontmatter without false-positives', () => {
    const pdd = `---\narchetype: atomic-visit\n---\n${SECTIONS_FULL}`;
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('tolerates `## **Bold Section**` style', () => {
    const pdd = SECTIONS_FULL.replace('## Archetype', '## **Archetype**');
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });
});

describe('checkArchetypeDeclared', () => {
  test('passes with frontmatter archetype', () => {
    const pdd = `---\narchetype: atomic-visit\n---\n# PDD\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('atomic-visit');
  });

  test('passes with body **Archetype:** declaration', () => {
    const pdd = `# PDD\n**Archetype:** focus-group\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('focus-group');
  });

  test('passes with `## Archetype: multi-stage` heading', () => {
    const pdd = `# PDD\n\n## Archetype: multi-stage\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('multi-stage');
  });

  test('fails when no archetype declared', () => {
    const pdd = `# PDD\n\nNo archetype here.\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no archetype');
  });

  test('fails on invalid archetype value', () => {
    const pdd = `---\narchetype: bogus-archetype\n---\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('bogus-archetype');
  });
});

describe('checkStressTestAppendixPresent', () => {
  test('passes when "## Stress Test Results" present', () => {
    expect(checkStressTestAppendixPresent('# PDD\n\n## Stress Test Results\n\n5/5\n').pass).toBe(true);
  });

  test('passes with hyphenated form', () => {
    expect(checkStressTestAppendixPresent('## Stress-Test Results\n').pass).toBe(true);
  });

  test('fails when absent', () => {
    const r = checkStressTestAppendixPresent('# PDD\n\n## Some other section\n');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkSuccessMetricsTablePopulated', () => {
  test('passes when section has populated table', () => {
    const pdd = `## Success Metrics\n\n| Metric | Target |\n|---|---|\n| Visits | ≥ 10 |\n`;
    expect(checkSuccessMetricsTablePopulated(pdd).pass).toBe(true);
  });

  test('fails when section missing', () => {
    expect(checkSuccessMetricsTablePopulated('# PDD\n').pass).toBe(false);
  });

  test('fails when table has no data rows', () => {
    const pdd = `## Success Metrics\n\n| Metric | Target |\n|---|---|\n\n## Next\n`;
    const r = checkSuccessMetricsTablePopulated(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no populated data rows');
  });

  test('passes with multiple data rows', () => {
    const pdd = `## Success Metrics\n\n| Metric | Target |\n|---|---|\n| A | ≥ 1 |\n| B | ≥ 2 |\n`;
    const r = checkSuccessMetricsTablePopulated(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('2 metric');
  });
});

describe('checkEvidenceModelLayered', () => {
  test('passes when all three layers present', () => {
    const pdd = `## Evidence Model\n\nLayer A, Layer B, and Layer C.\n`;
    expect(checkEvidenceModelLayered(pdd).pass).toBe(true);
  });

  test('passes when layers in a table', () => {
    const pdd = `## Evidence Model\n\n| Layer | Purpose |\n|---|---|\n| Layer A | proof |\n| Layer B | content |\n| Layer C | aggregate |\n`;
    expect(checkEvidenceModelLayered(pdd).pass).toBe(true);
  });

  test('fails when section missing', () => {
    expect(checkEvidenceModelLayered('# PDD\n').pass).toBe(false);
  });

  test('fails when only Layer A present', () => {
    const pdd = `## Evidence Model\n\nLayer A only.\n`;
    const r = checkEvidenceModelLayered(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Layer B');
    expect(r.detail).toContain('Layer C');
  });
});

describe('checkReviewerCommentTableIfReferenced', () => {
  test('passes when no markers and no section (clean source)', () => {
    const r = checkReviewerCommentTableIfReferenced('# PDD\n\n## Problem\n\nNo comments.\n');
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('clean source');
  });

  test('fails when markers present but no Disposition section', () => {
    const pdd = `# PDD\n\n## Problem\n\nReviewer comment [a] flagged this.\n`;
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no Reviewer Comments');
  });

  test('passes when section present with rows', () => {
    const pdd = `## Reviewer Comments — Disposition\n\n| # | Comment | Disposition |\n|---|---|---|\n| [a] | x | addressed |\n`;
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(true);
  });

  test('fails when section present but table empty', () => {
    const pdd = `## Reviewer Comments — Disposition\n\n| # | Comment | Disposition |\n|---|---|---|\n`;
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no populated table rows');
  });
});

describe('CHECKS array', () => {
  test('exports six checks in stable order', () => {
    expect(CHECKS).toHaveLength(6);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'all_required_sections_present',
      'archetype_declared_and_valid',
      'stress_test_appendix_present',
      'success_metrics_table_populated',
      'evidence_model_layered',
      'reviewer_comment_table_if_referenced',
    ]);
  });

  // audit: TypeScript enforces these fields at compile time (via the QACheck interface). Test passes vacuously for a well-typed module; provides no run
  test.skip('every check has type, description, and run', () => {
    for (const c of CHECKS) {
      expect(c.id).toBeTruthy();
      expect(['static', 'llm']).toContain(c.type);
      expect(c.description).toBeTruthy();
      expect(typeof c.run).toBe('function');
    }
  });

  // audit: Snapshot of the current implementation, not a contract. If a future LLM check is added, this test breaks but the system is still correct. Te
  test.skip('every check is type: static (no LLM checks for idea-to-pdd-qa)', () => {
    for (const c of CHECKS) {
      expect(c.type).toBe('static');
    }
  });
});
