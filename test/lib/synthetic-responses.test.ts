import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCreateResponsePayloads,
  findDenyListHits,
  findRealOrgCollision,
  foldName,
  normalizeDenyList,
  partitionAgainstExisting,
  SeedPlanValidationError,
  syntheticEmail,
  validateSeedPlan,
  type SeedPlanInput,
  type SyntheticPersona,
} from '../../lib/synthetic-responses';

const QUESTIONS = [
  { id: 'q_org', required: true },
  { id: 'q_fte', required: true },
  { id: 'q_budget', required: false },
];

function persona(over: Partial<SyntheticPersona> = {}): SyntheticPersona {
  return {
    key: 'strong',
    org_name: 'Lake Basin Outreach [Synthetic]',
    intended_profile: 'strong fit',
    answers: { q_org: 'We work in two districts.', q_fte: '40', q_budget: '20000' },
    submitted_by_name: 'Programme lead (synthetic)',
    submission_date: '2026-10-18T10:00:00Z',
    ...over,
  };
}

const WINNER = persona({
  key: 'winner',
  org_name: 'ace-nm-org',
  winner: { llo_entity_id: 'ace-nm-org', connect_org_id: 387 },
});

function plan(personas: SyntheticPersona[], over: Partial<SeedPlanInput> = {}): SeedPlanInput {
  return {
    solicitation_id: 1000003,
    questions: QUESTIONS,
    personas,
    count: personas.length,
    mailbox: 'ace@dimagi-ai.com',
    real_org_names: ['Spark Microgrants', 'Trickle Up', 'KADSIPA', 'ace-nm-org'],
    deny_list: ['GiveDirectly', 'Give Directly', 'GD'],
    ...over,
  };
}

const codes = (p: SeedPlanInput) => validateSeedPlan(p).map((e) => e.code);

describe('helpers', () => {
  it('folds punctuation and case', () => {
    expect(foldName('Give-Directly, Inc.')).toBe('give directly inc');
  });

  it('tags ACE\'s own mailbox', () => {
    expect(syntheticEmail('ace@dimagi-ai.com', 3)).toBe('ace+synthetic-3@dimagi-ai.com');
    expect(syntheticEmail('ace+old@dimagi-ai.com', 1)).toBe('ace+synthetic-1@dimagi-ai.com');
    expect(() => syntheticEmail('not-an-address', 1)).toThrow();
  });

  it('matches deny-list terms on whole words and joined spellings', () => {
    expect(findDenyListHits('We partnered with GiveDirectly before', ['Give Directly'])).toEqual(['Give Directly']);
    expect(findDenyListHits('GD\'s pilot', ['GD'])).toEqual(['GD']);
    expect(findDenyListHits('our budget is modest', ['GD'])).toEqual([]);
    expect(findDenyListHits('give directly', ['GiveDirectly'])).toEqual(['GiveDirectly']);
  });

  it('finds real-org collisions after stripping the suffix', () => {
    expect(findRealOrgCollision('Spark Microgrants [Synthetic]', ['Spark Microgrants'])).toBe('Spark Microgrants');
    expect(findRealOrgCollision('Spark Microgrants Uganda [Synthetic]', ['Spark Microgrants'])).toBe('Spark Microgrants');
    expect(findRealOrgCollision('Lake Basin Outreach [Synthetic]', ['Spark Microgrants'])).toBeNull();
  });

  it('parses and de-duplicates the per-opp deny list', () => {
    expect(normalizeDenyList(['GiveDirectly', ' givedirectly ', 'GD'])).toEqual(['GiveDirectly', 'GD']);
    expect(normalizeDenyList(undefined)).toEqual([]);
    expect(() => normalizeDenyList('GD')).toThrow();
  });
});

