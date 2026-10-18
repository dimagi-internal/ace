import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_SUFFIX,
  SupplyChainRefError,
  buildSource,
  buildSourceRef,
  money,
  moneyFromMinor,
  programScope,
  refKey,
  simulatedDate,
  syntheticName,
} from '../../lib/supply-chain-ref.js';
import {
  buyerOfRecord,
  classifyRunnerRefusal,
  planRunner,
  SupplyChainRunnerError,
} from '../../lib/supply-chain-runner.js';

describe('buildSourceRef', () => {
  it('is deterministic: the same parts always give the same ref (labs replays a repeated ref)', () => {
    const parts = { scope: '20261018-1903', skill: 'supply-chain-setup', step: 'commodity', key: 'feature-handset' };
    expect(buildSourceRef(parts)).toBe('ace:20261018-1903:supply-chain-setup:commodity:feature-handset');
    expect(buildSourceRef(parts)).toBe(buildSourceRef({ ...parts }));
  });

  it('normalises a free-text key, including the ref separator', () => {
    expect(refKey('  Kampala Handsets Ltd [Synthetic] ')).toBe('kampala-handsets-ltd-synthetic');
    expect(refKey('week-2:flw-007')).toBe('week-2-flw-007');
    expect(() => refKey(':::')).toThrow(SupplyChainRefError);
  });

  it('refuses a scope or segment that would break the shape', () => {
    expect(() => buildSourceRef({ scope: '', skill: 's', step: 'x', key: 'k' })).toThrow(/scope/);
    expect(() => buildSourceRef({ scope: 'a:b', skill: 's', step: 'x', key: 'k' })).toThrow(/scope/);
    expect(() => buildSourceRef({ scope: 'r', skill: 'Supply Chain', step: 'x', key: 'k' })).toThrow(/skill/);
    expect(() => buildSourceRef({ scope: 'r', skill: 's', step: 'a:b', key: 'k' })).toThrow(/step/);
  });

  it('refuses a ref longer than labs accepts', () => {
    expect(() => buildSourceRef({ scope: 'r', skill: 's', step: 'x', key: 'k'.repeat(600) })).toThrow(/512/);
  });

  it('programScope is the out-of-run scope', () => {
    expect(programScope(10602)).toBe('program-10602');
    expect(() => programScope('abc')).toThrow(SupplyChainRefError);
  });
});

describe('buildSource', () => {
  const base = { scope: 'run-1', skill: 'supply-chain-setup', step: 'supplier', key: 'Acme' };

  it('labels every simulated excerpt, so an invented record never reads as real', () => {
    expect(buildSource({ ...base, simulated: true }).excerpt).toBe('Simulated by ACE.');
    expect(buildSource({ ...base, simulated: true, excerpt: 'Quote for 1,500 handsets' }).excerpt).toBe(
      'Simulated by ACE. Quote for 1,500 handsets',
    );
    expect(buildSource({ ...base, simulated: true, excerpt: 'simulated clarification' }).excerpt).toBe(
      'simulated clarification',
    );
  });

  it('keeps sent_on in the past (the § G calendar is backdated)', () => {
    expect(buildSource({ ...base, sentOn: '2026-09-07', today: '2026-10-18' }).sent_on).toBe('2026-09-07');
    expect(() => buildSource({ ...base, sentOn: '2026-11-01', today: '2026-10-18' })).toThrow(/after today/);
    expect(() => buildSource({ ...base, sentOn: '07/09/2026' })).toThrow(/YYYY-MM-DD/);
  });

  it('bounds sender and excerpt to the atom limits', () => {
    expect(() => buildSource({ ...base, sender: ' ' })).toThrow(/sender/);
    expect(() => buildSource({ ...base, excerpt: 'x'.repeat(2001) })).toThrow(/2000/);
  });
});

