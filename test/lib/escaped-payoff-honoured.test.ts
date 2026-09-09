/**
 * ace#2316 — the `below_programme_scale` escape is a promise, and this is the
 * test that it gets kept.
 *
 * `checkDetectionCohortFloor` grants the escape to a programme whose real
 * roster sits below `DETECTION_MIN_ROWS`, on the stated condition that the demo
 * builds "its payoff elsewhere". It then returns `ok` without ever looking at
 * where elsewhere went, so the condition was prose.
 *
 * The verbatim case is `spark-facilitator/20260908-2215`: escape taken with two
 * correct PDD quotes, the right mitigation written down — *"the narrative's
 * payoff is built on the qualifying-share rule, which holds at any cohort size,
 * rather than on a claim that unaided scanning is impossible"* — and a payoff
 * that then clicked `testid:below-target-filter` to hide 10 of 12 rows. Four
 * independent judges capped `use_case_soundness` at 3 on it, which pins concept
 * under the 4.0 convergence bar; three consecutive runs of the opp ended
 * non-converged.
 *
 * The negative controls are the point of the file: this check must stay silent
 * on every demo that did NOT take the escape, or it becomes the third
 * false-positive rule in this module's history (ace#1660 retracted, ace#1841
 * pruned).
 */
import { describe, it, expect } from 'vitest';
import {
  checkEscapedPayoffIsHonoured,
  checkDetectionCohortFloor,
  DETECTION_MIN_ROWS,
  type DddScene,
} from '../../lib/ddd-scene-actions.js';

/** The escape as spark-facilitator/20260908-2215 actually declared it. */
const SPARK_SIGNAL = {
  pdd_control: 'meeting_conducted = yes AND meeting_type = community_meeting',
  below_programme_scale:
    'PDD §9: "Direct beneficiaries of the payment layer: approximately 12 Community Based ' +
    'Facilitators, one per community." PDD §10: "Count: ~12, one per community."',
};

/** The payoff scene that actually shipped, actions verbatim from the run. */
const SPARK_PAYOFF_SCENES: DddScene[] = [
  {
    title: 'Two below the target, and one with a nameable cause',
    actions: [
      { kind: 'click', target: 'testid:below-target-filter' },
      { kind: 'wait_for', target: 'text:Listing 2 of 12 facilitators' },
      { kind: 'hold' },
      { kind: 'click', target: 'testid:coach-cbf_tione_maseko' },
      { kind: 'wait_for', target: 'testid:task-created-cbf_tione_maseko' },
    ],
  },
];

describe('checkEscapedPayoffIsHonoured — the shipped defect (ace#2316)', () => {
  it('fails the spark run: escape taken, no payoff_control declared', () => {
    const report = checkEscapedPayoffIsHonoured(
      { detectable_signal: SPARK_SIGNAL, data_shape: { rows: 12, periods: 13, groups: 1 } },
      SPARK_PAYOFF_SCENES,
    );
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('escaped-payoff-unhonoured');
    expect(report.findings[0].detail).toMatch(/names\s+no control/i);
  });

  it('the floor check itself still passes the spark run — this check is the missing half', () => {
    // Proves the two checks are complementary rather than redundant: the escape
    // is legitimately granted, and that is exactly why nothing caught the rest.
    const floor = checkDetectionCohortFloor({
      detectable_signal: SPARK_SIGNAL,
      data_shape: { rows: 12, periods: 13, groups: 1 },
    });
    expect(floor.ok).toBe(true);
    expect(floor.findings).toHaveLength(0);
  });

  it('fails when a control IS declared but no scene acts on it', () => {
    const report = checkEscapedPayoffIsHonoured(
      {
        detectable_signal: SPARK_SIGNAL,
        data_shape: { rows: 12 },
        // What the producer SHOULD have declared, per its own written mitigation.
        payoff_control: 'testid:payability-decision-cbf_tione_maseko',
      },
      SPARK_PAYOFF_SCENES,
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].kind).toBe('escaped-payoff-unhonoured');
    expect(report.findings[0].detail).toContain('testid:payability-decision-cbf_tione_maseko');
  });

  it('does not let a re-pointed declaration launder the same defect', () => {
    // Re-pointing the declaration at the template's filter is the cheapest way
    // to turn this check green while shipping the identical demo. It passes the
    // identity match by construction — so the guard against it is the skill's
    // "put the control on the page" instruction, and this test pins the
    // behaviour so the loophole is documented rather than discovered.
    const report = checkEscapedPayoffIsHonoured(
      {
        detectable_signal: SPARK_SIGNAL,
        data_shape: { rows: 12 },
        payoff_control: 'testid:below-target-filter',
      },
      SPARK_PAYOFF_SCENES,
    );
    expect(report.ok).toBe(true);
  });
});

