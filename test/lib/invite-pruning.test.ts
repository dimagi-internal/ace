/**
 * dimagi-internal/ace#1289 — the ACE test user accumulates a Connect invite
 * per `/ace:run` forever, and unclaimed opportunities render under a "New
 * Opportunities" section header that sits BELOW the entire "In Progress"
 * section. On the dogfood device In Progress is ~20 cards deep (~25 tiles),
 * so the target tile is ~6 full viewport scrolls down and both tile-finding
 * scrolls time out.
 *
 * `connect-resume-opp.yaml` never received the #647 recalibration at all
 * (`timeout: 20000`, `visibilityPercentage: 60`, default speed) and blocks the
 * Deliver leg exactly as the claim recipe blocks the Learn leg.
 *
 * The issue names the class-level fix and says why a recalibration is not one:
 *
 * > A recalibration alone will expire again the same way — the list grows
 * > every run.
 *
 * So this is the half that does not touch the device: stop making a fixed
 * scroll budget carry unbounded growth by pruning the test user's invites on
 * PRIOR-RUN opportunities. The budget changes are device-truth and stay out.
 *
 * The safety property is the whole design: NEVER delete the current run's
 * invite. Doing so would break the very run doing the pruning — a far worse
 * failure than the slow scroll it is fixing.
 */
import { describe, it, expect } from 'vitest';
import { selectPrunableInvites } from '../../lib/invite-pruning.js';

const invite = (over: Record<string, unknown> = {}) => ({
  id: 1,
  opportunity_id: 'opp-old-1',
  status: 'invited',
  phone_number: '+7426000100',
  ...over,
});

describe('selectPrunableInvites (#1289)', () => {
  it('prunes prior-run invites for the test user', () => {
    const r = selectPrunableInvites({
      invites: [
        invite({ id: 1, opportunity_id: 'opp-old-1' }),
        invite({ id: 2, opportunity_id: 'opp-old-2' }),
      ],
      currentOpportunityId: 'opp-current',
    });
    expect(r.byOpportunity).toEqual({ 'opp-old-1': [1], 'opp-old-2': [2] });
    expect(r.excluded).toEqual([]);
  });

  it('NEVER prunes the current run\'s invite — that would break this run', () => {
    const r = selectPrunableInvites({
      invites: [invite({ id: 9, opportunity_id: 'opp-current' }), invite({ id: 1 })],
      currentOpportunityId: 'opp-current',
    });
    expect(r.byOpportunity).toEqual({ 'opp-old-1': [1] });
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ id: 9, reason: 'current-run' });
  });

  it('never prunes an ACCEPTED invite — that is a real worker', () => {
    const r = selectPrunableInvites({
      invites: [invite({ id: 5, status: 'accepted' }), invite({ id: 6 })],
      currentOpportunityId: 'opp-current',
    });
    expect(r.byOpportunity).toEqual({ 'opp-old-1': [6] });
    expect(r.excluded[0]).toMatchObject({ id: 5, reason: 'accepted' });
  });

  it('refuses to run at all without a current opportunity id', () => {
    expect(() =>
      selectPrunableInvites({ invites: [invite()], currentOpportunityId: '' }),
    ).toThrow(/currentOpportunityId/);
  });

  it('scopes to the ACE test user when a phone number is given', () => {
    const r = selectPrunableInvites({
      invites: [
        invite({ id: 1, phone_number: '+7426000100' }),
        invite({ id: 2, phone_number: '+265999888777', opportunity_id: 'opp-old-2' }),
      ],
      currentOpportunityId: 'opp-current',
      testUserPhone: '+7426000100',
    });
    expect(r.byOpportunity).toEqual({ 'opp-old-1': [1] });
    expect(r.excluded[0]).toMatchObject({ id: 2, reason: 'not-test-user' });
  });

  it('is a no-op when there is nothing but the current run', () => {
    const r = selectPrunableInvites({
      invites: [invite({ id: 9, opportunity_id: 'opp-current' })],
      currentOpportunityId: 'opp-current',
    });
    expect(r.byOpportunity).toEqual({});
    expect(r.total).toBe(0);
  });

  it('reports the totals a skill logs', () => {
    const r = selectPrunableInvites({
      invites: [invite({ id: 1 }), invite({ id: 2, opportunity_id: 'opp-old-2' }), invite({ id: 3, opportunity_id: 'opp-current' })],
      currentOpportunityId: 'opp-current',
    });
    expect(r.total).toBe(2);
    expect(r.opportunityCount).toBe(2);
  });
});