describe('validateSeedPlan', () => {
  it('accepts a well-formed plan (positive control)', () => {
    const p = plan([
      persona(),
      persona({ key: 'missing', org_name: 'Hill Country Forum [Synthetic]', flags: ['missing_answer'], answers: { q_org: 'x' } }),
      WINNER,
    ]);
    expect(validateSeedPlan(p)).toEqual([]);
  });

  it('refuses a fictional name without the suffix', () => {
    expect(codes(plan([persona({ org_name: 'Lake Basin Outreach' }), WINNER]))).toContain('MISSING_SUFFIX');
  });

  it('refuses impersonating a real partner', () => {
    expect(codes(plan([persona({ org_name: 'Trickle Up [Synthetic]' }), WINNER]))).toContain('REAL_ORG_COLLISION');
  });

  it('refuses a deny-listed party in any LLO-facing text', () => {
    const p = plan([persona({ answers: { q_org: 'We ran cash transfers with GiveDirectly.', q_fte: '3' } }), WINNER]);
    expect(codes(p)).toContain('DENY_LIST_HIT');
  });

  it('refuses an unanswered required question unless flagged, and a flag that lies', () => {
    expect(codes(plan([persona({ answers: { q_org: 'x' } }), WINNER]))).toContain('UNANSWERED_REQUIRED');
    expect(codes(plan([persona({ flags: ['missing_answer'] }), WINNER]))).toContain('MISSING_ANSWER_NOT_MISSING');
  });

  it('requires exactly one bound winner', () => {
    expect(codes(plan([persona()]))).toContain('WINNER_COUNT');
    expect(codes(plan([persona(), { ...WINNER, winner: { llo_entity_id: 'ace-nm-org', connect_org_id: 'ace-nm-org' } }]))).toContain(
      'WINNER_UNBOUND',
    );
    expect(codes(plan([persona(), { ...WINNER, flags: ['missing_answer'], answers: { q_org: 'x' } }]))).toContain(
      'WINNER_MISSING_ANSWER',
    );
  });

  it('refuses count drift, unknown questions, duplicate names', () => {
    expect(codes(plan([persona(), WINNER], { count: 5 }))).toContain('COUNT_MISMATCH');
    expect(codes(plan([persona({ answers: { q_org: 'x', q_fte: '1', q_nope: 'y' } }), WINNER]))).toContain('UNKNOWN_QUESTION');
    expect(codes(plan([persona(), persona({ key: 'b', org_name: 'lake basin outreach [Synthetic]' }), WINNER]))).toContain(
      'DUPLICATE_NAME',
    );
  });
});

describe('buildCreateResponsePayloads', () => {
  it('builds tagged emails and binds the winner the way labs needs (K1)', () => {
    const payloads = buildCreateResponsePayloads(plan([persona(), WINNER]));
    expect(payloads[0]).toMatchObject({
      org_name: 'Lake Basin Outreach [Synthetic]',
      submitted_by_email: 'ace+synthetic-1@dimagi-ai.com',
      status: 'submitted',
    });
    expect(payloads[0].llo_entity_id).toBeUndefined();
    expect(payloads[1]).toMatchObject({ llo_entity_id: 'ace-nm-org', org_id: '387', org_name: 'ace-nm-org' });
  });

  it('marks every seeded response synthetic, the winner included (ace#3257)', () => {
    // Labs gives an own-side response a demonstration award only when it was
    // created synthetic; the marker cannot be added later.
    const payloads = buildCreateResponsePayloads(plan([persona(), WINNER]));
    expect(payloads.every((p) => p.synthetic === true)).toBe(true);
  });

  it('re-files a winner whose existing response predates the marker, never a fictional one', () => {
    const payloads = buildCreateResponsePayloads(plan([persona(), WINNER]));
    const existing = payloads.map((p, i) => ({
      id: 100 + i,
      org_name: p.org_name,
      submitted_by_email: p.submitted_by_email,
      synthetic: false,
    }));
    const { create, skip } = partitionAgainstExisting(payloads, existing);
    expect(create.map((p) => p.llo_entity_id)).toEqual(['ace-nm-org']);
    expect(skip.map((s) => s.response_id)).toEqual([100]);
    // A marked winner is skipped as before.
    const marked = existing.map((r) => ({ ...r, synthetic: true }));
    expect(partitionAgainstExisting(payloads, marked).create).toHaveLength(0);
  });

  it('throws a typed error on an invalid plan', () => {
    expect(() => buildCreateResponsePayloads(plan([persona()]))).toThrow(SeedPlanValidationError);
  });
});

describe('captured live probe (2026-10-18, spec § K1)', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'labs', 'seed-responses-probe-2026-10-18.json'), 'utf-8'),
  );

  it('award_response.org_id is the Connect integer id, never the labs pk or slug', () => {
    const { winner_standin } = fixture.labs_orgs;
    const built = buildCreateResponsePayloads(
      plan([
        persona(),
        { ...WINNER, winner: { llo_entity_id: winner_standin.slug, connect_org_id: winner_standin.connect_organization_id } },
      ]),
    )[1];
    expect(built.org_id).toBe(fixture.responses.bound_winner_with_org_id.org_id);
    expect(built.org_id).not.toBe(String(winner_standin.labs_id));
    expect(built.org_id).not.toBe(winner_standin.slug);
  });

  it('a bound response created without org_id reads back empty, so the builder always sends it', () => {
    expect(fixture.responses.bound_winner_without_org_id.org_id).toBe('');
  });

  it('owner seeding allows duplicates, so partitionAgainstExisting skips re-runs', () => {
    const payloads = buildCreateResponsePayloads(plan([persona({ org_name: 'Probe Alpha Collective [Synthetic]' }), WINNER]));
    const existing = Object.values(fixture.responses) as { id: number; org_name: string; submitted_by_email?: string }[];
    const { create, skip } = partitionAgainstExisting(payloads, existing);
    expect(skip.map((s) => s.response_id)).toContain(fixture.responses.free_named.id);
    expect(skip.map((s) => s.response_id)).toContain(fixture.responses.bound_winner_with_org_id.id);
    expect(create).toHaveLength(0);
  });
});
