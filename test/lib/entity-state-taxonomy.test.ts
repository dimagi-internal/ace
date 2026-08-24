/**
 * ace#1564 — the built app must use the PARTNER's entity-state vocabulary.
 *
 * The regression these pin is `spark-facilitator/20260820-0817`: the PDD
 * declared Spark's own published FCAP phases (1 = Planning, steps 1–14 …) and
 * the Deliver app shipped a different four-way partition with invented labels.
 * Every structural gate passed it, because the app was internally consistent
 * with its own invented vocabulary.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStateTaxonomy,
  diffStateTaxonomy,
  describeTaxonomyDiff,
} from '../../lib/entity-state-taxonomy';

/** The taxonomy the spark-facilitator PDD actually declared. */
const SPARK =
  '1=Planning (steps 1-14); 2=Implementation (steps 15-18); ' +
  '3=Second Round Planning & Implementation (steps 19-22); 4=Transition (steps 23-24) ' +
  '[source: FCAP Structure, Phases and Activities (Spark, shared 2026-07-21).pdf]';

describe('parseStateTaxonomy', () => {
  it('parses values, verbatim labels, expanded steps and the named source', () => {
    const t = parseStateTaxonomy(SPARK);
    expect(t.declared).toBe(true);
    expect(t.problems).toEqual([]);
    expect(t.states.map((s) => s.value)).toEqual(['1', '2', '3', '4']);
    expect(t.states[0].label).toBe('Planning');
    expect(t.states[2].label).toBe('Second Round Planning & Implementation');
    expect(t.states[0].steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(t.states[3].steps).toEqual([23, 24]);
    expect(t.source).toContain('FCAP Structure, Phases and Activities');
  });

  it('accepts states with no step partition', () => {
    const t = parseStateTaxonomy('screening=Screening; enrolled=Enrolled in the cohort');
    expect(t.declared).toBe(true);
    expect(t.problems).toEqual([]);
    expect(t.states.map((s) => s.steps)).toEqual([[], []]);
    expect(t.source).toBeNull();
  });

  it('accepts a mixed list of ranges and single steps', () => {
    const t = parseStateTaxonomy('a=Alpha (steps 1-3, 7); b=Beta (step 9)');
    expect(t.states[0].steps).toEqual([1, 2, 3, 7]);
    expect(t.states[1].steps).toEqual([9]);
    expect(t.problems).toEqual([]);
  });

  // The HALT signal. Absence must never read as a licence to invent — this is
  // the whole point of choosing derive-or-halt over a canonical vocabulary.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['unfilled template placeholder', '[value=Label (steps a-b); … or omit this row]'],
    ['explicit n/a', 'n/a'],
    ['none', 'None'],
    ['TBD', 'TBD'],
    ['nullish', null],
  ])('reports declared:false for %s', (_label, raw) => {
    const t = parseStateTaxonomy(raw as string | null);
    expect(t.declared).toBe(false);
    expect(t.states).toEqual([]);
  });

  it('ships no default vocabulary when nothing is declared', () => {
    const t = parseStateTaxonomy(undefined);
    expect(t.states).toHaveLength(0);
    expect(t.source).toBeNull();
  });

  it('flags a step claimed by two states', () => {
    const t = parseStateTaxonomy('1=Planning (steps 1-7); 2=Implementation (steps 5-9)');
    expect(t.problems.join(' ')).toMatch(/step 5 belongs to both/);
  });

  it('flags duplicate values and duplicate labels', () => {
    const dupValue = parseStateTaxonomy('1=Planning; 1=Implementation');
    expect(dupValue.problems.join(' ')).toMatch(/duplicate state value "1"/);
    const dupLabel = parseStateTaxonomy('1=Planning; 2=planning ');
    expect(dupLabel.problems.join(' ')).toMatch(/duplicate state label/);
  });

  it('flags malformed entries and inverted ranges rather than guessing', () => {
    const t = parseStateTaxonomy('Planning steps 1-14; 2=Implementation (steps 18-15)');
    expect(t.problems.join(' ')).toMatch(/unparseable state entry/);
    expect(t.problems.join(' ')).toMatch(/inverted step range/);
  });
});

describe('diffStateTaxonomy', () => {
  const declared = parseStateTaxonomy(SPARK).states;

  it('passes a build that ships the declared taxonomy verbatim', () => {
    const diff = diffStateTaxonomy({
      declared,
      built: declared.map((s) => ({ value: s.value, label: s.label, steps: s.steps })),
    });
    expect(diff.ok).toBe(true);
    expect(describeTaxonomyDiff(diff)).toEqual([]);
  });

  // The exact shipped defect: same four values, invented labels, re-partitioned
  // steps. Nothing else in Phase 3 can see this.
  it('catches the spark-facilitator re-partition and relabel', () => {
    const diff = diffStateTaxonomy({
      declared,
      built: [
        { value: '1', label: 'Introduction and community entry', steps: [1, 2, 3, 4] },
        {
          value: '2',
          label: 'Planning',
          steps: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        },
        { value: '3', label: 'Implementation', steps: [19, 20, 21, 22] },
        { value: '4', label: 'Sustainability and graduation', steps: [23, 24] },
      ],
    });
    expect(diff.ok).toBe(false);
    expect(diff.relabelled.map((r) => r.value)).toEqual(['1', '2', '3', '4']);
    // 3 happens to keep steps 19–22, so only 1 and 2 moved — but its LABEL
    // still changed, which is why relabel and re-partition are separate findings.
    expect(diff.repartitioned.map((r) => r.value)).toEqual(['1', '2']);
    expect(diff.extraInBuild).toEqual([]);
    expect(diff.missingInBuild).toEqual([]);
    expect(describeTaxonomyDiff(diff).join('\n')).toMatch(/re-partitioned/);
  });

  it('catches an invented extra state and a dropped declared one', () => {
    const diff = diffStateTaxonomy({
      declared,
      built: [
        { value: '1', label: 'Planning', steps: declared[0].steps },
        { value: '2', label: 'Implementation', steps: declared[1].steps },
        { value: '3', label: 'Second Round Planning & Implementation', steps: declared[2].steps },
        { value: 'graduated', label: 'Graduated', steps: [] },
      ],
    });
    expect(diff.extraInBuild).toEqual(['graduated']);
    expect(diff.missingInBuild).toEqual(['4']);
    expect(describeTaxonomyDiff(diff).join('\n')).toMatch(/invented state value "graduated"/);
  });

  it('ignores case and surrounding whitespace in labels, not wording', () => {
    const same = diffStateTaxonomy({
      declared: [{ value: '1', label: 'Planning', steps: [] }],
      built: [{ value: '1', label: '  planning ', steps: [] }],
    });
    expect(same.ok).toBe(true);

    const reworded = diffStateTaxonomy({
      declared: [{ value: '1', label: 'Planning', steps: [] }],
      built: [{ value: '1', label: 'Planning phase', steps: [] }],
    });
    expect(reworded.ok).toBe(false);
  });

  it('does not manufacture a re-partition when one side numbers no steps', () => {
    const diff = diffStateTaxonomy({
      declared: [{ value: '1', label: 'Planning', steps: [1, 2, 3] }],
      built: [{ value: '1', label: 'Planning' }],
    });
    expect(diff.ok).toBe(true);
    expect(diff.repartitioned).toEqual([]);
  });
});
