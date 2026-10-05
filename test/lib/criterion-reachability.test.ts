/**
 * ace#2670 — multi-day criteria are declared, recorded NOT REACHED, and
 * scored as not-reached (never pass, never the didn't-finish fail).
 *
 * The positive control is the as-built spark-facilitator Community Meeting
 * Record `date_of_meeting` validate, read live 2026-10-05 via Nova get_field
 * (quoted verbatim in the issue). The negatives are the near-misses a loose
 * regex would mis-classify: `>=` (same-day allowed), no today() cap, and a
 * `>` against today() itself rather than a prior record.
 */
import { describe, it, expect } from 'vitest';
import {
  detectMultiDayDateConstraint,
  normalizeCriterion,
  reconcileNotReached,
  capJourneyCompletion,
  notReachedGateLines,
  JOURNEY_COMPLETION_NOT_REACHED_CAP,
} from '../../lib/criterion-reachability';

const SPARK_DATE_OF_MEETING =
  ". <= today() and . >= today() - 1096 and (#form/enrolment_date_ref = '' or . >= date(#form/enrolment_date_ref)) and (#form/prev_meeting_date = '' or . > date(#form/prev_meeting_date))";

describe('detectMultiDayDateConstraint', () => {
  it('flags the spark-facilitator date_of_meeting validate (positive control)', () => {
    const r = detectMultiDayDateConstraint(SPARK_DATE_OF_MEETING);
    expect(r).toEqual({ strictlyIncreasing: true, cappedAtToday: true, multiDay: true });
  });

  it('does NOT flag >= against the previous record (same-day records allowed)', () => {
    expect(
      detectMultiDayDateConstraint('. <= today() and . >= date(#form/prev_meeting_date)').multiDay,
    ).toBe(false);
  });

  it('does NOT flag a strictly-increasing date with no today() cap (forward-datable)', () => {
    const r = detectMultiDayDateConstraint('. > date(#form/prev_meeting_date)');
    expect(r.strictlyIncreasing).toBe(true);
    expect(r.cappedAtToday).toBe(false);
    expect(r.multiDay).toBe(false);
  });

  it('does NOT treat `. > today()` or `. >= today() - N` as a prior-record ordering', () => {
    expect(detectMultiDayDateConstraint('. <= today() and . >= today() - 1096').multiDay).toBe(false);
    expect(detectMultiDayDateConstraint('. > today() - 30 and . <= today()').multiDay).toBe(false);
  });

  it('accepts the /data/ path form and the reversed today() >= . cap', () => {
    expect(
      detectMultiDayDateConstraint('today() >= . and . > /data/prev_visit_date').multiDay,
    ).toBe(true);
  });

  it('empty / missing validate is never multi-day', () => {
    expect(detectMultiDayDateConstraint('').multiDay).toBe(false);
    expect(detectMultiDayDateConstraint(undefined).multiDay).toBe(false);
  });
});

describe('normalizeCriterion', () => {
  it('a bare string is single-session', () => {
    expect(normalizeCriterion('submission_confirmed')).toEqual({
      name: 'submission_confirmed',
      reachability: 'single-session',
    });
  });

  it('the mapping form carries reachability + reason', () => {
    expect(
      normalizeCriterion({
        name: 'fourth_meeting_labelled_not_paid',
        reachability: 'multi-day',
        reason: 'needs 4 meetings on one case; date_of_meeting > prev and <= today()',
      }),
    ).toEqual({
      name: 'fourth_meeting_labelled_not_paid',
      reachability: 'multi-day',
      reason: 'needs 4 meetings on one case; date_of_meeting > prev and <= today()',
    });
  });

  it('refuses a multi-day declaration with no reason (spacing advice is not a declaration)', () => {
    expect(() => normalizeCriterion({ name: 'x', reachability: 'multi-day' })).toThrow(/reason/);
  });

  it('refuses an unknown reachability value', () => {
    expect(() =>
      normalizeCriterion({ name: 'x', reachability: 'someday' as never, reason: 'r' }),
    ).toThrow(/reachability/);
  });
});

