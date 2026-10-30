import { describe, it, expect } from 'vitest';
import {
  resolveConnectOrgs,
  renderConnectOrgsYaml,
  ConnectOrgConfigError,
  LEGACY_DEFAULT_PM_ORG,
  phase4Orgs,
  runConnectOrgs,
  aceControlledOrgs,
  connectOrgsFromTenancy,
} from '../../lib/connect-orgs.js';

describe('resolveConnectOrgs', () => {
  it('unconfigured install keeps the legacy PM org and has no NM org', () => {
    const o = resolveConnectOrgs({});
    expect(o.pm_org).toBe(LEGACY_DEFAULT_PM_ORG);
    expect(o.nm_org).toBeNull();
    expect(o.source).toEqual({ pm_org: 'legacy-default', nm_org: 'unset', llo_org: 'unset' });
  });

  it('reads both orgs from env', () => {
    const o = resolveConnectOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' });
    expect(o).toEqual({
      pm_org: 'ace-pm-org',
      nm_org: 'ace-nm-org',
      llo_org: null,
      source: { pm_org: 'env', nm_org: 'env', llo_org: 'unset' },
    });
  });

  it('treats empty, whitespace and quoted-empty values as unset', () => {
    for (const v of ['', '   ', '""', "''"]) {
      const o = resolveConnectOrgs({ ACE_CONNECT_PM_ORG: v, ACE_CONNECT_NM_ORG: v, ACE_CONNECT_LLO_ORG: v });
      expect(o.source).toEqual({ pm_org: 'legacy-default', nm_org: 'unset', llo_org: 'unset' });
    }
  });

  it('strips surrounding quotes and whitespace the way a .env line carries them', () => {
    expect(resolveConnectOrgs({ ACE_CONNECT_PM_ORG: ' "ace-pm-org" ' }).pm_org).toBe('ace-pm-org');
  });

  it('fails loud on a pasted URL or path rather than 404ing phases later', () => {
    expect(() => resolveConnectOrgs({ ACE_CONNECT_PM_ORG: 'https://connect.dimagi.com/a/ace-pm-org/' })).toThrow(
      ConnectOrgConfigError,
    );
    expect(() => resolveConnectOrgs({ ACE_CONNECT_NM_ORG: 'ace nm' })).toThrow(/ACE_CONNECT_NM_ORG/);
  });
});

describe('llo_org (the ACE-owned winner org)', () => {
  it('reads ACE_CONNECT_LLO_ORG when it is distinct from the PM and NM orgs', () => {
    const o = resolveConnectOrgs({
      ACE_CONNECT_PM_ORG: 'ace-pm-org',
      ACE_CONNECT_NM_ORG: 'ace-nm-org',
      ACE_CONNECT_LLO_ORG: 'ace-llo-org',
    });
    expect(o.llo_org).toBe('ace-llo-org');
    expect(o.source.llo_org).toBe('env');
  });

  it("refuses a winner org equal to the PM org (labs refuses an award to the call's own side)", () => {
    expect(() => resolveConnectOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_LLO_ORG: 'ace-pm-org' })).toThrow(
      /ACE_CONNECT_LLO_ORG.*PM org/,
    );
    // also against the legacy default PM org when PM is unset
    expect(() => resolveConnectOrgs({ ACE_CONNECT_LLO_ORG: LEGACY_DEFAULT_PM_ORG })).toThrow(ConnectOrgConfigError);
  });

  it('refuses a winner org equal to the NM org', () => {
    expect(() =>
      resolveConnectOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org', ACE_CONNECT_LLO_ORG: 'ace-nm-org' }),
    ).toThrow(/ACE_CONNECT_LLO_ORG.*NM org/);
  });

  it('refuses a pasted URL like the other keys', () => {
    expect(() => resolveConnectOrgs({ ACE_CONNECT_LLO_ORG: 'https://connect.dimagi.com/a/x/' })).toThrow(ConnectOrgConfigError);
  });

  it('the winner org is an ACE-controlled org (ace@ belongs to it)', () => {
    expect(
      aceControlledOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org', ACE_CONNECT_LLO_ORG: 'ace-llo-org' }),
    ).toEqual(['ace-llo-org', 'ace-nm-org', 'ace-pm-org']);
  });

  it('a workspace tenancy never supplies a winner org', () => {
    const o = connectOrgsFromTenancy({ connect_pm_org: 'partner-pm', connect_holding_org: 'partner-nm' });
    expect(o.llo_org).toBeNull();
    expect(o.source.llo_org).toBe('unset');
  });

  it('preflight WARNs (not fails) when the winner org is unset, and is silent when set', () => {
    const unset = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'ace-pm-org' });
    expect(unset).toContain('connect_orgs:\n  status: ok');
    expect(unset).toContain('  llo_org: null');
    expect(unset).toContain('  llo_org_status: warn');
    expect(unset).toMatch(/llo_org_remediation: ".*ace_winner/);
    const set = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_LLO_ORG: 'ace-llo-org' });
    expect(set).toContain('  llo_org: "ace-llo-org"');
    expect(set).not.toContain('llo_org_status');
  });

  it('a bad winner org turns the block into status: fail, naming the key', () => {
    const y = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_LLO_ORG: 'ace-pm-org' });
    expect(y).toContain('status: fail');
    expect(y).toMatch(/remediation: ".*ACE_CONNECT_LLO_ORG/);
  });
});

