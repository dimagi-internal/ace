/**
 * ace#2339 — the deck must end on the beat where the product acts.
 *
 * `arc_shape` carries a HARD CAP at 3 when the finale is not the strongest
 * moment; it is weighted .30 and every judge's overall is the MINIMUM across
 * its dimensions, so that cap alone holds a run under the 4.0 convergence bar
 * however good the rest is.
 *
 * The verbatim case is `spark-facilitator/20260909-1211`: six scenes, peak at
 * scene 4, the one state-changing beat at scene 5, and a prose-only scene 6
 * over "the run's emptiest screen". The material for a strong finale was
 * already in the deck — it just was not last.
 *
 * The negative controls are the point of the file. This family has already
 * retracted one rule (ace#1660) and pruned another (ace#1841) for firing on
 * specs that were fine; a fourth false positive here would be the pattern, not
 * an accident.
 */
import { describe, it, expect } from 'vitest';
import { checkArcLadder, type LadderSpec } from '../../lib/demo-arc-ladder.js';

/** The deck that shipped, actions reduced to the shape the check reads. */
const SHIPPED: LadderSpec = {
  scenes: [
    { title: 'Twelve communities, seven steps, thirteen weeks', actions: [{ kind: 'wait_for', target: 'text:9 of 12' }] },
    { title: 'What a record has to clear to be paid', actions: [{ kind: 'click', target: 'testid:view-payment-rules' }] },
    { title: 'The same window, one row per record', actions: [{ kind: 'wait_for', target: 'text:Why 24 records were not paid' }] },
    { title: 'A record that is correct and earns nothing', actions: [{ kind: 'click', target: 'testid:record-bwanje-2026-09-02' }] },
    { title: 'What a reviewer writes back', actions: [{ kind: 'click', target: 'testid:record-review-confirm' }] },
    { title: 'What this pilot has not set', actions: [{ kind: 'click', target: 'testid:view-open-parameters' }] },
  ],
};

describe('checkArcLadder — the shipped defect (ace#2339)', () => {
  it('flags a deck whose last state change is followed by inert scenes', () => {
    // Scene 6 as it would be WITHOUT its disclosure click: prose over a static frame.
    const deck: LadderSpec = {
      scenes: [
        ...SHIPPED.scenes!.slice(0, 5),
        { title: 'What this pilot has not set', actions: [{ kind: 'hold' }] },
      ],
    };
    const r = checkArcLadder(deck);
    expect(r.pass).toBe(false);
    expect(r.findings[0].kind).toBe('payoff-followed-by-decline');
    expect(r.lastActionSceneIndex).toBe(5);
    expect(r.findings[0].detail).toMatch(/REORDER, not new material/);
  });

  it('names how many inert scenes trail the payoff', () => {
    const deck: LadderSpec = {
      scenes: [
        { title: 'peak', actions: [{ kind: 'click', target: 'testid:x' }] },
        { title: 'recap a', actions: [{ kind: 'hold' }] },
        { title: 'recap b', actions: [{ kind: 'wait_for', target: 'text:y' }] },
      ],
    };
    const r = checkArcLadder(deck);
    expect(r.pass).toBe(false);
    expect(r.findings[0].detail).toContain('scene 1 of 3');
    expect(r.findings[0].detail).toContain('2 inert scene(s) follow');
  });

  it('flags a deck where nothing ever changes the page', () => {
    const r = checkArcLadder({
      scenes: [
        { title: 'a', actions: [{ kind: 'wait_for', target: 'text:x' }] },
        { title: 'b', actions: [{ kind: 'scroll_to', target: 'text:y' }] },
      ],
    });
    expect(r.pass).toBe(false);
    expect(r.findings[0].kind).toBe('finale-is-not-the-payoff');
    expect(r.lastActionSceneIndex).toBeNull();
  });

  it('scroll is NOT a state change — it re-frames what was already rendered', () => {
    const r = checkArcLadder({
      scenes: [{ title: 'only', actions: [{ kind: 'scroll', target: 'bottom' }] }],
    });
    expect(r.pass).toBe(false);
  });
});

