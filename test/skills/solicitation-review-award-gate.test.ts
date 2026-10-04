/**
 * Owner decision 2026-10-04: an unanswered `review_ask: required-before` row
 * with `needed_by: award` is a HARD STOP in `solicitation-review` — the award
 * is refused, not warned about. `award_response` is irreversible and the skill
 * is prose an agent executes, so the gate has to sit in the procedure BEFORE
 * the human is asked to approve, and the procedure has to say it cannot be
 * talked past. The data half (what counts as unanswered) is
 * `requiredBeforeBlockers`, tested in test/lib/open-asks.test.ts.
 *
 * Observed: the spec (ace#2631) classified spark-facilitator/20261001-2208's
 * ledger and found one genuinely open, award-gating question
 * (`rct-sample-overlap`) with no default and no gate — Phase 8 could have
 * awarded trial communities.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync(join(__dirname, '..', '..', 'skills', 'solicitation-review', 'SKILL.md'), 'utf8');

describe('solicitation-review refuses to award while a required-before: award ask is open', () => {
  const gate = SKILL.indexOf('5b. **Required-before gate');
  const hitl = SKILL.indexOf('6. **HITL gate.**');
  const award = SKILL.indexOf('7. **Call `award_response`.**');

  it('the gate step exists and runs before the HITL prompt and the award call', () => {
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(hitl);
    expect(hitl).toBeLessThan(award);
  });

  it('it calls decisions_open_asks with neededBy award and stops on a non-empty requiredBefore', () => {
    const step = SKILL.slice(gate, hitl);
    expect(step).toContain('decisions_open_asks');
    expect(step).toContain("neededBy: 'award'");
    expect(step).toMatch(/requiredBefore` is non-empty/);
    expect(step).toMatch(/do\s+not\s+call\s+`award_response`/i);
    expect(step).toMatch(/HARD STOP/);
    expect(step).toMatch(/not\s+even\s+if\s+the\s+human\s+asks/i);
  });

  it('a recommended-confirmation ask is explicitly not a blocker', () => {
    expect(SKILL.slice(gate, hitl)).toMatch(/`recommended-confirmation`\s+ask\s+never\s+blocks\s+the\s+award/);
  });
});
