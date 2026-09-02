/**
 * ace#1829 — the training deck invented its own Learn module numbering, and
 * instructed a worker to open a module that does not exist.
 *
 * The producer numbered the Learn suite two incompatible ways in ONE deck: the
 * reference section printed the app's names correctly while the practice
 * section renumbered from list position, counting the unnumbered
 * `Pre-Assessment` tile as Module 1. Slides 34-39 are TIMED hands-on blocks, so
 * a first-day FLW follows "Complete Learn Module 4: What Makes a Visit Payable",
 * opens the app, finds Module 3 under that name, and stalls.
 *
 * The detector lives in `lib/deck-module-labels.ts` and is unit-tested. This
 * file holds the SKILL text to actually using it — the same argument
 * `deliver-l0-loop-integrity.test.ts` makes: a rule stated in prose and never
 * run is how the defect shipped in the first place. The producer's step-11
 * self-eval already counted practice slides, and the shipped deck passed that
 * count with every one of those slides carrying a wrong number.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(REPO_ROOT, 'skills/training-deck-generate/SKILL.md');
const text = fs.readFileSync(SKILL, 'utf8');

describe('training-deck-generate binds module labels to the app', () => {
  it('runs the check rather than only describing the rule', () => {
    expect(
      text.includes('checkDeckModuleLabels'),
      'The skill never calls checkDeckModuleLabels. Module labels are then ' +
        'whatever the generator counted, and the slide-count check cannot ' +
        'catch it — counting confirms one slide per module while every slide ' +
        'carries the wrong number (ace#1829).',
    ).toBe(true);
    expect(text).toContain('lib/deck-module-labels');
  });

  it('the label check is a FAIL, not a warn', () => {
    // A worker cannot act on a warn. The instruction is either followable or
    // it is not.
    const idx = text.indexOf('checkDeckModuleLabels');
    const block = text.slice(Math.max(0, idx - 2000), idx + 2000);
    expect(block).toMatch(/HARD GATE|FAIL on any finding/);
  });

  it('the unnumbered app entries must be passed IN, not filtered out', () => {
    // Pre-Assessment is the entry that caused the off-by-one. Dropping it from
    // the check's input hides the exact defect the check exists to catch.
    const idx = text.indexOf('checkDeckModuleLabels');
    const block = text.slice(idx, idx + 2000);
    expect(block).toMatch(/including unnumbered/i);
  });

  it('the practice-slide title template no longer synthesises an ordinal', () => {
    expect(
      text.includes('Complete Learn Module N:'),
      'The practice module still templates a synthesised ordinal ' +
        '("Complete Learn Module N: <module-name>"). The app\'s module names ' +
        'already carry their own numbers, so a number derived from slide ' +
        'position can only disagree with them (ace#1829).',
    ).toBe(false);
  });

  it('both Learn-facing sections say the label is lifted verbatim', () => {
    // The reference section was accidentally correct — it had no template at
    // all. Making the rule explicit in both places is what stops the two
    // sections drifting apart again.
    const verbatimMentions = [...text.matchAll(/verbatim/gi)].length;
    expect(verbatimMentions).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/NEVER synthesise an ordinal/i);
  });

  it('names where the authoritative labels come from', () => {
    // Two sources that agree, so "I could not find them" is not available.
    expect(text).toContain('pdd-to-learn-app_summary.md');
    expect(text).toContain('learn-tap-module-after-');
  });
});
