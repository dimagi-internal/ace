import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { phase4Orgs } from '../../lib/connect-orgs.js';
import {
  fetchOppTenancy,
  hqApiKeyName,
  renderRunWorkspaceYaml,
  resolveRunWorkspace,
  runSummaryUrl,
  runWorkbenchUrl,
  RunWorkspaceError,
  tenancyUrl,
  type TenancyResponse,
} from '../../lib/run-workspace.js';

const ENV = {
  ACE_WEB_WORKSPACE: 'dimagi-team',
  ACE_DRIVE_ROOT_FOLDER_ID: 'ace-root',
  ACE_HQ_DOMAIN: 'connect-ace-prod',
  ACE_CONNECT_PM_ORG: 'ace-pm-org',
  ACE_CONNECT_NM_ORG: 'ace-nm-org',
  OCS_TEAM_SLUG: 'connect-ace',
};

// Verbatim shape of the live read on 2026-10-08:
// GET /api/w/spark/opps/spark-facilitator/tenancy
const SPARK: TenancyResponse = {
  slug: 'spark-facilitator',
  tenancy: { hq_domain: 'connect-ace-spark', connect_pm_org: 'spark-pm-org-test', connect_holding_org: 'spark-nm-org-test' },
  drive_root_folder_id: '16_76AGvTl4Eg9XWQntUqX6MWicmADRDN',
  source: 'opp',
};

function err(fn: () => unknown): RunWorkspaceError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RunWorkspaceError);
    return e as RunWorkspaceError;
  }
  throw new Error('expected a RunWorkspaceError');
}

describe('resolveRunWorkspace — default workspace', () => {
  it('a bare opp uses ACE_WEB_WORKSPACE and today\'s .env values, with no ace-web read needed', () => {
    const r = resolveRunWorkspace({ workspace: null, opp: 'spark-facilitator', env: ENV });
    expect(r).toMatchObject({
      workspace: 'dimagi-team',
      is_default: true,
      source: 'env',
      drive_root_folder_id: 'ace-root',
      hq_domain: 'connect-ace-prod',
      ocs: { team: 'connect-ace', source: 'configured' },
      hq_api_key: { kind: 'instance', ref: '${ACE_HQ_API_KEY}' },
      warnings: [],
    });
    expect(r.connect_orgs).toMatchObject({ pm_org: 'ace-pm-org', nm_org: 'ace-nm-org', source: { pm_org: 'env', nm_org: 'env' } });
  });

  it('naming the default workspace explicitly is the same as a bare opp', () => {
    const a = resolveRunWorkspace({ workspace: null, opp: 'x', env: ENV });
    const b = resolveRunWorkspace({ workspace: 'dimagi-team', opp: 'x', env: ENV });
    expect(b).toEqual(a);
  });

  it('falls back to .env when ace-web is unreachable, and says so', () => {
    const r = resolveRunWorkspace({ workspace: null, opp: 'x', env: ENV, responseError: new Error('ECONNREFUSED') });
    expect(r.hq_domain).toBe('connect-ace-prod');
    expect(r.warnings.join()).toMatch(/not read.*ECONNREFUSED/);
  });

  it('keeps .env authoritative but warns when ace-web\'s tenancy disagrees', () => {
    const r = resolveRunWorkspace({
      workspace: null,
      opp: 'x',
      env: ENV,
      response: { tenancy: { hq_domain: 'somewhere-else', connect_pm_org: 'ace-pm-org' }, drive_root_folder_id: 'ace-root' },
    });
    expect(r.hq_domain).toBe('connect-ace-prod');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/hq_domain=somewhere-else/);
  });

  it('errors when no workspace is given and none is configured', () => {
    const e = err(() => resolveRunWorkspace({ workspace: null, opp: 'x', env: { ...ENV, ACE_WEB_WORKSPACE: '' } }));
    expect(e.code).toBe('NO_DEFAULT_WORKSPACE');
  });
});

