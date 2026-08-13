import { describe, it, expect } from 'vitest';

import {
  classifyOppConsumption,
  type LearnRowLike,
  type DeliverRowLike,
} from '../../lib/opp-consumption.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#796 — Phase 6 retry on an already-walked run.
//
// Learn completion is ONE-WAY per (test user, opportunity). Once a Phase-6
// dispatch walks Learn to 100% and consumes the visit quota, a RETRY on the
// same run cannot restore the precondition — the run reuses the same opp. The
// only restore is a fresh /ace:run.
//
// Today that is discovered ~10 minutes in, after a full AVD cold boot, as a
// cryptic Deliver-leg failure. This classifier is the pre-AVD probe that turns
// it into an immediate, named halt.
//
// THE RULE THAT SHAPES EVERY TEST BELOW (CLAUDE.md § "attempt the transition,
// treat the conflict as the skip"): this is a COST-skip, not a correctness
// skip. It exists to avoid burning wall-clock on a walk that cannot succeed.
// So every ambiguous read must FAIL OPEN — proceed and let the recipe branches
// stay authoritative. A false `fully-consumed` would halt a run that could
// have walked, which is strictly worse than the wasted boot it is preventing.
// ---------------------------------------------------------------------------

const WORKER = 'ACE Test';

const learn = (over: Partial<LearnRowLike> = {}): LearnRowLike => ({
  name: WORKER,
  modules_completed_pct: 0,
  learn_complete: false,
  ...over,
});

const deliver = (over: Partial<DeliverRowLike> = {}): DeliverRowLike => ({
  name: WORKER,
  payment_unit: 'Household visit',
  progress_completed: 0,
  progress_total: 5,
  ...over,
});

describe('classifyOppConsumption — the walkable state', () => {
  it('fresh opp: Learn not started → both legs walkable', () => {
    const r = classifyOppConsumption({
      learnWorkers: [learn()],
      deliverWorkers: [deliver()],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('fresh');
    expect(r.learn_complete).toBe(false);
    expect(r.walkable_legs).toEqual(['learn', 'deliver']);
  });

  it('Learn partially done is still fresh — only 100% gates Deliver', () => {
    // Connect sets completed_learn_date only at 100%; 80% does not consume
    // the Learn precondition, so the Learn walk is still available.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ modules_completed_pct: 80, learn_complete: false })],
      deliverWorkers: [deliver()],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('fresh');
    expect(r.walkable_legs).toContain('learn');
  });

  it('Learn complete but quota remaining → learn-consumed, Deliver still walkable', () => {
    // This is the state #570/#863 already handle on-device: the claim recipe
    // records `satisfied-by-prior-completion` and proceeds to the Deliver leg.
    // The probe must NOT halt here.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ modules_completed_pct: 100, learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 2, progress_total: 5 })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('learn-consumed');
    expect(r.learn_complete).toBe(true);
    expect(r.deliver_quota_exhausted).toBe(false);
    expect(r.walkable_legs).toEqual(['deliver']);
  });
});

describe('classifyOppConsumption — the halt state (#796 repro)', () => {
  it('Learn complete AND quota exhausted → fully-consumed, nothing walkable', () => {
    // The exact bednet-spot-check/20260617-2125 state: the device banner read
    // "Daily Visits 1/1 — you have completed the maximum number of visits."
    const r = classifyOppConsumption({
      learnWorkers: [learn({ modules_completed_pct: 100, learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 1, progress_total: 1 })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('fully-consumed');
    expect(r.deliver_quota_exhausted).toBe(true);
    expect(r.walkable_legs).toEqual([]);
  });

  it('over-delivery still counts as exhausted', () => {
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 7, progress_total: 5 })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('fully-consumed');
  });

  it('exhausted on ONE payment unit but not another is NOT fully-consumed', () => {
    // Multi-payment-unit opps render one row per worker+unit. A walk can still
    // deliver against the unit with headroom, so this must stay walkable.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [
        deliver({ payment_unit: 'Household visit', progress_completed: 1, progress_total: 1 }),
        deliver({ payment_unit: 'Follow-up', progress_completed: 0, progress_total: 3 }),
      ],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('learn-consumed');
    expect(r.deliver_quota_exhausted).toBe(false);
    expect(r.walkable_legs).toEqual(['deliver']);
  });
});

describe('classifyOppConsumption — fail-open cases (a wrong halt is worse than a wasted boot)', () => {
  it('worker absent from the Learn roster → worker-not-found, still proceeds', () => {
    // The test user may not be accepted yet, or the roster read may be stale.
    // Never conclude "consumed" from a missing row.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ name: 'Someone Else', learn_complete: true })],
      deliverWorkers: [deliver({ name: 'Someone Else', progress_completed: 1, progress_total: 1 })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('worker-not-found');
    expect(r.walkable_legs).toEqual(['learn', 'deliver']);
  });

  it('empty rosters → worker-not-found, still proceeds', () => {
    const r = classifyOppConsumption({
      learnWorkers: [],
      deliverWorkers: [],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('worker-not-found');
    expect(r.walkable_legs).toEqual(['learn', 'deliver']);
  });

  it('progress_total null (unreadable quota) → never fully-consumed', () => {
    // parseWorkerDeliverTable returns null when the progress bar did not
    // render two integers. Unreadable is NOT exhausted.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: null, progress_total: null })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('learn-consumed');
    expect(r.deliver_quota_exhausted).toBe(false);
    expect(r.walkable_legs).toEqual(['deliver']);
  });

  it('Learn complete but NO deliver rows at all → never fully-consumed', () => {
    // A worker accepted on Learn may have no Deliver row until the first
    // submission. Absence of evidence is not exhaustion.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('learn-consumed');
    expect(r.deliver_quota_exhausted).toBe(false);
  });

  it('progress_total 0 is not a divide-by-zero exhaustion', () => {
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 0, progress_total: 0 })],
      workerName: WORKER,
    });
    expect(r.deliver_quota_exhausted).toBe(false);
    expect(r.verdict).toBe('learn-consumed');
  });

  it('learn_complete wins over a stale pct — trust the boolean Connect derived', () => {
    // parseWorkerLearnTable sets learn_complete from pct >= 100 OR a rendered
    // completed_learn_date. The date is the authoritative gate, so a row with
    // the date but a lagging pct is still complete.
    const r = classifyOppConsumption({
      learnWorkers: [learn({ modules_completed_pct: 0, learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 1, progress_total: 1 })],
      workerName: WORKER,
    });
    expect(r.verdict).toBe('fully-consumed');
  });
});