describe('simulatedDate', () => {
  it('offsets inside a Monday-aligned week', () => {
    expect(simulatedDate('2026-09-07', 0)).toBe('2026-09-07');
    expect(simulatedDate('2026-09-07', 4)).toBe('2026-09-11');
  });
  it('refuses a non-Monday week start or an offset outside the week', () => {
    expect(() => simulatedDate('2026-09-08', 0)).toThrow(/Monday/);
    expect(() => simulatedDate('2026-09-07', 7)).toThrow(/0-6/);
  });
});

describe('money', () => {
  it('passes decimal strings and refuses numbers (labs refuses JSON numbers for amounts)', () => {
    expect(money('12.50')).toBe('12.50');
    expect(() => money(12.5 as unknown as string)).toThrow(/decimal string/);
    expect(() => money('-3')).toThrow(SupplyChainRefError);
  });
  it('builds a decimal string from integer minor units', () => {
    expect(moneyFromMinor(1250)).toBe('12.50');
    expect(moneyFromMinor(5)).toBe('0.05');
    expect(moneyFromMinor(7, 0)).toBe('7');
    expect(() => moneyFromMinor(1.5)).toThrow(SupplyChainRefError);
  });
});

describe('syntheticName', () => {
  it('appends the marker once', () => {
    expect(syntheticName('Kampala Handsets Ltd')).toBe(`Kampala Handsets Ltd ${SYNTHETIC_SUFFIX}`);
    expect(syntheticName(syntheticName('X'))).toBe(`X ${SYNTHETIC_SUFFIX}`);
  });
});

describe('planRunner', () => {
  const unset = { org_id: null, your_standing: 'partner' };

  it('ace_winner path: declare the winner first, the PM org as the fallback', () => {
    expect(planRunner({ aceWinner: true, pmLabsOrgId: 386, lloLabsOrgId: 412, current: unset })).toEqual({
      action: 'declare',
      candidates: [
        { org_id: 412, role: 'llo' },
        { org_id: 386, role: 'pm' },
      ],
    });
  });

  it('no winner: declare the PM org only', () => {
    expect(planRunner({ aceWinner: false, pmLabsOrgId: 386, current: unset })).toEqual({
      action: 'declare',
      candidates: [{ org_id: 386, role: 'pm' }],
    });
  });

  it('never moves an existing runner; proceeds when ACE already has programme standing', () => {
    const plan = planRunner({
      aceWinner: true,
      pmLabsOrgId: 386,
      lloLabsOrgId: 412,
      current: { org_id: 386, your_standing: 'programme' },
    });
    expect(plan).toMatchObject({ action: 'proceed', org_id: 386, role: 'pm', buyer_of_record: 'partner_org' });
  });

  it('halts when a runner exists and ACE is only a partner under it', () => {
    const plan = planRunner({ aceWinner: false, pmLabsOrgId: 386, current: { org_id: 2, your_standing: 'partner' } });
    expect(plan.action).toBe('blocker');
  });

  it('refuses a winner that is missing or the same org as the PM org', () => {
    expect(() => planRunner({ aceWinner: true, pmLabsOrgId: 386, current: unset })).toThrow(SupplyChainRunnerError);
    expect(() => planRunner({ aceWinner: true, pmLabsOrgId: 386, lloLabsOrgId: 386, current: unset })).toThrow(
      /distinct/,
    );
  });

  it('buyer of record follows the runner', () => {
    expect(buyerOfRecord('llo')).toBe('programme_org');
    expect(buyerOfRecord('pm')).toBe('partner_org');
  });
});

describe('classifyRunnerRefusal', () => {
  it('recognises the live support-only gate text', () => {
    expect(classifyRunnerRefusal('only platform support declares which organisation runs a program')).toBe(
      'support_only',
    );
    expect(classifyRunnerRefusal('Platform support only: it decides who acts as the programme')).toBe('support_only');
  });
  it('treats an eligibility refusal as try-the-next-candidate', () => {
    expect(classifyRunnerRefusal('Organisation 412 holds no accepted application in program 900')).toBe('not_eligible');
  });
  it('anything else is unknown', () => {
    expect(classifyRunnerRefusal('Internal Server Error')).toBe('other');
  });
});
