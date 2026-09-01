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
  checkPddIsNativeGoogleDoc,
  checkProgramParametersCoherent,
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

## Program Parameters

| Key | Value |
|---|---|
| learn_passing_score | 100 |
| assessment_items | 6 |

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

  test('accepts longitudinal-visits in frontmatter', () => {
    const pdd = `---\narchetype: longitudinal-visits\n---\n# PDD\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('longitudinal-visits');
  });

  test('accepts longitudinal-visits in a body declaration', () => {
    // The regex alternation must not let `atomic-visit` or a prefix shadow
    // it, and the value must come back whole — a truncated match here would
    // route the PDD down the wrong archetype branch silently.
    const pdd = `# PDD\n**Archetype:** longitudinal-visits\n`;
    const r = checkArchetypeDeclared(pdd);
    expect(r.pass).toBe(true);
    expect(r.detail).toBe('longitudinal-visits');
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
  test('exports ten checks in stable order', () => {
    expect(CHECKS).toHaveLength(10);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'pdd_is_native_google_doc',
      'all_required_sections_present',
      'archetype_declared_and_valid',
      'stress_test_appendix_present',
      'success_metrics_table_populated',
      'evidence_model_layered',
      'program_parameters_coherent',
      'payment_unit_matches_entity_grain',
      'entity_state_taxonomy_declared_for_longitudinal',
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

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1061 — the PDD silently regressed from a native Google
// Doc to text/markdown between two runs of the SAME opp, six days apart:
//
//   20260722-1341 → application/vnd.google-apps.document  (Sophie left 9 anchored comments)
//   20260728-0705 → text/markdown                         (no comment gutter at all)
//
// The PDD is the ONE artifact in the pipeline whose purpose is to be argued
// with by a human; every other Phase-1 output is machine-facing. Ship it as
// markdown and the whole feedback→ledger→next-run loop has no entry point —
// and the failure is silent in both directions, because every CONTENT check
// still passes. Format is exactly the property that regresses invisibly, so it
// needs a check of its own.
// ---------------------------------------------------------------------------

describe('checkPddIsNativeGoogleDoc (#1061)', () => {
  const GDOC = 'application/vnd.google-apps.document';

  test('passes when the artifact is a native Google Doc', () => {
    expect(checkPddIsNativeGoogleDoc({ artifactMimeType: GDOC }).pass).toBe(true);
  });

  test('fails on text/markdown — the exact regression — and names the fixing atom', () => {
    const r = checkPddIsNativeGoogleDoc({ artifactMimeType: 'text/markdown' });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/text\/markdown/);
    expect(r.auto_fix_hint).toMatch(/drive_create_doc_from_markdown/);
  });

  test('fails on any other non-Doc mimeType (pdf, plain text)', () => {
    for (const mime of ['application/pdf', 'text/plain', 'application/octet-stream']) {
      expect(checkPddIsNativeGoogleDoc({ artifactMimeType: mime }).pass).toBe(false);
    }
  });

  test('fails — does NOT silently pass — when the mimeType was not supplied', () => {
    // An unverifiable format check must not report success: "nobody checked"
    // is how this regression shipped in the first place. The hint points at
    // the RUNNER (pass --artifact-mime-type), not at the PDD's content, so
    // the orchestrator does not burn an auto-fix rewriting a healthy doc.
    const r = checkPddIsNativeGoogleDoc({});
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toMatch(/--artifact-mime-type/);
    // …and it must steer the orchestrator AWAY from an auto-fix rewrite,
    // since the PDD's content is not what failed.
    expect(r.auto_fix_hint).toMatch(/do NOT regenerate/i);
  });

  test('is registered in CHECKS and reads its mimeType from ctx', () => {
    const entry = CHECKS.find((c) => c.id === 'pdd_is_native_google_doc');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('static');
    expect(entry!.run('# PDD\n', { artifactMimeType: GDOC })).toMatchObject({ pass: true });
    expect(entry!.run('# PDD\n', { artifactMimeType: 'text/markdown' })).toMatchObject({
      pass: false,
    });
  });
});

describe('checkProgramParametersCoherent', () => {
  const table = (rows: string) =>
    `# PDD\n\n## Program Parameters\n\n| Key | Value |\n|---|---|\n${rows}\n\n## Next\n\nx\n`;

  test('passes on a coherent table', () => {
    const r = checkProgramParametersCoherent(
      table('| learn_passing_score | 100 |\n| assessment_items | 6 |\n| payment_rate_min | 1.00 |\n| payment_rate_max | 2.50 |'),
    );
    expect(r.pass).toBe(true);
  });

  test('fails when the section is absent', () => {
    const r = checkProgramParametersCoherent('# PDD\n\n## Timeline\n\nx\n');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no § Program Parameters');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when the table has no parseable data rows', () => {
    const r = checkProgramParametersCoherent(
      '# PDD\n\n## Program Parameters\n\nTBD.\n\n## Next\n\nx\n',
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no parseable');
  });

  test('rejects a passing score outside 0-100', () => {
    const r = checkProgramParametersCoherent(table('| learn_passing_score | 150 |'));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('0-100');
  });

  // The bednet case: 90% over 6 items is unreachable except by scoring all six,
  // so the gate is really 100% while every downstream doc says 90.
  test('flags a threshold only attainable at 100%', () => {
    const r = checkProgramParametersCoherent(
      table('| learn_passing_score | 90 |\n| assessment_items | 6 |'),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('effectively 100%');
  });

  test('does NOT flag a threshold that is genuinely attainable below 100', () => {
    // 80 over 5 items: 4/5 = 80 clears it, so k(4) < items(5) — coherent.
    const r = checkProgramParametersCoherent(
      table('| learn_passing_score | 80 |\n| assessment_items | 5 |'),
    );
    expect(r.pass).toBe(true);
  });

  test('does NOT flag an explicit 100% gate', () => {
    const r = checkProgramParametersCoherent(
      table('| learn_passing_score | 100 |\n| assessment_items | 6 |'),
    );
    expect(r.pass).toBe(true);
  });

  test('flags an inverted rate band', () => {
    const r = checkProgramParametersCoherent(
      table('| payment_rate_min | 4.00 |\n| payment_rate_max | 2.00 |'),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('exceeds payment_rate_max');
  });

  test('flags a cap that can never bind', () => {
    const r = checkProgramParametersCoherent(
      table('| flw_count_min | 2 |\n| total_cap_per_flw | 30 |\n| expected_reach_max | 30 |'),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('can never bind');
  });

  test('accepts a non-binding cap once cap_rationale acknowledges it', () => {
    const r = checkProgramParametersCoherent(
      table('| flw_count_min | 2 |\n| total_cap_per_flw | 30 |\n| expected_reach_max | 30 |\n| cap_rationale | Fraud ceiling, not a throughput target. |'),
    );
    expect(r.pass).toBe(true);
  });

  // Every rule must skip silently when an operand is missing — QA is binary
  // with no warn tier, so a half-specified table must not manufacture a failure.
  test('skips rules whose operands are absent', () => {
    const r = checkProgramParametersCoherent(table('| entity_id_grain | username + visit date |'));
    expect(r.pass).toBe(true);
  });

  test('is registered in CHECKS', () => {
    expect(CHECKS.map((c) => c.id)).toContain('program_parameters_coherent');
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1617 — the #991 ordinal class, reintroduced through the
// EXPORT read path. `SKILL.md` § Process step 1 mandates reading the PDD with
// `exportAs: 'text/markdown'`, and Drive's markdown exporter backslash-escapes
// a numbered H2 (`## 1. Archetype` → `## 1\. Archetype`) because a bare `1.`
// at line start would otherwise read as an ordered-list marker. Every
// heading-anchored check reads through ORDINAL_PREFIX, so one cause reported
// all 12 required sections plus four section-bodied checks as missing on a
// healthy PDD, and Phase 1 halted.
//
// Measured on hh-poverty-targeting/20260824-1404: the SAME document scored
// 9/9 from local markdown and 4/9 after the Drive round-trip. These tests pin
// the round-trip half — #991 was fixed once and regressed through a different
// reader, so the invariant is "escaped and unescaped score identically", not
// "the regex has a backslash in it".
// ---------------------------------------------------------------------------

/**
 * Reproduce Google Drive's `text/markdown` export escaping.
 *
 * Deliberately narrow to what a real export was observed to emit (ace#1609
 * captured `\_`, `\.`, `\[`, `\]`, `\#`; ace#1617 quotes the `## 1\.` heading
 * form): a trailing ordinal period, underscores inside snake_case keys, and
 * square brackets around reviewer-comment markers. `### 6.1` is NOT escaped —
 * only a trailing period triggers it.
 */
function driveMarkdownExport(md: string): string {
  return md
    .replace(/^(#{1,6}\s+\d+(?:\.\d+)*)\.(\s)/gm, '$1\\.$2')
    .replace(/_/g, '\\_')
    .replace(/([[\]])/g, '\\$1');
}

/** `SECTIONS_FULL` with every H2 numbered, the way a producer mirrors a numbered source PDD. */
function numberH2s(md: string): string {
  let n = 0;
  return md.replace(/^## (?!$)/gm, () => `## ${++n}. `);
}

describe('Drive markdown-export escaping (#1617)', () => {
  const numbered = numberH2s(SECTIONS_FULL);
  const exported = driveMarkdownExport(numbered);

  test('the fixture really is escaped the way Drive exports it', () => {
    // Guards the test itself: if driveMarkdownExport stopped escaping, every
    // assertion below would pass vacuously.
    expect(exported).toContain('## 1\\. Archetype');
    expect(exported).toContain('## 2\\. Problem Statement');
    expect(exported).toContain('learn\\_passing\\_score');
  });

  test('check 1 resolves every required section from an escaped export', () => {
    const r = checkAllRequiredSectionsPresent(exported);
    expect(r.pass).toBe(true);
    expect(r.detail).toBeUndefined();
  });

  test('tolerates an escaped multi-level ordinal (`## 4\\.2 Target Population`)', () => {
    const pdd = SECTIONS_FULL.replace(
      '## Target Population',
      '## 4\\.2 Target Population',
    );
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('tolerates an escaped ordinal on BOTH separators (`## 4\\.2\\. Target Population`)', () => {
    const pdd = SECTIONS_FULL.replace(
      '## Target Population',
      '## 4\\.2\\. Target Population',
    );
    expect(checkAllRequiredSectionsPresent(pdd).pass).toBe(true);
  });

  test('still rejects a truncated section name in an escaped export', () => {
    const pdd = driveMarkdownExport(
      numbered.replace(/^## (\d+)\. Target Population$/m, '## $1. Target Pop'),
    );
    const r = checkAllRequiredSectionsPresent(pdd);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Target Population');
  });

  // The four secondary failures from the repro — all of them anchor through
  // extractSection, so they came from the same single cause.
  test('check 3 finds the stress-test appendix in an escaped export', () => {
    expect(checkStressTestAppendixPresent(exported).pass).toBe(true);
  });

  test('check 4 counts Success Metrics rows in an escaped export', () => {
    expect(checkSuccessMetricsTablePopulated(exported).pass).toBe(true);
  });

  test('check 5 finds all three evidence layers in an escaped export', () => {
    expect(checkEvidenceModelLayered(exported).pass).toBe(true);
  });

  test('check 7 parses escaped snake_case Program Parameters keys', () => {
    // `learn\_passing\_score` must resolve to `learn_passing_score`; an
    // unresolved key reads as "no parseable rows" and fails the check.
    const r = checkProgramParametersCoherent(exported);
    expect(r.pass).toBe(true);
  });

  test('check 2 reads the archetype out of an escaped export', () => {
    expect(checkArchetypeDeclared(exported).detail).toBe('atomic-visit');
  });

  test('check 6 sees escaped reviewer markers and counts the disposition table', () => {
    const withComments = driveMarkdownExport(
      `${numbered}\n## 14. Reviewer Comments — Disposition\n\n| Marker | Disposition |\n| --- | --- |\n| [a] | Honoured in § 6.1 |\n`,
    );
    const r = checkReviewerCommentTableIfReferenced(withComments);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/disposition row/);
  });

  // The end-to-end shape of the repro: 4/9 before the fix, 9/9 after — and
  // identical to the same document read as local markdown.
  test('all 9 checks score an escaped export exactly as they score the source', () => {
    const ctx = { artifactMimeType: 'application/vnd.google-apps.document' };
    const score = (pdd: string) =>
      CHECKS.map((c) => {
        const r = c.run(pdd, ctx);
        // Every check in this skill is static/sync; narrow rather than await
        // so an accidentally-async check fails loudly instead of comparing
        // two identical Promises and passing vacuously.
        if (r instanceof Promise) throw new Error(`${c.id} returned a Promise`);
        return `${c.id}=${r.pass}`;
      });
    expect(score(exported)).toEqual(score(numbered));
    expect(score(exported).filter((s) => s.endsWith('=true'))).toHaveLength(10);
  });
});
