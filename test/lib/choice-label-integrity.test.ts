// Regression suites for ace#1689 and ace#1688, both from
// `spark-facilitator/20260820-0817` Phase 6. The fixtures below are the
// RECORDED artifacts from that run — the live ui-dump in #1689 and the
// released Deliver CCZ `bf4898f5d80b456eb4525fc4e2d9ced9` in #1688 — not
// invented examples.

import { describe, it, expect } from 'vitest';
import {
  renderMarkdownLabel,
  checkMarkdownEatenLabels,
  checkCaseListEnumDrift,
} from '../../lib/choice-label-integrity.js';

describe('renderMarkdownLabel (ace#1689)', () => {
  it('drops the ordered-list marker, exactly as the device showed', () => {
    // Authored -> what uiautomator actually dumped on the device.
    const observed: Array<[string, string]> = [
      ['1. Planning', 'Planning'],
      ['2. Implementation', 'Implementation'],
      ['3. Second Round Planning and Implementation', 'Second Round Planning and Implementation'],
      ['4. Transition', 'Transition'],
    ];
    for (const [authored, onDevice] of observed) {
      expect(renderMarkdownLabel(authored).rendered).toBe(onDevice);
      expect(renderMarkdownLabel(authored).construct).toBe('ordered-list');
    }
  });

  it('covers the adjacent block constructs that consume their marker', () => {
    expect(renderMarkdownLabel('- Yes').rendered).toBe('Yes');
    expect(renderMarkdownLabel('* Yes').rendered).toBe('Yes');
    expect(renderMarkdownLabel('# Heading').rendered).toBe('Heading');
    expect(renderMarkdownLabel('> Quoted').rendered).toBe('Quoted');
    expect(renderMarkdownLabel('1) Paren form').rendered).toBe('Paren form');
  });

  it('leaves ordinary labels alone — a false alarm trains people to ignore it', () => {
    for (const s of [
      'Planning',
      'Yes',
      'No',
      'Phase 1: Planning',
      '1.5 kg or more', // a decimal, not a list marker: no space after the dot
      'Mother-in-law', // hyphen mid-string
      '3rd trimester',
      'N/A',
    ]) {
      expect(renderMarkdownLabel(s).rendered).toBe(s);
      expect(renderMarkdownLabel(s).construct).toBeUndefined();
    }
  });
});

describe('checkMarkdownEatenLabels (ace#1689)', () => {
  it('flags the run’s real FCAP phase list and says what the device will show', () => {
    const res = checkMarkdownEatenLabels([
      { value: '1', label: '1. Planning', location: 'meeting_classification/phase' },
      { value: '2', label: '2. Implementation', location: 'meeting_classification/phase' },
    ]);
    expect(res.status).toBe('checked');
    if (res.status !== 'checked') return;
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0].rendered).toBe('Planning');
    expect(res.findings[0].construct).toBe('ordered-list');
    expect(res.findings[0].remediation).toContain('Planning');
  });

  it('passes a clean list', () => {
    const res = checkMarkdownEatenLabels([
      { value: 'y', label: 'Yes' },
      { value: 'n', label: 'No' },
    ]);
    expect(res.status).toBe('checked');
    if (res.status !== 'checked') return;
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it('is UNABLE, not ok, when there is nothing to inspect', () => {
    // The whole point of CheckOutcome: an empty input must not read as a pass.
    const res = checkMarkdownEatenLabels([]);
    expect(res.status).toBe('unable');
    if (res.status !== 'unable') return;
    expect(res.reason).toBeTruthy();
    expect(res).not.toHaveProperty('ok');
  });
});

describe('checkCaseListEnumDrift (ace#1688)', () => {
  // The two taxonomies as shipped, verbatim from the issue's table.
  const caseListEnums = {
    '1': '1. Introduction',
    '2': '2. Planning',
    '3': '3. Implementation',
    '4': '4. Sustainability',
  };
  const formChoices = {
    '1': '1. Planning',
    '2': '2. Implementation',
    '3': '3. Second Round Planning and Implementation',
    '4': '4. Transition',
  };

  it('catches the shipped drift on every value', () => {
    const res = checkCaseListEnumDrift({ property: 'phase', caseListEnums, formChoices });
    expect(res.status).toBe('checked');
    if (res.status !== 'checked') return;
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(4);
    expect(res.findings.every((f) => f.kind === 'label-mismatch')).toBe(true);
    // The finding has to make the confusion legible, not just say "differs".
    expect(res.findings[0].remediation).toContain('1. Introduction');
    expect(res.findings[0].remediation).toContain('1. Planning');
  });

  it('separates a value the form cannot produce from one the tile cannot render', () => {
    const res = checkCaseListEnumDrift({
      property: 'phase',
      caseListEnums: { '1': 'Planning', '9': 'Retired phase' },
      formChoices: { '1': 'Planning', '2': 'Implementation' },
    });
    expect(res.status).toBe('checked');
    if (res.status !== 'checked') return;
    const kinds = Object.fromEntries(res.findings.map((f) => [f.value, f.kind]));
    expect(kinds['9']).toBe('missing-from-form');
    expect(kinds['2']).toBe('missing-from-case-list');
  });

  it('passes when the two agree', () => {
    const res = checkCaseListEnumDrift({
      property: 'phase',
      caseListEnums: { '1': 'Planning' },
      formChoices: { '1': 'Planning' },
    });
    expect(res.status).toBe('checked');
    if (res.status !== 'checked') return;
    expect(res.ok).toBe(true);
  });

  it('is UNABLE when the form side is missing — the form is the authority', () => {
    const res = checkCaseListEnumDrift({
      property: 'phase',
      caseListEnums: { '1': 'Planning' },
      formChoices: {},
    });
    expect(res.status).toBe('unable');
    if (res.status !== 'unable') return;
    expect(res.reason).toContain('authority');
  });
});
