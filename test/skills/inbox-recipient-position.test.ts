/**
 * Cc means ACE was kept informed, not asked (Jon, 2026-08-26).
 *
 * A thread can be unmistakably direct human communication — no notification, a
 * real person, a real ask — and still not be addressed to ACE. The noise table
 * does not catch that case, because it classifies by SENDER and this is about
 * RECIPIENT position.
 *
 * The failure it prevents is ACE replying to, or starting work from, a
 * conversation between two other people that it was merely shown. That costs
 * more than silence: it puts an agent's voice into a thread where nobody asked
 * for it, and the humans then have to unpick it.
 *
 * The rule has a deliberate override — a cc'd message that names ACE in the body
 * IS direct communication — so the test pins BOTH halves. Pinning only the
 * default would let a later edit drop the override and make ACE unreachable on
 * any thread where it is cc'd, which is the opposite failure and a quieter one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TRIAGE = readFileSync(join(ROOT, 'skills', 'inbox-triage', 'SKILL.md'), 'utf8');
const TURN = readFileSync(join(ROOT, 'skills', 'turn', 'SKILL.md'), 'utf8');

describe('recipient position is a triage rule, not folklore', () => {
  it('inbox-triage carries the rule', () => {
    expect(TRIAGE).toMatch(/Recipient position/i);
  });

  it('states the default for a cc-only thread', () => {
    // The whole point: cc defaults to silence.
    expect(TRIAGE).toMatch(/only in `cc`/i);
    expect(TRIAGE).toMatch(/NO ACTION/i);
  });

  it('keeps the override, so ACE stays reachable when cc-d', () => {
    expect(TRIAGE).toMatch(/override/i);
    expect(TRIAGE).toMatch(/explicitly addresses ACE in the body/i);
  });

  it('requires to/cc to come from the STRUCTURED read', () => {
    // A raw text view hides Cc: entirely -- the field this rule turns on.
    const section = TRIAGE.slice(TRIAGE.search(/## Recipient position/i));
    expect(section).toMatch(/structured/i);
    expect(section).toMatch(/canopy email read/);
  });

  it('the turn close-out reports recipient position', () => {
    // Without this the rule is invisible in the turn record, and a deliberate
    // silence is indistinguishable from a thread that was never read.
    expect(TURN).toMatch(/recipient position/i);
    expect(TURN).toMatch(/cc'd-no-action/i);
  });
});
