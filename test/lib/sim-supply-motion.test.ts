import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessSupplyMotion, planWorkerTopUps, type MotionInput } from '../../lib/sim-supply-motion';

const liveConnectFi = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/connect-fi-20261018-1440-supply-motion.json'), 'utf8'),
) as MotionInput;

describe('planWorkerTopUps', () => {
  it('issues an opening float in week 1 and tops back up to it', () => {
    const plan = planWorkerTopUps({ issues: { w01: { 1: 1, 2: 3, 3: 2, 4: 0 } }, weeks: 4 });
    expect(plan.float.w01).toBe(6); // busiest week 3 x 2 weeks
    expect(plan.issued.w01).toEqual({ 1: 6, 2: 1, 3: 3, 4: 2 });
    expect(plan.on_hand_end.w01).toEqual({ 1: 5, 2: 3, 3: 4, 4: 6 });
  });

  it('never plans a worker below zero, even in a week busier than the float', () => {
    const plan = planWorkerTopUps({ issues: { w: { 1: 0, 2: 9 } }, weeks: 2, float_weeks: 0.5 });
    expect(plan.float.w).toBe(5);
    expect(Object.values(plan.on_hand_end.w).every((q) => q >= 0)).toBe(true);
    expect(plan.issued.w[2]).toBe(4); // topped up to 9 for that week
  });

  it('a worker with no handovers still carries the minimum float', () => {
    const plan = planWorkerTopUps({ issues: { idle: {} }, weeks: 3 });
    expect(plan.issued.idle).toEqual({ 1: 1, 2: 0, 3: 0 });
    expect(plan.on_hand_end.idle[3]).toBe(1);
  });

  it('the withheld top-up is the planted stockout: that worker runs out', () => {
    const plan = planWorkerTopUps({ issues: { w: { 1: 2, 2: 2, 3: 2 } }, weeks: 3, withhold: { username: 'w', week: 3 } });
    expect(plan.issued.w[3]).toBe(0);
    expect(plan.on_hand_end.w[3]).toBe(0);
    expect(plan.on_hand_end.w[2]).toBeGreaterThan(0);
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
