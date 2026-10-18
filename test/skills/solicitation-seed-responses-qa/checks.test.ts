/**
 * Unit tests for skills/solicitation-seed-responses-qa/checks.ts.
 *
 * The clean bundle is built from the live probe captured 2026-10-18
 * (test/fixtures/labs/seed-responses-probe-2026-10-18.json): what labs really
 * returned for a private call, two fictional respondents and a bound winner.
 * Each bad input is the defect the check exists for, taken from the spec
 * (§ A2 private-only, § D impersonation / confidentiality / ACE-only email,
 * § K1 winner binding) or from the probe itself (1000048: a bound response
 * created without org_id reads back org_id "").
 */

import { describe, expect, test } from 'vitest';
import { stringify } from 'yaml';

import fx from '../../fixtures/labs/seed-responses-probe-2026-10-18.json';
import {
  CHECKS,
  checkNoDenyListParty,
  checkNoRealOrgCollision,
  checkRequiredAnswersPresent,
  checkResponseCountMatches,
  checkSolicitationStillPrivate,
  checkSyntheticEmailsOnly,
  checkWinnerBoundToLloOrg,
  type SeedBundle,
} from '../../../skills/solicitation-seed-responses-qa/checks';

function clean(f: typeof fx): SeedBundle {
  const alpha = { ...f.responses.free_named, submitted_by_name: 'Probe Alpha (synthetic)', responses: { q_org: 'x', q_fte: '40' } };
  const beta = { ...f.responses.missing_required_answer, submitted_by_email: 'ace+synthetic-2@dimagi-ai.com' };
  const win = { ...f.responses.bound_winner_with_org_id, submitted_by_email: 'ace+synthetic-3@dimagi-ai.com', responses: { q_org: 'y', q_fte: '60' } };
  return {
    solicitation: { id: f.solicitation.id, is_public: f.solicitation.is_public },
    expected_count: 3,
    mailbox: 'ace@dimagi-ai.com',
    winner: { llo_entity_id: f.labs_orgs.winner_standin.slug, connect_org_id: f.labs_orgs.winner_standin.connect_organization_id },
    questions: [
      { id: 'q_org', required: true },
      { id: 'q_fte', required: true },
      { id: 'q_budget', required: false },
    ],
    real_org_names: ['Spark Microgrants', 'Trickle Up', 'ace-nm-org'],
    deny_list: ['GiveDirectly', 'Give Directly', 'GD'],
    roster: [
      { key: 'alpha', response_id: alpha.id, org_name: alpha.org_name },
      { key: 'beta', response_id: beta.id, org_name: beta.org_name, flags: ['missing_answer'] },
      { key: 'winner', response_id: win.id, org_name: win.org_name, winner: true },
    ],
    responses: [alpha, beta, win],
  };
}

const y = (b: SeedBundle) => stringify(b);

describe('checkResponseCountMatches', () => {
  test('passes on the live-captured bundle', () => {
    expect(checkResponseCountMatches(y(clean(fx))).pass).toBe(true);
  });
  test('fails on count drift and on a roster response missing from labs', () => {
    expect(checkResponseCountMatches(y({ ...clean(fx), expected_count: 5 })).pass).toBe(false);
    const b = clean(fx);
    expect(checkResponseCountMatches(y({ ...b, responses: b.responses.slice(1) })).pass).toBe(false);
  });
});

describe('checkRequiredAnswersPresent', () => {
  test('passes when only the flagged persona skips a required answer', () => {
    expect(checkRequiredAnswersPresent(y(clean(fx))).pass).toBe(true);
  });
  test('fails on an unflagged blank, and on a missing_answer flag that answers everything', () => {
    const unflagged = clean(fx);
    unflagged.roster[1].flags = [];
    expect(checkRequiredAnswersPresent(y(unflagged)).pass).toBe(false);
    const lying = clean(fx);
    lying.roster[0].flags = ['missing_answer'];
    expect(checkRequiredAnswersPresent(y(lying)).pass).toBe(false);
  });
});

