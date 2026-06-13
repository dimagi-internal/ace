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
