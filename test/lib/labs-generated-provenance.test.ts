import { describe, it, expect } from 'vitest';
import { readGenerated, unmarkedPools } from '../../lib/labs-generated-provenance.js';

// connect-labs #2718: a mirror pool counts as generated only when it declares
// numbers: authored. These cases follow labs' own provenance.replays_real_cases.
const cohort = (longitudinal: string) =>
  ['opportunity_id: 1', 'beneficiary_cohorts:', '  - id: communities', `    longitudinal: ${longitudinal}`, ''].join('\n');
const POOL = '[{owner: cbf_a01, start_date: "2026-06-22", visits: [{day: 0, values: {}}]}]';

describe('unmarkedPools', () => {
  it('passes an authored mirror pool (the cascade shape)', () => {
    expect(unmarkedPools(cohort(`{mode: mirror, numbers: authored, jitter_frac: 0, transplant_pool: ${POOL}}`))).toEqual([]);
  });

  it('flags a mirror pool with no numbers mark', () => {
    expect(unmarkedPools(cohort(`{mode: mirror, jitter_frac: 0, transplant_pool: ${POOL}}`))).toEqual([
      'beneficiary_cohorts[0].longitudinal',
    ]);
  });

  it('flags a modelled pool unless it says modelled or authored', () => {
    expect(unmarkedPools(cohort(`{mode: modelled, transplant_pool: ${POOL}}`))).toHaveLength(1);
    expect(unmarkedPools(cohort(`{mode: modelled, numbers: modelled, transplant_pool: ${POOL}}`))).toEqual([]);
    expect(unmarkedPools(cohort(`{mode: modelled, numbers: authored, transplant_pool: ${POOL}}`))).toEqual([]);
  });

  it('passes synthetic mode and a manifest with no longitudinal block', () => {
    expect(unmarkedPools(cohort('{mode: synthetic, fields: {}}'))).toEqual([]);
    expect(unmarkedPools('cohort: {}\n')).toEqual([]);
  });

  it('finds every unmarked pool in a mixed manifest', () => {
    const yaml = [
      'beneficiary_cohorts:',
      `  - longitudinal: {mode: mirror, numbers: authored, transplant_pool: ${POOL}}`,
      `  - longitudinal: {mode: mirror, transplant_pool: ${POOL}}`,
      '',
    ].join('\n');
    expect(unmarkedPools(yaml)).toEqual(['beneficiary_cohorts[1].longitudinal']);
  });

  it('the example cascade pool builder marks its pool authored', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../docs/examples/cascade/spark-facilitator/pool.py'), 'utf8');
    expect(src).toMatch(/"mode": "mirror", "numbers": "authored"/);
  });
});

describe('readGenerated', () => {
  it('reads generated: true', () => {
    expect(readGenerated('{"folder_id": "", "generated": true}')).toEqual({ generated: true });
  });

  it('reads generated: false with labs reason', () => {
    expect(readGenerated('{"generated": false, "not_generated_because": "mirror pool"}')).toEqual({
      generated: false,
      reason: 'mirror pool',
    });
  });

  it('is undefined when labs does not report it or the payload is not JSON', () => {
    expect(readGenerated('{"folder_id": "x"}')).toEqual({ generated: undefined });
    expect(readGenerated('not json')).toEqual({ generated: undefined });
  });
});
