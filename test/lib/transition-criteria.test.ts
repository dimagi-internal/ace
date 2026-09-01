/**
 * Tests for `lib/transition-criteria.ts` — the ace#1885 static preventer.
 *
 * The calibration fixture is the exact case that shipped green:
 * `spark-facilitator/20260828-0703`, journey `journey-deliver-followup-preload`,
 * criterion `case_state_updated_after_submit`, asserted as
 * `assertVisible "Chilanga.*"` inside the case-list container. That assertion
 * proves the row exists; it would hold identically before and after the date
 * advanced, so the dispatch went green over a real `blocks-e2e` defect
 * (`last_meeting_date` stale across three synced meetings).
 */
import { describe, it, expect } from 'vitest';
import {
  checkTransitionCriteria,
  formatTransitionCriteriaReport,
  transitionWordIn,
  type RecipeStep,
} from '../../lib/transition-criteria.js';

/** The ace#1885 recipe tail, as generated: navigate to the case, then assert the row. */
const ACE_1885_STEPS: RecipeStep[] = [
  { command: 'tapOn', text: 'Chilanga.*', id: '${SELECTOR:case-list-container}' },
  { command: 'tapOn', text: 'Community meeting record' },
  { command: 'inputText', text: 'yes' },
  { command: 'tapOn', id: '${SELECTOR:form-nav-finish}' },
  { command: 'assertVisible', text: 'Chilanga.*', id: '${SELECTOR:case-list-container}' },
];

describe('transitionWordIn', () => {
  it('flags the ace#1885 criterion name', () => {
    expect(transitionWordIn('case_state_updated_after_submit')).toBe('updated');
  });

  it('matches across kebab-case and camelCase too', () => {
    expect(transitionWordIn('meeting-count-incremented')).toBe('incremented');
    expect(transitionWordIn('caseStateRefreshed')).toBe('refreshed');
  });

  it('does not flag presence criteria', () => {
    expect(transitionWordIn('app_boots')).toBeNull();
    expect(transitionWordIn('no_crash')).toBeNull();
    expect(transitionWordIn('submit_confirmation_visible')).toBeNull();
  });

  it('matches on token boundaries, not substrings', () => {
    // `update_form` is an action name, not a claim that something moved.
    expect(transitionWordIn('update_form')).toBeNull();
    expect(transitionWordIn('unchanged_baseline')).toBeNull();
  });
});

describe('checkTransitionCriteria — the ace#1885 fixture', () => {
  const report = checkTransitionCriteria([
    {
      id: 'journey-deliver-followup-preload',
      criteria: ['app_boots', 'no_crash', 'case_state_updated_after_submit'],
      steps: ACE_1885_STEPS,
    },
  ]);

  it('FAILS the criterion that shipped green', () => {
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      journeyId: 'journey-deliver-followup-preload',
      criterion: 'case_state_updated_after_submit',
      transitionWord: 'updated',
      reason: 'presence-only',
    });
  });

  it('judges only the transition-named criterion, not app_boots / no_crash', () => {
    expect(report.transitionCriteriaChecked).toBe(1);
  });

  it('names the offending assertion in the report so the author sees the gap', () => {
    const text = formatTransitionCriteriaReport(report);
    expect(text).toContain('[BLOCKER]');
    expect(text).toContain('case_state_updated_after_submit');
    expect(text).toContain('assertVisible "Chilanga.*"');
    expect(text).toContain('ace#1885');
  });
});

