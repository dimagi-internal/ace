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
  STAGE_EXECUTOR,
  DEFAULT_CLONE_BUDGET,
  allHistoryRuns,
  budgetBreaches,
  followJob,
  mapRunsByPeriod,
  parseCloneBudget,
  portableConfig,
  rewritePairsFromAssetPlan,
  rewritePairsFromDriveIdPlan,
  type CreateRecord,
  type LabsCopyState,
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

describe('no default stage is handed to an agent (the release path stays fast)', () => {
  // A stage handed back to an agent is how a 10-minute copy became hours
  // (Phase 4 re-dispatch, ace#3021; the Labs § 4c hand-off, ace#3020). This
  // fails while any stage is anything but the script.
  it('every stage is executed by the script', () => {
    const agentRun = STAGES.filter((s) => STAGE_EXECUTOR[s] !== 'script');
    expect(agentRun).toEqual([]);
  });
  it('the Labs stage never reports "agent-run" / "by hand" for an ace-run cascade', async () => {
    const labs = fakeLabs();
    const r = await rebuildLabs(labsCtx(labs));
    expect(JSON.stringify(r)).not.toMatch(/agent-run|by hand/);
    const noDeps = await rebuildLabs({ ...labsCtx(labs), deps: undefined });
    expect(noDeps).toMatchObject({ status: 'not-done', step: 'labs-token' });
    expect(JSON.stringify(noDeps)).not.toMatch(/agent-run|by hand/);
  });
});

// ── The scripted Labs copy, against an in-memory labs ────────────────

// The products.synthetic shape of noora-health/20261015-1129 (trimmed; see test/lib/clone-labs-rebuild.test.ts).
const SYN = {
  provider: 'ace-run',
  labs_opp_id: 10137,
  cascade: {
    program_id: 10137,
    program_name: 'Noora Care Companion',
    partners: [
      { label: 'Kulawa Newborn Trust (example)', opportunity_id: 10137 },
      { label: "Tallafi Mothers' Network (example)", opportunity_id: 10138 },
    ],
    registry: { registry_id: 9684, program_id: 10137, version: 2 },
    programme_report: { workflow_id: 9686, run_id: 9806, url: 'https://labs.connect.dimagi.com/labs/workflow/9686/run/?run_id=9806&program_id=10137' },
    worker_review: { workflow_id: 9688, run_id: 9690 },
    cohort_id: 13,
    visits_pipeline_id: 9685,
    opp_reports: [
      { partner: 'Kulawa', opportunity_id: 10137, workflow_id: 9691, run_id: 9808, url: 'https://labs.connect.dimagi.com/labs/workflow/9691/run/?run_id=9808&opportunity_id=10137' },
      { partner: 'Tallafi', opportunity_id: 10138, workflow_id: 9693, run_id: 9809, url: 'https://labs.connect.dimagi.com/labs/workflow/9693/run/?run_id=9809&opportunity_id=10138' },
    ],
    history: { run_ids: [9701, 9806] },
    benchmark_publications: { cohort_id: 13, first: 274, last: 289 },
  },
  workflows: {
    worker_review: { workflow_id: 9688, run_url: 'https://labs.connect.dimagi.com/labs/workflow/9688/run/?run_id=9690&program_id=10137&flw=10138%3A%3Aedu_ta05&source_run=9806' },
  },
  source: { labs_synthetic_opp_id: 10137, record_counts: { user_visits: { '10137': 645, '10138': 625 }, total_visits: 1270 } },
};
const WEEKS = [
  { period_start: '2026-09-28', period_end: '2026-10-04' },
  { period_start: '2026-10-05', period_end: '2026-10-11' },
];
const snap = (v: number) => ({ snapshot: { state: { snapshot: { programInd: { coverage: { value: v } }, byLLO: [{ llo: 'Kulawa', ind: { coverage: { value: v + 0.1 } } }] } } } });

