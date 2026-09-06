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
  checkNameArchetype,
  detectArchetypesInName,
  ARCHETYPE_NAME_TOKENS,
  DURABLE_PROGRAM_FIELDS,
  REFRESHABLE_PROGRAM_FIELDS,
  type LiveProgramFields,
  type PddProgramFields,
} from '../../lib/program-reconcile.js';
import { assertChecked, assertUnable, isPass } from '../../lib/check-outcome.js';

const STALE_LIVE: LiveProgramFields = {
  // ace#1966 — an archetype-neutral name (invented for this fixture; the live
  // program's actual name was not read), so the name check RUNS and passes.
  // Without a name it reports UNABLE, which is deliberately not silent.
  name: 'Spark Community Facilitator Programme',
  description:
    'CBFs facilitate monthly community meetings. Payment requires: GPS within 500m of the ' +
    'gps_reference at <=50m accuracy (deterministic Layer A gate), CBF passed the Learn ' +
    'post-test at >=80%, record submitted within 72h of submission. 25 communities, 3 months.',
  budget: 25000,
  start_date: '2026-07-28',
  end_date: '2027-01-31',
};

const CURRENT_PDD: PddProgramFields = {
  archetype: 'atomic-visit',
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
    name: 'Spark Community Facilitator Programme',
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
//
// ace#1966 — a program NAME can assert a superseded archetype forever.
//
// `bednet-check-2-visit/20260902-1555`: the durable program is named
// "Bednet Check Multi-Stage Study — 2026" while the description ACE refreshed
// on it in the same step says "Archetype: longitudinal-visits, and
// deliberately NOT multi-stage". `name` is durable, so reconcile refreshed six
// parameters and reported diffs: ['description'] — saying nothing about the
// one field a reader sees first.
//
// The fix does NOT keep the name correct (that is a rename, and a rename is an
// operator's call). It makes the name non-authoritative: the divergence is
// reported in CODE, and nothing derives an archetype from a name.
//
describe('checkNameArchetype — what a program NAME asserts (ace#1966)', () => {
  it('flags the live case: a multi-stage name under a longitudinal-visits PDD', () => {
    const r = checkNameArchetype('Bednet Check Multi-Stage Study — 2026', 'longitudinal-visits');
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      {
        name: 'Bednet Check Multi-Stage Study — 2026',
        declared: 'longitudinal-visits',
        asserted: ['multi-stage'],
      },
    ]);
  });

  it('passes when the name agrees with the PDD — and still reports what it read', () => {
    const r = checkNameArchetype('Bednet Check Multi-Stage Study — 2026', 'multi-stage');
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    // Present on a PASS too: "the name agrees" and "the name says nothing" are
    // different facts, and a reader of the program notes wants both.
    expect(r.asserted).toEqual(['multi-stage']);
  });

  it('passes an archetype-NEUTRAL name — the recommended outcome — asserting nothing', () => {
    // "<Domain> Survey" is the recommended atomic-visit name AND a word
    // longitudinal programmes use freely. A detector that read it as an
    // assertion would fire on names that assert nothing.
    for (const [name, declared] of [
      ['Bednet Check Survey — 2026', 'longitudinal-visits'],
      ['Malaria Field Deployment', 'multi-stage'],
      ['Household Poverty Targeting Survey', 'atomic-visit'],
    ] as const) {
      const r = checkNameArchetype(name, declared);
      assertChecked(r);
      expect(r.ok).toBe(true);
      expect(r.asserted).toEqual([]);
    }
  });

  it('reads the hyphenated, spaced and joined spellings humans actually write', () => {
    for (const name of ['X Multi-Stage Study', 'X Multi Stage Study', 'X Multistage Study']) {
      expect(detectArchetypesInName(name)).toEqual(['multi-stage']);
    }
  });

  it('reads FGD and focus-group names as focus-group', () => {
    expect(detectArchetypesInName('Vaccine Hesitancy Pilot (FGD) — Q2 2026')).toEqual(['focus-group']);
    expect(detectArchetypesInName('Nutrition Focus Group Study')).toEqual(['focus-group']);
  });

  it('reads the longitudinal names the skill § Archetypes recommends', () => {
    expect(detectArchetypesInName('Bednet Check Follow-Up Study')).toEqual(['longitudinal-visits']);
    expect(detectArchetypesInName('Bednet Check Two-Visit Study')).toEqual(['longitudinal-visits']);
  });

  it('reports a self-contradictory name rather than picking one of its claims', () => {
    const r = checkNameArchetype('Bednet Multi-Stage Follow-Up Study', 'longitudinal-visits');
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings[0].asserted).toEqual(['multi-stage', 'longitudinal-visits']);
  });

  it('is UNABLE, not a pass, when either side is missing', () => {
    // The state that used to be `null` alongside "the name is fine". Silence
    // there is indistinguishable from a verified-clean name — the exact class
    // lib/check-outcome.ts exists to close (ace#1332 -> #1538 -> #1576 -> #1634).
    for (const r of [
      checkNameArchetype(undefined, 'multi-stage'),
      checkNameArchetype('X Multi-Stage Study', undefined),
      checkNameArchetype('   ', 'multi-stage'),
    ]) {
      assertUnable(r);
      expect(r.reason).not.toBe('');
      expect(isPass(r)).toBe(false);
    }
  });

  it('names WHICH side was missing, so the reason is actionable', () => {
    const noName = checkNameArchetype(undefined, 'multi-stage');
    assertUnable(noName);
    expect(noName.reason).toContain('live.name');

    const noArchetype = checkNameArchetype('X Multi-Stage Study', undefined);
    assertUnable(noArchetype);
    expect(noArchetype.reason).toContain('pdd.archetype');
  });

  it('gives atomic-visit no token at all — a neutral name must produce silence', () => {
    expect(ARCHETYPE_NAME_TOKENS.map((t) => t.archetype)).not.toContain('atomic-visit');
  });
});

