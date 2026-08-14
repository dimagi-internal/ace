/**
 * dimagi-internal/ace#1286 — a REQUIRED handoff key that no producing skill
 * tells anyone to write.
 *
 * `REQUIRED_PRODUCT_KEYS['connect-setup']` has required
 * `products.connect.ace_test_user.invite_row_present` since #1184, but
 * `connect-opp-setup`'s emit template never mentioned it — `grep -rn
 * invite_row_present skills/` returned ZERO. An agent following the skill
 * verbatim wrote a products block that failed `verify_phase_products` at the
 * phase boundary, deterministically, on every Phase 4 run, then repaired it by
 * hand.
 *
 * Worse than ordinary doc drift, because of WHY that key exists — the schema's
 * own comment says it: "Prose in SKILL.md already instructed the read-back and
 * was silently skipped — Phase 4 shipped `done` on a bare HTTP 202, and Phase 6
 * rediscovered the dead invite a whole dispatch later." The structural
 * preventer was added precisely because prose failed, and then the prose it
 * points at was not updated. The check became a speed bump every run repairs,
 * rather than a contract the producer satisfies first time.
 *
 * This floor makes the class structurally impossible: hardening the contract
 * without teaching the producer now fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

import { REQUIRED_PRODUCT_KEYS } from '../lib/phase-products-schema.js';

/**
 * Which skill(s) are responsible for emitting each phase's products block.
 *
 * Explicit rather than derived: a leaf like `url` or `domain` appears in
 * dozens of SKILL.md files, so a repo-wide search would pass on coincidence.
 * Scoping to the owning producer is what gives the assertion teeth — and if a
 * producer is renamed, the missing-file check below fails loudly, which is the
 * correct signal rather than a silent skip.
 */
const PRODUCER_SKILLS: Record<string, string[]> = {
  'commcare-setup': ['app-deploy'],
  'connect-setup': ['connect-opp-setup'],
  'qa-and-training': ['training-deck-render', 'training-deck-generate', 'training-onboarding-email'],
  'solicitation-management': ['solicitation-create'],
};

function skillText(slug: string): string {
  const path = new URL(`../skills/${slug}/SKILL.md`, import.meta.url);
  expect(existsSync(path), `producer skill not found: skills/${slug}/SKILL.md`).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('every REQUIRED_PRODUCT_KEY is teachable from its producing skill (#1286)', () => {
  it('covers every phase that declares required product keys', () => {
    // If a new phase gains required keys, this map must gain a row — otherwise
    // the assertion below would silently not cover it.
    for (const phase of Object.keys(REQUIRED_PRODUCT_KEYS)) {
      expect(
        PRODUCER_SKILLS[phase],
        `REQUIRED_PRODUCT_KEYS has '${phase}' but PRODUCER_SKILLS does not name its producer`,
      ).toBeDefined();
    }
  });

  it('names each required key in the SKILL.md an agent copies from', () => {
    const missing: string[] = [];
    for (const [phase, keys] of Object.entries(REQUIRED_PRODUCT_KEYS)) {
      const producers = PRODUCER_SKILLS[phase] ?? [];
      const corpus = producers.map(skillText).join('\n');
      for (const dotted of keys ?? []) {
        const leaf = dotted.split('.').pop()!;
        if (!corpus.includes(leaf)) {
          missing.push(`${phase}: ${dotted} (leaf '${leaf}' absent from ${producers.join(', ')})`);
        }
      }
    }
    expect(
      missing,
      'these keys are REQUIRED at the phase boundary but no producing skill tells an agent to ' +
        'write them — the producer will fail verify_phase_products every run and repair by hand ' +
        `(ace#1286):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
