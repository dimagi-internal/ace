import { describe, it, expect } from 'vitest';
import {
  checkScreenShape,
  formatScreenShapeReport,
  SCREEN_INPUT_WARN,
  SCREEN_INPUT_MAX,
  LONG_PASSAGE_CHARS,
  type ScreenField,
} from '../../lib/screen-shape';

/** Build N answerable single_select questions. */
function questions(n: number, prefix = 'q'): ScreenField[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    kind: 'single_select',
    label: `Question ${i + 1}?`,
  }));
}

function group(id: string, children: ScreenField[], label?: string): ScreenField {
  return { id, kind: 'group', ...(label !== undefined ? { label } : {}), children };
}

describe('checkScreenShape', () => {
  describe('the shape that motivated this check (regression anchor)', () => {
    // The Deliver form as it shipped on hh-poverty-targeting/20260812-2034:
    // ONE group carrying the zone question, the household roster repeat, the
    // roster gate, and all eight remaining PPI indicators — 10 answerable
    // questions plus a nested repeat, on one screen. It passed every Phase 3
    // gate and scored field_answerability 9.5.
    const shippedInstrumentGroup = group(
      'household_questions',
      [
        { id: 'instrument_start_time', kind: 'hidden' },
        { id: 'i1_zone', kind: 'single_select', label: 'In which zone does the household live?' },
        { id: 'roster_intro', kind: 'label', label: 'List every person the respondent names.' },
        {
          id: 'hh_member',
          kind: 'repeat',
          label: 'Household roster',
          children: [
            { id: 'member_name', kind: 'text', label: 'Name or nickname' },
            { id: 'member_qualifies', kind: 'single_select', label: 'Is this person a member?' },
          ],
        },
        { id: 'roster_complete', kind: 'single_select', label: 'Have you listed everyone?' },
        { id: 'household_size', kind: 'hidden' },
        { id: 'size_band', kind: 'hidden' },
        ...['i3_bread', 'i4_eggs', 'i5_milk', 'i6_sachet_water', 'i7_electricity', 'i8_sofa', 'i9_fan', 'i10_iron'].map(
          (id) => ({ id, kind: 'single_select', label: `${id}?` }),
        ),
      ],
      'Questions about the household',
    );

    it('flags it as a violation on BOTH mechanisms', () => {
      const report = checkScreenShape([shippedInstrumentGroup]);

      const oversized = report.findings.filter((f) => f.kind === 'oversized-screen');
      const repeatInList = report.findings.filter((f) => f.kind === 'repeat-in-field-list');

      // 10 answerable: i1_zone + roster_complete + the 8 remaining indicators.
      // The repeat's own children are NOT counted — a repeat gets its own screens.
      expect(oversized).toHaveLength(1);
      expect(oversized[0].severity).toBe('violation');
      expect(oversized[0].inputCount).toBe(10);
      expect(oversized[0].groupId).toBe('household_questions');

      expect(repeatInList).toHaveLength(1);
      expect(repeatInList[0].severity).toBe('violation');
      expect(repeatInList[0].detail).toContain('hh_member');
    });

    it('is caught by the count alone, not only by the nested repeat', () => {
      // Belt-and-braces: strip the repeat and the count must still fail, so a
      // future relaxation of one mechanism cannot silently un-catch this shape.
      const withoutRepeat: ScreenField = {
        ...shippedInstrumentGroup,
        children: (shippedInstrumentGroup.children ?? []).filter((c) => c.kind !== 'repeat'),
      };
      const report = checkScreenShape([withoutRepeat]);
      const violations = report.findings.filter((f) => f.severity === 'violation');
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe('oversized-screen');
    });

    it('passes once split the way the operator ruled', () => {
      // Multiple questions per screen is fine — the sets just have to be
      // coherent and short. This is the post-fix layout.
      const split: ScreenField[] = [
        group('where_lives', [
          { id: 'instrument_start_time', kind: 'hidden' },
          { id: 'i1_zone', kind: 'single_select', label: 'Zone?' },
        ], 'Where the household lives'),
        group('household_roster', [
          { id: 'roster_intro', kind: 'label', label: 'List every person.' },
          { id: 'roster_complete', kind: 'single_select', label: 'Listed everyone?' },
          { id: 'household_size', kind: 'hidden' },
        ], 'Who lives in the household'),
        {
          id: 'hh_member',
          kind: 'repeat',
          children: [
            { id: 'member_name', kind: 'text' },
            { id: 'member_qualifies', kind: 'single_select' },
          ],
        },
        group('food_and_drink', questions(4, 'i'), 'Food and drink in the past 7 days'),
        group('electricity_use', questions(1, 'e'), 'Electricity in the past 30 days'),
        group('household_assets', questions(3, 'a'), 'Things the household owns'),
      ];
      expect(checkScreenShape(split).findings).toEqual([]);
    });
  });

  describe('screen length', () => {
    it('passes a coherent set at the comfortable limit', () => {
      const report = checkScreenShape([group('g', questions(SCREEN_INPUT_WARN))]);
      expect(report.findings).toEqual([]);
      expect(report.screensChecked).toBe(1);
    });

    it('warns — not fails — just above the comfortable limit', () => {
      const report = checkScreenShape([group('g', questions(SCREEN_INPUT_WARN + 1))]);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe('warn');
      expect(report.findings[0].kind).toBe('oversized-screen');
    });

    it('fails above the ceiling', () => {
      const report = checkScreenShape([group('g', questions(SCREEN_INPUT_MAX + 1))]);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe('violation');
    });

    it('never flags a one-question-per-screen form — this is not that rule', () => {
      const report = checkScreenShape(
        Array.from({ length: 20 }, (_, i) => group(`g${i}`, questions(1, `g${i}q`))),
      );
      expect(report.findings).toEqual([]);
    });
  });

  describe('what counts as an answerable question', () => {
    it('ignores hidden and label fields', () => {
      const children: ScreenField[] = [
        ...questions(2),
        ...Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, kind: 'hidden' })),
        ...Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, kind: 'label', label: 'note' })),
      ];
      const report = checkScreenShape([group('g', children)]);
      expect(report.findings).toEqual([]);
    });

    it('counts a nested group into the parent screen', () => {
      // A group inside a field-list still renders on the same screen.
      const nested = group('outer', [
        ...questions(5, 'o'),
        group('inner', questions(5, 'i')),
      ]);
      const report = checkScreenShape([nested]);
      const outer = report.findings.find((f) => f.groupId === 'outer');
      expect(outer?.inputCount).toBe(10);
      expect(outer?.severity).toBe('violation');
    });

    it('does not count a repeat body toward the parent screen', () => {
      const withRepeat = group('g', [
        ...questions(2),
        { id: 'r', kind: 'repeat', children: questions(30, 'r') },
      ]);
      const report = checkScreenShape([withRepeat]);
      const oversized = report.findings.filter((f) => f.kind === 'oversized-screen');
      expect(oversized).toEqual([]);
    });

    it('still walks into a repeat body to check ITS screens', () => {
      const report = checkScreenShape([
        { id: 'r', kind: 'repeat', children: [group('inner', questions(12, 'x'))] },
      ]);
      const violation = report.findings.find((f) => f.groupId === 'inner');
      expect(violation?.severity).toBe('violation');
    });
  });

  describe('repeat nested in a field-list', () => {
    it('is a violation regardless of screen length', () => {
      const report = checkScreenShape([
        group('g', [{ id: 'roster', kind: 'repeat', children: questions(2, 'r') }]),
      ]);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].kind).toBe('repeat-in-field-list');
      expect(report.findings[0].severity).toBe('violation');
    });

    it('is not raised for a repeat at the form root', () => {
      const report = checkScreenShape([
        { id: 'roster', kind: 'repeat', children: questions(2, 'r') },
      ]);
      expect(report.findings).toEqual([]);
    });
  });

  describe('long read-aloud passage', () => {
    const passage = 'x'.repeat(LONG_PASSAGE_CHARS);

    it('warns when it shares a screen with unrelated questions', () => {
      // The consent-script case: script + occupancy + availability + consent.
      const report = checkScreenShape([
        group('doorstep', [
          ...questions(2, 'obs'),
          { id: 'consent_script', kind: 'label', label: passage },
          { id: 'consent', kind: 'single_select', label: 'Agree?' },
        ]),
      ]);
      const finding = report.findings.find((f) => f.kind === 'long-passage-with-questions');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warn');
    });

    it('is silent when the passage sits with the single answer it governs', () => {
      const report = checkScreenShape([
        group('consent_block', [
          { id: 'consent_script', kind: 'label', label: passage },
          { id: 'consent', kind: 'single_select', label: 'Agree?' },
        ]),
      ]);
      expect(report.findings).toEqual([]);
    });

    it('is silent for a short caption above several questions', () => {
      const report = checkScreenShape([
        group('g', [{ id: 'cap', kind: 'label', label: 'Answer these:' }, ...questions(3)]),
      ]);
      expect(report.findings).toEqual([]);
    });
  });

  describe('thresholds are overridable', () => {
    it('honours caller-supplied limits', () => {
      const report = checkScreenShape([group('g', questions(4))], {
        warnAbove: 2,
        violationAbove: 3,
      });
      expect(report.findings[0].severity).toBe('violation');
    });
  });

  describe('formatScreenShapeReport', () => {
    it('reports PASS with the screen count', () => {
      const out = formatScreenShapeReport(checkScreenShape([group('g', questions(2))]));
      expect(out).toContain('screen-shape: PASS');
      expect(out).toContain('1 screen(s) checked');
    });

    it('reports FAIL and names the offending group and its label', () => {
      const out = formatScreenShapeReport(
        checkScreenShape([group('household_questions', questions(12), 'Questions about the household')]),
      );
      expect(out).toContain('screen-shape: FAIL');
      expect(out).toContain('[BLOCKER]');
      expect(out).toContain('household_questions');
      expect(out).toContain('Questions about the household');
    });

    it('reports WARN when nothing rises to a violation', () => {
      const out = formatScreenShapeReport(
        checkScreenShape([group('g', questions(SCREEN_INPUT_WARN + 1))]),
      );
      expect(out).toContain('screen-shape: WARN');
      expect(out).not.toContain('[BLOCKER]');
    });
  });

  it('reports zero screens for a form with no groups', () => {
    const report = checkScreenShape(questions(5));
    expect(report).toEqual({ screensChecked: 0, findings: [] });
  });
});
