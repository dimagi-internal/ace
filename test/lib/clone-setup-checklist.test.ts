/**
 * The operator setup checklist that opens every clone (Jon, 2026-10-02):
 * "have me create the HQ space and turn on demo mode, and then have me manually
 * create a PM and NM org for you to use, and give me clear URLs to click".
 * The text goes to a human verbatim, so the tests pin every URL, the slug
 * substitution, and the absence of ACE-internal vocabulary.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyConnectProbe,
  classifyHqMyRole,
  cloneSetupVerifyChecks,
  extractConnectInviteUrl,
  extractHqInviteUrl,
  renderCloneSetupChecklist,
  renderVerifyChecks,
  suggestedHqDomain,
} from '../../lib/clone-setup-checklist';
import { hqEnterpriseFlipUrl } from '../../lib/hq-enterprise-flip';

const ALL = { workspace: 'spark', hqDomain: 'connect-ace-spark', pmOrg: 'spark-program', nmOrg: 'spark' };

describe('renderCloneSetupChecklist', () => {
  it('carries every URL with all slugs substituted', () => {
    const t = renderCloneSetupChecklist(ALL);
    for (const url of [
      'https://www.commcarehq.org/register/domain/',
      hqEnterpriseFlipUrl('connect-ace-spark'),
      'https://www.commcarehq.org/a/connect-ace-spark/settings/project/internal_subscription_management/',
      'https://www.commcarehq.org/a/connect-ace-spark/settings/users/web/invite/',
      'https://connect.dimagi.com/register/organization/',
      'https://connect.dimagi.com/a/spark-program/organization/',
      'https://connect.dimagi.com/a/spark/organization/',
    ]) expect(t).toContain(url);
    expect(t).not.toMatch(/<[a-z-]+>/); // no placeholder left
    expect(t).toContain('ace@dimagi-ai.com');
    expect(t).toContain('**Test or Demo Project**');
    expect(t).toContain('**Enable Program Manager**');
    expect(t).toContain('**Then reply "done".**');
  });

  it('keeps the HQ space and orgs in the order the operator decided: HQ, demo mode, then the two orgs', () => {
    const t = renderCloneSetupChecklist(ALL);
    const at = (s: string) => t.indexOf(s);
    expect(at('/register/domain/')).toBeLessThan(at('internal_subscription_management'));
    expect(at('internal_subscription_management')).toBeLessThan(at('/register/organization/'));
    expect(at('/a/spark-program/organization/')).toBeLessThan(at('/a/spark/organization/'));
  });

  it('uses placeholders and asks for the slugs it does not know', () => {
    const t = renderCloneSetupChecklist({ workspace: 'spark', hqDomain: 'connect-ace-spark' });
    expect(t).toContain('https://connect.dimagi.com/a/<program-manager-org>/organization/');
    expect(t).toContain('https://connect.dimagi.com/a/<partner-org>/organization/');
    expect(t).not.toContain('%3C'); // a placeholder is never URL-encoded
    expect(t.match(/\*\*Send me its slug\*\*/g)).toHaveLength(2);
    expect(t).toMatch(/Then reply with\*\* the slug of the organization that runs the program, the slug of the organization that holds the opportunity/);
    expect(t).not.toMatch(/HQ project space slug/);
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
    expect(text).toContain('connect_list_programs(organization_slug: spark-program)');
    expect(text).toContain('connect_list_opportunities(organization_slug: spark)');
    expect(text).toContain('https://www.commcarehq.org/a/connect-ace-spark/settings/users/my_role/');
    expect(text).toContain('https://connect.dimagi.com/a/spark-program/program/init/');
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
    expect(classifyConnectProbe('pm-program-manager', 404).detail).toMatch(/Enable Program Manager is off/);
    expect(classifyConnectProbe('nm-admin', 404).detail).toMatch(/not an Admin/);
    expect(classifyConnectProbe('pm-admin', 302).detail).toMatch(/connect-login/);
  });
});
