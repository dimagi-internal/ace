/**
 * Multi-role builds — one Learn + Deliver pair and one Connect opportunity per
 * worker role in one `/ace:run` (lib/worker-roles.ts, skills/_worker-roles.md).
 *
 * Driver: smallholder-seasonal/20261028-1636 added an independent enumerator
 * beside the coach after Phase 3 had built the coach's apps. The shape is
 * ADDITIVE — `apps.{learn,deliver}` and `connect.opportunity` keep the primary
 * role — so these tests pin both halves: the new keys validate and are
 * enforced, and a single-role run is byte-identical to before.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateRunReadme, workerRolesFromRunState } from '../../lib/run-readme.js';
import {
  parseWorkerRoles,
  planWorkerRoles,
  planRoleBuilds,
  roleKey,
  roleOpportunityName,
  roleTileToken,
  siblingOpportunityNames,
  missingRoleOpportunities,
  rolesOwedByPhase3,
  WorkerRolesError,
} from '../../lib/worker-roles.js';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
  classifyPhaseProducts,
  requiredProductKeys,
  REQUIRED_PRODUCT_KEYS,
} from '../../lib/phase-products-schema.js';
import { buildCommcareProducts, buildRoleCommcareProducts, CommcareProductsError } from '../../lib/commcare-products.js';
import { planOpportunityCreate } from '../../lib/connect-opp-resume.js';
import { OPP_NAME_RUN_ID_PREFIX_RE } from '../../mcp/connect/opportunity-name.js';

const RUN = '20261028-1636';
const DISPLAY = 'Smallholder Seasonal Support';

const facts = (app: string, n: string) => ({
  name: `${app} ${n}`,
  nova_app_id: `nova-${app}-${n}`,
  hq_app_id: `hq-${app}-${n}`,
  hq_url: `https://www.commcarehq.org/a/connect-ace-prod/apps/view/hq-${app}-${n}/`,
  build_status: 'success' as const,
});

const COACH_APPS = buildCommcareProducts({ learn: facts('learn', 'coach'), deliver: facts('deliver', 'coach') }).apps;
const ENUM_PATCH = buildRoleCommcareProducts(
  { key: 'enumerator', label: 'Enumerator' },
  ['coach', 'enumerator'],
  { learn: facts('learn', 'enum'), deliver: facts('deliver', 'enum') },
);

const opp = (id: string) => ({ id, name: `${RUN} · x`, url: `https://connect.dimagi.com/a/ace-nm-org/opportunity/${id}/` });
const atu = { phone: '+74260000000', invite_row_present: true };

describe('parseWorkerRoles / roleKey', () => {
  it('keeps PDD order, normalises keys and labels', () => {
    expect(parseWorkerRoles('coach, Independent enumerator')).toEqual([
      { key: 'coach', label: 'Coach' },
      { key: 'independent_enumerator', label: 'Independent enumerator' },
    ]);
    expect(roleKey('FLW')).toBe('flw');
  });

  it('refuses two names that collapse to one key', () => {
    expect(() => parseWorkerRoles('Coach, coach')).toThrow(WorkerRolesError);
  });

  it('reads an absent or empty cell as no roles', () => {
    expect(parseWorkerRoles(undefined)).toEqual([]);
    expect(parseWorkerRoles('')).toEqual([]);
  });
});

describe('planWorkerRoles', () => {
  it('one role (the smallholder PDD before the enumerator) is single-role', () => {
    const p = planWorkerRoles({ worker_roles: 'coach' });
    expect(p.multi_role).toBe(false);
    expect(p.extra).toEqual([]);
    expect(p.primary?.key).toBe('coach');
  });

  it('two roles with no single-opportunity choice is per-role, primary first', () => {
    const p = planWorkerRoles({ worker_roles: 'coach, enumerator' });
    expect(p.multi_role).toBe(true);
    expect(p.primary?.key).toBe('coach');
    expect(p.extra.map((r) => r.key)).toEqual(['enumerator']);
  });

  it('opportunity_structure per-role is per-role', () => {
    expect(planWorkerRoles({ worker_roles: 'coach, enumerator', opportunity_structure: 'per-role' }).multi_role).toBe(true);
  });

  it('an explicit single structure keeps one shared opportunity', () => {
    expect(planWorkerRoles({ worker_roles: 'coach, enumerator', opportunity_structure: 'single' }).multi_role).toBe(false);
  });

  it('all-workers visibility with no structure row keeps one shared opportunity', () => {
    const p = planWorkerRoles({ worker_roles: 'FLW, enumerator', learn_module_visibility: 'all-workers' });
    expect(p.multi_role).toBe(false);
    expect(p.reason).toMatch(/all-workers/);
  });
});

describe('planRoleBuilds — the resume case (build only the missing role)', () => {
  const plan = planWorkerRoles({ worker_roles: 'coach, enumerator', opportunity_structure: 'per-role' });

  it('primary built and released, enumerator absent → only the enumerator is owed, from the build stage', () => {
    const r = planRoleBuilds(plan, { apps: COACH_APPS }, { 'hq-learn-coach': true, 'hq-deliver-coach': true });
    expect(r.todo.map((s) => s.role.key)).toEqual(['enumerator']);
    expect(r.todo[0]).toMatchObject({ learn: 'build', deliver: 'build', primary: false });
  });

  it('a deployed-but-unreleased primary app is still owed (release stage)', () => {
    const r = planRoleBuilds(plan, { apps: COACH_APPS }, { 'hq-learn-coach': true });
    expect(r.todo[0]).toMatchObject({ primary: true, learn: 'ready', deliver: 'release' });
  });

  it('every pair released → precondition holds', () => {
    const products = { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } };
    const released = { 'hq-learn-coach': true, 'hq-deliver-coach': true, 'hq-learn-enum': true, 'hq-deliver-enum': true };
    expect(planRoleBuilds(plan, products, released).todo).toEqual([]);
  });

  it('a Nova app with no HQ id is owed a deploy, not a rebuild', () => {
    const products = { apps: { ...COACH_APPS, roles: { enumerator: { learn: { nova_app_id: 'n1' } } } } };
    const r = planRoleBuilds(plan, products, { 'hq-learn-coach': true, 'hq-deliver-coach': true });
    expect(r.todo[0]).toMatchObject({ learn: 'deploy', deliver: 'build' });
  });
});

describe('rolesOwedByPhase3 — the Phase 4 entry guard', () => {
  const plan = planWorkerRoles({ worker_roles: 'coach, enumerator' });

  it('a single-role Phase 3 that finished before the PDD gained a role owes the new role', () => {
    // smallholder-seasonal/20261028-1636: Phase 3 done with the coach pair only, no worker_roles.
    expect(rolesOwedByPhase3(plan, { apps: COACH_APPS })).toEqual(['enumerator']);
  });

  it('owes nothing once the role pair is recorded', () => {
    expect(rolesOwedByPhase3(plan, { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } })).toEqual([]);
  });

  it('a recorded worker_roles list that disagrees with the PDD owes every extra role', () => {
    const products = { apps: { ...COACH_APPS, ...ENUM_PATCH.apps, worker_roles: ['enumerator', 'coach'] } };
    expect(rolesOwedByPhase3(plan, products)).toEqual(['enumerator']);
  });

  it('a single-role plan owes nothing', () => {
    expect(rolesOwedByPhase3(planWorkerRoles({ worker_roles: 'coach' }), { apps: COACH_APPS })).toEqual([]);
  });
});

describe('opportunity names + tile tokens', () => {
  const coach = { key: 'coach', label: 'Coach' };
  const en = { key: 'enumerator', label: 'Enumerator' };

  it('every role name keeps the run-id front prefix the create atom enforces (ace#755)', () => {
    expect(roleOpportunityName(RUN, en, DISPLAY)).toBe(`${RUN} · Enumerator · ${DISPLAY}`);
    expect(OPP_NAME_RUN_ID_PREFIX_RE.test(roleOpportunityName(RUN, en, DISPLAY))).toBe(true);
  });

  it('each tile token matches its own opportunity and not the sibling', () => {
    const coachName = roleOpportunityName(RUN, coach, DISPLAY);
    const enumName = roleOpportunityName(RUN, en, DISPLAY);
    const re = (t: string) => new RegExp(`^.*${t}.*$`, 'u');
    expect(re(roleTileToken(RUN, coach)).test(coachName)).toBe(true);
    expect(re(roleTileToken(RUN, coach)).test(enumName)).toBe(false);
    expect(re(roleTileToken(RUN, en)).test(coachName)).toBe(false);
    // …whereas the plain run-id matcher would hit both — the reason the token exists.
    expect(re(RUN).test(coachName) && re(RUN).test(enumName)).toBe(true);
  });

  it('siblingOpportunityNames is empty on a single-role run', () => {
    expect(siblingOpportunityNames(RUN, planWorkerRoles({ worker_roles: 'coach' }), DISPLAY, coach)).toEqual([]);
  });
});

describe('planOpportunityCreate with sibling role opportunities', () => {
  const plan = planWorkerRoles({ worker_roles: 'coach, enumerator' });
  const coach = plan.roles[0];
  const en = plan.roles[1];
  const coachName = roleOpportunityName(RUN, coach, DISPLAY);
  const enumName = roleOpportunityName(RUN, en, DISPLAY);
  const listing = { complete: true, total_count: 1 };

  it('creating the second role is not halted as a RUN_ID_COLLISION by the first', () => {
    const rows = [{ id: 'opp-coach', name: coachName }];
    const without = planOpportunityCreate({ runId: RUN, expectedName: enumName, recorded: null, listing, rows });
    expect(without).toMatchObject({ action: 'halt', code: 'RUN_ID_COLLISION' });
    const withSiblings = planOpportunityCreate({
      runId: RUN,
      expectedName: enumName,
      recorded: null,
      listing,
      rows,
      siblingNames: siblingOpportunityNames(RUN, plan, DISPLAY, en),
    });
    expect(withSiblings.action).toBe('create');
  });

  it('a re-dispatch adopts the role opportunity it already created (no duplicate)', () => {
    const rows = [
      { id: 'opp-coach', name: coachName },
      { id: 'opp-enum', name: enumName },
    ];
    const r = planOpportunityCreate({
      runId: RUN,
      expectedName: enumName,
      recorded: null,
      listing: { complete: true, total_count: 2 },
      rows,
      siblingNames: siblingOpportunityNames(RUN, plan, DISPLAY, en),
    });
    expect(r).toMatchObject({ action: 'adopt', opportunity_id: 'opp-enum' });
  });

  it('an unknown name carrying the run id still halts', () => {
    const rows = [{ id: 'opp-x', name: `${RUN} · Something else` }];
    const r = planOpportunityCreate({
      runId: RUN,
      expectedName: enumName,
      recorded: null,
      listing,
      rows,
      siblingNames: siblingOpportunityNames(RUN, plan, DISPLAY, en),
    });
    expect(r).toMatchObject({ action: 'halt', code: 'RUN_ID_COLLISION' });
  });
});

describe('commcare-setup schema — apps.worker_roles / apps.roles', () => {
  it('the builder output for an extra role validates as a fragment beside the primary', () => {
    expect(validatePhaseProductsFragment('commcare-setup', ENUM_PATCH).valid).toBe(true);
    expect(validatePhaseProductsFragment('commcare-setup', { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } }).valid).toBe(true);
  });

  it('the builder refuses the primary role and an undeclared role', () => {
    expect(() => buildRoleCommcareProducts({ key: 'coach', label: 'Coach' }, ['coach', 'enumerator'], {})).toThrow(
      CommcareProductsError,
    );
    expect(() => buildRoleCommcareProducts({ key: 'supervisor', label: 'S' }, ['coach', 'enumerator'], {})).toThrow(
      CommcareProductsError,
    );
  });

  it('rejects the primary role written under roles, and a role not in worker_roles', () => {
    const primaryUnderRoles = validatePhaseProductsFragment('commcare-setup', {
      apps: { worker_roles: ['coach', 'enumerator'], roles: { coach: { learn: facts('learn', 'x') } } },
    });
    expect(primaryUnderRoles.valid).toBe(false);
    expect(JSON.stringify(primaryUnderRoles.issues)).toMatch(/primary role/);
    const stray = validatePhaseProductsFragment('commcare-setup', {
      apps: { worker_roles: ['coach', 'enumerator'], roles: { supervisor: {} } },
    });
    expect(stray.valid).toBe(false);
  });

  it('rejects a malformed role key', () => {
    expect(validatePhaseProductsFragment('commcare-setup', { apps: { roles: { 'Enumerator!': {} } } }).valid).toBe(false);
  });

  it('a done multi-role Phase 3 missing the extra pair fails the fence; with it, passes', () => {
    const declared = { apps: { ...COACH_APPS, worker_roles: ['coach', 'enumerator'] } };
    const r = validatePhaseProductsComplete('commcare-setup', declared);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path)).toEqual([
      'products.apps.roles.enumerator.learn.hq_app_id',
      'products.apps.roles.enumerator.deliver.hq_app_id',
    ]);
    expect(validatePhaseProductsComplete('commcare-setup', { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } }).valid).toBe(true);
  });

  it('INERT: a single-role run requires exactly what it did before', () => {
    expect(requiredProductKeys('commcare-setup', undefined, { apps: COACH_APPS })).toEqual(
      REQUIRED_PRODUCT_KEYS['commcare-setup'],
    );
    expect(requiredProductKeys('connect-setup', undefined, { connect: { opportunity: opp('a') } })).toEqual(
      REQUIRED_PRODUCT_KEYS['connect-setup'],
    );
  });
});

describe('connect-setup schema — connect.role_opportunities', () => {
  const primary = {
    domain: 'connect-ace-prod',
    primary_role: 'coach',
    opportunity: { ...opp('opp-coach'), tile_token: `${RUN} · Coach` },
    ace_test_user: atu,
  };

  it('accepts a role opportunity with the primary block’s inner shape', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      connect: {
        ...primary,
        role_opportunities: {
          enumerator: {
            label: 'Enumerator',
            opportunity: { ...opp('opp-enum'), tile_token: `${RUN} · Enumerator`, connect_int_id: 4242 },
            ace_test_user: atu,
            postcondition: { ok: true, failed: [], phase6_blockers: [] },
          },
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('validates the inner shape with the existing schemas (bad url, non-boolean read-back)', () => {
    const r = validatePhaseProductsFragment('connect-setup', {
      connect: {
        role_opportunities: {
          enumerator: { opportunity: { url: 'not-a-url' }, ace_test_user: { invite_row_present: 'yes' } },
        },
      },
    });
    expect(r.valid).toBe(false);
    const paths = r.issues.map((i) => i.path).join(' ');
    expect(paths).toContain('role_opportunities.enumerator.opportunity.url');
    expect(paths).toContain('role_opportunities.enumerator.ace_test_user.invite_row_present');
  });

  it('a role opportunity that exists owes its url and test-user read-back at done', () => {
    const r = validatePhaseProductsComplete('connect-setup', {
      connect: { ...primary, role_opportunities: { enumerator: { opportunity: { id: 'opp-enum' } } } },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.path)).toEqual([
      'products.connect.role_opportunities.enumerator.opportunity.url',
      'products.connect.role_opportunities.enumerator.ace_test_user.invite_row_present',
    ]);
  });

  it('classifyPhaseProducts: a done Phase 4 that created only the primary opportunity fails when Phase 3 built two roles', () => {
    const parsed = {
      phases: {
        'commcare-setup': { status: 'done', products: { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } } },
        'connect-setup': { status: 'done', products: { connect: primary } },
      },
    };
    const r = classifyPhaseProducts(parsed, 'connect-setup');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path)).toContain('products.connect.role_opportunities.enumerator.opportunity.url');
    expect(missingRoleOpportunities(parsed.phases['commcare-setup'].products, parsed.phases['connect-setup'].products)).toEqual([
      'enumerator',
    ]);

    const fixed = structuredClone(parsed) as any;
    fixed.phases['connect-setup'].products.connect.role_opportunities = {
      enumerator: { opportunity: opp('opp-enum'), ace_test_user: atu },
    };
    expect(classifyPhaseProducts(fixed, 'connect-setup').ok).toBe(true);
    expect(missingRoleOpportunities(fixed.phases['commcare-setup'].products, fixed.phases['connect-setup'].products)).toEqual([]);
  });

  it('classifyPhaseProducts: an in-flight Phase 4 is shape-checked only', () => {
    const parsed = {
      phases: {
        'commcare-setup': { status: 'done', products: { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } } },
        'connect-setup': { status: 'in_progress', products: { connect: primary } },
      },
    };
    expect(classifyPhaseProducts(parsed, 'connect-setup')).toMatchObject({ ok: true, mode: 'fragment' });
  });
});

describe('run README § Worker roles', () => {
  it('is absent on a single-role run', () => {
    const rs = { phases: { 'commcare-setup': { products: { apps: COACH_APPS } } } };
    expect(workerRolesFromRunState(rs)).toBeNull();
    expect(generateRunReadme(RUN, {}, { workerRoles: workerRolesFromRunState(rs) })).not.toContain('Worker roles');
  });

  it('lists every role and shows a role with no opportunity yet as missing', () => {
    const rs = {
      phases: {
        'commcare-setup': { products: { apps: { ...COACH_APPS, ...ENUM_PATCH.apps } } },
        'connect-setup': { products: { connect: { opportunity: opp('opp-coach') } } },
      },
    };
    const rows = workerRolesFromRunState(rs)!;
    expect(rows.map((r) => [r.key, r.primary, r.deliver_hq_app_id])).toEqual([
      ['coach', true, 'hq-deliver-coach'],
      ['enumerator', false, 'hq-deliver-enum'],
    ]);
    const md = generateRunReadme(RUN, {}, { workerRoles: rows });
    expect(md).toContain('## Worker roles');
    expect(md).toMatch(/\| Enumerator \| hq-learn-enum \| hq-deliver-enum \| — not yet \|/);
    expect(md).toContain('opportunity/opp-coach/');
  });
});

describe('scripts/worker-roles.ts — reads the PDD as idea-to-pdd-qa does', () => {
  it('prints a multi-role plan for a two-role per-role PDD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-roles-'));
    const pdd = join(dir, 'pdd.md');
    writeFileSync(
      pdd,
      '# PDD\n\nArchetype: longitudinal-visits\n\n## Program Parameters\n\n| Parameter | Value | Source |\n|---|---|---|\n' +
        '| worker_roles | coach, enumerator | read |\n| opportunity_structure | per-role | read |\n\n## Budget\n',
    );
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const out = execFileSync(
      process.execPath,
      [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/worker-roles.ts'), '--pdd', pdd],
      { encoding: 'utf8' },
    );
    const plan = JSON.parse(out);
    expect(plan.multi_role).toBe(true);
    expect(plan.primary.key).toBe('coach');
    expect(plan.extra.map((r: { key: string }) => r.key)).toEqual(['enumerator']);
  }, 30_000);
});
