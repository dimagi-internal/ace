/**
 * Tests for `lib/date-default-validate.ts` — the ace#1081 static preventer.
 *
 * The CommCare date widget defaults to today and the connect-2.63.2 selector
 * map has no calibrated date-widget row, so a required date question is only
 * smoke-walkable when today satisfies its `validate` expression. These tests
 * pin the exact expressions from the spark-facilitator/20260730-1718 Deliver
 * app (the run that surfaced the class) as the calibration set.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateValidateWithTodayDefault,
  checkDateDefaultValidate,
  formatDateDefaultValidateReport,
} from '../../lib/date-default-validate.js';

describe('evaluateValidateWithTodayDefault', () => {
  it('passes `. <= today()` (past-or-today constraint — the common shape)', () => {
    expect(evaluateValidateWithTodayDefault('. <= today()')).toEqual({
      verdict: 'satisfied',
    });
  });

  it('passes `. >= today()` (today-or-future constraint)', () => {
    expect(evaluateValidateWithTodayDefault('. >= today()')).toEqual({
      verdict: 'satisfied',
    });
  });

  it('fails `. > today()` (strictly-future — the widget default cannot satisfy it)', () => {
    expect(evaluateValidateWithTodayDefault('. > today()')).toEqual({
      verdict: 'violated',
    });
  });

  it('fails the real spark-facilitator next_meeting_date constraint', () => {
    // Deliver "Record Community Meeting" → group next_steps (ace#1081).
    expect(
      evaluateValidateWithTodayDefault('. > today() and . <= date(today() + 30)'),
    ).toEqual({ verdict: 'violated' });
  });

  it('passes the inclusive variant of the same window', () => {
    expect(
      evaluateValidateWithTodayDefault('. >= today() and . <= date(today() + 30)'),
    ).toEqual({ verdict: 'satisfied' });
  });

  it('fails a strictly-past constraint', () => {
    expect(evaluateValidateWithTodayDefault('. < today()')).toEqual({
      verdict: 'violated',
    });
    expect(evaluateValidateWithTodayDefault('. <= date(today() - 1)')).toEqual({
      verdict: 'violated',
    });
  });

  it('handles or / not / parentheses', () => {
    expect(
      evaluateValidateWithTodayDefault('. > today() or . <= today()'),
    ).toEqual({ verdict: 'satisfied' });
    expect(evaluateValidateWithTodayDefault('not(. > today())')).toEqual({
      verdict: 'satisfied',
    });
    expect(
      evaluateValidateWithTodayDefault('(. >= today()) and (. <= date(today() + 7))'),
    ).toEqual({ verdict: 'satisfied' });
  });

  it('handles equality comparisons', () => {
    expect(evaluateValidateWithTodayDefault('. = today()')).toEqual({
      verdict: 'satisfied',
    });
    expect(evaluateValidateWithTodayDefault('. != today()')).toEqual({
      verdict: 'violated',
    });
  });

  it('returns unverifiable — never pass, never crash — on node references', () => {
    const out = evaluateValidateWithTodayDefault('. >= /data/visit/start_date');
    expect(out.verdict).toBe('unverifiable');
    expect(out.reason).toBeTruthy();
  });

  it('returns unverifiable on unknown functions (now, format-date, …)', () => {
    expect(evaluateValidateWithTodayDefault('. <= now()').verdict).toBe('unverifiable');
    expect(
      evaluateValidateWithTodayDefault("format-date(., '%Y') = '2026'").verdict,
    ).toBe('unverifiable');
  });

  it('returns unverifiable on malformed expressions and empty input', () => {
    expect(evaluateValidateWithTodayDefault('((. > today()').verdict).toBe('unverifiable');
    expect(evaluateValidateWithTodayDefault('. > > today()').verdict).toBe('unverifiable');
    expect(evaluateValidateWithTodayDefault('').verdict).toBe('unverifiable');
    expect(evaluateValidateWithTodayDefault('   ').verdict).toBe('unverifiable');
  });

  it('returns unverifiable when the expression is not boolean-valued', () => {
    expect(evaluateValidateWithTodayDefault('today() + 30').verdict).toBe('unverifiable');
  });
});

describe('checkDateDefaultValidate', () => {
  const sparkFields = [
    { id: 'date_of_meeting', kind: 'date', required: true, validate: '. <= today()' },
    { id: 'meeting_conducted', kind: 'single_select', required: true },
    {
      id: 'next_meeting_date',
      kind: 'date',
      required: true,
      validate: '. > today() and . <= date(today() + 30)',
    },
    { id: 'reschedule_date', kind: 'date', required: true, validate: '. >= today()' },
    { id: 'notes', kind: 'text', required: false },
    // Non-required date: the walk may skip it, so it is out of scope.
    { id: 'optional_followup', kind: 'date', required: false, validate: '. > today()' },
    // Required date with no constraint: any default satisfies.
    { id: 'recruitment_date', kind: 'date', required: true },
  ];

  it('flags exactly the strictly-future required date field', () => {
    const report = checkDateDefaultValidate(sparkFields);
    expect(report.dateFieldsChecked).toBe(4);
    expect(report.violations).toEqual([
      {
        fieldId: 'next_meeting_date',
        validate: '. > today() and . <= date(today() + 30)',
        verdict: 'violated',
      },
    ]);
  });

  it('reports unverifiable constraints as violations, not passes', () => {
    const report = checkDateDefaultValidate([
      { id: 'weird_date', kind: 'date', required: true, validate: '. <= now()' },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].verdict).toBe('unverifiable');
    expect(report.violations[0].reason).toBeTruthy();
  });

  it('passes a form with no date fields at all', () => {
    const report = checkDateDefaultValidate([
      { id: 'q1', kind: 'single_select', required: true },
    ]);
    expect(report).toEqual({ dateFieldsChecked: 0, violations: [] });
  });
});

describe('formatDateDefaultValidateReport', () => {
  it('renders PASS when clean', () => {
    const s = formatDateDefaultValidateReport({ dateFieldsChecked: 3, violations: [] });
    expect(s).toContain('PASS');
    expect(s).toContain('3 required date field(s)');
  });

  it('renders FAIL naming the field and the constraint on a violation', () => {
    const s = formatDateDefaultValidateReport({
      dateFieldsChecked: 4,
      violations: [
        {
          fieldId: 'next_meeting_date',
          validate: '. > today() and . <= date(today() + 30)',
          verdict: 'violated',
        },
      ],
    });
    expect(s).toContain('FAIL');
    expect(s).toContain('next_meeting_date');
    expect(s).toContain('[BLOCKER]');
    expect(s).toContain('ace#1081');
  });

  it('renders WARN when the only findings are unverifiable', () => {
    const s = formatDateDefaultValidateReport({
      dateFieldsChecked: 1,
      violations: [
        { fieldId: 'd1', validate: '. <= now()', verdict: 'unverifiable', reason: 'x' },
      ],
    });
    expect(s).toContain('WARN');
    expect(s).toContain('cannot statically verify');
  });
});

// ═══════════════════════════════════════════════════════════════════
// POSITIVE control, seeded by the negative-control ratchet
// (test/skills/negative-control-ratchet.test.ts).
//
// Every existing case here asserts a violation, except one that feeds a form
// with NO date fields — which returns `dateFieldsChecked: 0`. Per
// `lib/check-outcome.ts`, "did not look" is not "looked and it was fine", so
// that case cannot stand as the positive control: a rule that flagged EVERY
// required date field would have passed the whole suite, and `app-test-cases`
// would halt Phase 3 on forms whose widget default is perfectly legal.
// ═══════════════════════════════════════════════════════════════════

describe('checkDateDefaultValidate — a satisfiable form must come back clean', () => {
  it('POSITIVE — required dates the widget default really does satisfy', () => {
    const report = checkDateDefaultValidate([
      { id: 'date_of_meeting', kind: 'date', required: true, validate: '. <= today()' },
      { id: 'reschedule_date', kind: 'date', required: true, validate: '. >= today()' },
      // Required date with no constraint at all: any default satisfies.
      { id: 'recruitment_date', kind: 'date', required: true },
    ]);
    expect(report.violations).toEqual([]);
    // …and it actually LOOKED at all three, rather than passing by matching
    // nothing — the ace#1634 regex-blindness shape.
    expect(report.dateFieldsChecked).toBe(3);
  });

  it('POSITIVE — a bounded window that INCLUDES today is legal, not a violation', () => {
    // The edge the over-tight version gets wrong. `. >= today() and . <= date(today() + 30)`
    // is the same shape as the field ace#1081 flagged, differing only in
    // whether the lower bound is strict — and only the strict one traps the
    // walk. A check that flagged both would be relaxed until it flagged
    // neither.
    const report = checkDateDefaultValidate([
      { id: 'next_meeting_date', kind: 'date', required: true, validate: '. >= today() and . <= date(today() + 30)' },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.dateFieldsChecked).toBe(1);
  });
});
