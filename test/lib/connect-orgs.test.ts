import { describe, it, expect } from 'vitest';
import {
  resolveConnectOrgs,
  renderConnectOrgsYaml,
  ConnectOrgConfigError,
  LEGACY_DEFAULT_PM_ORG,
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
