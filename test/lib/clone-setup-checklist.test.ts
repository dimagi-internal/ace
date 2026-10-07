/**
 * The operator setup checklist that opens every clone (Jon, 2026-10-02):
 * "have me create the HQ space and turn on demo mode, and then have me manually
 * create a PM and NM org for you to use, and give me clear URLs to click".
 * Amended 2026-10-07 (dimagi/commcare-connect#1580): ACE creates both Connect
 * orgs itself, named <workspace>-pm-test / <workspace>-nm-test; the operator only
 * ticks the two staff-only settings (Program manager, Is test) in Django admin.
 * The text goes to a human verbatim, so the tests pin every URL, the slug
 * substitution, and the absence of ACE-internal vocabulary.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyConnectProbe,
  classifyHqMyRole,
  classifyOrgCreate,
  classifyOrgPreflight,
  cloneSetupVerifyChecks,
  connectOrgNames,
  extractConnectInviteUrl,
  extractHqInviteUrl,
  renderCloneSetupChecklist,
  renderVerifyChecks,
  suggestedHqDomain,
} from '../../lib/clone-setup-checklist';
import { hqEnterpriseFlipUrl } from '../../lib/hq-enterprise-flip';

const ALL = { workspace: 'spark', hqDomain: 'connect-ace-spark', pmOrg: 'spark-pm-test', nmOrg: 'spark-nm-test' };

describe('connectOrgNames — the clone naming convention (Jon, 2026-10-07)', () => {
  it('names the program org <ws>-pm-test and the holding org <ws>-nm-test', () => {
    expect(connectOrgNames('spark')).toEqual({ pm: 'spark-pm-test', nm: 'spark-nm-test' });
  });
  it('is what the checklist and the checks use when no org flags are passed', () => {
    const t = renderCloneSetupChecklist({ workspace: 'spark', hqDomain: 'connect-ace-spark' });
    expect(t).toContain('`spark-pm-test`');
    expect(t).toContain('`spark-nm-test`');
    expect(renderVerifyChecks({ workspace: 'spark', hqDomain: 'h' })).toContain('/a/spark-pm-test/program/init/');
  });
  it('lets explicit flags win', () => {
    expect(renderCloneSetupChecklist({ ...ALL, pmOrg: 'other-pm' })).toContain('`other-pm`');
  });
});

describe('renderCloneSetupChecklist', () => {
  it('carries every URL with all slugs substituted', () => {
    const t = renderCloneSetupChecklist(ALL);
    for (const url of [
      'https://www.commcarehq.org/register/domain/',
      hqEnterpriseFlipUrl('connect-ace-spark'),
      'https://www.commcarehq.org/a/connect-ace-spark/settings/project/internal_subscription_management/',
      'https://www.commcarehq.org/a/connect-ace-spark/settings/users/web/invite/',
      'https://connect.dimagi.com/admin/organization/organization/?q=spark-pm-test',
      'https://connect.dimagi.com/admin/organization/organization/?q=spark-nm-test',
    ]) expect(t).toContain(url);
    // ACE creates the orgs: the operator is never sent to create one or to add ace@.
    expect(t).not.toContain('/register/organization/');
    expect(t).not.toMatch(/Add Member/);
    expect(t).not.toMatch(/<[a-z-]+>/); // no placeholder left
    expect(t).toContain('ace@dimagi-ai.com');
    expect(t).toContain('**Test or Demo Project**');
    expect(t).toContain('**Program manager**');
    expect(t.match(/\*\*Is test\*\*/g)).toHaveLength(2);
    expect(t).toContain('**Then reply "done".**');
  });

  it('keeps the HQ space and orgs in the order the operator decided: HQ, demo mode, then the two orgs', () => {
    const t = renderCloneSetupChecklist(ALL);
    const at = (s: string) => t.indexOf(s);
    expect(at('/register/domain/')).toBeLessThan(at('internal_subscription_management'));
    expect(at('internal_subscription_management')).toBeLessThan(at('?q=spark-pm-test'));
    expect(at('?q=spark-pm-test')).toBeLessThan(at('?q=spark-nm-test'));
  });

  it('never asks for a Connect slug — ACE names the orgs', () => {
    const t = renderCloneSetupChecklist({ workspace: 'spark', hqDomain: 'connect-ace-spark' });
    expect(t).not.toMatch(/Send me its slug/);
    expect(t).not.toContain('%3C');
    expect(t).toContain('**Then reply "done".**');
  });

  it('suggests connect-ace-<workspace> for an unknown HQ space and asks for its slug', () => {
    const t = renderCloneSetupChecklist({ workspace: 'spark' });
    expect(t).toContain('Project Name `connect-ace-spark`');
    expect(t).toContain('https://www.commcarehq.org/a/<hq-space>/settings/project/internal_subscription_management/');
    expect(t).toContain('https://www.commcarehq.org/a/<hq-space>/settings/users/web/invite/');
    expect(t).toContain('the HQ project space slug');
    expect(suggestedHqDomain('a-very-long-workspace-name')).toHaveLength(25);
    expect(suggestedHqDomain('a-very-long-workspace-name')).not.toMatch(/-$/);
  });

  it('drops the Connect items when the clone keeps the shared Connect orgs', () => {
    const t = renderCloneSetupChecklist({ workspace: 'spark', hqDomain: 'connect-ace-spark', skipConnect: true });
    expect(t).not.toContain('connect.dimagi.com');
    expect(t).toContain('/settings/users/web/invite/');
  });

  it('speaks to the operator, not in ACE-internal vocabulary', () => {
    for (const t of [renderCloneSetupChecklist(ALL), renderCloneSetupChecklist({ workspace: 'spark' })]) {
      for (const bad of [/tenancy/i, /run_state/, /\bphase\b/i, /\b4[ab]\b/, /\batoms?\b/i, /kept-shared/, /keep-shared/, /holding_org/, /pm_org|nm_org/, /\bPM\b/, /\bNM\b/, /\bMCP\b/, /\bPAT\b/, /CommCare Connect/, /Step \d/]) {
        expect(t, String(bad)).not.toMatch(bad);
      }
    }
  });
});

