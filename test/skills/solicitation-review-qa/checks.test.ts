/**
 * Unit tests for static QA checks in skills/solicitation-review-qa/checks.ts.
 *
 * Each check is a pure function. Tests use small inline strings (no fixtures)
 * to exercise individual branches.
 */

import { describe, expect, test } from 'vitest';
import {
  checkRecommendationSectionPresent,
  checkAwardeeNamed,
  checkAwardeeReasoningSubstantive,
  checkAllResponsesScored,
  checkCriteriaCoverageTablePopulated,
  checkScoringTableWellFormed,
  checkTieBreakResolved,
  checkNoAwardActionYet,
  normalizeDriveExport,
  CHECKS,
} from '../../../skills/solicitation-review-qa/checks';

const REC_FULL = `# Solicitation Review — Recommendation

## Summary

Reviewed 3 responses for the turmeric-market-survey opportunity.

## Criteria Coverage

| Criterion | Weight | Coverage Notes |
|---|---|---|
| Geographic Coverage | 0.30 | All 3 responses cover Tamil Nadu |
| FLW Capacity        | 0.30 | LLO-A claims 50 FLWs; LLO-B 30; LLO-C 20 |
| Domain Experience   | 0.40 | LLO-A has 5y in agri-extension |

## Recommendation

response_id: resp-42
org_slug: ngo-alpha

We recommend awarding to NGO Alpha based on Geographic Coverage and FLW Capacity. Their Domain Experience scores highest at 9/10 across all reviewers. The scoring rubric places them 1.5 points above the next contender.

## Tie-Break

Not applicable — top-two gap was 1.5.
`;

const SCORING_FULL = `# Scoring Rubric

| response_id | score | rationale |
|---|---|---|
| resp-42 | 8.5 | Strong on coverage and experience |
| resp-43 | 7.0 | Smaller team but local |
| resp-44 | 6.5 | Limited domain experience |
`;

