import { describe, it, expect } from 'vitest';
import { checkSceneVariety, type VarietyFinding, type VarietySpec } from '../../lib/demo-scene-variety';

/**
 * The fixture is the scene table of `spark-facilitator/20260907-1120` verbatim —
 * seven scenes, two surfaces, four of them the payment ledger. `verdict-arc.yaml`
 * scored it visual_variety 2 and escalation 2, both by deduction rules this
 * module mirrors. Every value here was read off the spec of record, not invented.
 */
const SPARK_SPEC: VarietySpec = {
  scenes: [
    {
      id: 'what-the-pilot-pays-for',
      url: '${payment_integrity_par_url}',
      actions: [{ kind: 'wait_for', target: 'css:[data-testid=ledger-table]' }, { kind: 'hold' }],
    },
    { id: 'the-test-a-record-has-to-pass', actions: [{ kind: 'scroll', value: '174' }, { kind: 'hold' }] },
    { id: 'three-below-the-target', actions: [{ kind: 'scroll', value: '347' }, { kind: 'hold' }] },
    {
      id: 'the-column-that-changes-nothing',
      actions: [{ kind: 'scroll_to', target: 'css:[data-testid=ledger-table]' }, { kind: 'hold' }],
    },
    {
      id: 'the-week-in-front-of-a-partner-trainer',
      url: '${weekly_review_par_url}',
      actions: [
        { kind: 'wait_for', target: 'css:[data-testid=stat-reviewed]' },
        { kind: 'hold' },
        { kind: 'scroll', value: 'bottom' },
        { kind: 'hold' },
        { kind: 'scroll', value: 'top' },
        { kind: 'hold' },
      ],
    },
    {
      id: 'narrow-the-week-to-the-three',
      actions: [
        { kind: 'click', target: 'testid:filter-below-floor' },
        { kind: 'wait_for', target: 'text:Showing 3 of 12 facilitators' },
        { kind: 'hold' },
      ],
    },
    {
      id: 'the-decision-the-shortfall-list-never-names',
      actions: [
        { kind: 'click', target: 'testid:filter-below-floor' },
        { kind: 'wait_for', target: 'text:Showing 12 of 12 facilitators' },
        { kind: 'hold' },
        { kind: 'scroll', value: 'bottom' },
        { kind: 'click', target: 'testid:ontrack-steven_msiska' },
        { kind: 'wait_for', target: 'css:[data-testid=decision-steven_msiska]' },
        { kind: 'hold' },
      ],
    },
  ],
};

const kinds = (fs: VarietyFinding[]) => fs.map((f) => f.kind);

