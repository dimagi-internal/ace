/**
 * The BUILD-TIME cap check resolves the counter's timing itself (ace#2515).
 *
 * `pdd-to-deliver-app § Step 4j` sub-step 6 used to hard-code a pre-increment
 * timing. On spark-facilitator/20260926-1413 (Deliver app
 * d41602e3-5423-4bcd-b873-51aa0434ee59) the correct build
 * `capped_index = min(#form/step_info/prior_index + 1, 3)` read as capacity 4
 * under that assumption and would have been HALTed and "repaired" to under-pay.
 *
 * Inputs are the VERBATIM `get_field` read-backs from that app
 * (test/fixtures/nova/capped-index-readback-spark-20260926-1413.json). Grounding
 * on them caught a misreading the inline draft shared with the implementation:
 * Nova spells the case read `#community/…` (the case type), not `#case/…`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBuiltClampCapacity, novaToXPath } from '../../lib/payable-cap-arithmetic';

const repoRoot = new URL('../..', import.meta.url).pathname;
const FIXTURE = JSON.parse(
  readFileSync(join(repoRoot, 'test/fixtures/nova/capped-index-readback-spark-20260926-1413.json'), 'utf8'),
);
const CAP: number = FIXTURE.declared_cap;
/** The `binds` a Step 4j caller assembles from the captured read-backs. */
const bindsOf = (fx: typeof FIXTURE): Record<string, string> => ({
  [`${fx.group_path}/${fx.prior_index.field.id}`]: fx.prior_index.field.calculate,
});

describe('checkBuiltClampCapacity over the captured ace#2515 read-back', () => {
  it('passes the real post-increment clamp at its declared cap', () => {
    const r = checkBuiltClampCapacity(FIXTURE.capped_index.field.calculate, bindsOf(FIXTURE), CAP);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.timing).toBe('includes-current');
    expect(r.capacity).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('reads the Nova case-type spelling as a casedb read', () => {
    expect(novaToXPath(FIXTURE.prior_index.field.calculate)).toContain("instance('casedb')");
    expect(novaToXPath('#user/role')).toBe('#user/role');
  });

  it('NEGATIVE CONTROL: dropping the + 1 (min(<casedb count>, cap)) is off by one — capacity cap + 1', () => {
    const r = checkBuiltClampCapacity(FIXTURE.capped_index.field.calculate.replace(' + 1', ''), bindsOf(FIXTURE), CAP);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.timing).toBe('pre-increment');
    expect(r.capacity).toBe(CAP + 1);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toContain(`if(/data/step_info/prior_index >= ${CAP}, ${CAP - 1}`);
  });

  it('NEGATIVE CONTROL: the "repair" the hard-coded timing proposed (clamp at cap - 1) under-pays', () => {
    const r = checkBuiltClampCapacity(FIXTURE.capped_index.field.calculate.replace(`, ${CAP})`, `, ${CAP - 1})`), bindsOf(FIXTURE), CAP);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.capacity).toBe(CAP - 1);
    expect(r.ok).toBe(false);
  });

  it('accepts XForm keys and expressions too', () => {
    const r = checkBuiltClampCapacity(
      novaToXPath(FIXTURE.capped_index.field.calculate),
      new Map(Object.entries(bindsOf(FIXTURE)).map(([k, v]) => [novaToXPath(k), novaToXPath(v)])),
      CAP,
    );
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.ok).toBe(true);
  });

  it('is unable — never a default timing — when the counter node is not supplied', () => {
    expect(checkBuiltClampCapacity(FIXTURE.capped_index.field.calculate, {}, CAP).status).toBe('unable');
  });
});

describe('the Step 4j snippet does not hard-code a counter timing (ace#2515)', () => {
  const skill = readFileSync(join(repoRoot, 'skills/pdd-to-deliver-app/SKILL.md'), 'utf8');
  it('calls the timing-resolving helper', () => {
    expect(skill).toContain('checkBuiltClampCapacity');
  });
  it('never passes a literal timing to payableCapacity', () => {
    expect(skill).not.toMatch(/payableCapacity\([^)]*['"](pre-increment|includes-current)['"]/);
  });
});