/** A minimal labs: the source cascade exists; every write mints ids from 20000 up. */
function fakeLabs(opts: {
  failOnce?: string;
  /** How `failOnce` fails: `unlanded` = a 502 before the write (the default), `lost` = the write
   *  LANDS and then the reply is lost (a 502 after), `error` = a plain non-transport tool error. */
  failMode?: 'unlanded' | 'lost' | 'error';
  workspaceOk?: boolean;
  figureDrift?: boolean;
} = {}) {
  let next = 20000;
  const id = () => next++;
  const calls: Array<{ tool: string; args: any }> = [];
  const failed = new Set<string>();
  const runs = new Map<number, Array<{ run_id: number; period_start: string; period_end: string; data?: unknown; status: string }>>();
  runs.set(9686, [{ run_id: 9701, ...WEEKS[0], data: snap(0.5), status: 'completed' }, { run_id: 9806, ...WEEKS[1], data: snap(0.6), status: 'completed' }]);
  runs.set(9691, [{ run_id: 9807, ...WEEKS[0], status: 'completed' }, { run_id: 9808, ...WEEKS[1], status: 'completed' }]);
  runs.set(9693, [{ run_id: 9805, ...WEEKS[0], status: 'completed' }, { run_id: 9809, ...WEEKS[1], status: 'completed' }]);
  const counts: Record<number, number> = { 10137: 645, 10138: 625 };
  const oppReports: number[] = [];
  let programReport = 0;
  // What the creates made, so the list tools (the look-ups) can find it.
  const registries: Array<{ id: number; name: string; program_id: number }> = [];
  const workflows: Array<{ id: number; name: string; template_type: string; program_id: number; pipeline_id: number; worker_review: { workflow_id: number; run_id: number } }> = [];
  const cohorts: Array<{ id: number; name: string; organization_id: string }> = [];
  const call = async (tool: string, args: any): Promise<any> => {
    calls.push({ tool, args });
    const failNow = opts.failOnce === tool && !failed.has(tool);
    if (failNow) failed.add(tool);
    if (failNow && opts.failMode === 'error') throw new Error(`${tool}: INVALID_SCHEMA bad argument`);
    if (failNow && opts.failMode !== 'lost') throw new Error(`${tool}: labs HTTP 502: Bad Gateway`);
    const reply = await answer(tool, args);
    if (failNow) throw new Error(`${tool}: labs HTTP 502: Bad Gateway`); // landed; reply lost
    return reply;
  };
  const answer = async (tool: string, args: any): Promise<any> => {
    switch (tool) {
      case 'semantic_registry_list':
        return { registries: registries.filter((r) => r.program_id === args.program_id) };
      case 'workflow_list':
        return { workflows: workflows.filter((w) => w.program_id === args.program_id).map((w) => ({ id: w.id, name: w.name, template_type: w.template_type, kind: 'workflow' })) };
      case 'benchmarks_cohort_list':
        return { cohorts: cohorts.filter((c) => c.organization_id === args.organization_id) };
      case 'synthetic_clone_to_labs_only': {
        const o = id();
        counts[o] = counts[args.source_opportunity_id];
        return { opportunity_id: o, program_id: args.program_id ?? o, label: args.label };
      }
      case 'synthetic_local_records_count':
        return { opportunity_id: args.opportunity_id, total: counts[args.opportunity_id] ?? 0 };
      case 'semantic_registry_get':
        return { id: 9684, name: 'Noora registry', properties_doc: { properties: [] }, indicators_doc: { measures: [] }, deployment: { llo_map: { '10137': 'Kulawa', '10138': 'Tallafi' } } };
      case 'semantic_registry_create': {
        const r = { id: id(), name: args.name, program_id: args.program_id };
        registries.push(r);
        return { id: r.id };
      }
      case 'workflow_get':
        if (args.workflow_id === 9686) return { id: 9686, name: 'Programme report', template_type: 'indicator_programme_report', config: { showFilters: true, worker_review: { workflow_id: 9688 } }, pipeline_sources: [{ pipeline_id: 9685, alias: 'visits' }] };
        if (args.workflow_id === 9691) return { id: 9691, template_type: 'indicator_opp_report', config: {} };
        {
          const w = workflows.find((x) => x.id === args.workflow_id);
          if (w) return { id: w.id, name: w.name, template_type: w.template_type, config: { worker_review: w.worker_review }, pipeline_sources: [{ pipeline_id: w.pipeline_id, alias: 'visits' }] };
        }
        return { id: args.workflow_id, template_type: 'indicator_programme_report', config: {}, pipeline_sources: [{ pipeline_id: programReport + 1, alias: 'visits' }] };
      case 'workflow_create_from_template': {
        programReport = id();
        const pipe = id();
        const wr = id();
        const wrRun = id();
        workflows.push({ id: programReport, name: args.name, template_type: args.template_key, program_id: args.program_id, pipeline_id: pipe, worker_review: { workflow_id: wr, run_id: wrRun } });
        return { workflow_id: programReport, pipeline_id: pipe, companions: { worker_review: { workflow_id: wr, run_id: wrRun } } };
      }
      case 'pipeline_get':
        return args.pipeline_id === 9685 ? { id: 9685, schema: { fields: ['a', 'b'] }, version: 3 } : { id: args.pipeline_id, schema: { fields: ['a'] }, version: 1 };
      case 'pipeline_update_schema':
        return { ok: true };
      case 'labs_context':
        return { organizations: [{ slug: 'labs-synthetic-noora-care-companion-partners--ace-noora-health-x', name: `Noora Care Companion partners (ace noora-health/noora-health/20261015-1129)` }] };
      case 'benchmarks_cohort_create': {
        const c = { id: 40 + cohorts.length, name: args.name, organization_id: args.organization_id };
        cohorts.push(c);
        return { id: c.id };
      }
      case 'benchmarks_cohort_add_opportunities':
        return { ok: true };
      case 'benchmarks_create_opp_reports': {
        const created = calls.filter((c) => c.tool === 'synthetic_clone_to_labs_only').map((c, i) => {
          const w = id();
          oppReports.push(w);
          return { opportunity_id: 20000 + i, workflow_id: w };
        });
        return { created, skipped: [], shared: true };
      }
      case 'workflow_rebuild_history': {
        const made = WEEKS.map((w, i) => ({ run_id: id(), ...w, data: snap(opts.figureDrift && i === 1 ? 0.61 : [0.5, 0.6][i]), status: 'completed' }));
        runs.set(args.definition_id, made);
        for (const w of oppReports) runs.set(w, WEEKS.map((wk) => ({ run_id: id(), ...wk, status: 'completed' })));
        return { job_id: 'j1', poll_with: 'job_status', state: 'running' };
      }
      case 'job_status':
        return { job_id: args.job_id, state: 'succeeded', result: { done: true, next_start: null } };
      case 'workflow_history_runs': {
        const all = runs.get(args.definition_id) ?? [];
        const start = args.start_at ?? 0;
        const page = all.slice(start, start + 1); // page of ONE: the copy must follow the cursor
        return { runs: page.map((r) => (args.include_snapshot ? r : { ...r, data: undefined })), done: start + 1 >= all.length, next_start_at: start + 1 >= all.length ? null : start + 1 };
      }
      case 'benchmarks_publish':
        return { publication_id: id(), cohort_id: args.cohort_id, as_of: 'x' };
      default:
        throw new Error(`fake labs: unexpected ${tool}`);
    }
  };
  return { call, calls, made: { registries, workflows, cohorts }, workspaceOk: opts.workspaceOk ?? true };
}

