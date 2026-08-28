/**
 * dimagi-internal/ace#1770 — a REQUIRED PDD section that no producer tells
 * anyone to write.
 *
 * `idea-to-pdd-qa`'s `REQUIRED_SECTIONS` has hard-gated on `Program
 * Parameters` (blocker on both `all_required_sections_present` and
 * `program_parameters_coherent`) while `skills/idea-to-pdd/SKILL.md § Process
 * step 4` — the producer's canonical base-section list — never named it:
 * `grep -n "Program Parameters" skills/idea-to-pdd/SKILL.md` returned ZERO.
 * Both the `SECTION_PURPOSES` docblock and the emitted `auto_fix_hint` claimed
 * that list as their source, so the failure hint sent the producer to a list
 * that did not contain the section it was being told to add.
 *
 * Effect: every Phase 1 run failed QA attempt 1 deterministically and spent one
 * of its two auto-fix attempts rediscovering a structural defect, not an
 * authorial one. Observed on `bednet-check-2-visit/20260828-0629`.
 *
 * Exact sibling of `test/required-product-keys-producible.test.ts` (#1286):
 * hardening a machine contract without teaching the producer turns the check
 * into a speed bump every run repairs. This floor makes the class
 * structurally impossible — tightening `REQUIRED_SECTIONS` without teaching
 * `idea-to-pdd` now fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { REQUIRED_SECTIONS } from '../../../skills/idea-to-pdd-qa/checks.js';

const PRODUCER = 'skills/idea-to-pdd/SKILL.md';

function read(rel: string): string {
  return readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf-8');
}

describe('every REQUIRED_SECTION is teachable from the producer (#1770)', () => {
  const producer = read(PRODUCER);

  it.each(REQUIRED_SECTIONS.map((s) => [s]))(
    '`%s` is named in the producer SKILL.md',
    (section) => {
      expect(
        producer.includes(section),
        `idea-to-pdd-qa hard-gates on § ${section}, but ${PRODUCER} never mentions it. ` +
          `A producer following the skill verbatim will fail QA attempt 1 on EVERY run and ` +
          `burn an auto-fix attempt on a structural defect. Add it to § Process step 4's ` +
          `base-sections list (with its purpose) in the same change that requires it.`,
      ).toBe(true);
    },
  );

  it('the base-sections list in § Process step 4 covers the required set', () => {
    const start = producer.indexOf('**Base sections (all archetypes):**');
    expect(start, `base-sections list not found in ${PRODUCER}`).toBeGreaterThan(-1);
    // The list ends where step 4a begins.
    const end = producer.indexOf('\n4a.', start);
    expect(end, `step 4a marker not found after the base-sections list in ${PRODUCER}`).toBeGreaterThan(start);
    const list = producer.slice(start, end);
    for (const section of REQUIRED_SECTIONS) {
      expect(
        list.includes(section),
        `§ ${section} is required by idea-to-pdd-qa but is not a bullet in ` +
          `${PRODUCER} § Process step 4's base-sections list — which is the list both the ` +
          `SECTION_PURPOSES docblock and the all_required_sections_present auto_fix_hint cite.`,
      ).toBe(true);
    }
  });
});