describe('reconcileNotReached', () => {
  const criteria = [
    'app_boots',
    'meeting_1_saved',
    {
      name: 'fourth_meeting_labelled_not_paid',
      reachability: 'multi-day' as const,
      reason: 'needs 4 dated meetings on one community',
    },
  ];

  it('an ungraded multi-day criterion is NOT REACHED with its catalog reason', () => {
    const r = reconcileNotReached(criteria, ['app_boots', 'meeting_1_saved']);
    expect(r.notReached).toEqual([
      {
        criterion: 'fourth_meeting_labelled_not_paid',
        reason: 'reachability: multi-day — needs 4 dated meetings on one community',
      },
    ]);
    expect(r.unaccounted).toEqual([]);
  });

  it('a multi-day criterion reached on successive days and graded is NOT listed', () => {
    const r = reconcileNotReached(criteria, [
      'app_boots',
      'meeting_1_saved',
      'fourth_meeting_labelled_not_paid',
    ]);
    expect(r.notReached).toEqual([]);
    expect(r.unaccounted).toEqual([]);
  });

  it('an ungraded single-session criterion with a stated reason is NOT REACHED', () => {
    const r = reconcileNotReached(criteria, ['app_boots'], [
      { criterion: 'meeting_1_saved', reason: 'leg blocked: picker surface outside palette' },
    ]);
    expect(r.notReached.map((n) => n.criterion)).toEqual([
      'meeting_1_saved',
      'fourth_meeting_labelled_not_paid',
    ]);
    expect(r.unaccounted).toEqual([]);
  });

  it('an ungraded criterion with no reason and no declaration is UNACCOUNTED (the silent drop)', () => {
    const r = reconcileNotReached(criteria, ['app_boots']);
    expect(r.unaccounted).toEqual(['meeting_1_saved']);
  });
});

describe('capJourneyCompletion', () => {
  it('caps at 2 when anything is NOT REACHED, never below what was scored', () => {
    expect(JOURNEY_COMPLETION_NOT_REACHED_CAP).toBe(2);
    expect(capJourneyCompletion(5, [{ criterion: 'x', reason: 'r' }])).toBe(2);
    expect(capJourneyCompletion(1, [{ criterion: 'x', reason: 'r' }])).toBe(1);
    expect(capJourneyCompletion(5, [])).toBe(5);
  });

  it('a NOT REACHED criterion is never scored as the didn\'t-finish 0', () => {
    expect(capJourneyCompletion(5, [{ criterion: 'x', reason: 'r' }])).toBeGreaterThan(0);
  });
});

describe('notReachedGateLines (llo-launch surfacing)', () => {
  it('names every NOT REACHED criterion from a verdict, flattened or per_item', () => {
    const lines = notReachedGateLines({
      verdict: 'pass',
      per_item: [
        {
          ref: 'journey-deliver-followup-preload',
          not_reached: [{ criterion: 'savings_shown_only_from_step_5', reason: 'multi-day' }],
        },
      ],
      not_reached: [
        { journey: 'journey-deliver-over-cap', criterion: 'fourth_meeting_labelled_not_paid', reason: 'multi-day' },
      ],
    });
    expect(lines).toEqual([
      '[WARN] journey-deliver-over-cap: fourth_meeting_labelled_not_paid NOT REACHED (multi-day)',
      '[WARN] journey-deliver-followup-preload: savings_shown_only_from_step_5 NOT REACHED (multi-day)',
    ]);
  });

  it('de-duplicates an entry present in both places', () => {
    const lines = notReachedGateLines({
      per_item: [{ ref: 'j', not_reached: [{ criterion: 'c', reason: 'r' }] }],
      not_reached: [{ journey: 'j', criterion: 'c' }],
    });
    expect(lines).toEqual(['[WARN] j: c NOT REACHED (r)']);
  });

  it('a verdict with nothing unreached yields no lines', () => {
    expect(notReachedGateLines({ verdict: 'pass', not_reached: [] })).toEqual([]);
    expect(notReachedGateLines({})).toEqual([]);
  });
});