describe('reconcileProgramWithPdd — the name check rides in warnings[] (ace#1966)', () => {
  const inSyncLive: LiveProgramFields = {
    name: 'Bednet Check Multi-Stage Study — 2026',
    description: 'Archetype: longitudinal-visits, and deliberately NOT multi-stage.',
    budget: 5000,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
  };
  const inSyncPdd: PddProgramFields = {
    description: 'Archetype: longitudinal-visits, and deliberately NOT multi-stage.',
    budget: 5000,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    archetype: 'longitudinal-visits',
  };

  it('warns about the name even when every REFRESHABLE field is in sync', () => {
    // The trap. A caller that emits warnings only on the diverging branch
    // drops exactly this case — the shape of the live defect: the run
    // refreshed six parameters and reported nothing about the name.
    const r = reconcileProgramWithPdd(inSyncLive, inSyncPdd);
    expect(r.inSync).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('[WARN]');
    expect(r.warnings[0]).toContain('NAME asserts archetype multi-stage');
    expect(r.warnings[0]).toContain('longitudinal-visits');
  });

  it('exposes the check as structured data, not only as prose', () => {
    const r = reconcileProgramWithPdd(inSyncLive, inSyncPdd);
    assertChecked(r.nameArchetype);
    expect(r.nameArchetype.ok).toBe(false);
    expect(r.nameArchetype.findings[0].declared).toBe('longitudinal-visits');
  });

  it('is silent about the name when it agrees with the PDD', () => {
    const r = reconcileProgramWithPdd(inSyncLive, { ...inSyncPdd, archetype: 'multi-stage' });
    expect(r.warnings).toEqual([]);
    expect(isPass(r.nameArchetype)).toBe(true);
  });

  it('NEVER puts name in updateArgs — the reconciler reports, it does not rename', () => {
    const r = reconcileProgramWithPdd({ ...inSyncLive, description: 'stale text' }, inSyncPdd);
    expect(r.updateArgs).not.toHaveProperty('name');
    expect(Object.keys(r.updateArgs)).toEqual(['description']);
  });

  it('leaves name out of the diffs — a durable field is not a refreshable divergence', () => {
    const r = reconcileProgramWithPdd(inSyncLive, inSyncPdd);
    expect(r.diffs.map((d) => d.field)).not.toContain('name');
  });

  it('says UNABLE TO CHECK — loudly, not silently — when the caller omits either input', () => {
    const { name: _n, ...noName } = inSyncLive;
    const r = reconcileProgramWithPdd(noName, inSyncPdd);
    assertUnable(r.nameArchetype);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('UNABLE TO CHECK');
    expect(r.warnings[0]).toContain('This is NOT a pass');
  });

  it('carries the name warning ALONGSIDE the per-field ones, never instead of them', () => {
    const r = reconcileProgramWithPdd(
      { ...inSyncLive, description: 'stale text', budget: 100 },
      inSyncPdd,
    );
    expect(r.warnings).toHaveLength(3); // description, budget, name
    expect(r.warnings.filter((w) => w.includes('NAME asserts archetype'))).toHaveLength(1);
  });
});
