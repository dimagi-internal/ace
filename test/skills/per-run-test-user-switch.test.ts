/**
 * dimagi-internal/ace#1289 — the per-run demo test user ships COMPLETE but
 * SWITCHED OFF, and the remaining work is deliberately reduced to one live
 * calibration plus one flag flip.
 *
 * That only holds if two things stay true, and neither is enforceable by prose:
 *
 *   1. **The precondition to flip the switch is one greppable sentence**, stated
 *      identically wherever an operator might look. The reason it is a single
 *      string rather than three paraphrases is that a paraphrase drifts, and a
 *      drifted precondition is how a gate gets flipped on a premise nobody
 *      re-checked (the exact failure CLAUDE.md § "a stale block is not a block"
 *      records twice).
 *   2. **Every guarded surface names the switch**, so `grep ACE_PER_RUN_TEST_USER`
 *      enumerates the complete blast radius. Without that, "it is inert while
 *      off" is an assertion rather than something a reader can verify.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACE_PER_RUN_TEST_USER_FLAG,
  PER_RUN_TEST_USER_FLIP_PRECONDITION,
} from '../../lib/per-run-test-user.js';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/**
 * Every surface that guards behaviour on the switch. A new guarded surface
 * belongs in this list — that is the point of the list.
 */
const GUARDED_SURFACES = [
  '.env.tpl',
  'skills/connect-opp-setup/SKILL.md',
  'skills/app-screenshot-capture/SKILL.md',
  'agents/qa-and-training.md',
];

/**
 * Normalize away everything that is presentation rather than content: line
 * wrapping, Markdown backticks/emphasis, and the `#` that prefixes every
 * continuation line of a `.env.tpl` comment. What survives is letters, digits
 * and the dots in `2.63.2` — enough that a genuine paraphrase still fails while
 * a legitimately re-wrapped or re-formatted copy still passes.
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
/** Line wrapping only — for checks whose target is a short phrase. */
const flatten = (s: string) => s.replace(/\s+/g, ' ');

describe('the flip precondition is stated identically everywhere (ace#1289)', () => {
  it.each(GUARDED_SURFACES)('%s carries the verbatim precondition sentence', (rel) => {
    expect(
      norm(read(rel)).includes(norm(PER_RUN_TEST_USER_FLIP_PRECONDITION)),
      `${rel} must state the flip precondition VERBATIM (wrapping aside), not a paraphrase.\n` +
        `Expected to find:\n  ${PER_RUN_TEST_USER_FLIP_PRECONDITION}\n` +
        `Source of truth: PER_RUN_TEST_USER_FLIP_PRECONDITION in lib/per-run-test-user.ts.`,
    ).toBe(true);
  });

  it('names BOTH clauses — a calibration AND a completed fresh-signup registration', () => {
    // One clause alone is not the gate: calibrated ids that were never exercised
    // end to end have not shown the guarded block actually runs.
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toMatch(/calibrated/);
    expect(PER_RUN_TEST_USER_FLIP_PRECONDITION).toMatch(/fresh-signup registration has completed/);
  });
});

describe('every guarded surface names the switch (ace#1289)', () => {
  it.each(GUARDED_SURFACES)('%s mentions ACE_PER_RUN_TEST_USER', (rel) => {
    expect(read(rel)).toContain(ACE_PER_RUN_TEST_USER_FLAG);
  });

  it('states the default is OFF on every guarded surface', () => {
    for (const rel of GUARDED_SURFACES) {
      expect(flatten(read(rel)), `${rel} must say the switch defaults OFF`).toMatch(
        /off by default|default off/i,
      );
    }
  });
});

describe('the switch is not accidentally enabled in the repo (ace#1289)', () => {
  it('.env.tpl ships the flag COMMENTED OUT', () => {
    const active = read('.env.tpl')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .filter((l) => l.includes(ACE_PER_RUN_TEST_USER_FLAG));
    expect(
      active,
      'ACE_PER_RUN_TEST_USER must remain commented out in .env.tpl until the flip ' +
        'precondition holds — an active line here turns it on for every machine that ' +
        'runs /ace:setup --force-env.',
    ).toEqual([]);
  });

  it('no shipped config or script sets the flag on', () => {
    // Guards against the switch being enabled somewhere that is not .env.tpl —
    // a hook, a command, a setup script.
    for (const rel of ['bin/ace-setup', 'config/gating.json']) {
      let text: string;
      try {
        text = read(rel);
      } catch {
        continue;
      }
      expect(text).not.toMatch(new RegExp(`${ACE_PER_RUN_TEST_USER_FLAG}\\s*=\\s*(true|1|yes|on)`, 'i'));
    }
  });
});