describe('resolveRunWorkspace — partner workspace', () => {
  it('takes every tenant from ace-web (spark, as read live 2026-10-08)', () => {
    const r = resolveRunWorkspace({ workspace: 'spark', opp: 'spark-facilitator', env: ENV, response: SPARK });
    expect(r).toMatchObject({
      workspace: 'spark',
      is_default: false,
      source: 'ace-web',
      drive_root_folder_id: '16_76AGvTl4Eg9XWQntUqX6MWicmADRDN',
      hq_domain: 'connect-ace-spark',
      hq_api_key: { kind: 'space-restricted', mint_per_run: true },
    });
    expect(r.connect_orgs).toMatchObject({ pm_org: 'spark-pm-org-test', nm_org: 'spark-nm-org-test', source: { pm_org: 'tenancy', nm_org: 'tenancy' } });
  });

  it('with no ocs_team in the tenancy, uses the configured team and says the bot is reviewed by public link', () => {
    const r = resolveRunWorkspace({ workspace: 'spark', opp: 'spark-facilitator', env: ENV, response: SPARK });
    expect(r.ocs.team).toBe('connect-ace');
    expect(r.ocs.source).toBe('configured');
    expect(r.ocs.note).toMatch(/public link/);
  });

  it('accepts a tenancy ocs_team equal to the session\'s OCS team', () => {
    const r = resolveRunWorkspace({
      workspace: 'spark', opp: 'o', env: ENV,
      response: { ...SPARK, tenancy: { ...SPARK.tenancy, ocs_team: 'connect-ace' } },
    });
    expect(r.ocs.source).toBe('tenancy');
  });

  it('refuses a tenancy whose OCS team differs from the one fixed at MCP start', () => {
    const e = err(() =>
      resolveRunWorkspace({ workspace: 'spark', opp: 'o', env: ENV, response: { ...SPARK, tenancy: { ...SPARK.tenancy, ocs_team: 'spark-ocs' } } }),
    );
    expect(e.code).toBe('OCS_TEAM_MISMATCH');
    expect(e.remediation).toMatch(/OCS_TEAM_SLUG=spark-ocs.*restart/);
  });

  it('an incomplete tenancy is a typed error naming EVERY missing field — never a fallback to .env', () => {
    const e = err(() =>
      resolveRunWorkspace({
        workspace: 'spark', opp: 'spark-facilitator', env: ENV,
        response: { tenancy: { connect_pm_org: 'spark-pm-org-test' }, drive_root_folder_id: null },
      }),
    );
    expect(e.code).toBe('TENANCY_INCOMPLETE');
    expect(e.fields).toEqual(['drive_root_folder_id', 'tenancy.hq_domain', 'tenancy.connect_holding_org']);
    expect(e.message).toMatch(/never falls back/);
    expect(e.remediation).toMatch(/PATCH \/api\/w\/spark\/opps\/spark-facilitator\/tenancy/);
  });

  it('an unread tenancy is fatal for a partner workspace', () => {
    const e = err(() =>
      resolveRunWorkspace({
        workspace: 'spark', opp: 'o', env: ENV,
        responseError: new RunWorkspaceError('TENANCY_UNREADABLE', '404', 'invite ace@'),
      }),
    );
    expect(e.code).toBe('TENANCY_UNREADABLE');
    expect(e.remediation).toBe('invite ace@');
  });

  it('refuses a partner tenancy that names a shared tenant', () => {
    const e = err(() =>
      resolveRunWorkspace({
        workspace: 'spark', opp: 'o', env: ENV,
        response: { ...SPARK, tenancy: { ...SPARK.tenancy, hq_domain: 'connect-ace-prod', connect_holding_org: 'ace-nm-org' } },
      }),
    );
    expect(e.code).toBe('SHARED_TENANT');
    expect(e.message).toMatch(/connect-ace-prod/);
    expect(e.message).toMatch(/ace-nm-org/);
  });

  it('refuses the default workspace\'s Drive root as a partner root', () => {
    const e = err(() =>
      resolveRunWorkspace({ workspace: 'spark', opp: 'o', env: ENV, response: { ...SPARK, drive_root_folder_id: 'ace-root' } }),
    );
    expect(e.code).toBe('SHARED_TENANT');
  });

  it('rejects a non-slug workspace', () => {
    expect(err(() => resolveRunWorkspace({ workspace: 'a b', opp: 'o', env: ENV, response: SPARK })).code).toBe('BAD_SLUG');
  });
});

describe('phase4Orgs from a resolved workspace', () => {
  it('a partner workspace runs PM→NM in the partner\'s own orgs', () => {
    const r = resolveRunWorkspace({ workspace: 'spark', opp: 'spark-facilitator', env: ENV, response: SPARK });
    expect(phase4Orgs(r.connect_orgs)).toEqual({
      mode: 'pm-nm',
      pm_org: 'spark-pm-org-test',
      holding_org: 'spark-nm-org-test',
      verification_rules_settable: true,
    });
  });

  it('the default workspace is unchanged', () => {
    const r = resolveRunWorkspace({ workspace: null, opp: 'x', env: ENV });
    expect(phase4Orgs(r.connect_orgs).holding_org).toBe('ace-nm-org');
  });
});

