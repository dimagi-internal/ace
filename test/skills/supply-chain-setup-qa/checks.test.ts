/**
 * Controls for skills/supply-chain-setup-qa/checks.ts.
 *
 * Grounded on a LIVE labs capture (program 10602, read-only, 2026-10-18 — see
 * the fixture's `_provenance`). That capture is what taught two of these
 * checks their shape: an unset `connect_username` comes back as `""`, not
 * null, and `programme_team_list` REFUSES on a Dimagi-run programme because
 * Dimagi's team is "everyone with a Dimagi address".
 *
 * `orgs_bound` guards the class ace#3049 observed on
 * noora-health/20261015-1129: a Connect org with no bound labs org gives ACE no
 * labs membership, so every owner-scoped write refuses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syntheticName } from '../../../lib/supply-chain-ref';
import {
  CHECKS,
  checkNoRegistryConflicts,
  checkOrgsBound,
  checkPlannedRecordsReadBack,
  checkRunnerMatchesPlan,
  checkRunnerStanding,
  checkSuppliersSynthetic,
  checkTeamHasAceAdmin,
  checkUserHeldPointsNamed,
  normalizeReadback,
  type RawReadback,
  type SetupPlan,
  type SetupReadback,
} from '../../../skills/supply-chain-setup-qa/checks';

/** The live capture, read off disk once. Every block below passes it in explicitly. */
const LIVE = readFileSync(new URL('./fixtures/labs-program-10602-readback.json', import.meta.url), 'utf-8');

/** The live readback, normalised (a fresh copy each call, so mutations never leak). */
function live(capture: string): SetupReadback {
  return normalizeReadback(JSON.parse(capture) as RawReadback);
}

/** A plan that says exactly what the live programme holds (so every check should pass on it). */
function planMatching(rb: SetupReadback): SetupPlan {
  return {
    program_id: 10602,
    runner: { org_id: rb.runner.org_id as number, role: 'other' },
    orgs: rb.orgs
      .filter((o) => typeof o.connect_organization_id === 'number')
      .map((o) => ({ slug: o.slug, role: 'pm' as const, connect_organization_id: o.connect_organization_id as number })),
    commodities: rb.commodities,
    items: rb.items.map((i) => ({ sku: i.sku, commodity_slug: '' })),
    supply_points: rb.supply_points.map((p) => ({ slug: p.slug, kind: p.kind })),
    suppliers: rb.suppliers.map((s) => ({ name: syntheticName(s.name) })),
    synthetic_usernames: [],
    ace_email: 'ace@dimagi-ai.com',
  };
}

function doc(capture: string, mut?: (plan: SetupPlan, readback: SetupReadback) => void): string {
  const readback = live(capture);
  // What setup itself would have created: invented suppliers carry the marker.
  readback.suppliers = readback.suppliers.map((x) => ({ name: syntheticName(x.name) }));
  const plan = planMatching(readback);
  mut?.(plan, readback);
  return JSON.stringify({ plan, readback });
}

describe('normalizeReadback on the live capture', () => {
  it('reads labs\' shapes: {value: [...]}, "" usernames, and the Dimagi team refusal', () => {
    const rb = live(LIVE);
    expect(rb.runner).toEqual({ org_id: 2, your_standing: 'programme' });
    expect(rb.commodities.map((c) => c.slug)).toContain('iptsc-treatment-packet');
    expect(rb.supply_points[0]).toEqual({ slug: 'schi-district-store', kind: 'regional_store', connect_username: null });
    expect(rb.team_by_domain).toBe(true);
    expect(rb.checks.every((c) => c.category === 'missing')).toBe(true);
  });
});

describe('normalizeReadback on the live programme_team_list shape (programme 361, ace#3261)', () => {
  // Verbatim from the issue: supply_chain_programme_team_list({program_id: 361}).
  const TEAM_361 = {
    org_id: 356,
    org_name: 'ACE Test LLO (Synthetic)',
    members: [{ user_id: 49, email: 'ace@dimagi-ai.com', role: 'admin' }],
  };

  function withTeam(team: RawReadback['programme_team_list']): SetupReadback {
    const raw = JSON.parse(LIVE) as RawReadback;
    raw.programme_team_list = team;
    return normalizeReadback(raw);
  }

  it('reads members from the live {org_id, org_name, members} reply', () => {
    const rb = withTeam(TEAM_361);
    expect(rb.team).toEqual([{ email: 'ace@dimagi-ai.com', role: 'admin' }]);
    expect(rb.team_by_domain).toBeUndefined();
  });

  it('team_has_ace_admin passes on that reply passed as labs returned it', () => {
    const readback = withTeam(TEAM_361);
    const plan = planMatching(readback);
    expect(checkTeamHasAceAdmin(JSON.stringify({ plan, readback })).pass).toBe(true);
  });

  it('still accepts {value: [...]} and a bare array', () => {
    expect(withTeam({ value: TEAM_361.members }).team).toHaveLength(1);
    expect(withTeam(TEAM_361.members).team).toHaveLength(1);
  });
});