describe('checkSceneVariety — the deck as a sequence, before anything is rendered', () => {
  it('predicts both arc caps on the run that motivated it', () => {
    const r = checkSceneVariety(SPARK_SPEC);

    expect(r.pass).toBe(false);
    expect(r.judged).toBe(7);
    expect(r.surfaces).toBe(2);

    const monopoly = r.findings.filter((f) => f.kind === 'surface-monopoly');
    expect(monopoly).toHaveLength(1);
    expect(monopoly[0].detail).toContain('4 of 7');

    // Scenes 2, 3 and 4 each follow the ledger with nothing but a scroll —
    // exactly the pairs the judge listed as 1->2, 2->3 and 3->4.
    const scrollOnly = r.findings.filter((f) => f.kind === 'scroll-only-transition');
    expect(scrollOnly.map((f) => f.scene)).toEqual([
      'the-test-a-record-has-to-pass',
      'three-below-the-target',
      'the-column-that-changes-nothing',
    ]);
  });

  it('does not flag a scene that changes what the page shows', () => {
    // Scenes 6 and 7 stay on the review surface but each clicks something, so
    // the frame carries a state the previous one could not have.
    const r = checkSceneVariety(SPARK_SPEC);
    const flagged = r.findings.map((f) => f.scene);
    expect(flagged).not.toContain('narrow-the-week-to-the-three');
    expect(flagged).not.toContain('the-decision-the-shortfall-list-never-names');
  });

  it('CONTROL — a deck that visits a new surface or acts each time passes clean', () => {
    const r = checkSceneVariety({
      scenes: [
        { id: 'a', url: '${one}', actions: [{ kind: 'wait_for' }, { kind: 'hold' }] },
        { id: 'b', url: '${two}', actions: [{ kind: 'scroll', value: '200' }, { kind: 'hold' }] },
        { id: 'c', actions: [{ kind: 'click', target: 'testid:x' }, { kind: 'hold' }] },
        { id: 'd', url: '${three}', actions: [{ kind: 'hold' }] },
      ],
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.surfaces).toBe(3);
  });

  it('counts a surface at exactly half the scenes as acceptable', () => {
    // The judge's rule is "more than half", so two of four is not a monopoly.
    const r = checkSceneVariety({
      scenes: [
        { id: 'a', url: '${one}', actions: [{ kind: 'hold' }] },
        { id: 'b', actions: [{ kind: 'click' }, { kind: 'hold' }] },
        { id: 'c', url: '${two}', actions: [{ kind: 'hold' }] },
        { id: 'd', actions: [{ kind: 'click' }, { kind: 'hold' }] },
      ],
    });
    expect(kinds(r.findings)).toEqual([]);
  });

  it('carries an inherited surface forward across several scenes', () => {
    const r = checkSceneVariety({
      scenes: [
        { id: 'a', url: '${one}', actions: [{ kind: 'hold' }] },
        { id: 'b', actions: [{ kind: 'click' }] },
        { id: 'c', actions: [{ kind: 'click' }] },
      ],
    });
    expect(r.surfaces).toBe(1);
    expect(kinds(r.findings)).toEqual(['surface-monopoly']);
  });

  it('treats a scene with no actions at all as adding nothing', () => {
    const r = checkSceneVariety({
      scenes: [
        { id: 'a', url: '${one}', actions: [{ kind: 'click' }] },
        { id: 'b', actions: [] },
        { id: 'c', url: '${two}', actions: [{ kind: 'click' }] },
        { id: 'd', url: '${three}', actions: [{ kind: 'click' }] },
      ],
    });
    const scrollOnly = r.findings.filter((f) => f.kind === 'scroll-only-transition');
    expect(scrollOnly.map((f) => f.scene)).toEqual(['b']);
    expect(scrollOnly[0].detail).toContain('(none)');
  });

  it('reads goto as a state change even without a declared url', () => {
    const r = checkSceneVariety({
      scenes: [
        { id: 'a', url: '${one}', actions: [{ kind: 'hold' }] },
        { id: 'b', actions: [{ kind: 'goto', target: '${one}#tab2' }, { kind: 'hold' }] },
        { id: 'c', url: '${two}', actions: [{ kind: 'hold' }] },
        { id: 'd', url: '${three}', actions: [{ kind: 'hold' }] },
      ],
    });
    expect(kinds(r.findings)).toEqual([]);
  });

  it('is silent on an empty spec rather than dividing by nothing', () => {
    expect(checkSceneVariety({ scenes: [] }).findings).toEqual([]);
    expect(checkSceneVariety(undefined).pass).toBe(true);
    expect(checkSceneVariety(undefined).judged).toBe(0);
  });

  it('generates at least one finding of every kind it can emit', () => {
    expect(new Set(kinds(checkSceneVariety(SPARK_SPEC).findings))).toEqual(
      new Set(['surface-monopoly', 'scroll-only-transition']),
    );
  });

  it('every blocking finding reaches auto_fix_hint', () => {
    const r = checkSceneVariety(SPARK_SPEC);
    expect(r.auto_fix_hint).toBeDefined();
    for (const f of r.findings.filter((x) => x.blocking)) {
      if (f.scene) expect(r.auto_fix_hint).toContain(f.scene);
    }
  });
});