describe('URLs per workspace', () => {
  const base = 'https://labs.connect.dimagi.com/ace/';
  it('summary URL carries the run\'s workspace', () => {
    expect(runSummaryUrl(base, 'spark', 'spark-facilitator', '20261008-1200')).toBe(
      'https://labs.connect.dimagi.com/ace/opps/spark/spark-facilitator/runs/20261008-1200/summary',
    );
    expect(runSummaryUrl(base, 'dimagi-team', 'x', '20261008-1200')).toBe(
      'https://labs.connect.dimagi.com/ace/opps/dimagi-team/x/runs/20261008-1200/summary',
    );
  });
  it('workbench URL carries the run\'s workspace', () => {
    expect(runWorkbenchUrl(base, 'spark', 'spark-facilitator', '20261008-1200')).toBe(
      'https://labs.connect.dimagi.com/ace/w/spark/opps/spark-facilitator/runs/20261008-1200',
    );
  });
  it('tenancy URL', () => {
    expect(tenancyUrl(base, 'spark', 'spark-facilitator')).toBe('https://labs.connect.dimagi.com/ace/api/w/spark/opps/spark-facilitator/tenancy');
  });
  it('per-run HQ key name', () => {
    expect(hqApiKeyName('connect-ace-spark', '20261008-1200')).toBe('ace-run-connect-ace-spark-20261008-1200');
  });
});

describe('fetchOppTenancy', () => {
  it('sends the PAT and returns the body', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(SPARK), { status: 200 }));
    const body = await fetchOppTenancy({ baseUrl: 'https://x/ace', token: 't', workspace: 'spark', opp: 'spark-facilitator', fetchImpl: f as unknown as typeof fetch });
    expect(body).toEqual(SPARK);
    expect(f).toHaveBeenCalledWith('https://x/ace/api/w/spark/opps/spark-facilitator/tenancy', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }));
  });
  it('404 is a typed TENANCY_UNREADABLE naming the workspace', async () => {
    const f = async () => new Response('nope', { status: 404 });
    await expect(fetchOppTenancy({ baseUrl: 'https://x', token: 't', workspace: 'spark', opp: 'o', fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code: 'TENANCY_UNREADABLE' });
  });
  it('no token is ACE_WEB_NOT_CONFIGURED, without a request', async () => {
    const f = vi.fn();
    await expect(fetchOppTenancy({ baseUrl: 'https://x', token: '', workspace: 'spark', opp: 'o', fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code: 'ACE_WEB_NOT_CONFIGURED' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('renderRunWorkspaceYaml', () => {
  it('a partner block parses, carries the nested connect_orgs and the preflight reads', () => {
    const y = parseYaml(renderRunWorkspaceYaml(resolveRunWorkspace({ workspace: 'spark', opp: 'spark-facilitator', env: ENV, response: SPARK })));
    expect(y.run_workspace.status).toBe('ok');
    expect(y.run_workspace.hq_domain).toBe('connect-ace-spark');
    expect(y.run_workspace.connect_orgs.pm_org).toBe('spark-pm-org-test');
    expect(y.run_workspace.connect_orgs.phase4_holding_org).toBe('spark-nm-org-test');
    expect(y.run_workspace.hq_api_key).toMatch(/^hq-key:ace-run-connect-ace-spark-/);
    expect(y.run_workspace.preflight_reads).toHaveLength(4);
    expect(y.run_workspace.preflight_reads.join('\n')).toMatch(/get_hq_connection/);
  });
  it('the default block has no preflight reads', () => {
    const y = parseYaml(renderRunWorkspaceYaml(resolveRunWorkspace({ workspace: null, opp: 'x', env: ENV })));
    expect(y.run_workspace.preflight_reads).toEqual([]);
    expect(y.run_workspace.is_default).toBe(true);
  });
  it('a failure renders status fail with code and remediation', () => {
    const y = parseYaml(renderRunWorkspaceYaml(new RunWorkspaceError('TENANCY_INCOMPLETE', 'm', 'r', ['tenancy.hq_domain'])));
    expect(y.run_workspace).toMatchObject({ status: 'fail', code: 'TENANCY_INCOMPLETE', fields: ['tenancy.hq_domain'], remediation: 'r' });
  });
});
