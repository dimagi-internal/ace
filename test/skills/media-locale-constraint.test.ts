/**
 * `app-media-coverage` pins generated imagery to the programme's locale
 * (dimagi-internal/ace#2895).
 *
 * ## The failure class
 *
 * Step 6's Content Generator directive had no country constraint. On
 * `turmeric-market-study-ghana/20261012-1749` — a Ghana (`GHS`) programme — the
 * Deliver app's guidance photo showed a Ugandan `UGX 1000` MTN scratchcard and a
 * worker badge reading `FLW-UG045`: the one image a newly certified worker
 * studies to learn what a correct photo looks like.
 *
 * ## Why the PDD, not run_state
 *
 * The run's country/currency also live under
 * `phases.connect-setup.products.connect.opportunity`, but that block is
 * written by Phase 4 and this skill runs in Phase 3 — reading it would always
 * find nothing. The PDD's § Program Parameters `opportunity_country` /
 * `opportunity_currency` are the Phase-3-available source.
 *
 * SCOPE: offline. Asserts the skill's process body CARRIES the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SKILL_REL = 'skills/app-media-coverage/SKILL.md';
const SKILL = readFileSync(join(REPO_ROOT, SKILL_REL), 'utf8');

function step6(): string {
  const idx = SKILL.indexOf('## Change log');
  const body = idx > 0 ? SKILL.slice(0, idx) : SKILL;
  const start = body.indexOf('### 6.');
  const end = body.indexOf('### 7.');
  expect(start, 'step 6 not found in app-media-coverage').toBeGreaterThan(0);
  return body.slice(start, end).replace(/\s+/g, ' ');
}

describe('app-media-coverage locale constraint (ace#2895)', () => {
  it('step 6 reads opportunity_country and opportunity_currency from the PDD', () => {
    const s = step6();
    expect(s).toMatch(/opportunity_country/);
    expect(s).toMatch(/opportunity_currency/);
    expect(s).toMatch(/Program Parameters/);
  });

  it('step 6 does not source the locale from Phase 4 run_state', () => {
    const s = step6();
    // It may NAME run_state only to say not to read it.
    expect(
      /NOT from `run_state\.yaml`/.test(s),
      'Step 6 must say the locale comes from the PDD, not the Phase 4 run_state block, ' +
        'which does not exist yet while this Phase 3 skill runs.',
    ).toBe(true);
  });

  it('step 6 states the rule: depicted currency/badges/documents match the country, or none', () => {
    const s = step6().replace(/\s+/g, ' ');
    expect(/currency/i.test(s) && /badge/i.test(s) && /document/i.test(s)).toBe(true);
    expect(
      /or the image depicts none/i.test(s),
      'Step 6 must allow the country-neutral alternative ("or the image depicts none").',
    ).toBe(true);
  });

  it('step 6 never guesses a country when the PDD lacks one', () => {
    expect(step6()).toMatch(/never guess a country/i);
  });
});
