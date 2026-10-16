/**
 * Residual → confirm-ask synthesis must not leak fixer prose onto the
 * reviewer page (ace#2996).
 *
 * Repro: dimagi-team/noora-health/20261015-1129. Two of the 18 confirm rows
 * on the anonymous run-summary page were synthesized from phase residuals
 * and carried (a) the residual's `where_to_apply` ("Nova review on both
 * apps (hau, Latin script).") as the "Why confirm" line, and (b) the same
 * `what` text twice, once as `plain` ("Open question: …") and once as
 * `plain_question` ("How should this be handled: …?").
 */

import { describe, expect, it } from 'vitest';
import { deriveReviewAsks, openResiduals, RESIDUAL_PLAIN, RESIDUAL_REASON } from '../../lib/decisions-enrich';

const HAUSA_WHAT =
  'Hausa text in both apps (including the Deliver consent script) is ACE-authored and needs native-speaker review; the Learn fail message inserts English module names; Connect shows module names in English';
const HAUSA_WHERE = 'Nova review on both apps (hau, Latin script).';

function runState(residual: Record<string, unknown>) {
  return { phases: { 'commcare-setup': { status: 'done', residuals: [residual] } } };
}

function residualAsk(rs: unknown) {
  const asks = deriveReviewAsks(rs, []).filter((a) => a.basis.endsWith('residual'));
  expect(asks).toHaveLength(1);
  return asks[0];
}

describe('residual confirm asks (ace#2996)', () => {
  it('never uses where_to_apply as the "Why confirm" reason', () => {
    const ask = residualAsk(runState({ what: HAUSA_WHAT, where_to_apply: HAUSA_WHERE }));
    expect(ask.reason).toBe(RESIDUAL_REASON);
    expect(ask.reason).not.toContain('Nova review');
    expect(ask.synthesize?.confirm_reason ?? ask.reason).not.toContain('hau');
  });

  it('still derives a named-owner reason from where_to_apply (it is mined, not copied)', () => {
    const ask = residualAsk(
      runState({ what: 'Whole-group photo refusal has no recording path', where_to_apply: 'design decision for Spark / the implementing organisation.' }),
    );
    expect(ask.reason).toMatch(/^Only Spark and the implementing organisation can decide/);
  });

  it('does not emit plain and plain_question with the same content', () => {
    const ask = residualAsk(runState({ what: HAUSA_WHAT, where_to_apply: HAUSA_WHERE }));
    expect(ask.plain).toBe(RESIDUAL_PLAIN);
    expect(ask.plainQuestion).toContain('Hausa text');
    expect(ask.plain).not.toContain('Hausa text');
    expect(ask.synthesize?.plain).toBe(RESIDUAL_PLAIN);
    expect(ask.synthesize?.plain_question).toBe(ask.plainQuestion);
  });

  it("prefers the residual's own reviewer-facing plain wording over its fixer prose", () => {
    const rs = runState({
      what: HAUSA_WHAT,
      where_to_apply: HAUSA_WHERE,
      plain: 'The Hausa wording in both apps was written by the build and has not been checked by a native speaker.',
    });
    expect(openResiduals(rs)[0].plain).toMatch(/^The Hausa wording/);
    const ask = residualAsk(rs);
    expect(ask.plainQuestion).toBe(
      'How should this be handled: The Hausa wording in both apps was written by the build and has not been checked by a native speaker?',
    );
    expect(ask.plainQuestion).not.toContain('ACE-authored');
  });
});
