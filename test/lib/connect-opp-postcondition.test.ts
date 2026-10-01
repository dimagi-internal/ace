import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOppPostcondition, type OppDecided, type OppReadback } from '../../lib/connect-opp-postcondition';

// Live read-back of spark-facilitator/20260926-1800's opportunity, 2026-10-01 (committed fixture).
const FIXTURE = join(__dirname, '../fixtures/qa-gaps/spark-20260926-1800-opp-readback.json');
function fromFixture(text: string) {
  const f = JSON.parse(text);
  const read: OppReadback = { opportunity: f.opportunity, paymentUnits: f.payment_units, testUserInvite: { match: f.flw_invites_match } };
  const decided: OppDecided = {
    paymentUnitNames: f.decided.payment_unit_names,
    formFieldRulesExpected: f.decided.form_field_rules_expected,
    formFieldRulesSaved: f.decided.form_field_rules_saved,
    expectActive: true,
    expectTestUserInvited: true,
  };
  return { read, decided };
}

describe('connect-opp-setup post-condition', () => {
  it("passes Spark's opportunity on everything but the verification rules Connect refused (ace#2419)", () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    const r = checkOppPostcondition(sparkRead, sparkDecided);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['verification_rules_persisted']);
    // a refused verification write does not stop the device walk
    expect(r.phase6_blockers).toEqual([]);
  });

  it('blocks Phase 6 when the test user has no invite row, and does not take active:true as activation proof', () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    const r = checkOppPostcondition({ ...sparkRead, testUserInvite: { match: null } }, { ...sparkDecided, formFieldRulesSaved: 2 });
    expect(r.checks.find((c) => c.id === 'activated')?.pass).toBe(false);
    expect(r.checks.find((c) => c.id === 'test_user_invited')?.pass).toBe(false);
    expect(r.phase6_blockers.join(' ')).toMatch(/ace#824/);
  });

  it('fails is_test false and unknown alike', () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    expect(checkOppPostcondition({ ...sparkRead, opportunity: { ...sparkRead.opportunity, is_test: false } }, sparkDecided).checks.find((c) => c.id === 'is_test')?.pass).toBe(false);
    expect(checkOppPostcondition({ ...sparkRead, opportunity: { id: 'x', active: true } }, sparkDecided).checks.find((c) => c.id === 'is_test')?.detail).toMatch(/unknown/);
  });

  it('names missing and unexpected payment units', () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    const r = checkOppPostcondition({ ...sparkRead, paymentUnits: [{ name: 'Something else' }] }, sparkDecided);
    expect(r.checks.find((c) => c.id === 'payment_units_match')?.detail).toMatch(/missing: Per verified community meeting; 1 unexpected/);
  });

  it('treats a failed read as unconfirmed, never as fine', () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    const r = checkOppPostcondition({ opportunity: null, paymentUnits: null, testUserInvite: null }, sparkDecided);
    expect(r.ok).toBe(false);
    expect(r.phase6_blockers.length).toBeGreaterThanOrEqual(2);
  });

  it('stands the activation check down when the skill deliberately did not activate', () => {
    const { read: sparkRead, decided: sparkDecided } = fromFixture(readFileSync(FIXTURE, 'utf8'));
    const r = checkOppPostcondition({ ...sparkRead, opportunity: { ...sparkRead.opportunity, active: false }, testUserInvite: { match: null } }, { ...sparkDecided, formFieldRulesSaved: 2, expectActive: false, expectTestUserInvited: false });
    expect(r.ok).toBe(true);
  });
});