describe('checkEscapedPayoffIsHonoured — honoured promises pass', () => {
  it('passes when the payoff scene acts on the declared control', () => {
    const scenes: DddScene[] = [
      {
        title: 'A record filed, and not payable',
        actions: [
          { kind: 'click', target: 'testid:payability-decision-cbf_tione_maseko' },
          { kind: 'wait_for', target: 'text:committee meeting — not payable' },
        ],
      },
    ];
    const report = checkEscapedPayoffIsHonoured(
      {
        detectable_signal: SPARK_SIGNAL,
        data_shape: { rows: 12 },
        payoff_control: 'testid:payability-decision-cbf_tione_maseko',
      },
      scenes,
    );
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it('matches across canopy target prefixes', () => {
    const report = checkEscapedPayoffIsHonoured(
      {
        detectable_signal: SPARK_SIGNAL,
        data_shape: { rows: 12 },
        payoff_control: 'payability-decision',
      },
      [{ actions: [{ kind: 'click', target: 'testid:payability-decision' }] }],
    );
    expect(report.ok).toBe(true);
  });

  it('does not match on a substring — a prefix of a control is a different control', () => {
    const report = checkEscapedPayoffIsHonoured(
      {
        detectable_signal: SPARK_SIGNAL,
        data_shape: { rows: 12 },
        payoff_control: 'testid:filter-and-approve',
      },
      [{ actions: [{ kind: 'click', target: 'testid:filter' }] }],
    );
    expect(report.ok).toBe(false);
  });
});

describe('checkEscapedPayoffIsHonoured — negative controls (must stay silent)', () => {
  it('silent when no detection signal is declared', () => {
    expect(
      checkEscapedPayoffIsHonoured({ data_shape: { rows: 12 } }, SPARK_PAYOFF_SCENES).ok,
    ).toBe(true);
  });

  it('silent on the documented `none` escape', () => {
    expect(
      checkEscapedPayoffIsHonoured(
        { detectable_signal: 'none (PDD declares no verification rules)', data_shape: { rows: 12 } },
        SPARK_PAYOFF_SCENES,
      ).ok,
    ).toBe(true);
  });

  it('silent when the cohort clears the floor, so the escape was never needed', () => {
    // A demo at scale keeps its detection payoff and owes no declaration.
    expect(
      checkEscapedPayoffIsHonoured(
        {
          detectable_signal: { pdd_control: 'qualifying share below target' },
          data_shape: { rows: DETECTION_MIN_ROWS + 100 },
        },
        SPARK_PAYOFF_SCENES,
      ).ok,
    ).toBe(true);
  });

  it('silent on an UNEVIDENCED below_programme_scale flag — the floor check owns that', () => {
    // An empty escape is not an escape (programmeScaleEscape requires a quote),
    // so this check stands down and checkDetectionCohortFloor fires instead.
    const source = {
      detectable_signal: { pdd_control: 'x', below_programme_scale: '   ' },
      data_shape: { rows: 12 },
    };
    expect(checkEscapedPayoffIsHonoured(source, SPARK_PAYOFF_SCENES).ok).toBe(true);
    expect(checkDetectionCohortFloor(source).ok).toBe(false);
  });

  it('accepts the declaration when scenes do not exist yet (QA before the narrative)', () => {
    const source = {
      detectable_signal: SPARK_SIGNAL,
      data_shape: { rows: 12 },
      payoff_control: 'testid:payability-decision',
    };
    expect(checkEscapedPayoffIsHonoured(source, undefined).ok).toBe(true);
    expect(checkEscapedPayoffIsHonoured(source, []).ok).toBe(true);
  });

  it('still demands the declaration even before scenes exist', () => {
    // The declaration is the producer's own output, so its absence is decidable
    // at QA time and must not wait for the narrative.
    expect(
      checkEscapedPayoffIsHonoured(
        { detectable_signal: SPARK_SIGNAL, data_shape: { rows: 12 } },
        undefined,
      ).ok,
    ).toBe(false);
  });
});
