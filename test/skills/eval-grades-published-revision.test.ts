import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ace#2592 (spark-facilitator/20261001-2208) — `training-faq-eval` scored 8.4 `pass` for a published FAQ that
 * was EMPTY. It read the doc (revision 8), revised the local draft, the
 * republish emptied the doc, and the verdict was written from the draft.
 *
 * The contract lives once in `_eval-template.md § Grade the published
 * revision (stock)`; every Phase 6 document eval must route step 1 through it.
 */

const SKILLS = join(__dirname, '..', '..', 'skills');
const SECTION = '## Grade the published revision (stock)';
const POINTER = '§ Grade the published revision (stock)';

const PHASE6_DOC_EVALS = [
  'training-faq-eval',
  'training-quick-reference-eval',
  'training-deck-generate-eval',
  'training-flw-guide-eval',
  'training-llo-guide-eval',
  'training-onboarding-email-eval',
];

/** Step 1 of `## Process` must cite the stock read-back contract. */
export function processStep1CitesPublishedRead(body: string): boolean {
  const process = body.split(/^## Process\s*$/m)[1];
  if (!process) return false;
  const step1 = process.split(/^2\. /m)[0];
  return step1.includes(POINTER);
}

describe('eval template — the published-revision contract (ace#2592)', () => {
  const tpl = readFileSync(join(SKILLS, '_eval-template.md'), 'utf-8');

  it('defines the stock section with its three rules', () => {
    expect(tpl).toContain(SECTION);
    const section = tpl.split(SECTION)[1].split(/^## /m)[0];
    expect(section).toMatch(/graded_revision/);
    expect(section).toMatch(/graded_total_length/);
    expect(section).toMatch(/BLOCKER/);
    expect(section).toMatch(/AFTER the republish/);
  });

  for (const skill of PHASE6_DOC_EVALS) {
    it(`${skill} reads the PUBLISHED artifact in Process step 1`, () => {
      const body = readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf-8');
      expect(processStep1CitesPublishedRead(body)).toBe(true);
    });
  }

  it('negative control: the pre-fix step 1 is caught', () => {
    const preFix = '## Process\n\n1. Read inputs from Drive.\n2. Build a catalogue.\n';
    expect(processStep1CitesPublishedRead(preFix)).toBe(false);
  });

  it('negative control: a pointer outside step 1 does not count', () => {
    const misplaced =
      `## Process\n\n1. Read inputs from Drive.\n2. Grade. See ${POINTER}.\n`;
    expect(processStep1CitesPublishedRead(misplaced)).toBe(false);
  });
});
