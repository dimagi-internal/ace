import { describe, expect, test } from 'vitest';
import { checkLaunchParametersPresent, CHECKS } from '../../../skills/idea-to-pdd-qa/checks';

/**
 * Every Phase 3 / Phase 4 launch parameter must be decided in the PDD.
 *
 * ## Why
 *
 * Operator decision 2026-09-09: PDD review must verify the app-build and
 * opportunity-creation parameters, propose values when the human does not
 * supply them, and not proceed until they are settled.
 *
 * The sibling check `program_parameters_coherent` validates the numbers that
 * ARE present (min ≤ max, reachable passing score, cap vs reach). It cannot
 * fail a PDD for saying nothing, and its own fix hint asks for these keys only
 * "where the PDD decides them". So a PDD could pass every gate carrying no
 * payment rate, no caps, no dates and no verification flags, leaving
 * `connect-opp-setup` to invent them mid-run or fall back to a skill default
 * nobody chose.
 *
 * ## The org_amount gap
 *
 * `connect_create_payment_unit` takes `amount` (FLW) AND `org_amount` (LLO),
 * and `org_amount` is REQUIRED for managed opportunities — the API rejects the
 * create without it. The PDD vocabulary had `payment_rate_min`/`max` for the
 * FLW side and nothing at all for the LLO side, so half the payment model
 * reached Connect as a number no decision row covered.
 */

function pdd(rows: string): string {
  return `# Test PDD

## Program Parameters

| Key | Value |
|---|---|
${rows}

## Timeline

Four weeks.
`;
}

const COMPLETE_ROWS = [
  '| payment_rate_min | 1.00 |',
  '| payment_rate_max | 2.50 |',
  '| llo_payment_per_visit | 0.50 |',
  '| daily_cap_per_flw | 5 |',
  '| total_cap_per_flw | 30 |',
  '| campaign_target_visits | 300 |',
  '| total_budget_usd | 900 |',
  '| opportunity_start_date | 2026-06-01 |',
  '| opportunity_end_date | 2026-06-30 |',
  '| verification_flags | photo_required, gps_within_radius |',
  '| connect_delivery_type | nutrition |',
  '| opportunity_country | USA |',
  '| opportunity_currency | USD |',
].join('\n');