describe('cloneSetupVerifyChecks', () => {
  it('lists the HQ and Connect read-backs, each pointing at the checklist item that fixes it', () => {
    const ids = cloneSetupVerifyChecks(ALL).map((c) => c.id);
    expect(ids).toEqual(['hq-admin', 'hq-plan', 'hq-api', 'pm-admin', 'pm-program-manager', 'pm-programs', 'nm-admin', 'nm-opportunities']);
    const text = renderVerifyChecks(ALL);
    expect(text).toContain('commcare_get_subscription(domain: connect-ace-spark)');
    expect(text).toContain('commcare_list_apps(domain: connect-ace-spark)');
    expect(text).toContain('connect_list_programs(organization_slug: spark-pm-test)');
    expect(text).toContain('connect_list_opportunities(organization_slug: spark-nm-test)');
    expect(text).toContain('https://www.commcarehq.org/a/connect-ace-spark/settings/users/my_role/');
    expect(text).toContain('https://connect.dimagi.com/a/spark-pm-test/program/init/');
  });
  it('proves Admin with the admin-only member table, never the org home', () => {
    // Since #1580 the org home is 200 for ANY org ace@ can profile-edit (live
    // 2026-10-07: `dimagi`, not a member: home 200, member_table 404).
    const admin = cloneSetupVerifyChecks(ALL).filter((c) => c.id.endsWith('-admin') && c.system === 'connect');
    expect(admin.map((c) => c.how)).toEqual([
      'GET https://connect.dimagi.com/a/spark-pm-test/organization/member_table',
      'GET https://connect.dimagi.com/a/spark-nm-test/organization/member_table',
    ]);
  });
  it('has HQ checks only with skipConnect', () => {
    expect(cloneSetupVerifyChecks({ ...ALL, skipConnect: true }).every((c) => c.system === 'hq')).toBe(true);
  });
});

