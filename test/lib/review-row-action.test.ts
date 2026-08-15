/**
 * ace#1394 — the weekly-review ACTION column offered "Draft coaching message"
 * on every row, including rows its own legend marked "all payable".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  primaryRowAction,
  shouldOfferCoaching,
  type AttentionReason,
} from '../../lib/review-row-action';

describe('the two rows that actually shipped wrong', () => {
  it('Peter Masamba — 2 of 2 payable, listed only for a flagged record', () => {
    // "WHY THE REST WERE NOT PAID: all payable". Coaching him is a non-sequitur.
    const a = primaryRowAction(['flagged-record']);
    expect(a.label).toBe('Open flagged record');
    expect(a.kind).toBe('drill');
    expect(shouldOfferCoaching(['flagged-record'])).toBe(false);
  });

  it('Rhoda Chimwemwe — 100% payable, listed only for a fix above tolerance', () => {
    // The same page's WHAT IS NOT A PAYMENT GATE card says this never blocks payment.
    expect(primaryRowAction(['fix-above-tolerance']).kind).toBe('drill');
    expect(shouldOfferCoaching(['fix-above-tolerance'])).toBe(false);
  });
});

describe('each reason gets the action that answers it', () => {
  it.each<[AttentionReason, string]>([
    ['flagged-record', 'Open flagged record'],
    ['no-records', 'Draft check-in message'],
    ['below-threshold', 'Draft coaching message'],
    ['fix-above-tolerance', 'Open records'],
  ])('%s → %s', (reason, label) => {
    expect(primaryRowAction([reason]).label).toBe(label);
  });

  it('a missing record asks why, rather than assuming underperformance', () => {
    expect(primaryRowAction(['no-records']).label).toBe('Draft check-in message');
  });

  it('coaching is offered for exactly one reason', () => {
    const all: AttentionReason[] = ['flagged-record', 'no-records', 'below-threshold', 'fix-above-tolerance'];
    expect(all.filter((r) => shouldOfferCoaching([r]))).toEqual(['below-threshold']);
  });
});

describe('a row carrying several reasons answers the most actionable', () => {
  it('a flagged record outranks a below-threshold rate', () => {
    expect(primaryRowAction(['below-threshold', 'flagged-record']).label)
      .toBe('Open flagged record');
  });

  it('order of the input array does not matter', () => {
    expect(primaryRowAction(['flagged-record', 'below-threshold']).label)
      .toBe(primaryRowAction(['below-threshold', 'flagged-record']).label);
  });

  it('an advisory tolerance fix never outranks a real reason', () => {
    expect(primaryRowAction(['fix-above-tolerance', 'below-threshold']).label)
      .toBe('Draft coaching message');
    expect(primaryRowAction(['fix-above-tolerance', 'no-records']).label)
      .toBe('Draft check-in message');
  });
});

describe('the degenerate case fails toward reading, not toward judging', () => {
  it('no reasons at all yields a drill-down, never a coaching prompt', () => {
    // Such a row should not be listed; if a rendering bug lists it anyway, the
    // failure must not surface as an unwarranted "this person needs coaching".
    const a = primaryRowAction([]);
    expect(a.kind).toBe('drill');
    expect(shouldOfferCoaching([])).toBe(false);
  });
});

describe('every action explains itself', () => {
  // Wrapped in an object: it.each spreads a bare array, so the empty case
  // would arrive as zero arguments.
  it.each([
    { reasons: ['flagged-record'] as AttentionReason[] },
    { reasons: ['no-records'] as AttentionReason[] },
    { reasons: ['below-threshold'] as AttentionReason[] },
    { reasons: ['fix-above-tolerance'] as AttentionReason[] },
    { reasons: [] as AttentionReason[] },
  ])('rationale is present for $reasons', ({ reasons }) => {
    expect(primaryRowAction(reasons).rationale.length).toBeGreaterThan(20);
  });

  it('says plainly that an advisory row has nothing to action', () => {
    expect(primaryRowAction(['fix-above-tolerance']).rationale).toContain('nothing to action');
  });
});

describe('the polish skill carries the rule (ace#1394)', () => {
  const skill = readFileSync(
    join(__dirname, '../../skills/synthetic-workflow-polish/SKILL.md'),
    'utf8',
  );

  it('states that the action follows the row reason', () => {
    expect(skill).toMatch(/never one action for every row/i);
  });

  it('points at the shared mapping instead of restating a second copy', () => {
    expect(skill).toContain('lib/review-row-action.ts');
    expect(skill).toContain('primaryRowAction');
  });

  it('lists every reason the mapping knows about', () => {
    for (const phrase of [
      'Open flagged record',
      'Draft check-in message',
      'Draft coaching message',
      'no message action',
    ]) {
      expect(skill).toContain(phrase);
    }
  });

  it('records why it is a rule, so it is not trimmed as a preference', () => {
    expect(skill).toContain('ace#1394');
    expect(skill).toMatch(/all payable/);
  });
});
