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

  test('tolerates frontmatter without false-positives', () => {
    const pdd = `---\narchetype: atomic-visit\n---\n${SECTIONS_FULL}`;
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('tolerates `## **Bold Section**` style', () => {
    const pdd = SECTIONS_FULL.replace('## Archetype', '## **Archetype**');
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  // dimagi-internal/ace#991 — numbered H2s are the NORMAL shape when a producer
  // synthesises from a numbered source PDD. Before ordinal tolerance, a
  // structurally-complete PDD failed 5 of 6 checks from this one cause.
  test('tolerates ordinal-numbered headings (`## 1. Problem Statement`)', () => {
    const numbered = SECTIONS_FULL.replace(
      /^## (?!$)/gm,
      (() => {
        let n = 0;
        return () => `## ${++n}. `;
      })(),
    );
    expect(checkAllRequiredSectionsPresent(numbered).pass).toBe(true);
  });

  test('tolerates multi-level ordinals (`## 4.2 Target Population`)', () => {
    const pdd = SECTIONS_FULL.replace(
      '## Target Population',
      '## 4.2 Target Population',
    );
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('tolerates an ordinal with no trailing dot (`## 13 Timeline`)', () => {
    const pdd = SECTIONS_FULL.replace('## Timeline', '## 13 Timeline');
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('tolerates ordinal AND bold together (`## 1. **Archetype**`)', () => {
    const pdd = SECTIONS_FULL.replace('## Archetype', '## 1. **Archetype**');
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('still rejects a truncated section name even when numbered', () => {
    const pdd = SECTIONS_FULL.replace(
      '## Target Population',
      '## 4. Target Pop',
    );
    const r = checkAllRequiredSectionsPresent(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Target Population');
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
  test.each([
    ['1 metric',  `## Success Metrics\n\n| Metric | Target |\n|---|---|\n| Visits | ≥ 10 |\n`, '1 metric'],
    ['2 metrics', `## Success Metrics\n\n| Metric | Target |\n|---|---|\n| A | ≥ 1 |\n| B | ≥ 2 |\n`, '2 metric'],
  ])('passes with %s populated', (_label, pdd, detailContains) => {
    const r = checkSuccessMetricsTablePopulated(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain(detailContains);
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
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1227 — the #991 ORDINAL_PREFIX fix reached only 3 of 5
// call sites; checks 3 and 6 build their own heading regexes inline and still
// rejected prefixed headings. Appendix-letter prefixes are canonical placement
// (SKILL.md step 6 puts the stress test in an appendix), so both tolerances
// apply to both checks.
// ---------------------------------------------------------------------------

describe('prefixed headings — checks 3 and 6 (#1227)', () => {
  const dispositionTable =
    '| Marker | Disposition |\n| --- | --- |\n| [a] | Honoured in § 6.1 |\n';

  test('check 3 accepts an appendix-prefixed stress-test heading', () => {
    const r = checkStressTestAppendixPresent('# PDD\n\n## Appendix C — Stress Test Results\n\n5/5\n');
    expect(r.pass).toBe(true);
  });

  test('check 3 accepts an ordinal-prefixed stress-test heading', () => {
    expect(checkStressTestAppendixPresent('## 15. Stress Test Results\n\n5/5\n').pass).toBe(true);
  });

  test('check 6 accepts an ordinal-prefixed reviewer-comments heading and counts its rows', () => {
    const pdd = `# PDD\n\nAddresses comment [a].\n\n## 14. Reviewer Comments — Disposition\n\n${dispositionTable}`;
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(true);
    // The probe and the extractor must AGREE (the pre-#1227 internal
    // inconsistency): rows must actually be counted, not skipped via the
    // defensive "table parse skipped" fallback.
    expect(r.detail).toMatch(/disposition row/);
  });

  test('check 6 accepts an appendix-prefixed reviewer-comments heading and counts its rows', () => {
    const pdd = `# PDD\n\nAddresses comment [a].\n\n## Appendix D — Reviewer Comments — Disposition\n\n${dispositionTable}`;
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/disposition row/);
  });

  test('check 6 still fails a prefixed heading whose table is empty', () => {
    const pdd = '# PDD\n\nAddresses comment [a].\n\n## 14. Reviewer Comments — Disposition\n\nProse only, no table.\n';
    const r = checkReviewerCommentTableIfReferenced(pdd);
    expect(r.pass).toBe(false);
  });
});
