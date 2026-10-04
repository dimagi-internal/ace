/**
 * A close date may only claim a buffer the delivery window actually leaves.
 *
 * Rows below are copied verbatim (fields that matter) from the REAL
 * decisions.yaml of spark-facilitator/20261001-2208
 * (Drive 1mJDoXuJolHqApYrr5m-gObwqDl6sVFzJvWJKklxP9uM): delivery runs
 * 2026-11-02 to 2027-02-26 and the opportunity "closes on 26 February 2027,
 * including a two-week buffer".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkBufferClaims, claimsBuffer } from '../../lib/buffer-claim';
import { DecisionsWriteError, composeAppendedLog } from '../../lib/decisions-write';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
const LOG = yaml.parse(
  readFileSync(join(__dirname, '../fixtures/buffer-claim/spark-20261001-2208-decisions.yaml'), 'utf8'),
) as { decisions: Row[] };
const ALL_ROWS: Row[] = LOG.decisions;
const byId = (id: string): Row => ({ ...ALL_ROWS.find((r) => r.id === id) });
// Fresh-append copies (no supersession links) for the write-boundary tests.
const strip = (r: Row): Row => {
  const { superseded_by: _s, supersedes: _p, ...rest } = r;
  return rest;
};
const SPARK_DELIVERY = byId('opportunity-dates');
const SPARK_CLOSE = byId('opportunity-end-date-spark');

describe('checkBufferClaims', () => {
  it('flags the real spark claim: close date = delivery end, yet "including a two-week buffer"', () => {
    // The whole real excerpt, supersession chain included: only the live row is judged.
    const v = checkBufferClaims(LOG.decisions);
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('opportunity-end-date-spark');
    expect(v[0].deliveryRowId).toBe('opportunity-dates');
    expect(v[0].detail).toContain('the same day, so there is no buffer');
  });

  it('passes when the close date really is later than the delivery end', () => {
    const close = { ...SPARK_CLOSE, 'ai-default': '2027-03-12', options: ['2027-03-12'] };
    expect(checkBufferClaims([SPARK_DELIVERY, close])).toEqual([]);
  });

  it('passes when the row states the date plainly (no buffer claimed)', () => {
    const close = {
      ...SPARK_CLOSE,
      plain: 'The Connect opportunity closes on 26 February 2027, the day delivery ends.',
      reasoning: 'PDD proposed end date; moves with the awarded response.',
    };
    expect(checkBufferClaims([SPARK_DELIVERY, close])).toEqual([]);
  });

  it('passes when no delivery window is stated (nothing to contradict)', () => {
    expect(checkBufferClaims([SPARK_CLOSE])).toEqual([]);
  });

  it('ignores superseded rows', () => {
    expect(checkBufferClaims([SPARK_DELIVERY, { ...SPARK_CLOSE, superseded_by: 'x' }])).toEqual([]);
  });

  it('"no buffer" is not a buffer claim', () => {
    expect(claimsBuffer({ id: 'opportunity-end-date', plain: 'Closes the day delivery ends; there is no buffer.' })).toBe(false);
  });
});

describe('decisions write boundary refuses the false claim', () => {
  const base = { opportunity: 'spark-facilitator', run_id: '20261001-2208', now: () => '2026-10-03T00:00:00Z' };

  it('throws UNSUPPORTED_BUFFER_CLAIM for the real spark pair', () => {
    expect.assertions(2);
    try {
      composeAppendedLog({ ...base, existingYamlText: null, rows: [strip(SPARK_DELIVERY), strip(SPARK_CLOSE)] });
    } catch (e) {
      expect(e).toBeInstanceOf(DecisionsWriteError);
      expect((e as DecisionsWriteError).code).toBe('UNSUPPORTED_BUFFER_CLAIM');
    }
  });

  it('accepts the same rows once the claim is removed', () => {
    const close = { ...SPARK_CLOSE, plain: 'The Connect opportunity closes on 26 February 2027.', reasoning: 'PDD proposed end date.' };
    const r = composeAppendedLog({ ...base, existingYamlText: null, rows: [strip(SPARK_DELIVERY), strip(close)] });
    expect(r.added).toBe(2);
  });
});
