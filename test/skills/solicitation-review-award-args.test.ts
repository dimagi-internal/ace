/**
 * ace#3146: `solicitation-review` Step 7 called `award_response(response_id,
 * amount)`. The live connect-labs schema requires `response_id`,
 * `reward_budget` and `org_id`, with `additionalProperties: false` and no
 * `amount` field, so the one irreversible Phase 8 step could not run as
 * written. Source of truth: dimagi-internal/connect-labs
 * `connect_labs/mcp/tools/solicitations.py` (`award_response` input schema,
 * `"required": ["response_id", "reward_budget", "org_id"]`).
 *
 * The test pins the documented call to that required set, and pins the HITL
 * prompt to the fact that labs may email the awardee. That email was
 * invisible to the approver before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync(join(__dirname, '..', '..', 'skills', 'solicitation-review', 'SKILL.md'), 'utf8');

const REQUIRED = ['response_id', 'reward_budget', 'org_id'];

function awardCall(): string {
  const m = SKILL.match(/mcp__connect-labs__award_response\(([\s\S]*?)\n\s*\)/);
  if (!m) throw new Error('no award_response( ... ) call block found in solicitation-review');
  return m[1];
}

function argNames(call: string): string[] {
  return [...call.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
}

describe('solicitation-review award_response call matches the live labs schema (ace#3146)', () => {
  it('passes every required argument', () => {
    const names = argNames(awardCall());
    for (const r of REQUIRED) expect(names).toContain(r);
  });

  it('passes no argument the schema does not define', () => {
    const allowed = new Set([...REQUIRED, 'fund_id', 'demonstration']); // demonstration: ace#3257
    for (const n of argNames(awardCall())) expect(allowed.has(n), `unexpected award_response arg: ${n}`).toBe(true);
  });

  it('the HITL prompt tells the approver labs may email the awardee', () => {
    const hitl = SKILL.slice(SKILL.indexOf('6. **HITL gate.**'), SKILL.indexOf('7. **Call `award_response`.**'));
    expect(hitl).toMatch(/email the\s+(?:>\s*)?awardee/);
    expect(hitl).toContain('org_id');
  });

  it('award-record.md records awardee_notified', () => {
    const rec = SKILL.slice(SKILL.indexOf('8. **Write `award-record.md`.**'), SKILL.indexOf('9. **'));
    expect(rec).toContain('awardee_notified');
    expect(rec).toContain('allocation_error');
  });
});
