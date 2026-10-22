import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessSupplyMotion, planWorkerTopUps, type MotionInput } from '../../lib/sim-supply-motion';

const liveConnectFi = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/connect-fi-20261018-1440-supply-motion.json'), 'utf8'),
) as MotionInput;

describe('planWorkerTopUps', () => {
  it('issues the float plus week 1 handovers, then replaces what was handed over', () => {
    const plan = planWorkerTopUps({ issues: { w01: { 1: 1, 2: 3, 3: 2, 4: 0 } }, weeks: 4 });
    expect(plan.float.w01).toBe(3); // average 1.5 a week x 2 weeks
    expect(plan.issued.w01).toEqual({ 1: 4, 2: 3, 3: 2, 4: 0 });
    expect(plan.on_hand_end.w01).toEqual({ 1: 3, 2: 3, 3: 3, 4: 3 });
  });

  it('a one-week spike is issued that week, not front-loaded, and leaves the worker holding the float', () => {
    // connect-fi moroto_w04's handovers, read off its rebuilt visits: the card-collection round lands in week 4.
    const plan = planWorkerTopUps({ issues: { w04: { 1: 0, 2: 1, 3: 0, 4: 9 } }, weeks: 4 });
    expect(plan.float.w04).toBe(5);
    expect(plan.issued.w04).toEqual({ 1: 5, 2: 1, 3: 0, 4: 9 });
    expect(plan.on_hand_end.w04[4]).toBe(5);
  });

  it('no worker ever ends a week below the float (connect-fi left every worker at 0)', () => {
    const issues = { a: { 1: 0, 2: 9 }, b: { 1: 4, 2: 0 }, c: {} };
    const plan = planWorkerTopUps({ issues, weeks: 2, float_weeks: 0.5 });
    for (const u of Object.keys(issues)) for (const w of [1, 2]) expect(plan.on_hand_end[u][w]).toBe(plan.float[u]);
  });

  it('a worker with no handovers still carries the minimum float', () => {
    const plan = planWorkerTopUps({ issues: { idle: {} }, weeks: 3 });
    expect(plan.issued.idle).toEqual({ 1: 1, 2: 0, 3: 0 });
    expect(plan.on_hand_end.idle[3]).toBe(1);
  });

  it('refuses a nonsense window', () => {
    expect(() => planWorkerTopUps({ issues: {}, weeks: 0 })).toThrow(/weeks/);
  });
});

describe('assessSupplyMotion', () => {
  it('fails the live connect-fi/20261018-1440 supply chain that every per-week QA passed', () => {
    const v = assessSupplyMotion(liveConnectFi);
    expect(v.pass).toBe(false);
    expect(v.figures).toMatchObject({ received: 814, left_central: 44, given_at_visits: 40 });
    const joined = v.problems.join('\n');
    expect(joined).toMatch(/only 44 of 814 received left the central store/);
    expect(joined).toMatch(/not tied to the visit opportunity/);
    expect(joined).toMatch(/carry no float/);
  });

  it('passes a network in motion', () => {
    const series = (n: number) => [0, n / 4, n / 2, (3 * n) / 4, n];
    const workers = ['w1', 'w2', 'w3'];
    const v = assessSupplyMotion({
      opportunity_id: 10200,
      flow: {
        nodes: [
          { id: 'c1', kind: 'source' },
          { id: 'p1', kind: 'store' },
          { id: 'p2', kind: 'store' },
          { id: 'given', kind: 'sink' },
          ...workers.map((id) => ({ id, kind: 'worker' })),
        ],
        links: [
          { source: 'c1', target: 'p1', series: [400, 400, 400, 400, 400] },
          { source: 'p1', target: 'p2', series: series(240) },
          ...workers.flatMap((id) => [
            { source: 'p2', target: id, series: series(80) },
            { source: id, target: 'given', series: series(60) },
          ]),
        ],
      },
      workers_on_opportunity: workers.map((u) => ({ connect_username: u, opportunity_id: 10200, dispensed: { amount: '60' } })),
      on_hand_by_week: Object.fromEntries(workers.map((u) => [u, { 1: 5, 2: 4, 3: 6, 4: 20 }])),
      stores: [
        { id: 1, has_coordinates: true },
        { id: 2, has_coordinates: true },
      ],
    });
    expect(v.problems).toEqual([]);
    expect(v.pass).toBe(true);
  });
});
