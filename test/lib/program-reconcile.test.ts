/**
 * Tests for lib/program-reconcile.ts (jjackson/ace#1078).
 *
 * Fixture pair modeled on the live instance that surfaced the class:
 * opp `spark-facilitator`, program a115e4f2-6af6-401b-8add-8b97af80f43c —
 * a stale description authored from an earlier run's PDD (enforced 500m GPS
 * payment gate, >=80% Learn gate, 25k budget, 72h window) vs the current
 * run's PDD (non-enforcing location language, 75% gate, 12k NTE, 48h).
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileProgramWithPdd,
  DURABLE_PROGRAM_FIELDS,
  REFRESHABLE_PROGRAM_FIELDS,
  type LiveProgramFields,
  type PddProgramFields,
} from '../../lib/program-reconcile.js';

const STALE_LIVE: LiveProgramFields = {
  description:
    'CBFs facilitate monthly community meetings. Payment requires: GPS within 500m of the ' +
    'gps_reference at <=50m accuracy (deterministic Layer A gate), CBF passed the Learn ' +
    'post-test at >=80%, record submitted within 72h of submission. 25 communities, 3 months.',
  budget: 25000,
  start_date: '2026-07-28',
  end_date: '2027-01-31',
};

const CURRENT_PDD: PddProgramFields = {
  description:
    'CBFs facilitate weekly community meetings. Location is advisory only — no submission is ' +
    'rejected on location or accuracy, and neither the app nor Connect enforces a radius. Learn ' +
    'post-test gate 75% (9 of 12), record submitted within 48h of the meeting date. 30 communities, 12 weeks.',
  budget: 12000,
  start_date: '2026-08-03',
  end_date: '2026-10-26',
};

describe('reconcileProgramWithPdd — stale fixture', () => {
  const result = reconcileProgramWithPdd(STALE_LIVE, CURRENT_PDD);

  it('flags the stale program as out of sync', () => {
    expect(result.inSync).toBe(false);
  });

  it('diffs description and both dates', () => {
    const fields = result.diffs.map((d) => d.field).sort();
    expect(fields).toEqual(['description', 'end_date', 'start_date']);
  });

  it('does NOT flag budget when the live ceiling exceeds the PDD budget (Step 4a headroom)', () => {
    // live 25000 >= pdd 12000: the ceiling can fund the PDD's intent; the
    // stale prose about "25,000 USD" is fixed by the description update.
    expect(result.diffs.find((d) => d.field === 'budget')).toBeUndefined();
    expect(result.updateArgs.budget).toBeUndefined();
  });

  it('produces connect_update_program args for exactly the diverging fields', () => {
    expect(result.updateArgs).toEqual({
      description: CURRENT_PDD.description,
      start_date: '2026-08-03',
      end_date: '2026-10-26',
    });
  });

  it('emits one [WARN] line per diverging field', () => {
    expect(result.warnings).toHaveLength(result.diffs.length);
    for (const w of result.warnings) {
      expect(w).toMatch(/^\[WARN\] reused Connect program (description|budget|start_date|end_date) diverges/);
    }
  });
});

describe('reconcileProgramWithPdd — matching fixture', () => {
  const matchingLive: LiveProgramFields = {
    description: CURRENT_PDD.description!,
    budget: 12000,
    start_date: '2026-08-03',
    end_date: '2026-10-26',
  };
  const result = reconcileProgramWithPdd(matchingLive, CURRENT_PDD);

  it('is in sync with no diffs, no update args, no warnings', () => {
    expect(result.inSync).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.updateArgs).toEqual({});
    expect(result.warnings).toEqual([]);
  });
});

describe('reconcileProgramWithPdd — edge semantics', () => {
  it('flags budget only when the live ceiling is BELOW the PDD budget, and raises it', () => {
    const result = reconcileProgramWithPdd({ ...STALE_LIVE, budget: 8000 }, CURRENT_PDD);
    const budgetDiff = result.diffs.find((d) => d.field === 'budget');
    expect(budgetDiff).toEqual({ field: 'budget', live: 8000, pdd: 12000 });
    expect(result.updateArgs.budget).toBe(12000);
  });

  it('skips fields the PDD did not derive (absence is never a divergence)', () => {
    const result = reconcileProgramWithPdd(STALE_LIVE, { budget: 12000 });
    expect(result.inSync).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it('treats whitespace-only differences as matching', () => {
    const live = { ...STALE_LIVE, description: '  Weekly   visits. ' };
    const result = reconcileProgramWithPdd(live, { description: 'Weekly visits.' });
    expect(result.inSync).toBe(true);
  });

  it('keeps the durable/refreshable split explicit and disjoint', () => {
    expect([...REFRESHABLE_PROGRAM_FIELDS].sort()).toEqual(
      ['budget', 'description', 'end_date', 'start_date'],
    );
    for (const f of REFRESHABLE_PROGRAM_FIELDS) {
      expect(DURABLE_PROGRAM_FIELDS).not.toContain(f);
    }
    // Identity fields the reuse path must never touch.
    expect(DURABLE_PROGRAM_FIELDS).toContain('id');
    expect(DURABLE_PROGRAM_FIELDS).toContain('organization_slug');
    expect(DURABLE_PROGRAM_FIELDS).toContain('delivery_type');
  });
});