describe('classifyOppConsumption — name matching', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const r = classifyOppConsumption({
      learnWorkers: [learn({ name: '  ace test  ', learn_complete: true })],
      deliverWorkers: [deliver({ name: 'ACE TEST', progress_completed: 1, progress_total: 1 })],
      workerName: 'ACE Test',
    });
    expect(r.verdict).toBe('fully-consumed');
  });
});

describe('classifyOppConsumption — every verdict carries an operator-readable reason', () => {
  it('names the remediation on the halting verdict', () => {
    const r = classifyOppConsumption({
      learnWorkers: [learn({ learn_complete: true })],
      deliverWorkers: [deliver({ progress_completed: 1, progress_total: 1 })],
      workerName: WORKER,
    });
    // The halt is only actionable if it says what to do. Per CLAUDE.md the
    // ONLY restore for a consumed opp is a fresh run — never an opp re-mint
    // (#573: a fresh opp reusing the same released Deliver app cannot create a
    // payment unit).
    expect(r.reason).toMatch(/fresh .?\/ace:run/i);
    expect(r.reason).toMatch(/1\/1/);
  });

  it('every verdict has a non-empty reason', () => {
    const cases = [
      { learnWorkers: [learn()], deliverWorkers: [deliver()] },
      { learnWorkers: [learn({ learn_complete: true })], deliverWorkers: [deliver()] },
      {
        learnWorkers: [learn({ learn_complete: true })],
        deliverWorkers: [deliver({ progress_completed: 1, progress_total: 1 })],
      },
      { learnWorkers: [], deliverWorkers: [] },
    ];
    for (const c of cases) {
      const r = classifyOppConsumption({ ...c, workerName: WORKER });
      expect(r.reason.length, `verdict ${r.verdict} must explain itself`).toBeGreaterThan(0);
    }
  });
});