describe('checkArcLadder — decks that end correctly pass', () => {
  it('passes the reordered ladder: action last', () => {
    const r = checkArcLadder({
      scenes: [
        { title: 'Opp KPIs — the window and the funnel', actions: [{ kind: 'click', target: 'testid:view-payment-rules' }] },
        { title: 'Worker KPIs — one row per facilitator', actions: [{ kind: 'click', target: 'testid:below-target-filter' }] },
        { title: 'A record that is correct and earns nothing', actions: [{ kind: 'click', target: 'testid:record-bwanje-2026-09-02' }] },
        { title: 'The reviewer confirms it', actions: [{ kind: 'click', target: 'testid:record-review-confirm' }] },
      ],
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
    expect(r.lastActionSceneIndex).toBe(4);
  });

  it('passes when the final scene mixes a state change with reads', () => {
    const r = checkArcLadder({
      scenes: [
        { title: 'a', actions: [{ kind: 'click', target: 'testid:x' }] },
        {
          title: 'finale',
          actions: [
            { kind: 'scroll_to', target: 'text:panel' },
            { kind: 'click', target: 'testid:confirm' },
            { kind: 'wait_for', target: 'text:Recorded' },
          ],
        },
      ],
    });
    expect(r.pass).toBe(true);
  });

  it('accepts every state-changing verb the variety check accepts', () => {
    for (const kind of ['click', 'type', 'fill', 'select', 'hover', 'press', 'check', 'uncheck', 'upload', 'drag', 'goto']) {
      const r = checkArcLadder({ scenes: [{ title: kind, actions: [{ kind }] }] });
      expect(r.pass, `${kind} should count as a state change`).toBe(true);
    }
  });
});

describe('checkArcLadder — negative controls (must not fire)', () => {
  it('silent on an empty or absent deck — it evaluated nothing', () => {
    expect(checkArcLadder(undefined).pass).toBe(true);
    expect(checkArcLadder({}).judged).toBe(0);
    expect(checkArcLadder({ scenes: [] }).judged).toBe(0);
  });

  it('stands down on an EVIDENCED finale_is_read declaration', () => {
    const deck: LadderSpec = {
      ...SHIPPED,
      scenes: [
        { title: 'a', actions: [{ kind: 'click', target: 'testid:x' }] },
        { title: 'the number itself is the point', actions: [{ kind: 'hold' }] },
      ],
      finale_is_read: 'The payoff is the coverage figure itself; there is no control to operate on it.',
    };
    expect(checkArcLadder(deck).pass).toBe(true);
  });

  it('accepts the object form of the escape', () => {
    const deck: LadderSpec = {
      scenes: [{ title: 'a', actions: [{ kind: 'hold' }] }],
      finale_is_read: { reason: 'A funder-facing coverage map has no interactive payoff.' },
    };
    expect(checkArcLadder(deck).pass).toBe(true);
  });

  it('an UNEVIDENCED finale_is_read is not an escape — a blank flag silences nothing', () => {
    for (const v of ['', '   ', true, {}, { reason: '  ' }, null]) {
      const deck: LadderSpec = {
        scenes: [{ title: 'a', actions: [{ kind: 'hold' }] }],
        finale_is_read: v as unknown,
      };
      expect(checkArcLadder(deck).pass, `finale_is_read=${JSON.stringify(v)} must not silence`).toBe(false);
    }
  });

  it('a single-scene deck that acts is fine — no trailing decline is possible', () => {
    const r = checkArcLadder({ scenes: [{ title: 'only', actions: [{ kind: 'click', target: 'testid:x' }] }] });
    expect(r.pass).toBe(true);
    expect(r.lastActionSceneIndex).toBe(1);
  });

  it('does not care WHERE earlier state changes are — only that the last scene acts', () => {
    // Deliberately front-loaded: this check has one opinion, and inventing a
    // second (pacing, rung ordering) is how it would become a false-positive rule.
    const r = checkArcLadder({
      scenes: [
        { title: 'a', actions: [{ kind: 'click', target: 'testid:1' }] },
        { title: 'b', actions: [{ kind: 'click', target: 'testid:2' }] },
        { title: 'c', actions: [{ kind: 'click', target: 'testid:3' }] },
      ],
    });
    expect(r.pass).toBe(true);
  });
});
