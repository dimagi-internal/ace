import { describe, it, expect } from 'vitest';
import * as yamlLib from 'js-yaml';
import {
  parseTrainingSpec,
  lintDeckFormatting,
  FORMATTING_BUDGETS,
  TrainingDeckSpecSchema,
  statsUnitMismatches,
} from '../../lib/training-deck-spec';

/**
 * Slides must fit their frames. Overflow is the enforceable half of
 * "well formatted" (operator decision 2026-09-09).
 *
 * ## Why a budget check rather than a style review
 *
 * "Well formatted and presented in the most effective way" is not directly
 * assertable, and pretending otherwise produces the worst kind of check — one
 * that passes on anything. But the specific way these decks GO wrong is
 * mechanical: the Dimagi stencil text frames are fixed-size, so body copy past
 * a certain length does not reflow smaller, it spills out of the shape or gets
 * clipped by Slides. No downstream check looks at pixels, so an overflowing
 * slide renders, passes every structural gate, and is first noticed by a room
 * of FLWs.
 *
 * The deck already pinned the two title budgets it had been burned by (cover
 * ≤ 28 chars, section ≤ 24). This extends the same treatment to the
 * text-carrying fields.
 *
 * ## Where the check lives, and why that matters
 *
 * Inside `parseTrainingSpec` — the function every render path already calls —
 * not in a helper the render skill is told to invoke. ace#1877 shipped exactly
 * that shape: a correct helper, a skill line saying "call it", and no caller.
 * It read as done for a release. The last test here is the anti-orphan one: it
 * asserts enforcement happens at the parse boundary.
 */

function specYaml(slidesYaml: string): string {
  return `slug: test-opp
name: Test Training
program: Test Program
archetype: atomic-visit
template_id: tmpl_abc
generated_at: "2026-05-23T00:00:00Z"
source:
  pdd_doc_id: doc_123
  run_id: run_456
manifest:
  common:
    logo: drive:logo123
voice:
  audience: flw
  language: en
modules:
  - id: m1
    title: Module One
    slides:
${slidesYaml}
`;
}

const COVER = `      - id: cover
        layout: cover
        title: Test
        subtitle: Sub`;

