/**
 * lib/clone-run.ts — the pure half of scripts/clone-run.ts (dimagi-internal/ace#3021).
 *
 * Fixtures are trimmed, verbatim copies of a real run: the source
 * dimagi-team/noora-health/20261015-1129 and the PARTIAL clone of it into the
 * noora-health workspace (HQ done, Connect rebuilt by the old agent-driven
 * Phase 4 re-dispatch, clone.connect still not-done).
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  AmbiguousCreateError,
  RefusedCreateError,
  STAGES,
  adoptableTargetConnect,
  checkTenantWrite,
  cloneSourceFromRunState,
  connectBuildSpec,
  connectProductsPatch,
  decideCreate,
  hqProductsPatch,
  isAmbiguousError,
  lookThenCreate,
  mapDeliverUnits,
  mapDuIds,
  planStages,
  productsPointAtTarget,
  rebuildLabs,
  rewriteReleaseSummary,
  summaryUrl,
  type CreateRecord,
} from '../../lib/clone-run.js';

const FIX = path.resolve(__dirname, '../fixtures/clone-run');
const source = YAML.parse(fs.readFileSync(path.join(FIX, 'source-run-state.yaml'), 'utf8'));
const partial = YAML.parse(fs.readFileSync(path.join(FIX, 'target-partial-run-state.yaml'), 'utf8'));
// The target's real tenancy, as ace-web answered it.
const TENANCY = JSON.parse(fs.readFileSync(path.join(FIX, 'target-tenancy.json'), 'utf8')).tenancy as {
  hq_domain: string; connect_pm_org: string; connect_holding_org: string;
};
const SUMMARY = `---
apps:
  learn_app:
    hq_app_id: f8b8c340d7a1405e8e11645c71227a9d
    build_id: c74ae6da729f45c7bdbf4784065f1bcf
    version: 9
    is_released: true
    released_at: "2026-10-15T18:40:00Z"
  deliver_app:
    hq_app_id: c4f71cdc67a0480890b1cb0940919380
    build_id: ea89cb02a9174881bced1e64a7056cc0
    version: 7
    is_released: true
    released_at: "2026-10-15T18:41:00Z"
---
# App release — noora-health / 20261015-1129

Learn build c74ae6da… (v9) in connect-ace-prod.
`;

describe('cloneSourceFromRunState — transcribed, never derived', () => {
  const src = cloneSourceFromRunState(source, SUMMARY);

  it('reads both apps and their RELEASED builds from app-release_summary first (ace#2702)', () => {
    expect(src.problems).toEqual([]);
    expect(src.apps.learn).toMatchObject({
      domain: 'connect-ace-prod',
      hq_app_id: 'f8b8c340d7a1405e8e11645c71227a9d',
      name: 'Newborn Care Classes Learn app',
      build_id: 'c74ae6da729f45c7bdbf4784065f1bcf',
      version: '9',
      build_from: 'app-release_summary',
    });
    expect(src.apps.deliver?.build_id).toBe('ea89cb02a9174881bced1e64a7056cc0');
  });

  it('falls back to run_state released_build_id when the summary has none', () => {
    const s = cloneSourceFromRunState(source, null);
    expect(s.apps.learn?.build_from).toBe('run_state');
    expect(s.apps.learn?.build_id).toBe('c74ae6da729f45c7bdbf4784065f1bcf');
  });

  it('refuses "latest saved" when no released build is recorded anywhere', () => {
    const rs = structuredClone(source);
    delete rs.phases['commcare-setup'].products.apps.learn.released_build_id;
    const s = cloneSourceFromRunState(rs, null);
    expect(s.apps.learn?.build_id).toBeNull();
    expect(s.problems.join(' ')).toMatch(/learn: no released build/);
  });

  it('reads the Connect products in the source orgs', () => {
    expect(src.connect).toMatchObject({
      pm_org: 'ace-pm-org',
      holding_org: 'ace-nm-org',
      program_id: 'bbae9eee-32b8-406c-889b-541ddfd8da9c',
      opportunity_id: '99b9bf42-602e-4ee0-819f-1bfe1530ba77',
      opportunity_name: '20261015-1129 · Newborn Care Companion Classes',
      test_user_phone: '+74260000101',
    });
    expect(src.ocs_public_url).toMatch(/openchatstudio\.com\/a\/connect-ace\/chatbots\//);
  });
});

describe('connectBuildSpec — the values Connect is re-built with', () => {
  const src = cloneSourceFromRunState(source, SUMMARY);
  const reads = {
    program: {
      name: 'Newborn Care Companion Classes — Kano Field Deployment 2027',
      description: 'An illustrative design…',
      delivery_type: 0, // the edit form does not render create-time-only fields
      budget: 144000000,
      currency: '',
      country: 'NGA',
      start_date: '2027-01-11',
      end_date: '2027-05-02',
    },
    opportunity: {
      short_description: 'Caregiver newborn-care classes on postnatal wards',
      description: 'Run short newborn-care classes in Hausa … up to 2 paid classes a day.',
    },
    init_form: { learn_app_description: 'Learn to run a newborn care class.' },
  };
  const spec = connectBuildSpec(src, reads);

  it('has no gaps for the real run', () => {
    expect(spec.problems).toEqual([]);
  });

  it('takes the PDD numbers the run recorded, not re-derived values', () => {
    expect(spec.program.delivery_type).toBe(9);
    expect(spec.provenance['program.delivery_type']).toBe('pdd.program_parameters.connect_delivery_type.id');
    expect(spec.program.currency).toBe('NGN');
    expect(spec.program.country).toBe('Nigeria');
    expect(spec.program.budget).toBe(144000000); // the source program's post-headroom ceiling
    expect(spec.opportunity).toMatchObject({
      name: '20261015-1129 · Newborn Care Companion Classes',
      start_date: '2027-01-11',
      end_date: '2027-05-02',
      total_budget: 14400000,
      passing_score: 80,
      is_test: true,
      learn_description: 'Learn to run a newborn care class.',
    });
  });

  it('transcribes the payment unit and verification rules from products', () => {
    expect(spec.payment_units).toEqual([
      { name: 'Verified caregiver class', amount: 5000, org_amount: 3000, max_total: 90, max_daily: 2, source_required_deliver_units: [7270] },
    ]);
    expect(spec.verification.form_field_rules).toEqual([
      { name: 'payable_class=yes', question_path: 'form.payable_class', question_value: 'yes', source_deliver_unit_id: 7270 },
    ]);
    // The older source products lack the window + duration; the PDD recorded them.
    expect(spec.verification.form_submission_start).toBe('06:00:00');
    expect(spec.verification.form_submission_end).toBe('20:00:00');
    expect(spec.verification.durations).toEqual([{ source_deliver_unit_id: null, duration_minutes: 20 }]);
    expect(spec.test_user_phone).toBe('+74260000101');
  });

  it('names every missing value instead of inventing one', () => {
    const s = connectBuildSpec(src, {});
    expect(s.problems).toEqual(expect.arrayContaining([
      'no recorded value for program.name',
      'no recorded value for program.description',
      'no recorded value for opportunity.short_description',
    ]));
  });

  it('refuses a short_description Connect would truncate (50-char trap)', () => {
    const s = connectBuildSpec(src, { ...reads, opportunity: { ...reads.opportunity, short_description: 'x'.repeat(51) } });
    expect(s.problems.join(' ')).toMatch(/51 chars/);
  });
});

describe('mapDeliverUnits', () => {
  it('maps a single unit by construction and several by slug', () => {
    expect([...mapDeliverUnits([{ id: 1, server_id: 7270, name: 'Caregiver class', slug: 'caregiver_class' }], [{ id: 1, server_id: 7295, name: 'Caregiver class', slug: 'caregiver_class' }])]).toEqual([[7270, 7295]]);
    const m = mapDeliverUnits(
      [{ id: 1, server_id: 10, name: 'A', slug: 'a' }, { id: 2, server_id: 11, name: 'B', slug: 'b' }],
      [{ id: 1, server_id: 21, name: 'B', slug: 'b' }, { id: 2, server_id: 20, name: 'A', slug: 'a' }],
    );
    expect(mapDuIds([10, 11], m, 'pu')).toEqual([20, 21]);
  });
  it('throws on an unmappable unit rather than paying for the wrong form', () => {
    expect(() => mapDuIds([99], new Map([[10, 20]]), 'pu')).toThrow(/no counterpart/);
  });
});

describe('planStages — resume from a partial clone: block', () => {
  it('runs everything on a fresh target', () => {
    expect(planStages(undefined).map((p) => p.action)).toEqual(STAGES.map(() => 'run'));
  });

  it('resumes the real partial clone: skips hq + ocs, redoes labs, runs connect', () => {
    const plan = Object.fromEntries(planStages(partial.clone).map((p) => [p.stage, p]));
    expect(plan.hq.action).toBe('skip');
    expect(plan.ocs.action).toBe('skip');
    expect(plan.connect).toMatchObject({ action: 'run', why: 'resuming from not-done' });
    // "Labs stays Dimagi-only" was the defect ace#3020 reports — never final.
    expect(plan.labs).toMatchObject({ action: 'run', why: 'resuming from skipped' });
    expect(plan.ace_web.action).toBe('run'); // looks first: ace-web's record is already done → no re-POST
  });

  it('honours --only and --redo', () => {
    const only = planStages(partial.clone, { only: ['readme'] });
    expect(only.filter((p) => p.action === 'run').map((p) => p.stage)).toEqual(['readme']);
    const redo = planStages(partial.clone, { redo: ['hq'] });
    expect(redo.find((p) => p.stage === 'hq')?.action).toBe('run');
  });
});

describe('adoptableTargetConnect — an earlier attempt already built Connect in the target orgs', () => {
  const src = cloneSourceFromRunState(source, SUMMARY);
  it('adopts the partial clone\'s program + opportunity instead of building a second set', () => {
    expect(adoptableTargetConnect(partial, TENANCY, src)).toEqual({
      program_id: 'b58121f3-9599-4949-ae3f-c951ce8241e4',
      opportunity_id: '42121823-40a2-4ab1-95e4-ca209dba1be1',
      application_id: '10f5054d-988b-40b9-a61c-a4c7a35de9ee',
    });
  });
  it('never adopts the SOURCE products a fresh ace-web copy still carries', () => {
    expect(adoptableTargetConnect(source, TENANCY, src)).toBeNull();
  });
  it('never adopts products in other orgs', () => {
    expect(adoptableTargetConnect(partial, { ...TENANCY, connect_holding_org: 'someone-else' }, src)).toBeNull();
  });
});

describe('"a timeout is not a failure — look before retry"', () => {
  it('decideCreate: adopt what is found; refuse a blind retry after an ambiguous create', () => {
    expect(decideCreate(undefined, { id: 'x' })).toEqual({ action: 'adopt', id: 'x' });
    expect(decideCreate(undefined, null)).toEqual({ action: 'create' });
    const amb: CreateRecord = { status: 'ambiguous', at: '2026-10-16T05:40:00Z', error: 'HTTP 504 Gateway Time-out' };
    expect(decideCreate(amb, null).action).toBe('refuse');
    expect(decideCreate(amb, null, { retryAmbiguous: true })).toEqual({ action: 'create' });
    expect(decideCreate(amb, { id: 'late' })).toEqual({ action: 'adopt', id: 'late' });
  });

  it('isAmbiguousError: transport outcomes are ambiguous, validation errors are not', () => {
    expect(isAmbiguousError(new Error('HTTP 504 Gateway Time-out'))).toBe(true);
    expect(isAmbiguousError(new Error('Timeout 30000ms exceeded'))).toBe(true);
    expect(isAmbiguousError(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousError(new Error('validation_error: name: This field is required'))).toBe(false);
  });

  it('a create that times out but landed is adopted on the re-look — never created twice', async () => {
    const saved: CreateRecord[] = [];
    let appeared = false;
    const create = vi.fn(async () => { appeared = true; throw new Error('HTTP 504 Gateway Time-out'); });
    const r = await lookThenCreate({
      step: 'connect.opportunity', record: undefined,
      look: async () => (appeared ? { id: 'opp-1' } : null),
      create, save: async (x) => { saved.push(x); }, sleep: async () => {}, settle: 3,
    });
    expect(r).toEqual({ id: 'opp-1', adopted: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(saved.map((x) => x.status)).toEqual(['pending', 'ambiguous', 'done']);
  });

  it('a create that times out and is still absent is recorded ambiguous and NOT retried', async () => {
    const saved: CreateRecord[] = [];
    const create = vi.fn(async () => { throw new Error('Timeout 30000ms exceeded'); });
    await expect(lookThenCreate({
      step: 'hq.learn.copy', record: undefined, look: async () => null, create,
      save: async (x) => { saved.push(x); }, sleep: async () => {}, settle: 2,
    })).rejects.toBeInstanceOf(AmbiguousCreateError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)?.status).toBe('ambiguous');
  });

  it('the NEXT run, resuming from that record, looks and refuses rather than creating', async () => {
    const create = vi.fn(async () => ({ id: 'dup' }));
    await expect(lookThenCreate({
      step: 'hq.learn.copy', record: { status: 'ambiguous', at: 't', error: 'Timeout' },
      look: async () => null, create, save: async () => {},
    })).rejects.toBeInstanceOf(RefusedCreateError);
    expect(create).not.toHaveBeenCalled();
  });

  it('a definite failure propagates without being recorded ambiguous', async () => {
    const saved: CreateRecord[] = [];
    await expect(lookThenCreate({
      step: 'connect.program', record: undefined, look: async () => null,
      create: async () => { throw new Error('validation_error: budget'); },
      save: async (x) => { saved.push(x); },
    })).rejects.toThrow(/validation_error/);
    expect(saved.map((x) => x.status)).toEqual(['pending']);
  });
});

describe('checkTenantWrite — the guard\'s semantics for writes outside MCP', () => {
  const bound = { workspace: 'noora-health', opp: 'noora-health', mode: 'enforce' as const, tenancy: TENANCY };
  it('allows a write into the bound tenancy (the partial clone\'s own recorded products)', () => {
    const c = partial.phases['connect-setup'].products.connect;
    const d = checkTenantWrite(bound, 'connect_create_opportunity', [
      { arg: 'organization_slug', value: c.pm_org_slug, fields: ['connect_pm_org'] },
      { arg: 'target_organization_slug', value: c.holding_org_slug, fields: ['connect_holding_org'] },
      { arg: 'learn_app.cc_domain', value: c.domain, fields: ['hq_domain'] },
    ]);
    expect(d.allow).toBe(true);
    expect(d.problems).toEqual([]);
  });
  it('refuses a write into the shared tenants (the source run\'s own HQ space)', () => {
    const shared = source.phases['connect-setup'].products.connect.domain;
    const d = checkTenantWrite(bound, 'commcare_make_build', [{ arg: 'domain', value: shared, fields: ['hq_domain'] }]);
    expect(d.allow).toBe(false);
    expect(d.problems[0]).toMatch(/connect-ace-prod is outside noora-health\/noora-health/);
  });
  it('refuses when the tenancy field is not set up, and only reports in warn mode', () => {
    const noHq = { ...bound, tenancy: { ...TENANCY, hq_domain: null } };
    expect(checkTenantWrite(noHq, 'x', [{ arg: 'domain', value: 'a', fields: ['hq_domain'] }]).allow).toBe(false);
    const warn = checkTenantWrite({ ...bound, mode: 'warn' }, 'x', [{ arg: 'domain', value: 'connect-ace-prod', fields: ['hq_domain'] }]);
    expect(warn).toMatchObject({ allow: true });
    expect(warn.problems).toHaveLength(1);
  });
});

describe('rewrites', () => {
  const apps = {
    learn: { hq_app_id: 'c86aa3fc820143cc8646084cf5c03796', build_id: '48262aac94a74c42a3ecea8c06ff6f81', version: 1, released_at: '2026-10-16T05:30:00Z' },
    deliver: { hq_app_id: 'b5f2dbbd038345ed8c3b2a60a125b2e3', build_id: '95d30af3fae0483b80fe8843f3599f07', version: 1, released_at: '2026-10-16T05:31:00Z' },
  };

  it('summaryUrl points the target at its own page', () => {
    expect(summaryUrl('https://labs.connect.dimagi.com/ace/', 'noora-health', 'noora-health', '20261015-1129'))
      .toBe('https://labs.connect.dimagi.com/ace/opps/noora-health/noora-health/runs/20261015-1129/summary');
  });

  it('hqProductsPatch rewrites ids + domain and keeps the Nova source', () => {
    const p = hqProductsPatch(source.phases['commcare-setup'].products.apps, 'connect-ace-noora-health', apps) as any;
    expect(p.domain).toBe('connect-ace-noora-health');
    expect(p.learn).toMatchObject({
      hq_app_id: apps.learn.hq_app_id,
      hq_url: 'https://www.commcarehq.org/a/connect-ace-noora-health/apps/view/c86aa3fc820143cc8646084cf5c03796/',
      released_build_id: apps.learn.build_id,
      nova_app_id: '5442b0a4-8e05-418e-9be2-08fbd18106bf',
    });
  });

  it('rewriteReleaseSummary re-records the frontmatter from the clone\'s builds, leaving the body for § 4e', () => {
    const r = rewriteReleaseSummary(SUMMARY, apps);
    expect(r.changed).toBe(true);
    const fm = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(r.text)![1]);
    expect(fm.apps.learn_app).toEqual({ ...apps.learn, is_released: true });
    expect(r.text).toContain('Learn build c74ae6da… (v9) in connect-ace-prod.');
    expect(rewriteReleaseSummary(r.text, apps).changed).toBe(false); // idempotent
  });

  it('connectProductsPatch writes the Phase 4 shape; productsPointAtTarget is the read-back', () => {
    const c = connectProductsPatch({
      pm_org: 'noora-health-pm-test', holding_org: 'noora-health-nm-test', hq_domain: 'connect-ace-noora-health',
      program_id: 'p', application_id: 'a', opportunity_id: 'o', opportunity_name: 'n', connect_int_id: 2352,
      payment_units: [], verification: {}, test_user: null,
    });
    expect(c).toMatchObject({
      org_mode: 'pm-nm',
      program: { url: 'https://connect.dimagi.com/a/noora-health-pm-test/program/p/' },
      opportunity: { url: 'https://connect.dimagi.com/a/noora-health-nm-test/opportunity/o/', connect_int_id: 2352 },
    });
    expect(productsPointAtTarget(partial, TENANCY)).toEqual([]);
    expect(productsPointAtTarget(source, TENANCY).join(' ')).toMatch(/connect-ace-prod/);
  });
});

describe('rebuildLabs (ace#3020)', () => {
  it('is an explicit not-done pointing at § 4c — never a silent skip, never a false atom-gap claim (ace#3038)', async () => {
    const r = await rebuildLabs({ source: cloneSourceFromRunState(source, null), sourceRunState: source, targetRunState: partial, to: 'noora-health', tenancy: TENANCY });
    expect(r).toEqual({ status: 'not-done', reason: expect.stringMatching(/§ 4c.*program_id.*clone\.labs\.status: done.*never regenerated/) });
    expect(r.reason).not.toMatch(/atom gap|2571/);
  });
});
