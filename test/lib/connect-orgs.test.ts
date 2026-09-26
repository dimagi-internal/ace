import { describe, it, expect } from 'vitest';
import {
  resolveConnectOrgs,
  renderConnectOrgsYaml,
  ConnectOrgConfigError,
  LEGACY_DEFAULT_PM_ORG,
  phase4Orgs,
  runConnectOrgs,
} from '../../lib/connect-orgs.js';

describe('resolveConnectOrgs', () => {
  it('unconfigured install keeps the legacy PM org and has no NM org', () => {
    const o = resolveConnectOrgs({});
    expect(o.pm_org).toBe(LEGACY_DEFAULT_PM_ORG);
    expect(o.nm_org).toBeNull();
    expect(o.source).toEqual({ pm_org: 'legacy-default', nm_org: 'unset' });
  });

  it('reads both orgs from env', () => {
    const o = resolveConnectOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' });
    expect(o).toEqual({
      pm_org: 'ace-pm-org',
      nm_org: 'ace-nm-org',
      source: { pm_org: 'env', nm_org: 'env' },
    });
  });

  it('treats empty, whitespace, quoted-empty and unresolved 1Password refs as unset', () => {
    for (const v of ['', '   ', '""', "''", 'op://Agent-Ace/x/y']) {
      const o = resolveConnectOrgs({ ACE_CONNECT_PM_ORG: v, ACE_CONNECT_NM_ORG: v });
      expect(o.source).toEqual({ pm_org: 'legacy-default', nm_org: 'unset' });
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