describe('deck formatting budgets', () => {
  it('accepts a slide inside every budget', () => {
    const spec = parseTrainingSpec(
      specYaml(
        `${COVER}
      - id: s1
        layout: content
        title: A reasonable title
        body: |
          Take one photo of the turmeric with the scratchcard in frame.
          Confirm the price before you leave the stall.`,
      ),
    );
    expect(lintDeckFormatting(spec)).toEqual([]);
  });

  it('flags body copy past the character budget as an error', () => {
    const findings = lintDeckFormatting(
      parseTrainingSpecLenient(
        `${COVER}
      - id: wall
        layout: content
        title: Too much
        body: "${'x'.repeat(FORMATTING_BUDGETS.bodyChars + 50)}"`,
      ),
    );
    const hit = findings.find((f) => f.rule === 'bodyChars');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.slideId).toBe('wall');
  });

  it('flags too many body lines as an error', () => {
    const lines = Array.from({ length: FORMATTING_BUDGETS.bodyLines + 3 }, (_, i) => `          line ${i}`).join('\n');
    const findings = lintDeckFormatting(
      parseTrainingSpecLenient(
        `${COVER}
      - id: listy
        layout: content
        title: Long list
        body: |
${lines}`,
      ),
    );
    expect(findings.find((f) => f.rule === 'bodyLines')?.severity).toBe('error');
  });

  it('flags too many agenda items as an error', () => {
    const items = Array.from(
      { length: FORMATTING_BUDGETS.agendaItems + 2 },
      (_, i) => `          - { label: "Item ${i}" }`,
    ).join('\n');
    const findings = lintDeckFormatting(
      parseTrainingSpecLenient(
        `${COVER}
      - id: agenda
        layout: agenda
        title: Agenda
        items:
${items}`,
      ),
    );
    expect(findings.find((f) => f.rule === 'agendaItems')?.severity).toBe('error');
  });

  it('flags an over-long single bullet as a warning, not an error', () => {
    // Legible, just poorly presented — must not halt a run.
    const findings = lintDeckFormatting(
      parseTrainingSpecLenient(
        `${COVER}
      - id: wrapper
        layout: content
        title: One long line
        body: "${'y'.repeat(FORMATTING_BUDGETS.bodyLineChars + 10)}"`,
      ),
    );
    expect(findings.find((f) => f.rule === 'bodyLineChars')?.severity).toBe('warn');
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('parseTrainingSpec THROWS on an error-severity violation (anti-orphan)', () => {
    // The load-bearing assertion. If the lint were only reachable through a
    // helper the skill is asked to call, this would pass while nothing enforced
    // anything in production.
    expect(() =>
      parseTrainingSpec(
        specYaml(
          `${COVER}
      - id: wall
        layout: content
        title: Too much
        body: "${'x'.repeat(FORMATTING_BUDGETS.bodyChars + 50)}"`,
        ),
      ),
    ).toThrow(/formatting budget/i);
  });

  it('the thrown error names the slide and tells you to split it', () => {
    let message = '';
    try {
      parseTrainingSpec(
        specYaml(
          `${COVER}
      - id: offending-slide
        layout: content
        title: Too much
        body: "${'x'.repeat(FORMATTING_BUDGETS.bodyChars + 50)}"`,
        ),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('offending-slide');
    expect(message).toMatch(/splitting the offending slides/);
    // Explicitly discourages the lazy fix.
    expect(message).toMatch(/not by raising the budgets/);
  });
});

/**
 * Parse WITHOUT the budget enforcement, so the lint's own findings can be
 * inspected for cases `parseTrainingSpec` would reject outright.
 */
function parseTrainingSpecLenient(slidesYaml: string) {
  return TrainingDeckSpecSchema.parse(yamlLib.load(specYaml(slidesYaml)));
}

/**
 * ace#2205: `USD 3 / USD 3 / 0` on poverty-graduation/20260905-1345 slide 6 —
 * the bare `0` read as a footnote beside two unit-carrying peers. A spec rule
 * (the stencil cannot know `0` means `USD 0`), so a `warn`, not a parse error.
 */
describe('statsUnits — sibling stat values share their unit (ace#2205)', () => {
  const statsSlide = (bigs: string[]) => `${COVER}
      - id: pay
        layout: stats
        title: Pay
        stats:
${bigs.map((b, i) => `          - big: "${b}"\n            label: "label ${i}"`).join('\n')}`;

  it('flags a bare numeral beside unit-carrying siblings, suggesting the unit', () => {
    const findings = lintDeckFormatting(parseTrainingSpec(specYaml(statsSlide(['USD 3', 'USD 3', '0']))))
      .filter((f) => f.rule === 'statsUnits');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ slideId: 'pay', severity: 'warn' });
    expect(findings[0].detail).toContain('"USD 0"');
  });

  it('passes the fixed row', () => {
    const findings = lintDeckFormatting(parseTrainingSpec(specYaml(statsSlide(['USD 3', 'USD 3', 'USD 0']))));
    expect(findings.filter((f) => f.rule === 'statsUnits')).toEqual([]);
  });

  it('does not flag siblings with different units, or an all-bare row', () => {
    for (const row of [['USD 3', '300 visits', '25%'], ['3', '10', '0']]) {
      const findings = lintDeckFormatting(parseTrainingSpec(specYaml(statsSlide(row))));
      expect(findings.filter((f) => f.rule === 'statsUnits'), row.join(' / ')).toEqual([]);
    }
  });

  it('carries a suffix unit over too', () => {
    expect(statsUnitMismatches([{ big: '25%' }, { big: '0' }])[0].suggestion).toBe('0%');
  });

  it('is a warn, so parseTrainingSpec does not refuse the spec', () => {
    expect(() => parseTrainingSpec(specYaml(statsSlide(['USD 3', '0'])))).not.toThrow();
  });
});
