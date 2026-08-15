/**
 * ace#1395 — two scenes made claims the frames they sit on cannot carry, and
 * both PASSED the existing falsifiability gate (`concept_claim` ≥5 words, no
 * marketing filler). Falsifiable in form, wrong in substance.
 *
 * The gate is necessary and not sufficient, so the three shapes are named
 * explicitly in the skill. This asserts they stay named — the same walkthrough
 * had already been through a correction pass that dropped one of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = readFileSync(
  join(__dirname, '../../skills/demo-narrative/SKILL.md'),
  'utf8',
);

describe('the three overreach shapes are named (ace#1395)', () => {
  it('says plainly that the falsifiability gate is not sufficient', () => {
    expect(skill).toMatch(/necessary and not sufficient/);
  });

  it('1 — renaming the quantity: use the label the panel shows', () => {
    expect(skill).toMatch(/FACILITATOR EARNINGS/);
    expect(skill).toMatch(/Use the label the panel actually\s*\n?\s*shows/);
  });

  it('2 — causality from n=1 needs a baseline or a weaker claim', () => {
    expect(skill).toMatch(/Causality from n=1/);
    expect(skill).toMatch(/cohort/);
  });

  it('3 — a summary adjective must match the plotted series', () => {
    // The specific numbers matter: they are what makes "low fifties" checkable.
    expect(skill).toContain('52.5');
    expect(skill).toContain('57.6');
    expect(skill).toMatch(/read the rendered numbers/i);
  });

  it('records that shape 3 survived a correction pass', () => {
    // Which is why "re-read it carefully" is not the fix.
    expect(skill).toMatch(/survived an\s*\n?\s*explicit narration-correction pass/);
  });

  it('bans build notes from funder-facing copy', () => {
    expect(skill).toMatch(/No build notes in funder-facing copy/);
    expect(skill).toMatch(/inline style/);
  });
});
