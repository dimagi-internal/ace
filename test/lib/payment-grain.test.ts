/**
 * Unit tests for lib/payment-grain.ts — the shared payment-unit-vs-entity_id
 * grain primitives used by BOTH `idea-to-pdd-qa` (ace#1420) and
 * `pdd-to-work-order-qa` (ace#1946).
 */
import { describe, expect, test } from 'vitest';
import {
  classifyGrainRelation,
  mentionsTerm,
  readProgramParameter,
  DAY_TERMS,
  EVENT_TERMS,
} from '../../lib/payment-grain';

describe('mentionsTerm', () => {
  test('matches whole words and their plurals', () => {
    expect(mentionsTerm('per verified visit', EVENT_TERMS)).toBe('visit');
    expect(mentionsTerm('six same-day visits', EVENT_TERMS)).toBe('visit');
    expect(mentionsTerm('worker username + encounter date', DAY_TERMS)).toBe('date');
  });

  test('does not match a substring inside a longer word', () => {
    expect(mentionsTerm('holiday', DAY_TERMS)).toBeNull();
    expect(mentionsTerm('revisiting', EVENT_TERMS)).toBeNull();
  });

  test('tolerates any whitespace run inside a multi-word term', () => {
    expect(mentionsTerm('one calendar\n  day', ['calendar day'])).toBe('calendar day');
    expect(mentionsTerm('one calendar day', ['calendar day'])).toBe('calendar day');
    expect(mentionsTerm('a calendar month', ['calendar day'])).toBeNull();
  });
});

describe('classifyGrainRelation', () => {
  test('flags a per-visit rate against a day-scoped grain (the ace#1420/#1946 defect)', () => {
    const r = classifyGrainRelation('per verified visit', 'worker username + encounter date');
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.unitEvent).toBe('visit');
      expect(r.grainDay).toBe('date');
    }
  });

  test('a day-scoped rate unit is consistent with a day grain', () => {
    expect(classifyGrainRelation('per verified follow-up day', 'worker + encounter date').kind).toBe(
      'unit-day-scoped',
    );
  });

  test('a per-visit rate against a per-visit grain is consistent', () => {
    expect(classifyGrainRelation('per verified visit', 'one entity per household visit').kind).toBe(
      'consistent',
    );
  });

  test('skips when either operand is absent', () => {
    expect(classifyGrainRelation('', 'worker + date').kind).toBe('not-applicable');
    expect(classifyGrainRelation('per visit', '   ').kind).toBe('not-applicable');
  });
});

describe('readProgramParameter', () => {
  const PDD = [
    '## Program Parameters',
    '',
    '| Key | Value |',
    '|---|---|',
    '| payment_rate_min | 2.00 |',
    '| `entity_id_grain` | worker username + encounter date |',
    '| empty_row |  |',
    '',
  ].join('\n');

  test('reads a row, stripping backticks', () => {
    expect(readProgramParameter(PDD, 'entity_id_grain')).toBe('worker username + encounter date');
    expect(readProgramParameter(PDD, 'payment_rate_min')).toBe('2.00');
  });

  test('returns null for an absent row, an empty value, or empty text', () => {
    expect(readProgramParameter(PDD, 'daily_cap_per_flw')).toBeNull();
    expect(readProgramParameter(PDD, 'empty_row')).toBeNull();
    expect(readProgramParameter('', 'entity_id_grain')).toBeNull();
  });
});
