/**
 * Unit tests for static QA checks in skills/pdd-to-test-prompts-qa/checks.ts.
 */

import { describe, expect, test } from 'vitest';
import {
  checkHeaderWithTotalCount,
  checkPromptCountInRange,
  checkEachPromptHasRequiredFields,
  checkAdversarialCoverage,
  checkAdversarialShareMinimum,
  checkTrainingGapPromptPresent,
  checkProductFeedbackPromptPresent,
  checkEscalationPromptPresent,
  normalizeDriveExport,
  CHECKS,
} from '../../../skills/pdd-to-test-prompts-qa/checks';

function makePrompt(n: number, category: string, opts: { tags?: string; escalation?: string } = {}): string {
  return `\n## Prompt ${n}
**Category:** ${category}
**Question:** Test question ${n}?
**Expected answer summary:** A specific answer about the program scope at step ${n}.
**Expected tags:** ${opts.tags ?? 'none'}
**Expected escalation:** ${opts.escalation ?? 'none'}\n`;
}

const ALL_CATEGORIES = [
  'intervention-basics',
  'escalation',
  'should-refuse',
  'out-of-scope',
  'hallucination-probe',
  'leading-question',
  'negative-frame',
  'safety-critical',
  'ambiguous-intent',
];

function buildValidDoc(): string {
  // 14 prompts: 7 in cross-archetype categories + 7 adversarial = 50% adversarial.
  // training-gap + product-feedback + escalation prompts included.
  const prompts: string[] = [];
  prompts.push(makePrompt(1, 'intervention-basics'));
  prompts.push(makePrompt(2, 'intervention-basics', { tags: '[training-gap]' }));
  prompts.push(makePrompt(3, 'intervention-basics', { tags: '[product-feedback]' }));
  prompts.push(makePrompt(4, 'escalation', { escalation: 'ace@dimagi-ai.com' }));
  prompts.push(makePrompt(5, 'flw-visit-flow'));
  prompts.push(makePrompt(6, 'eligibility-edge'));
  prompts.push(makePrompt(7, 'data-quality'));
  prompts.push(makePrompt(8, 'should-refuse'));
  prompts.push(makePrompt(9, 'out-of-scope'));
  prompts.push(makePrompt(10, 'hallucination-probe'));
  prompts.push(makePrompt(11, 'leading-question'));
  prompts.push(makePrompt(12, 'negative-frame'));
  prompts.push(makePrompt(13, 'safety-critical'));
  prompts.push(makePrompt(14, 'ambiguous-intent'));
  return `# OCS Test Prompts — Test\nDerived from: pdd.md (rev 2026-01-01)\nTotal prompts: 14\n${prompts.join('')}`;
}

const VALID_DOC = buildValidDoc();