function labsCtx(labs: ReturnType<typeof fakeLabs>, saved: { state?: LabsCopyState } = {}, retryAmbiguous?: Set<string>) {
  const sourceRunState = { ...source, phases: { ...source.phases, 'synthetic-data-and-workflows': { products: { synthetic: SYN } } } };
  return {
    source: cloneSourceFromRunState(sourceRunState, null),
    sourceRunState,
    targetRunState: saved.state ? { clone: { labs: { copy: saved.state } } } : partial,
    to: 'noora-health', opp: 'noora-health', run: '20261015-1129',
    tenancy: TENANCY,
    deps: {
      call: labs.call,
      sleep: async () => {},
      retryAmbiguous,
      save: async (s: LabsCopyState) => { saved.state = JSON.parse(JSON.stringify(s)); },
      workspace: async (_p: number, llos: string[]) => (labs.workspaceOk ? { ok: true, llos, detail: 'listed' } : { ok: false, llos: [], detail: 'no labs session (~/.ace/labs-session.json)' }),
    },
  };
}

describe('rebuildLabs — the scripted § 4c copy (ace#3020)', () => {
  it('copies records, registry, report, cohort, history, benchmarks; verifies; leaves no source id behind', async () => {
    const labs = fakeLabs();
    const r = await rebuildLabs(labsCtx(labs));
    expect(r.status).toBe('done');
    const clones = labs.calls.filter((c) => c.tool === 'synthetic_clone_to_labs_only');
    // The first partner WITHOUT program_id (its id becomes the program), later ones WITH it.
    expect(clones[0].args.program_id).toBeUndefined();
    expect(clones[1].args.program_id).toBe(clones[0] && 20000);
    expect(clones.every((c) => c.args.allowed_domains.join() === '@dimagi.com,@dimagi-ai.com')).toBe(true);
    // Never a regeneration.
    expect(labs.calls.some((c) => /generate|clone_opp|clone_profile|set_allowed_domains/.test(c.tool))).toBe(false);
    // The source config's companion link (a source id) is not copied onto the new report.
    const create = labs.calls.find((c) => c.tool === 'workflow_create_from_template')!.args;
    expect(create).toMatchObject({ template_key: 'indicator_programme_report', program_id: 20000, opportunity_ids: [20000, 20001], config: { showFilters: true } });
    expect(create.config.worker_review).toBeUndefined();
    // The visits pipeline gets the source schema, at the version read.
    expect(labs.calls.find((c) => c.tool === 'pipeline_update_schema')!.args).toMatchObject({ schema: { fields: ['a', 'b'] }, expected_version: 1 });
    // Publishes: one per saved run, oldest first.
    const pubs = labs.calls.filter((c) => c.tool === 'benchmarks_publish').map((c) => c.args.run_id);
    expect(pubs).toHaveLength(2);
    expect(pubs[0]).toBeLessThan(pubs[1]);
    // Products remapped: the programme report link names the copy.
    const syn = (r as any).synthetic;
    expect(JSON.stringify(syn)).not.toMatch(/\b(10137|10138|9686|9806|9684)\b/);
    expect(r).toMatchObject({ program_id: 20000, opportunity_ids: [20000, 20001], workspace: { llos: expect.arrayContaining([TENANCY.connect_holding_org]) } });
  });

  it('a failure mid-copy resumes at that step — no partner is copied twice', async () => {
    const labs = fakeLabs({ failOnce: 'semantic_registry_create', failMode: 'error' });
    const saved: { state?: LabsCopyState } = {};
    const first = await rebuildLabs(labsCtx(labs, saved));
    expect(first).toMatchObject({ status: 'not-done', step: 'registry' });
    const second = await rebuildLabs(labsCtx(labs, saved));
    expect(second.status).toBe('done');
    expect(labs.calls.filter((c) => c.tool === 'synthetic_clone_to_labs_only')).toHaveLength(2);
  });

  it('only the workspace-roles step (no MCP atom, connect-labs#2572) is left when the labs session is missing', async () => {
    const labs = fakeLabs({ workspaceOk: false });
    const r = await rebuildLabs(labsCtx(labs));
    expect(r).toMatchObject({ status: 'not-done', step: 'workspace' });
    expect(String(r.reason)).toMatch(/labs-workspace-setup\.ts --program-id 20000/);
    const steps = (r as any).copy.steps;
    for (const s of ['records', 'registry', 'programme_report', 'pipeline', 'cohort', 'history', 'benchmarks', 'verify']) expect(steps[s]?.done).toBe(true);
  });

  it('a copy whose figures differ from the source is NOT done', async () => {
    const r = await rebuildLabs(labsCtx(fakeLabs({ figureDrift: true })));
    expect(r).toMatchObject({ status: 'not-done', step: 'verify' });
    expect(String(r.reason)).toMatch(/2026-10-11 program\.coverage: source 0\.6, copy 0\.61/);
  });
});