describe('checkRecommendationSectionPresent', () => {
  test('passes when section present', () => {
    expect(checkRecommendationSectionPresent(REC_FULL).pass).toBe(true);
  });
  test('passes with bold-wrapped heading', () => {
    expect(checkRecommendationSectionPresent('## **Recommendation**\n\nbody').pass).toBe(true);
  });
  test('fails when section missing', () => {
    const r = checkRecommendationSectionPresent('# Doc\n\n## Other\n');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkAwardeeNamed', () => {
  test('passes when response_id named', () => {
    const r = checkAwardeeNamed(REC_FULL);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('resp-42');
  });
  test('passes when org_slug named', () => {
    const doc = `## Recommendation\n\nawardee: ngo-alpha\n`;
    expect(checkAwardeeNamed(doc).pass).toBe(true);
  });
  test('fails when no awardee named', () => {
    const doc = `## Recommendation\n\nWe recommend the strongest response.\n`;
    const r = checkAwardeeNamed(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no specific');
  });
  test('fails on placeholder TBD', () => {
    const doc = `## Recommendation\n\nresponse_id: TBD\n`;
    const r = checkAwardeeNamed(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('placeholder');
  });
  test('fails on angle-bracket placeholder', () => {
    const doc = `## Recommendation\n\nresponse_id: <fill-in>\n`;
    expect(checkAwardeeNamed(doc).pass).toBe(false);
  });
});

describe('checkAwardeeReasoningSubstantive', () => {
  test('passes with 3+ sentences and criterion reference', () => {
    expect(checkAwardeeReasoningSubstantive(REC_FULL).pass).toBe(true);
  });
  test('fails when reasoning under 3 sentences', () => {
    const doc = `## Recommendation\n\nresponse_id: r1\n\nThey looked best.\n`;
    const r = checkAwardeeReasoningSubstantive(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('1 sentence');
  });
  test('fails when no criterion referenced', () => {
    const doc = `## Recommendation\n\nresponse_id: r1\n\nThey were great. We liked them. They were our favorite.\n`;
    const r = checkAwardeeReasoningSubstantive(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('does not reference');
  });
  test('fails when Recommendation section missing', () => {
    const r = checkAwardeeReasoningSubstantive('# Doc\n\n## Other\n');
    expect(r.pass).toBe(false);
  });
});

describe('checkAllResponsesScored', () => {
  test('passes when responseFiles list absent (graceful skip)', () => {
    const r = checkAllResponsesScored(REC_FULL);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('skipped');
  });
  test('passes when all responses are in scoring', () => {
    const r = checkAllResponsesScored(REC_FULL, {
      scoring: SCORING_FULL,
      responseFiles: ['resp-42.md', 'resp-43.md', 'resp-44.md'],
    });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('3 response(s)');
  });
  test('fails when a response is missing from scoring', () => {
    const r = checkAllResponsesScored(REC_FULL, {
      scoring: SCORING_FULL,
      responseFiles: ['resp-42.md', 'resp-43.md', 'resp-44.md', 'resp-99.md'],
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('resp-99');
  });
  test('fails when scoring not provided alongside responseFiles', () => {
    const r = checkAllResponsesScored(REC_FULL, { responseFiles: ['resp-42.md'] });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('scoring-rubric text not provided');
  });
});

describe('checkCriteriaCoverageTablePopulated', () => {
  test('passes when section + rows present', () => {
    expect(checkCriteriaCoverageTablePopulated(REC_FULL).pass).toBe(true);
  });
  test('fails when section missing', () => {
    const doc = `## Recommendation\n\nresponse_id: r1\n`;
    const r = checkCriteriaCoverageTablePopulated(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('missing');
  });
  test('fails when section has empty table', () => {
    const doc = `## Criteria Coverage\n\n| Criterion | Weight |\n|---|---|\n\n## Next\n`;
    const r = checkCriteriaCoverageTablePopulated(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no populated');
  });
  test('passes for "Criterion Coverage" singular spelling', () => {
    const doc = `## Criterion Coverage\n\n| Criterion | Weight |\n|---|---|\n| A | 0.5 |\n`;
    expect(checkCriteriaCoverageTablePopulated(doc).pass).toBe(true);
  });
});

describe('checkScoringTableWellFormed', () => {
  test('passes with well-formed scoring table', () => {
    const r = checkScoringTableWellFormed(REC_FULL, { scoring: SCORING_FULL });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('3 response row');
  });
  test('fails when scoring not provided', () => {
    const r = checkScoringTableWellFormed(REC_FULL);
    expect(r.pass).toBe(false);
  });
  test('fails when required column missing', () => {
    const scoring = `| response_id | score |\n|---|---|\n| r1 | 8 |\n`;
    const r = checkScoringTableWellFormed(REC_FULL, { scoring });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no markdown table');
  });
  test('fails when a required cell is empty', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n| r1 | 8 |  |\n`;
    const r = checkScoringTableWellFormed(REC_FULL, { scoring });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('empty');
  });
  test('fails when no data rows', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n`;
    const r = checkScoringTableWellFormed(REC_FULL, { scoring });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no data rows');
  });
});

describe('checkTieBreakResolved', () => {
  test('passes when scoring not provided (graceful skip)', () => {
    expect(checkTieBreakResolved(REC_FULL).pass).toBe(true);
  });
  test('passes when top-two gap > 0.5 (no tie-break needed)', () => {
    const r = checkTieBreakResolved(REC_FULL, { scoring: SCORING_FULL });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('not required');
  });
  test('passes when fewer than 2 scores', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n| r1 | 8.0 | only one |\n`;
    expect(checkTieBreakResolved(REC_FULL, { scoring }).pass).toBe(true);
  });
  test('fails when within 0.5 and no Tie-Break section', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n| r1 | 8.5 | x |\n| r2 | 8.3 | y |\n`;
    const docNoTie = REC_FULL.replace('## Tie-Break\n\nNot applicable — top-two gap was 1.5.\n', '');
    const r = checkTieBreakResolved(docNoTie, { scoring });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('no § Tie-Break');
  });
  test('passes when within 0.5 and Tie-Break section populated', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n| r1 | 8.5 | x |\n| r2 | 8.3 | y |\n`;
    const doc = `## Recommendation\n\nresponse_id: r1\n\n## Tie-Break\n\nChose r1 because Geographic Coverage edge per PDD priority.\n`;
    expect(checkTieBreakResolved(doc, { scoring }).pass).toBe(true);
  });
  test('fails when Tie-Break section is empty', () => {
    const scoring = `| response_id | score | rationale |\n|---|---|---|\n| r1 | 8.5 | x |\n| r2 | 8.3 | y |\n`;
    const doc = `## Recommendation\n\n## Tie-Break\n\n`;
    const r = checkTieBreakResolved(doc, { scoring });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('empty');
  });
});

describe('checkNoAwardActionYet', () => {
  test('passes for a recommendation with no award-action language', () => {
    expect(checkNoAwardActionYet(REC_FULL).pass).toBe(true);
  });
  test('fails when awarded_at: present', () => {
    const doc = `## Recommendation\n\nresponse_id: r1\nawarded_at: 2026-05-09T12:00:00Z\n`;
    const r = checkNoAwardActionYet(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('awarded_at');
  });
  test('fails when status: awarded present', () => {
    const doc = `## Recommendation\n\nstatus: 'awarded'\n`;
    expect(checkNoAwardActionYet(doc).pass).toBe(false);
  });
  test('fails when "award_response called"', () => {
    const doc = `## Recommendation\n\nWe ran award_response called and confirmed.\n`;
    expect(checkNoAwardActionYet(doc).pass).toBe(false);
  });
  test('passes for "recommend awarding" language (recommendation, not action)', () => {
    const doc = `## Recommendation\n\nresponse_id: r1\n\nWe recommend awarding to NGO Alpha.\n`;
    expect(checkNoAwardActionYet(doc).pass).toBe(true);
  });
});

describe('CHECKS array', () => {
  test('exports eight checks in stable order', () => {
    expect(CHECKS).toHaveLength(8);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'recommendation_section_present',
      'awardee_named',
      'awardee_reasoning_substantive',
      'all_responses_scored',
      'criteria_coverage_table_populated',
      'scoring_table_well_formed',
      'tie_break_resolved',
      'no_award_action_yet',
    ]);
  });
});

describe('export-format independence (ace#2178)', () => {
  /**
   * Mimic Drive's markdown exporter over a doc whose body is literal markdown:
   * escape markdown-significant punctuation and end lines with the two-space
   * hard break it emits. Reproduces the observed `\#\# Recommendation` /
   * `\|` shape. Pipe cells matter here in a way they did not for the
   * test-prompts sibling: checks 5, 6 and 7 all parse markdown TABLES.
   */
  function asDriveMarkdownExport(doc: string): string {
    return doc
      .split('\n')
      .map((line) => {
        const escaped = line.replace(/([#*[\]_.+\-`|>])/g, '\\$1');
        return escaped.trim().length > 0 ? `${escaped}  ` : escaped;
      })
      .join('\n');
  }

  const REC_MD = asDriveMarkdownExport(REC_FULL);
  const SCORING_MD = asDriveMarkdownExport(SCORING_FULL);
  const CTX = { scoring: SCORING_FULL, responseFiles: ['resp-42.json'] };
  const CTX_MD = { scoring: SCORING_MD, responseFiles: ['resp-42.json'] };

  test('the fixture really is escaped the way Drive escapes it', () => {
    expect(REC_MD).toContain('\\#\\# Recommendation');
    expect(REC_MD).not.toMatch(/^## Recommendation/m);
    expect(SCORING_MD).toContain('\\| resp\\-42 ');
    expect(SCORING_MD).not.toMatch(/^\| resp-42/m);
  });

  test('normalizeDriveExport restores every anchor the checks match', () => {
    expect(normalizeDriveExport('\\#\\# Recommendation')).toBe('## Recommendation');
    expect(normalizeDriveExport('\\*\\*Awardee\\*\\*')).toBe('**Awardee**');
    expect(normalizeDriveExport('\\| resp\\-42 \\| 8.5 \\|')).toBe('| resp-42 | 8.5 |');
    // A non-punctuation escape is not a markdown escape — leave it alone.
    expect(normalizeDriveExport('a\\nb')).toBe('a\\nb');
  });

  test('the markdown export of a healthy pair passes every check', () => {
    const failures = CHECKS.filter(
      (c) => !(c.run as (d: string, x?: unknown) => { pass: boolean })(REC_MD, CTX_MD).pass,
    ).map((c) => c.id);
    expect(failures).toEqual([]);
  });

  test('both exports of the same document score identically', () => {
    const score = (rec: string, ctx: unknown) =>
      CHECKS.map(
        (c) =>
          `${c.id}:${(c.run as (d: string, x?: unknown) => { pass: boolean })(rec, ctx).pass}`,
      );
    expect(score(REC_MD, CTX_MD)).toEqual(score(REC_FULL, CTX));
  });

  test('a genuinely broken doc still fails under the markdown export', () => {
    // Guard against "normalise everything into a pass": drop the heading and
    // the check must still fail after normalisation.
    const broken = asDriveMarkdownExport(REC_FULL.replace('## Recommendation', '## Notes'));
    expect(checkRecommendationSectionPresent(broken).pass).toBe(false);
  });

  test('the SAFETY check is not blinded by the wrong export (the ace#2178 bite)', () => {
    // `no_award_action_yet` gates the irreversible award_response call. Under
    // the markdown export, `awarded_at:` escapes to `awarded\_at\:` and the
    // unnormalised pattern misses it — reporting `pass` on a doc that DOES
    // claim an award. Normalisation is what keeps it honest.
    const premature = REC_FULL.replace(
      'response_id: resp-42',
      'response_id: resp-42\nawarded_at: 2026-09-07T14:02:00Z',
    );
    expect(checkNoAwardActionYet(premature).pass).toBe(false);
    const prematureMd = asDriveMarkdownExport(premature);
    expect(prematureMd).not.toContain('awarded_at:');
    expect(checkNoAwardActionYet(prematureMd).pass).toBe(false);
  });
});
