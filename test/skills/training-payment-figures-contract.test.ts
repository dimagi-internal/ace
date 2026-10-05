/**
 * ace#2683 / ace#2684 — every training skill links the shared payment-figures
 * + payment-channel contract, and no training skill tells its writer that the
 * LLO pays "off-platform" or that Connect pays "without manual intervention".
 *
 * Earned on spark-facilitator/20261004-1706: all five training documents
 * printed the configured MWK 7,500 as THE rate while the PDD marked the band
 * [PROPOSED], and the LLO guide's "you pay CBFs off-platform" contradicted the
 * answer key's "paid by Connect without manual intervention" (deep OCS QA,
 * [ANSWER-KEY-CONTRADICTS-CORPUS] opp-40).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const TRAINING_SKILLS = [
  'training-llo-guide',
  'training-flw-guide',
  'training-faq',
  'training-quick-reference',
  'training-onboarding-email',
  'training-deck-generate',
];

const SECTION = '§ Payment figures and payment channel';

describe('training payment-figures contract (ace#2683, ace#2684)', () => {
  it('the shared template defines the contract with both rules', () => {
    const t = read('skills/_training-template.md');
    expect(t).toContain('## Payment figures and payment channel — one contract, all six skills');
    expect(t).toMatch(/\[PROPOSED\]` figure is printed as proposed/);
    expect(t).toContain("Connect's standard worker payment");
  });

  for (const skill of TRAINING_SKILLS) {
    it(`${skill} links the shared contract`, () => {
      expect(read(`skills/${skill}/SKILL.md`)).toContain(SECTION);
    });
  }

  it('no training skill instructs the writer to say the LLO pays off-platform', () => {
    for (const skill of TRAINING_SKILLS) {
      const body = read(`skills/${skill}/SKILL.md`);
      // Allowed only inside the "not off-platform" prohibition itself.
      const hits = body.split('\n').filter(
        (l) => /off-platform/i.test(l) && !/not\s+"?off-platform|never as "off-platform"|as "off-platform"/i.test(l),
      );
      expect(hits, skill).toEqual([]);
    }
  });

  it('pdd-to-test-prompts forbids the "paid by Connect without manual intervention" expectation', () => {
    const body = read('skills/pdd-to-test-prompts/SKILL.md');
    expect(body).toContain('ace#2684');
    expect(body).toContain('never "paid by Connect without');
  });
});