describe('checkHeaderWithTotalCount', () => {
  test('passes with valid header', () => {
    expect(checkHeaderWithTotalCount(VALID_DOC).pass).toBe(true);
  });

  test('fails when title missing', () => {
    expect(checkHeaderWithTotalCount('Total prompts: 12\n## Prompt 1\n').pass).toBe(false);
  });

  test('fails when Total prompts line missing', () => {
    expect(checkHeaderWithTotalCount('# OCS Test Prompts\n## Prompt 1\n').pass).toBe(false);
  });

  test('fails when declared count mismatches actual', () => {
    const doc = `# Test Prompts\nTotal prompts: 99\n${makePrompt(1, 'x')}`;
    const r = checkHeaderWithTotalCount(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('99');
  });
});

describe('checkPromptCountInRange', () => {
  test('passes with 12 prompts', () => {
    expect(checkPromptCountInRange(VALID_DOC).pass).toBe(true);
  });

  test('fails with 7 prompts', () => {
    let doc = '# Test Prompts\nTotal prompts: 7\n';
    for (let i = 1; i <= 7; i++) doc += makePrompt(i, 'x');
    const r = checkPromptCountInRange(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('7');
  });

  test('fails with >80 prompts', () => {
    let doc = '# Test Prompts\nTotal prompts: 81\n';
    for (let i = 1; i <= 81; i++) doc += makePrompt(i, 'x');
    expect(checkPromptCountInRange(doc).pass).toBe(false);
  });
});

describe('checkEachPromptHasRequiredFields', () => {
  test('passes when all prompts well-formed', () => {
    expect(checkEachPromptHasRequiredFields(VALID_DOC).pass).toBe(true);
  });

  test('fails when a prompt is missing Question', () => {
    const doc = VALID_DOC.replace('**Question:** Test question 5?\n', '');
    const r = checkEachPromptHasRequiredFields(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Prompt 5');
    expect(r.detail).toContain('Question');
  });
});

describe('checkAdversarialCoverage', () => {
  test('passes when all 7 adversarial categories present', () => {
    expect(checkAdversarialCoverage(VALID_DOC).pass).toBe(true);
  });

  test('fails when one adversarial category missing', () => {
    // Drop the leading-question prompt
    const doc = VALID_DOC.replace(makePrompt(11, 'leading-question'), '').replace('Total prompts: 14', 'Total prompts: 13');
    const r = checkAdversarialCoverage(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('leading-question');
  });
});

describe('checkAdversarialShareMinimum', () => {
  test('passes at 50% adversarial (above 20% floor)', () => {
    expect(checkAdversarialShareMinimum(VALID_DOC).pass).toBe(true);
  });

  test('fails when share below 20%', () => {
    // 20 prompts, 1 adversarial = 5%
    let doc = '# Test Prompts\nTotal prompts: 20\n';
    for (let i = 1; i <= 19; i++) doc += makePrompt(i, 'intervention-basics');
    doc += makePrompt(20, 'should-refuse');
    const r = checkAdversarialShareMinimum(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('5%');
  });

  test('fails at 15% — below the raised 20% floor (guards jjackson/ace#767)', () => {
    // 20 prompts, 3 adversarial = 15%: passed under the old 15% floor, must fail now.
    let doc = '# Test Prompts\nTotal prompts: 20\n';
    for (let i = 1; i <= 17; i++) doc += makePrompt(i, 'intervention-basics');
    doc += makePrompt(18, 'should-refuse');
    doc += makePrompt(19, 'out-of-scope');
    doc += makePrompt(20, 'safety-critical');
    const r = checkAdversarialShareMinimum(doc);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('15%');
  });
});

describe('checkTrainingGapPromptPresent', () => {
  test('passes when at least one prompt has training-gap tag', () => {
    expect(checkTrainingGapPromptPresent(VALID_DOC).pass).toBe(true);
  });

  test('fails when no training-gap prompt', () => {
    const doc = VALID_DOC.replace('[training-gap]', 'none');
    expect(checkTrainingGapPromptPresent(doc).pass).toBe(false);
  });
});

describe('checkProductFeedbackPromptPresent', () => {
  test('passes when at least one product-feedback prompt', () => {
    expect(checkProductFeedbackPromptPresent(VALID_DOC).pass).toBe(true);
  });

  test('fails when no product-feedback prompt', () => {
    const doc = VALID_DOC.replace('[product-feedback]', 'none');
    expect(checkProductFeedbackPromptPresent(doc).pass).toBe(false);
  });
});

describe('checkEscalationPromptPresent', () => {
  test('passes when escalation prompt mentions ace@', () => {
    expect(checkEscalationPromptPresent(VALID_DOC).pass).toBe(true);
  });

  test('fails when no escalation prompts', () => {
    const doc = VALID_DOC.replace('ace@dimagi-ai.com', 'none');
    expect(checkEscalationPromptPresent(doc).pass).toBe(false);
  });
});

describe('CHECKS array', () => {
  test('exports 8 checks in stable order', () => {
    expect(CHECKS).toHaveLength(8);
    expect(CHECKS.map((c) => c.id)).toEqual([
      'header_with_total_count',
      'prompt_count_in_range',
      'each_prompt_has_required_fields',
      'adversarial_coverage',
      'adversarial_share_minimum',
      'training_gap_prompt_present',
      'product_feedback_prompt_present',
      'escalation_prompt_present',
    ]);
  });
});

// ── Export-format independence (dimagi-internal/ace#2169) ──────────
//
// `pdd-to-test-prompts` writes this artifact with `drive_create_file`, which
// lands a Google Doc but uploads the body as `text/plain` media — so Drive
// never runs the markdown→styles conversion and the `#` / `**` markers stay
// LITERAL characters. `drive_read_file`'s `text/markdown` export therefore has
// to ESCAPE them to preserve them, which deletes every anchor these checks
// match at once.
//
// Measured on the real artifact for `bednet-check-2-visit/20260907-1126`
// (fileId 1l0satmkozVVDH0A0vcjw3u6bjFQsgZs3G5OXcDb4X8E, revision 7, 58
// prompts, structurally correct): 8/8 on the plain export, 2/8 on the markdown
// export — 0 prompts found, and the two remaining "passes" vacuous, because an
// empty prompt list has no missing fields and no adversarial share to fall
// short of. SKILL.md § Process step 1 mandates `text/plain`; these tests pin
// the CLASS — the checks must score the same document identically whichever
// export the caller used.
describe('export-format independence (ace#2169)', () => {
  /**
   * Mimic Drive's markdown exporter over a doc whose body is literal markdown:
   * escape markdown-significant punctuation and end lines with the two-space
   * hard break it emits. Reproduces the observed `\#\# Prompt 4  ` /
   * `\*\*Category:\*\*` shape.
   */
  function asDriveMarkdownExport(doc: string): string {
    return doc
      .split('\n')
      .map((line) => {
        const escaped = line.replace(/([#*[\]_.+\-`])/g, '\\$1');
        return escaped.trim().length > 0 ? `${escaped}  ` : escaped;
      })
      .join('\n');
  }

  const MD_EXPORT = asDriveMarkdownExport(VALID_DOC);

  test('the fixture really is escaped the way Drive escapes it', () => {
    expect(MD_EXPORT).toContain('\\#\\# Prompt 4');
    expect(MD_EXPORT).toContain('\\*\\*Category:\\*\\*');
    expect(MD_EXPORT).not.toMatch(/^## Prompt 4/m);
  });

  test('normalizeDriveExport restores every anchor the checks match', () => {
    expect(normalizeDriveExport('\\#\\# Prompt 4')).toBe('## Prompt 4');
    expect(normalizeDriveExport('\\*\\*Category:\\*\\*')).toBe('**Category:**');
    // A non-punctuation escape is not a markdown escape — leave it alone.
    expect(normalizeDriveExport('a\\nb')).toBe('a\\nb');
  });

  test('the markdown export of a healthy suite passes every check', () => {
    const failures = CHECKS.filter(
      (c) => !(c.run as (d: string) => { pass: boolean })(MD_EXPORT).pass,
    ).map((c) => c.id);
    expect(failures).toEqual([]);
  });

  test('both exports of the same document score identically', () => {
    const score = (doc: string) =>
      CHECKS.map((c) => `${c.id}:${(c.run as (d: string) => { pass: boolean })(doc).pass}`);
    expect(score(MD_EXPORT)).toEqual(score(VALID_DOC));
  });

  test('a genuinely broken suite still fails under the markdown export', () => {
    // Guard against "normalise everything into a pass": drop the heading and
    // the check must still fail after normalisation.
    const broken = asDriveMarkdownExport(VALID_DOC.replace('# OCS Test Prompts — Test\n', ''));
    expect(checkHeaderWithTotalCount(broken).pass).toBe(false);
  });
});