describe('checkTransitionCriteria — what DOES satisfy a transition criterion', () => {
  it('passes a captured-pair comparison (both sides observed)', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: ['case_state_updated_after_submit'],
        steps: [
          { command: 'copyTextFrom', id: '${SELECTOR:case-detail-last-meeting}' },
          { command: 'evalScript', text: '${output.before = maestro.copiedText}' },
          ...ACE_1885_STEPS,
          { command: 'copyTextFrom', id: '${SELECTOR:case-detail-last-meeting}' },
          { command: 'assertTrue', text: '${output.before != maestro.copiedText}' },
        ],
      },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.transitionCriteriaChecked).toBe(1);
  });

  it('passes a declared expected NEW value that the recipe asserts', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: [
          { name: 'case_state_updated_after_submit', expected_value: '01 Sep 2026' },
        ],
        steps: [
          ...ACE_1885_STEPS,
          { command: 'assertVisible', text: 'Last meeting: 01 Sep 2026' },
        ],
      },
    ]);
    expect(report.violations).toEqual([]);
  });

  it('a capture with no later comparison is NOT proof', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: ['case_state_updated_after_submit'],
        steps: [
          { command: 'copyTextFrom', id: '${SELECTOR:case-detail-last-meeting}' },
          ...ACE_1885_STEPS,
        ],
      },
    ]);
    expect(report.violations[0].reason).toBe('presence-only');
  });

  it('a comparison that runs BEFORE the capture is NOT proof', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-repeat-step',
        criteria: ['meetings_on_current_step_incremented'],
        steps: [
          { command: 'assertTrue', text: '${output.before != output.after}' },
          { command: 'copyTextFrom', id: '${SELECTOR:case-detail-meeting-count}' },
        ],
      },
    ]);
    expect(report.violations[0]).toMatchObject({
      transitionWord: 'incremented',
      reason: 'presence-only',
    });
  });
});

describe('checkTransitionCriteria — expected_value edge cases', () => {
  it('rejects an expected_value the recipe TAPPED to get here', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: [
          { name: 'case_state_updated_after_submit', expected_value: 'Chilanga.*' },
        ],
        steps: ACE_1885_STEPS,
      },
    ]);
    expect(report.violations[0]).toMatchObject({
      reason: 'expected-value-is-a-navigation-target',
    });
    expect(report.violations[0].detail).toContain('tapOn');
  });

  it('rejects an expected_value that is declared but never asserted', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: [
          { name: 'case_state_updated_after_submit', expected_value: '01 Sep 2026' },
        ],
        steps: ACE_1885_STEPS,
      },
    ]);
    expect(report.violations[0]).toMatchObject({
      reason: 'expected-value-not-asserted',
    });
  });
});

describe('checkTransitionCriteria — degenerate inputs', () => {
  it('reports no-assertions distinctly from presence-only', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-payability-feedback',
        criteria: ['payment_total_advanced'],
        steps: [{ command: 'tapOn', text: 'Submit' }],
      },
    ]);
    expect(report.violations[0]).toMatchObject({
      transitionWord: 'advanced',
      reason: 'no-assertions',
    });
  });

  it('a journey with no transition criteria passes and is counted', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-submit',
        criteria: ['app_boots', 'no_crash', 'submit_confirmation'],
        steps: [{ command: 'assertVisible', text: 'Submitted' }],
      },
    ]);
    expect(report).toEqual({
      journeysChecked: 1,
      transitionCriteriaChecked: 0,
      violations: [],
    });
    expect(formatTransitionCriteriaReport(report)).toContain('transition-criteria: PASS');
  });

  it('reports one violation per offending criterion across journeys', () => {
    const report = checkTransitionCriteria([
      {
        id: 'journey-deliver-followup-preload',
        criteria: ['case_state_updated_after_submit', 'meeting_count_incremented'],
        steps: ACE_1885_STEPS,
      },
      {
        id: 'journey-deliver-invalid-input',
        criteria: ['error_banner_cleared'],
        steps: [{ command: 'assertVisible', text: 'Chilanga.*' }],
      },
    ]);
    expect(report.violations.map((v) => v.criterion)).toEqual([
      'case_state_updated_after_submit',
      'meeting_count_incremented',
      'error_banner_cleared',
    ]);
    expect(report.transitionCriteriaChecked).toBe(3);
  });
});