describe('rebuildLabs — the three Labs creates are look-then-create (ace#3092)', () => {
  const CREATES = [
    ['semantic_registry_create', 'registries', 'registry'],
    ['workflow_create_from_template', 'workflows', 'programme_report'],
    ['benchmarks_cohort_create', 'cohorts', 'cohort'],
  ] as const;

  for (const [tool, kind, stepName] of CREATES) {
    it(`${tool}: a create that LANDS but whose reply is lost is adopted, never repeated`, async () => {
      const labs = fakeLabs({ failOnce: tool, failMode: 'lost' });
      const saved: { state?: LabsCopyState } = {};
      const r = await rebuildLabs(labsCtx(labs, saved));
      expect(r.status).toBe('done');
      expect(labs.calls.filter((c) => c.tool === tool)).toHaveLength(1);
      expect(labs.made[kind]).toHaveLength(1);
      expect((saved.state!.steps as any)[`${stepName}_create`]).toMatchObject({ status: 'done', id: String(labs.made[kind][0].id) });
      // A rerun that lost every later record (only the partner copies kept) still finds it.
      const { records, records_partial, program_id } = saved.state!.steps as any;
      await rebuildLabs(labsCtx(labs, { state: { id_map: saved.state!.id_map, steps: { records, records_partial, program_id } } }));
      expect(labs.made[kind]).toHaveLength(1);
    });

    it(`${tool}: an ambiguous create that did NOT land is refused on rerun until --retry-ambiguous labs.${stepName}`, async () => {
      const labs = fakeLabs({ failOnce: tool, failMode: 'unlanded' });
      const saved: { state?: LabsCopyState } = {};
      const first = await rebuildLabs(labsCtx(labs, saved));
      expect(first).toMatchObject({ status: 'not-done', step: stepName });
      expect(String(first.reason)).toMatch(/recorded as ambiguous, NOT retried/);
      expect((saved.state!.steps as any)[`${stepName}_create`].status).toBe('ambiguous');
      const second = await rebuildLabs(labsCtx(labs, saved));
      expect(second).toMatchObject({ status: 'not-done', step: stepName });
      expect(String(second.reason)).toMatch(/--retry-ambiguous/);
      expect(labs.made[kind]).toHaveLength(0);
      const third = await rebuildLabs(labsCtx(labs, saved, new Set([`labs.${stepName}`])));
      expect(third.status).toBe('done');
      expect(labs.made[kind]).toHaveLength(1);
    });
  }

  it('an adopted programme report still yields its pipeline and worker-review companion', async () => {
    const labs = fakeLabs({ failOnce: 'workflow_create_from_template', failMode: 'lost' });
    const saved: { state?: LabsCopyState } = {};
    const r = await rebuildLabs(labsCtx(labs, saved));
    expect(r.status).toBe('done');
    const wf = labs.made.workflows[0];
    expect((saved.state!.steps as any).programme_report).toMatchObject({ workflow_id: wf.id, pipeline_id: wf.pipeline_id, worker_review: wf.worker_review, adopted: true });
    expect(saved.state!.id_map['9688']).toBe(wf.worker_review.workflow_id);
  });

  it('two objects already bearing the clone-unique name stop the step — never a guess', async () => {
    const labs = fakeLabs();
    // Seed a registry list with two hits by making the first run create one, then duplicating it.
    const saved: { state?: LabsCopyState } = {};
    await rebuildLabs(labsCtx(labs, saved));
    labs.made.registries.push({ ...labs.made.registries[0], id: 99999 });
    const again = await rebuildLabs(labsCtx(labs, { state: { id_map: saved.state!.id_map, steps: { records: (saved.state!.steps as any).records } } }));
    expect(again).toMatchObject({ status: 'not-done', step: 'registry' });
    expect(String(again.reason)).toMatch(/2 registries named/);
  });
});

