/**
 * dimagi-internal/ace#1327 — the Deliver branch of `app-connect-coverage`
 * Step 2 keyed the expected Connect block off the form's TYPE.
 *
 * The Learn branch of the same step already states the correct rule, in
 * these words: "a `user_score` + selects shape does NOT by itself mean the
 * form is the gate — a baseline pre-test has exactly the same shape …
 * **Decide by role, not by shape**". An unpaid registration form is to
 * `deliver_unit` exactly as a pre-test is to `assessment`: same shape as the
 * paid thing, must not be marked. (ace#1131 is the Learn-side instance,
 * already fixed; this is its Deliver-side sibling.)
 *
 * Two failures fell out of the type-keyed table on bednet-check-2-visit,
 * whose PDD operating rule R2 is "Only the follow-up visit is paid;
 * registration is not" — a requirement, taught in the Learn app and tested
 * by an item in the gating assessment:
 *
 *  1. The damaging half. The registration form is `type: registration`, so
 *     the table expected `deliver_unit`, observed none, classified `missing`
 *     and Step 4 would FIX it — adding a deliver_unit to a form the PDD says
 *     is never payable, after which Phase 4 can wire a payment unit and the
 *     program pays for the stage it explicitly does not pay for. The repair
 *     path is `configure_connect`, which is REPLACE-ALL, so the wrong
 *     expectation rewrites the whole participant set.
 *  2. The silent half. The paid form here is `type: close` (it updates and
 *     closes the household case) and no row covers `close`, so it fell to
 *     "otherwise → LLM judgment, default deliver_unit". Right answer, by
 *     defaulting rather than by knowing — and the same default produces
 *     failure 1 in reverse when the roles are swapped.
 */
import { describe, it, expect } from 'vitest';

import {
  decideDeliverExpectations,
  classifyDeliverObservation,
} from '../../../skills/app-connect-coverage/deliver-expectations.js';

const registration = { uuid: 'r1', name: 'Household Registration', type: 'registration', hasInputs: true };
const closeForm = { uuid: 'c1', name: 'Stage 2 Follow-up', type: 'close', hasInputs: true };

describe('decideDeliverExpectations (#1327)', () => {
  it('the bednet shape: unpaid registration + paid close form', () => {
    const d = decideDeliverExpectations([
      { ...registration, pddRole: 'not-payable' },
      { ...closeForm, pddRole: 'payable' },
    ]);
    expect(d.map((x) => [x.uuid, x.expected])).toEqual([
      ['r1', 'none'],
      ['c1', 'deliver_unit'],
    ]);
    expect(d.every((x) => x.basis === 'pdd-role')).toBe(true);
  });

  it('the inverse fixture proves it reads ROLE, not type', () => {
    const d = decideDeliverExpectations([
      { ...registration, pddRole: 'payable' },
      { ...closeForm, pddRole: 'not-payable' },
    ]);
    expect(d.map((x) => [x.uuid, x.expected])).toEqual([
      ['r1', 'deliver_unit'],
      ['c1', 'none'],
    ]);
  });

  it('falls back to the type heuristic only when the PDD is silent, and SAYS it fell back', () => {
    const d = decideDeliverExpectations([registration, closeForm]);
    expect(d[0]).toMatchObject({ expected: 'deliver_unit', basis: 'type-heuristic', fellBack: true });
    expect(d[1]).toMatchObject({ expected: 'deliver_unit', basis: 'llm-judgment', fellBack: true });
  });

  it('a label-only survey is a task, not a delivery', () => {
    const d = decideDeliverExpectations([
      { uuid: 's1', name: 'Read this', type: 'survey', hasInputs: false },
    ]);
    expect(d[0]).toMatchObject({ expected: 'task', basis: 'type-heuristic' });
  });

  it('every decision explains itself — the report has to be auditable', () => {
    for (const d of decideDeliverExpectations([{ ...registration, pddRole: 'not-payable' }, closeForm])) {
      expect(d.why.length).toBeGreaterThan(20);
    }
  });
});

describe('classifyDeliverObservation (#1327)', () => {
  it('a deliver_unit on a form the PDD says is unpaid is EXTRA — remove it, never call it a match', () => {
    expect(classifyDeliverObservation('none', 'deliver_unit')).toBe('extra');
  });

  it('an absent deliver_unit on an unpaid form is a match, not a gap to fix', () => {
    expect(classifyDeliverObservation('none', 'none')).toBe('match');
  });

  it('still reports a genuinely missing deliver_unit on a payable form', () => {
    expect(classifyDeliverObservation('deliver_unit', 'none')).toBe('missing');
  });

  it('reports a wrong block type rather than silently accepting it', () => {
    expect(classifyDeliverObservation('deliver_unit', 'task')).toBe('wrong');
    expect(classifyDeliverObservation('task', 'deliver_unit')).toBe('wrong');
  });
});