describe('invitation links in ace@ mail', () => {
  // Bodies shaped like the real mails in ace@'s inbox (2026-10-02).
  const hqBody = 'Jonathan Jackson has invited you to join the ace-enterprise project on CommCare.\nhttps://www.commcarehq.org/a/ace-enterprise/settings/users/join/4e44e8ae-2807-4105-ac82-7187484add78/\n';
  const cxBody = 'Accept: https://connect.dimagi.com/a/ace-pm-org/organization/invite/7QG66zsMMKVbd4Bef0e2kfcUBii0QwCupaCYDTBeSU0/ thanks';

  it('finds the HQ join link for the right space only', () => {
    expect(extractHqInviteUrl(hqBody, 'ace-enterprise')).toBe('https://www.commcarehq.org/a/ace-enterprise/settings/users/join/4e44e8ae-2807-4105-ac82-7187484add78/');
    expect(extractHqInviteUrl(hqBody, 'ace')).toBeNull();
    expect(extractHqInviteUrl(hqBody, 'connect-ace-spark')).toBeNull();
  });
  it('finds the Connect accept link for the right org only', () => {
    expect(extractConnectInviteUrl(cxBody, 'ace-pm-org')).toBe('https://connect.dimagi.com/a/ace-pm-org/organization/invite/7QG66zsMMKVbd4Bef0e2kfcUBii0QwCupaCYDTBeSU0/');
    expect(extractConnectInviteUrl(cxBody, 'ace-nm-org')).toBeNull();
    expect(extractConnectInviteUrl(cxBody, 'ace')).toBeNull();
  });
});

describe('live read-back classification', () => {
  it('HQ my_role', () => {
    expect(classifyHqMyRole(200, '{"role": "Admin", "is_domain_admin": true}').ok).toBe(true);
    expect(classifyHqMyRole(200, '{"role": "App Editor", "is_domain_admin": false}')).toMatchObject({ ok: false, detail: expect.stringMatching(/App Editor, not Admin/) });
    expect(classifyHqMyRole(404, '<html>')).toMatchObject({ ok: false, detail: expect.stringMatching(/does not exist/) });
    expect(classifyHqMyRole(302, '')).toMatchObject({ ok: false, detail: expect.stringMatching(/not a member/) });
    expect(classifyHqMyRole(200, '<!DOCTYPE html>').ok).toBe(false);
    expect(classifyHqMyRole(200, '{"is_dimagi_admin": true}').ok).toBe(false);
  });
  it('Connect org home / program init', () => {
    expect(classifyConnectProbe('pm-program-manager', 200).ok).toBe(true);
    expect(classifyConnectProbe('pm-program-manager', 404).detail).toMatch(/Program manager is off/);
    expect(classifyConnectProbe('nm-admin', 404).detail).toMatch(/not an Admin/);
    expect(classifyConnectProbe('pm-admin', 302).detail).toMatch(/connect-login/);
  });
});

describe('creating the orgs', () => {
  it('preflight: skips an org ace@ already administers, refuses one it does not, creates a missing one', () => {
    expect(classifyOrgPreflight('pm', 'spark-pm-test', 200, 200)).toMatchObject({ status: 'exists', ok: true });
    expect(classifyOrgPreflight('pm', 'spark-pm-test', 404, 200)).toMatchObject({ status: 'taken', ok: false });
    expect(classifyOrgPreflight('nm', 'spark-nm-test', 404, 404)).toBeNull();
    expect(classifyOrgPreflight('nm', 'spark-nm-test', 302, 302)).toMatchObject({ ok: false, detail: expect.stringMatching(/connect-login/) });
  });
  it('create: the redirect slug must equal the name', () => {
    expect(classifyOrgCreate('pm', 'spark-pm-test', 302, '/a/spark-pm-test/opportunity/', '')).toMatchObject({ status: 'created', ok: true });
    expect(classifyOrgCreate('pm', 'spark-pm-test', 302, '/a/spark-pm-test-1/opportunity/', '')).toMatchObject({ status: 'suffixed', ok: false });
    expect(classifyOrgCreate('pm', 'spark-pm-test', 302, '/accounts/login/?next=/register/organization/', '')).toMatchObject({ ok: false, detail: expect.stringMatching(/connect-login/) });
  });
  it('create: a re-rendered form with the duplicate-name error is "taken"', () => {
    const body = '<p id="error_1_id_name" class="invalid-feedback"><strong>An organization with this name already exists.</strong></p>';
    expect(classifyOrgCreate('nm', 'spark-nm-test', 200, '', body)).toMatchObject({ status: 'taken', ok: false, detail: expect.stringMatching(/already exists/) });
    expect(classifyOrgCreate('nm', 'spark-nm-test', 500, '', '')).toMatchObject({ status: 'error', ok: false });
  });
});