describe('renderConnectOrgsYaml', () => {
  it('emits the preflight block', () => {
    const y = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'ace-pm-org' });
    expect(y).toContain('connect_orgs:\n  status: ok');
    expect(y).toContain('  pm_org: "ace-pm-org"');
    expect(y).toContain('  nm_org: null');
    expect(y).toContain('    pm_org: env');
    expect(y).toContain('    nm_org: unset');
  });

  it('emits status: fail with a remediation on a bad value instead of throwing', () => {
    const y = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'a/b' });
    expect(y).toContain('status: fail');
    expect(y).toMatch(/remediation: ".*ACE_CONNECT_PM_ORG/);
  });
});

// Phase 4 PM→NM (operator decision 2026-09-26, after spark-facilitator/20260925-1536
// could not set verification rules on its self-managed opp — ace#2419).
describe('phase4Orgs', () => {
  it('nm_org configured → PM→NM: opportunity held by nm_org, rules settable at pm_org', () => {
    expect(phase4Orgs({ pm_org: 'pm', nm_org: 'nm' })).toEqual({
      mode: 'pm-nm', pm_org: 'pm', holding_org: 'nm', verification_rules_settable: true,
    });
  });
  it('nm_org unset → self-managed legacy shape, rules NOT settable', () => {
    expect(phase4Orgs({ pm_org: 'pm', nm_org: null })).toEqual({
      mode: 'self-managed', pm_org: 'pm', holding_org: 'pm', verification_rules_settable: false,
    });
  });
  it('nm_org equal to the PM org is still self-managed (request org == holding org)', () => {
    expect(phase4Orgs({ pm_org: 'pm', nm_org: 'pm' }).mode).toBe('self-managed');
  });
  it("a reused program's recorded org overrides the configured PM org", () => {
    expect(phase4Orgs({ pm_org: 'pm', nm_org: 'nm' }, 'old-pm')).toMatchObject({ pm_org: 'old-pm', holding_org: 'nm' });
  });
  it('the preflight block names the mode and holding org', () => {
    const y = renderConnectOrgsYaml({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' });
    expect(y).toContain('  phase4_mode: pm-nm');
    expect(y).toContain('  phase4_holding_org: "ace-nm-org"');
  });
});

describe('runConnectOrgs', () => {
  it('reads both recorded orgs', () => {
    expect(runConnectOrgs({ pm_org_slug: 'pm', holding_org_slug: 'nm', organization_slug: 'pm' })).toEqual({
      pm_org_slug: 'pm', holding_org_slug: 'nm',
    });
  });
  it('legacy runs (organization_slug only) backfill both — they were self-managed', () => {
    expect(runConnectOrgs({ organization_slug: 'legacy' })).toEqual({ pm_org_slug: 'legacy', holding_org_slug: 'legacy' });
  });
  it('nothing recorded → nulls, never the configured org', () => {
    expect(runConnectOrgs(undefined)).toEqual({ pm_org_slug: null, holding_org_slug: null });
  });
});

describe('connectOrgsFromTenancy (workspace runs)', () => {
  it('maps the tenancy PM / holding orgs onto pm_org / nm_org', async () => {
    const { connectOrgsFromTenancy } = await import('../../lib/connect-orgs.js');
    expect(connectOrgsFromTenancy({ connect_pm_org: 'spark-pm-org-test', connect_holding_org: 'spark-nm-org-test' })).toEqual({
      pm_org: 'spark-pm-org-test',
      nm_org: 'spark-nm-org-test',
      llo_org: null,
      source: { pm_org: 'tenancy', nm_org: 'tenancy', llo_org: 'unset' },
    });
  });
  it('never falls back to the legacy default when the tenancy names no PM org', async () => {
    const { connectOrgsFromTenancy, ConnectOrgConfigError } = await import('../../lib/connect-orgs.js');
    expect(() => connectOrgsFromTenancy({ connect_holding_org: 'x' })).toThrow(ConnectOrgConfigError);
  });
  it('rejects a URL in place of a slug, naming the tenancy field', async () => {
    const { connectOrgsFromTenancy } = await import('../../lib/connect-orgs.js');
    expect(() => connectOrgsFromTenancy({ connect_pm_org: 'https://connect.dimagi.com/a/x/' })).toThrow(/tenancy\.connect_pm_org/);
  });
});