describe('labs copy helpers', () => {
  it('mapRunsByPeriod pairs by period_end and names the missing weeks', () => {
    expect(mapRunsByPeriod([{ run_id: 1, period_end: '2026-10-04' }, { run_id: 2, period_end: '2026-10-11' }], [{ run_id: 9, period_end: '2026-10-04T00:00:00' }])).toEqual({ map: { '1': 9 }, missing: ['2026-10-11'] });
  });
  it('portableConfig drops keys that name source ids', () => {
    expect(portableConfig({ a: 1, link: { workflow_id: 9688 }, url: 'x?run_id=9806' }, new Set([9688, 9806]))).toEqual({ a: 1 });
  });
  it('followJob polls job_status to the result', async () => {
    const call = vi.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValueOnce({ state: 'succeeded', result: { done: true } });
    await expect(followJob(call, { job_id: 'j', poll_with: 'job_status' }, async () => {})).resolves.toEqual({ done: true });
    await expect(followJob(call, { done: true }, async () => {})).resolves.toEqual({ done: true });
  });
  it('allHistoryRuns follows the cursor to done', async () => {
    const pages = [{ runs: [{ run_id: 1 }], done: false, next_start_at: 1 }, { runs: [{ run_id: 2 }], done: true, next_start_at: null }];
    const call = vi.fn().mockImplementation(async () => pages.shift());
    expect((await allHistoryRuns(call, { definition_id: 1 })).map((r) => r.run_id)).toEqual([1, 2]);
  });
});

