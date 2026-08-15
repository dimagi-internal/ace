/**
 * ace#1420 — a per-visit rate with a per-day grain passed QA 8/8 and eval 9.5
 * with every money number ~6x wrong.
 */
import { describe, it, expect } from 'vitest';
import { checkPaymentUnitMatchesEntityGrain } from '../../skills/idea-to-pdd-qa/checks';

const pdd = (rows: string) => `# PDD\n\n## Program Parameters\n\n| Key | Value |\n|---|---|\n${rows}\n\n## Budget\n`;

describe('the exact pair that shipped (bednet-check-2-visit/20260814-2019)', () => {
  const r = checkPaymentUnitMatchesEntityGrain(
    pdd(
      '| payment_rate_unit | verified follow-up visit |\n' +
      '| entity_id_grain | worker username + encounter date |',
    ),
  );

  it('fails', () => expect(r.pass).toBe(false));

  it('names the collapse rather than just flagging a mismatch', () => {
    expect(r.detail).toMatch(/collapse into ONE payment entity/);
    expect(r.detail).toMatch(/agree only/);
  });

  it('says the grain wins, since that is the non-obvious half', () => {
    expect(r.auto_fix_hint).toMatch(/payable unit is the GRAIN/);
  });

  it('names every number that has to be re-derived', () => {
    for (const k of ['payment_rate_min', 'daily_cap_per_flw', 'total_cap_per_flw']) {
      expect(r.auto_fix_hint).toContain(k);
    }
  });
});

describe('passes', () => {
  it('a day-scoped rate against a day grain — the corrected form', () => {
    const r = checkPaymentUnitMatchesEntityGrain(
      pdd(
        '| payment_rate_unit | verified follow-up day |\n' +
        '| entity_id_grain | worker username + encounter date |',
      ),
    );
    expect(r.pass).toBe(true);
  });

  it('a per-visit rate against a per-visit grain', () => {
    const r = checkPaymentUnitMatchesEntityGrain(
      pdd(
        '| payment_rate_unit | verified follow-up visit |\n' +
        '| entity_id_grain | worker username + visit uuid |',
      ),
    );
    expect(r.pass).toBe(true);
  });

  it('a rate unit naming BOTH is read as day-scoped — the grain it matches', () => {
    // "per verified follow-up visit day" is coarse, not fine.
    const r = checkPaymentUnitMatchesEntityGrain(
      pdd(
        '| payment_rate_unit | verified follow-up visit day |\n' +
        '| entity_id_grain | worker username + encounter date |',
      ),
    );
    expect(r.pass).toBe(true);
  });
});

describe('skips silently when it does not apply', () => {
  it.each([
    ['neither declared', '| flw_count_min | 20 |'],
    ['only the unit', '| payment_rate_unit | verified visit |'],
    ['only the grain', '| entity_id_grain | worker + date |'],
  ])('%s', (_label, rows) => {
    const r = checkPaymentUnitMatchesEntityGrain(pdd(rows));
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/not applicable|not declared/);
  });

  it('defers to program_parameters_coherent when the section is missing', () => {
    const r = checkPaymentUnitMatchesEntityGrain('# PDD\n\n## Budget\n');
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('program_parameters_coherent');
  });
});

describe('term matching', () => {
  const check = (unit: string, grain: string) =>
    checkPaymentUnitMatchesEntityGrain(
      pdd(`| payment_rate_unit | ${unit} |\n| entity_id_grain | ${grain} |`),
    ).pass;

  it.each(['session', 'form', 'submission', 'encounter', 'meeting', 'interview', 'screening'])(
    'catches a per-%s rate against a day grain', (evt) => {
      expect(check(`completed ${evt}`, 'worker id + service date')).toBe(false);
    });

  it.each(['date', 'day', 'daily', 'calendar day'])('reads "%s" as day-scoped', (term) => {
    expect(check('verified visit', `worker + ${term}`)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(check('Verified Follow-up VISIT', 'Worker Username + Encounter DATE')).toBe(false);
  });

  it('does not fire on a grain with no time component', () => {
    expect(check('verified visit', 'beneficiary case id')).toBe(true);
  });

  it('handles plurals', () => {
    expect(check('verified visits', 'worker + encounter dates')).toBe(false);
  });
});