describe('supply-chain-setup-qa checks, grounded on program 10602', () => {
  it('checkRunnerStanding: programme passes; partner (program 353, same day) fails', () => {
    expect(checkRunnerStanding(doc(LIVE)).pass).toBe(true);
    expect(checkRunnerStanding(doc(LIVE, (_p, rb) => (rb.runner = { org_id: null, your_standing: 'partner' }))).pass).toBe(false);
  });

  it('checkRunnerMatchesPlan: the live runner matches; a plan naming another org fails', () => {
    expect(checkRunnerMatchesPlan(doc(LIVE)).pass).toBe(true);
    expect(checkRunnerMatchesPlan(doc(LIVE, (p) => (p.runner.org_id = 386))).pass).toBe(false);
  });

  it('checkOrgsBound: a Connect-bound org passes; planning the unbound Dimagi row as bound fails', () => {
    expect(checkOrgsBound(doc(LIVE)).pass).toBe(true);
    const r = checkOrgsBound(doc(LIVE, (p) => p.orgs.push({ slug: 'dimagi', role: 'pm', connect_organization_id: 51 })));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('dimagi');
  });

  it('checkPlannedRecordsReadBack: what labs holds passes; a planned item labs lacks fails, by name', () => {
    expect(checkPlannedRecordsReadBack(doc(LIVE)).pass).toBe(true);
    const r = checkPlannedRecordsReadBack(doc(LIVE, (p) => p.items.push({ sku: 'handset-basic-01', commodity_slug: 'feature-handset' })));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('item handset-basic-01');
  });

  it('checkUserHeldPointsNamed: no FLWs passes; an FLW with no user_held point fails', () => {
    expect(checkUserHeldPointsNamed(doc(LIVE)).pass).toBe(true);
    expect(checkUserHeldPointsNamed(doc(LIVE, (p) => (p.synthetic_usernames = ['syn-flw-001']))).pass).toBe(false);
  });

  it('checkUserHeldPointsNamed: a user_held point for a real (non-simulated) username fails', () => {
    const r = checkUserHeldPointsNamed(
      doc(LIVE, (p, rb) => {
        p.synthetic_usernames = ['syn-flw-001'];
        rb.supply_points.push({ slug: 'flw-001', kind: 'user_held', connect_username: 'real.worker' });
      }),
    );
    expect(r.pass).toBe(false);
  });

  it('checkSuppliersSynthetic: marked names pass; the live, real supplier names fail', () => {
    expect(checkSuppliersSynthetic(doc(LIVE)).pass).toBe(true);
    const realNames = live(LIVE).suppliers;
    const r = checkSuppliersSynthetic(doc(LIVE, (p) => (p.suppliers = realNames)));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Harmattan Health Supplies');
  });

  it('checkTeamHasAceAdmin: Dimagi runner + a Dimagi address passes; a non-Dimagi address fails', () => {
    expect(checkTeamHasAceAdmin(doc(LIVE)).pass).toBe(true);
    expect(checkTeamHasAceAdmin(doc(LIVE, (p) => (p.ace_email = 'ace@example.org'))).pass).toBe(false);
  });

  it('checkTeamHasAceAdmin: on a listed team, admin passes and member fails', () => {
    const listed = (role: string) =>
      doc(LIVE, (_p, rb) => {
        rb.team_by_domain = undefined;
        rb.team = [{ email: 'ACE@dimagi-ai.com', role }];
      });
    expect(checkTeamHasAceAdmin(listed('admin')).pass).toBe(true);
    expect(checkTeamHasAceAdmin(listed('member')).pass).toBe(false);
  });

  it('checkNoRegistryConflicts: the live missing-only findings pass; a conflict kind from the live vocabulary fails', () => {
    expect(checkNoRegistryConflicts(doc(LIVE)).pass).toBe(true);
    expect(checkNoRegistryConflicts(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'conflict', kind: 'stock_variance' }))).pass).toBe(false);
  });

  it('every failure carries an auto-fix hint, and a malformed artifact never passes', () => {
    const allBad = doc(LIVE, (p, rb) => {
      rb.runner = { org_id: null, your_standing: 'partner' };
      p.orgs.push({ slug: 'dimagi', role: 'pm', connect_organization_id: 51 });
      p.items.push({ sku: 'missing-sku', commodity_slug: 'x' });
      p.synthetic_usernames = ['syn-flw-001'];
      p.suppliers = live(LIVE).suppliers;
      p.ace_email = 'ace@example.org';
      rb.checks.push({ category: 'conflict', kind: 'stock_variance' });
    });
    for (const c of CHECKS) {
      const r = c.run(allBad) as { pass: boolean; auto_fix_hint?: string };
      expect(r.pass, c.id).toBe(false);
      expect(r.auto_fix_hint, c.id).toBeTruthy();
      expect((c.run('not json') as { pass: boolean }).pass, c.id).toBe(false);
      expect((c.run('{}') as { pass: boolean }).pass, c.id).toBe(false);
    }
  });
});
