import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  aceControlledOrgs,
  assertAcceptingForSelf,
  ActingForAnotherOrgError,
  LEGACY_DEFAULT_PM_ORG,
  CONTROLLED_ORGS_ENV,
  parseReceivedInvitations,
  resolveControlledApplicationOrg,
} from '../../lib/connect-orgs.js';

/**
 * ace#2954 — ACE accepted a Connect programme invitation ON BEHALF OF tekzal, a
 * real external partner it does not control, two minutes after inviting them.
 * Nobody at tekzal clicked anything.
 *
 * Connect's API permits this: ProgramApplicationAcceptView only checks that the
 * caller is an admin of the PROGRAMME's org, and it accepts straight from
 * INVITED — so the invited party's step can be skipped entirely. There is no
 * undo; the view has no transition out of ACCEPTED.
 *
 * These tests pin the authority rule. They are deliberately pure: the whole
 * decision is a routing question and needs no live Connect.
 */
describe('aceControlledOrgs', () => {
  it('an unconfigured install controls exactly the legacy PM org', () => {
    expect(aceControlledOrgs({})).toEqual([LEGACY_DEFAULT_PM_ORG]);
  });

  it('includes both configured orgs', () => {
    expect(aceControlledOrgs({ ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' }))
      .toEqual(['ace-nm-org', 'ace-pm-org']);
  });

  it('admits extra orgs declared in machine config', () => {
    const orgs = aceControlledOrgs({
      ACE_CONNECT_PM_ORG: 'ace-pm-org',
      [CONTROLLED_ORGS_ENV]: 'other-ace-org, "quoted-org"',
    });
    expect(orgs).toContain('other-ace-org');
    expect(orgs).toContain('quoted-org');
  });

  it('ignores junk in the extra list rather than admitting it', () => {
    const orgs = aceControlledOrgs({ [CONTROLLED_ORGS_ENV]: 'https://connect.dimagi.com/a/evil/,  ,ok-org' });
    expect(orgs).toContain('ok-org');
    expect(orgs).not.toContain('https://connect.dimagi.com/a/evil/');
  });
});

describe('assertAcceptingForSelf', () => {
  const env = { ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' };

  it('allows accepting for an org ACE controls', () => {
    expect(() => assertAcceptingForSelf('ace-nm-org', env)).not.toThrow();
  });

  it('REFUSES accepting for a partner org — the ace#2954 case', () => {
    expect(() => assertAcceptingForSelf('tekzal', env)).toThrow(ActingForAnotherOrgError);
    try {
      assertAcceptingForSelf('tekzal', env);
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('tekzal');
      // The message must say whose action it is and what to do instead,
      // because the person reading it is mid-run and about to retry.
      expect(m).toMatch(/INVITED organisation's action/);
      expect(m).toMatch(/Wait for the partner to accept/);
    }
  });

  it('FAILS CLOSED when the application org cannot be determined', () => {
    // connect_list_invites is a blind read that returns [] even for a live
    // invite, so "unknown" is a reachable state — and the act is irreversible.
    expect(() => assertAcceptingForSelf(null, env)).toThrow(ActingForAnotherOrgError);
    expect(() => assertAcceptingForSelf(undefined, env)).toThrow(ActingForAnotherOrgError);
    expect(() => assertAcceptingForSelf('   ', env)).toThrow(ActingForAnotherOrgError);
  });

  it('a RUN-SCOPED override cannot widen what ACE may act as', () => {
    // This is the whole control. On tekzal/20261013-2314 run_state's
    // run_connect_orgs legitimately named `tekzal` as the network-manager org.
    // Authority is derived from the ENVIRONMENT only, so naming a partner as
    // NM for an opp must never also authorise acting as that partner.
    expect(aceControlledOrgs(env)).not.toContain('tekzal');
    expect(() => assertAcceptingForSelf('tekzal', env)).toThrow(ActingForAnotherOrgError);
  });
});

describe('both backends carry the gate (ace#2954)', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the REST/atom path gates before calling acceptProgramApplication', () => {
    const src = read('mcp/connect-server.ts');
    const i = src.indexOf("server.tool('connect_accept_program_application'");
    expect(i).toBeGreaterThan(-1);
    const handler = src.slice(i, src.indexOf("server.tool('connect_list_invites'", i));
    expect(handler).toContain('assertAcceptingForSelf');
    // ace#3009: ownership must come from the controlled orgs' own pages, not
    // from the blind listInvites read.
    expect(handler).toContain('resolveControlledApplicationOrg');
    expect(handler).not.toContain('listInvites(');
    // The gate must precede the mutation, not follow it.
    expect(handler.indexOf('assertAcceptingForSelf'))
      .toBeLessThan(handler.indexOf('acceptProgramApplication(args)'));
  });

  it('the Playwright fallback refuses instead of POSTing at the partner url', () => {
    const src = read('mcp/connect/backends/playwright.ts');
    const i = src.indexOf('acceptProgramApplication: ConnectClient');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 3200);
    expect(body).toContain('assertAcceptingForSelf');
    expect(body).toContain('resolveControlledApplicationOrg');
    expect(body.slice(0, body.indexOf('/program/${args.program_id}/application/'))).not.toContain('listInvites(');
    // This backend builds `/a/<llo>/.../accept/` — the invited org's OWN url.
    // The gate must come before that request is built.
    expect(body.indexOf('assertAcceptingForSelf')).toBeLessThan(body.indexOf('/program/${args.program_id}/application/'));
  });
});

/**
 * ace#3009 — #2954's gate resolved the subject org via connect_list_invites,
 * a BLIND read that returns [] even for a live invite, so it failed closed on
 * EVERY accept, ACE's own NM org included (kaduna-graduation/20261015-1411:
 * program b628a35f…, application da8c184e… for ace-nm-org, status invited;
 * list_invites returned [] at both orgs). The resolver now reads each
 * CONTROLLED org's own programme page, which Connect scopes to invitations
 * addressed to that org.
 */
describe('resolveControlledApplicationOrg (ace#3009)', () => {
  const env = { ACE_CONNECT_PM_ORG: 'ace-pm-org', ACE_CONNECT_NM_ORG: 'ace-nm-org' };
  const PROG = 'b628a35f-be8f-469f-83ab-1b14bf469976';
  const APP = 'da8c184e-735c-4fb5-aa2b-5a2567558a45';
  // Shape of the live nm_home.html Apply button, observed 2026-10-16.
  const nmHome = (org: string, app = APP) =>
    `<button hx-post="/a/${org}/program/${PROG}/application/${app}/apply/" hx-swap="outerHTML" hx-target="body"
      class="button button-sm primary-dark">Apply to Program</button>`;
  const pmHome = '<p class="card_title">Some programme</p>';

  it('the blind list read cannot resolve the live repro — the old gate always refused', () => {
    // What #2954 did: look the application up in listInvites' output, which
    // was [] live, so the org was always undefined and the gate refused.
    const blindInvites: Array<{ id: string; organization: string }> = [];
    const old = blindInvites.find((i) => i.id === APP)?.organization;
    expect(() => assertAcceptingForSelf(old, env)).toThrow(ActingForAnotherOrgError);
  });

  it('resolves the live repro to ace-nm-org from its own programme page', async () => {
    const pages: Record<string, string> = { 'ace-pm-org': pmHome, 'ace-nm-org': nmHome('ace-nm-org') };
    const org = await resolveControlledApplicationOrg(
      { program_id: PROG, application_id: APP },
      env,
      async (o) => parseReceivedInvitations(pages[o] ?? '', o),
    );
    expect(org).toBe('ace-nm-org');
  });

  it('never reads an uncontrolled org, so a partner application is refused (ace#2954 stays closed)', async () => {
    const read: string[] = [];
    await expect(
      resolveControlledApplicationOrg({ program_id: PROG, application_id: APP }, env, async (o) => {
        read.push(o);
        // Even if a page showed the partner's application, the url's org
        // segment is the partner's, not the page's, so it does not count.
        return parseReceivedInvitations(nmHome('tekzal'), o);
      }),
    ).rejects.toThrow(ActingForAnotherOrgError);
    expect([...read].sort()).toEqual(['ace-nm-org', 'ace-pm-org']);
  });

  it('a run-scoped override cannot add an org to the search', async () => {
    const read: string[] = [];
    const overridden: Record<string, string> = { ...env, run_connect_orgs: 'tekzal' };
    await expect(
      resolveControlledApplicationOrg({ program_id: PROG, application_id: APP }, overridden, async (o) => {
        read.push(o);
        return [];
      }),
    ).rejects.toThrow(ActingForAnotherOrgError);
    expect(read).not.toContain('tekzal');
  });

  it('a different application on a controlled page does not match', async () => {
    const other = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await expect(
      resolveControlledApplicationOrg({ program_id: PROG, application_id: APP }, env, async (o) =>
        parseReceivedInvitations(nmHome(o, other), o),
      ),
    ).rejects.toThrow(ActingForAnotherOrgError);
  });

  it('FAILS CLOSED when every read errors, and names the failures', async () => {
    await expect(
      resolveControlledApplicationOrg({ program_id: PROG, application_id: APP }, env, async (o) => {
        throw new Error(`HTTP 403 at /a/${o}/program/`);
      }),
    ).rejects.toThrow(/HTTP 403 at \/a\/ace-nm-org\/program\//);
  });
});

describe('parseReceivedInvitations', () => {
  it("keeps only apply urls under the page's own org slug", () => {
    const html =
      '<a hx-post="/a/ace-nm-org/program/b628a35f-be8f-469f-83ab-1b14bf469976/application/da8c184e-735c-4fb5-aa2b-5a2567558a45/apply/">' +
      '<a hx-post="/a/tekzal/program/b628a35f-be8f-469f-83ab-1b14bf469976/application/11111111-1111-1111-1111-111111111111/apply/">';
    expect(parseReceivedInvitations(html, 'ace-nm-org')).toEqual([
      {
        organization: 'ace-nm-org',
        program_id: 'b628a35f-be8f-469f-83ab-1b14bf469976',
        application_id: 'da8c184e-735c-4fb5-aa2b-5a2567558a45',
      },
    ]);
  });
});

describe('tenancy guard covers the subject org, not just the caller (ace#2954)', () => {
  it('connect_send_llo_invite.organization is checked against the holding org', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../config/tenancy-targets.json'), 'utf8'),
    );
    const rule = cfg.rules.find((r: { name: string }) => r.name === 'connect-org-writes');
    expect(rule).toBeTruthy();
    expect(rule.tool_pattern).toContain('send_llo_invite');
    // Before ace#2954 only `organization_slug` (the CALLER) was mapped, so the
    // org being acted ON was never checked at all.
    expect(rule.args.organization).toEqual(['connect_holding_org']);
    expect(rule.args.organization_slug).toContain('connect_pm_org');
  });
});