describe('checkLaunchParametersPresent', () => {
  test('passes when every launch parameter is declared', () => {
    const r = checkLaunchParametersPresent(pdd(COMPLETE_ROWS));
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/all 12 launch parameters declared/);
  });

  test('fails a PDD with no § Program Parameters at all', () => {
    const r = checkLaunchParametersPresent('# PDD\n\n## Timeline\n\nFour weeks.\n');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/no § Program Parameters/);
  });

  test('fails on the missing org_amount key specifically — the documented gap', () => {
    const rows = COMPLETE_ROWS.split('\n')
      .filter((l) => !l.includes('llo_payment_per_visit'))
      .join('\n');
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/llo_payment_per_visit/);
    // The failure must say WHY it matters, not just that a key is absent.
    expect(r.detail).toMatch(/org_amount/);
    expect(r.detail).toMatch(/REQUIRED for managed opps/);
  });

  test('names every missing parameter and the field it feeds', () => {
    const r = checkLaunchParametersPresent(
      pdd('| payment_rate_min | 1.00 |\n| daily_cap_per_flw | 5 |'),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/missing 10 launch parameter/);
    expect(r.detail).toMatch(/verification_flags/);
    expect(r.detail).toMatch(/total_budget/);
    expect(r.detail).toMatch(/opportunity_start_date/);
    // Mapping is in the message so the fixer does not have to look it up.
    expect(r.detail).toMatch(/max_daily|max_total|total_budget/);
  });

  test('accepts the flw_payment_per_visit alias for the rate band', () => {
    const rows = COMPLETE_ROWS.split('\n')
      .filter((l) => !l.includes('payment_rate_min') && !l.includes('payment_rate_max'))
      .concat('| flw_payment_per_visit | 1.75 |')
      .join('\n');
    expect(checkLaunchParametersPresent(pdd(rows)).pass).toBe(true);
  });

  test('accepts expected_reach_max as the campaign-target alias', () => {
    const rows = COMPLETE_ROWS.replace(
      '| campaign_target_visits | 300 |',
      '| expected_reach_max | 300 |',
    );
    expect(checkLaunchParametersPresent(pdd(rows)).pass).toBe(true);
  });

  test('ACCEPTS [PROPOSED] values but flags them for sign-off', () => {
    // The auto-mode path. A proposal on the record is auditable; the check
    // enforces that the parameter was considered, not that a human signed it.
    const rows = COMPLETE_ROWS.replace(
      '| llo_payment_per_visit | 0.50 |',
      '| llo_payment_per_visit | 0.50 [PROPOSED] |',
    );
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/still marked proposed\/TBD/);
    expect(r.detail).toMatch(/llo_payment_per_visit/);
    expect(r.detail).toMatch(/sign-off before Phase 4/);
  });

  /**
   * The program-shell trio. `delivery_type`, `country` and `currency` are
   * create-time-only on a Connect program — `connect_update_program` accepts
   * only name/description/budget/start_date/end_date — so a wrong value here
   * can only be undone by creating a replacement program.
   *
   * Measured on `ai-demo-space` 2026-09-16 with none of them declared: seven of
   * eleven live turmeric programs carry delivery type "Interview" for a market
   * survey, and the current one pairs `country: IND` with `currency: USD`.
   */
  test('requires the delivery type to be a PDD decision, not a Phase 4 guess', () => {
    const rows = COMPLETE_ROWS.split('\n')
      .filter((l) => !l.includes('connect_delivery_type'))
      .join('\n');
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/connect_delivery_type/);
    expect(r.detail).toMatch(/connect_list_delivery_types/);
  });

  test('requires country and currency', () => {
    for (const key of ['opportunity_country', 'opportunity_currency']) {
      const rows = COMPLETE_ROWS.split('\n')
        .filter((l) => !l.includes(key))
        .join('\n');
      const r = checkLaunchParametersPresent(pdd(rows));
      expect(r.pass, `${key} should be required`).toBe(false);
      expect(r.detail).toContain(key);
    }
  });

  test('accepts payment_rate_currency as the currency alias', () => {
    const rows = COMPLETE_ROWS.replace(
      '| opportunity_currency | USD |',
      '| payment_rate_currency | USD |',
    );
    expect(checkLaunchParametersPresent(pdd(rows)).pass).toBe(true);
  });

  test('accepts total_budget as well as the legacy total_budget_usd', () => {
    const rows = COMPLETE_ROWS.replace('| total_budget_usd | 900 |', '| total_budget | 75000 |');
    expect(checkLaunchParametersPresent(pdd(rows)).pass).toBe(true);
  });

  test('FAILS the live turmeric pairing — country IND with currency USD', () => {
    const rows = COMPLETE_ROWS.replace('| opportunity_country | USA |', '| opportunity_country | IND |');
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/incoherent/);
    expect(r.detail).toMatch(/INR/);
    // The fix hint must forbid the tempting resolution.
    expect(r.auto_fix_hint).toMatch(/NOT resolve this by defaulting to USD/i);
  });

  test('passes a coherent non-USD programme', () => {
    const rows = COMPLETE_ROWS.replace(
      '| opportunity_country | USA |',
      '| opportunity_country | Nigeria |',
    ).replace('| opportunity_currency | USD |', '| opportunity_currency | NGN |');
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/NGA\/NGN/);
  });

  test('a [PROPOSED] currency is still checked for coherence', () => {
    // Otherwise a proposal is the loophole: mark it proposed and the pair is
    // never validated, which is exactly when a wrong default survives.
    const rows = COMPLETE_ROWS.replace(
      '| opportunity_country | USA |',
      '| opportunity_country | IND [PROPOSED] |',
    );
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/INR/);
  });

  test('an unrecognised country halts WITHOUT proposing a currency', () => {
    const rows = COMPLETE_ROWS.replace(
      '| opportunity_country | USA |',
      '| opportunity_country | Wakanda |',
    );
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not a recognised/i);
    expect(r.auto_fix_hint).not.toMatch(/Set `opportunity_currency` to `[A-Z]{3}`/);
  });

  test('an empty value is treated as missing, not as declared', () => {
    // `| verification_flags |  |` is the shape a half-filled template produces.
    const rows = COMPLETE_ROWS.replace(
      '| verification_flags | photo_required, gps_within_radius |',
      '| verification_flags |  |',
    );
    const r = checkLaunchParametersPresent(pdd(rows));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/verification_flags/);
  });

  test('the fix hint refuses "leave it out" as an option', () => {
    const r = checkLaunchParametersPresent(pdd('| payment_rate_min | 1.00 |'));
    expect(r.auto_fix_hint).toMatch(/WRITE THE PROPOSAL/);
    expect(r.auto_fix_hint).toMatch(/only wrong answer/);
    expect(r.auto_fix_hint).toMatch(/evidence_basis: inferred/);
  });

  test('is registered first in CHECKS', () => {
    expect(CHECKS[0].id).toBe('launch_parameters_present');
  });
});