describe('the wall-clock budget (config/clone-budget.json)', () => {
  const file = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/clone-budget.json'), 'utf8'));
  it('the shipped file covers every stage and matches the code defaults', () => {
    const b = parseCloneBudget(file);
    expect(Object.keys(file.stages).sort()).toEqual([...STAGES].sort());
    expect(b).toEqual(DEFAULT_CLONE_BUDGET);
    expect(b.stages.ace_web).toBe(600);
    expect(b.stages.connect).toBe(180);
    expect(b.total_seconds).toBe(1200);
  });
  it('a stage or the run over budget is a breach; a skipped stage costs nothing', () => {
    const b = parseCloneBudget(file);
    expect(budgetBreaches({ ace_web: { seconds: 601 }, connect: { seconds: 100 }, hq: { status: 'done' } }, 700, b)).toEqual([{ stage: 'ace_web', seconds: 601, budget_seconds: 600 }]);
    // ace-web#913's 6–8 min estimate for ~850 files sits inside the budget.
    expect(budgetBreaches({ ace_web: { seconds: 8 * 60 } }, 8 * 60, b)).toEqual([]);
    expect(budgetBreaches({}, 1201, b)).toEqual([{ stage: 'total', seconds: 1201, budget_seconds: 1200 }]);
    expect(budgetBreaches({ connect: { seconds: 180 } }, 1200, b)).toEqual([]);
  });
  it('refuses an unknown stage or a non-positive budget', () => {
    expect(() => parseCloneBudget({ stages: { nope: 1 } })).toThrow(/unknown stage/);
    expect(() => parseCloneBudget({ stages: { hq: 0 } })).toThrow(/positive/);
  });
});

describe('the id/URL map asset_refs applied (readiness content ledger)', () => {
  it('asset pairs, 8-char prefixes, versions and re-pointed frames', () => {
    const pairs = rewritePairsFromAssetPlan({
      pairs: [{ kind: 'app', from: 'aaaaaaaa1111bbbb2222', to: 'cccccccc3333dddd4444' }, { kind: 'hq_domain', from: 'connect-ace-prod', to: 'connect-ace-noora' }],
      versions: { learn: { from: '12', to: '3' } },
      frames: { repointed: { oldFrameId: 'newFrameId' } },
    });
    expect(pairs).toEqual([
      { from: 'aaaaaaaa1111bbbb2222', to: 'cccccccc3333dddd4444', kind: 'app' },
      { from: 'aaaaaaaa', to: 'cccccccc', kind: 'app_prefix' },
      { from: 'connect-ace-prod', to: 'connect-ace-noora', kind: 'hq_domain' },
      { from: '12', to: '3', kind: 'version' },
      { from: 'oldFrameId', to: 'newFrameId', kind: 'frame' },
    ]);
    expect(rewritePairsFromDriveIdPlan({ id_map: { s1: 'c1', same: 'same' } })).toEqual([{ from: 's1', to: 'c1', kind: 'drive_id' }]);
  });
});
