import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  aceControlledOrgs,
  assertAcceptingForSelf,
  ActingForAnotherOrgError,
  LEGACY_DEFAULT_PM_ORG,
  CONTROLLED_ORGS_ENV,
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
    const handler = src.slice(i, i + 1800);
    expect(handler).toContain('assertAcceptingForSelf');
    // The gate must precede the mutation, not follow it.
    expect(handler.indexOf('assertAcceptingForSelf'))
      .toBeLessThan(handler.indexOf('acceptProgramApplication(args)'));
  });

  it('the Playwright fallback refuses instead of POSTing at the partner url', () => {
    const src = read('mcp/connect/backends/playwright.ts');
    const i = src.indexOf('acceptProgramApplication: ConnectClient');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 2600);
    expect(body).toContain('assertAcceptingForSelf');
    // This backend builds `/a/<llo>/.../accept/` — the invited org's OWN url.
    // The gate must come before that request is built.
    expect(body.indexOf('assertAcceptingForSelf')).toBeLessThan(body.indexOf('/program/${args.program_id}/application/'));
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