describe('checkWinnerBoundToLloOrg', () => {
  test('passes on the response created with llo_entity_id + Connect org_id (1000049)', () => {
    expect(checkWinnerBoundToLloOrg(y(clean(fx))).pass).toBe(true);
  });
  test('fails on the probe response created without org_id (1000048)', () => {
    const b = clean(fx);
    b.responses[2] = { ...fx.responses.bound_winner_without_org_id };
    b.roster[2].response_id = fx.responses.bound_winner_without_org_id.id;
    expect(checkWinnerBoundToLloOrg(y(b)).pass).toBe(false);
  });
  test('fails when the org_id is the labs pk instead of the Connect id', () => {
    const b = clean(fx);
    b.responses[2] = { ...b.responses[2], org_id: String(fx.labs_orgs.winner_standin.labs_id) };
    expect(checkWinnerBoundToLloOrg(y(b)).pass).toBe(false);
  });
  test('fails with zero or two winners', () => {
    const none = clean(fx);
    none.roster[2].winner = false;
    expect(checkWinnerBoundToLloOrg(y(none)).pass).toBe(false);
    const two = clean(fx);
    two.roster[0].winner = true;
    expect(checkWinnerBoundToLloOrg(y(two)).pass).toBe(false);
  });
});

describe('checkNoRealOrgCollision', () => {
  test('passes on suffixed fictional names', () => {
    expect(checkNoRealOrgCollision(y(clean(fx))).pass).toBe(true);
  });
  test('fails when a fictional respondent is named after a real partner', () => {
    const b = clean(fx);
    b.responses[0] = { ...b.responses[0], org_name: 'Spark Microgrants [Synthetic]' };
    expect(checkNoRealOrgCollision(y(b)).pass).toBe(false);
  });
  test('fails when the [Synthetic] suffix is dropped', () => {
    const b = clean(fx);
    b.responses[0] = { ...b.responses[0], org_name: 'Probe Alpha Collective' };
    expect(checkNoRealOrgCollision(y(b)).pass).toBe(false);
  });
});

describe('checkNoDenyListParty', () => {
  test('passes when no response names a deny-listed party', () => {
    expect(checkNoDenyListParty(y(clean(fx))).pass).toBe(true);
  });
  test('fails when an answer names one, in either spelling', () => {
    const spaced = clean(fx);
    spaced.responses[0] = { ...spaced.responses[0], responses: { q_org: 'We delivered cash with Give Directly', q_fte: '4' } };
    expect(checkNoDenyListParty(y(spaced)).pass).toBe(false);
    const joined = clean(fx);
    joined.responses[2] = { ...joined.responses[2], responses: { q_org: 'Past GiveDirectly partner', q_fte: '60' } };
    expect(checkNoDenyListParty(y(joined)).pass).toBe(false);
  });
});

describe('checkSolicitationStillPrivate', () => {
  test('passes on the probe call (is_public: false)', () => {
    expect(checkSolicitationStillPrivate(y(clean(fx))).pass).toBe(true);
  });
  test('fails on a listed call', () => {
    expect(checkSolicitationStillPrivate(y({ ...clean(fx), solicitation: { id: 1, is_public: true } })).pass).toBe(false);
  });
});

describe('checkSyntheticEmailsOnly', () => {
  test('passes on ACE +synthetic-<n> addresses', () => {
    expect(checkSyntheticEmailsOnly(y(clean(fx))).pass).toBe(true);
  });
  test('fails on a made-up third-party address', () => {
    const b = clean(fx);
    b.responses[0] = { ...b.responses[0], submitted_by_email: 'director@lakebasin.org' };
    expect(checkSyntheticEmailsOnly(y(b)).pass).toBe(false);
  });
});

describe('CHECKS', () => {
  test('an unreadable bundle fails every check rather than passing vacuously', () => {
    for (const c of CHECKS) expect((c.run('not: [valid') as { pass: boolean }).pass).toBe(false);
  });
});
