/**
 * dimagi-internal/ace#1015 — two required questions capturing the same
 * real-world value, on one walk path, with INCOMPATIBLE constraints.
 *
 * spark-facilitator/20260728-1338, Deliver app 67ec398d, form
 * `record_a_community_meeting`. The `savings` group carries no `relevant`, so
 * it displays on BOTH branches of `meeting_conducted`. On the did-not-happen
 * branch the CBF is asked, in order:
 *
 *   meeting_did_not_happen/reschedule_date  "On what date will the meeting now
 *                                            be held?"     . >= today()
 *   savings/next_meeting_date               "On what date is the next meeting
 *                                            planned?"     . > today() and . <= today() + 30
 *
 * Same value, asked twice. A CBF who reschedules for TODAY satisfies the first
 * and is hard-blocked on the second, with no way to reconcile — and this is
 * exactly the branch the PDD requires to be "reachable without friction" (a
 * CBF honestly reporting a meeting that did not happen is doing the right
 * thing).
 *
 * All three existing field_answerability hard-gates correctly PASS: no
 * outcome-before-inputs, every constraint references `.` with a local
 * validate_msg, every relevance references an earlier field. The defect is a
 * class the dimension does not name — and it is only unsatisfiable at the
 * EDGE (`= today()`), which is why per-field analysis and a happy-path smoke
 * walk both miss it.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTodayRelativeConstraint,
  intersectRanges,
  checkPairSatisfiable,
} from '../../lib/constraint-satisfiability.js';

describe('parseTodayRelativeConstraint', () => {
  it('reads the two live constraints', () => {
    expect(parseTodayRelativeConstraint('. >= today()')).toEqual({ kind: 'range', min: 0, max: null });
    expect(parseTodayRelativeConstraint('. > today() and . <= today() + 30')).toEqual({
      kind: 'range', min: 1, max: 30,
    });
  });

  it('handles the mirrored forms and whitespace', () => {
    expect(parseTodayRelativeConstraint('.<today()')).toEqual({ kind: 'range', min: null, max: -1 });
    expect(parseTodayRelativeConstraint('. <= today()')).toEqual({ kind: 'range', min: null, max: 0 });
    expect(parseTodayRelativeConstraint('. >= today() - 7')).toEqual({ kind: 'range', min: -7, max: null });
  });

  it('reports UNPARSED rather than claiming a range it did not understand', () => {
    for (const c of ['. >= /data/other_date', 'count(.) > 0', '']) {
      expect(parseTodayRelativeConstraint(c).kind, c).toBe('unparsed');
    }
  });
});

describe('intersectRanges', () => {
  it('finds the empty intersection in the live pair', () => {
    expect(intersectRanges({ kind: 'range', min: 0, max: 0 }, { kind: 'range', min: 1, max: 30 })).toBeNull();
  });

  it('keeps a non-empty overlap', () => {
    expect(intersectRanges({ kind: 'range', min: 0, max: null }, { kind: 'range', min: 1, max: 30 }))
      .toEqual({ kind: 'range', min: 1, max: 30 });
  });

  it('treats a single shared day as satisfiable', () => {
    expect(intersectRanges({ kind: 'range', min: null, max: 1 }, { kind: 'range', min: 1, max: 30 }))
      .toEqual({ kind: 'range', min: 1, max: 1 });
  });
});

describe('checkPairSatisfiable (#1015)', () => {
  const reschedule = { id: 'meeting_did_not_happen/reschedule_date', required: true, constraint: '. >= today()' };
  const nextMeeting = { id: 'savings/next_meeting_date', required: true, constraint: '. > today() and . <= today() + 30' };

  it('does NOT flag the pair — both ranges overlap from tomorrow on', () => {
    // The full ranges DO intersect ([1,30]); the trap is only at the edge the
    // worker is free to choose. So the finding is the narrowed range, stated,
    // not a false "unsatisfiable".
    const r = checkPairSatisfiable(reschedule, nextMeeting);
    expect(r.satisfiable).toBe(true);
    expect(r.narrowed).toBe(true);
    expect(r.detail).toMatch(/today/i);
  });

  it('flags a genuinely empty intersection as unsatisfiable', () => {
    const r = checkPairSatisfiable(
      { id: 'a', required: true, constraint: '. <= today()' },
      { id: 'b', required: true, constraint: '. > today()' },
    );
    expect(r.satisfiable).toBe(false);
    expect(r.detail).toMatch(/no date satisfies both/i);
  });

  it('says UNKNOWN when either side is unparsed, instead of passing it', () => {
    const r = checkPairSatisfiable(reschedule, { id: 'b', required: true, constraint: 'count(.) > 0' });
    expect(r.satisfiable).toBe('unknown');
  });

  it('ignores a pair where either field is optional — the collision is with REQUIREDNESS', () => {
    const r = checkPairSatisfiable(reschedule, { ...nextMeeting, required: false });
    expect(r.satisfiable).toBe('not-applicable');
  });
});
