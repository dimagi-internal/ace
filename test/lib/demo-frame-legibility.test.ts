/**
 * The LEGIBILITY tier — can a rendered frame be READ? (ace#2219)
 *
 * Fixtures in this file are VERBATIM from
 * `~/.canopy/ddd/runs/connect-labs/poverty-graduation-targeting-stage-2026-09-07-001/`
 * (`unified_spec.yaml`, `verdict-concept.yaml`, `verdict-user.yaml`), the fifth
 * Phase 7 run to end at concept 2.0/5. They are not paraphrases: the scroll
 * values are the spec's own, and the coined terms are the strings the judges
 * quoted back.
 *
 * The control cases matter as much as the failing ones. A check that cannot be
 * satisfied is a check authors route around, which is how ace#1841's and
 * ace#2131's narrow rules were each evaded by the next run.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  checkScrollFraming,
  checkCoinedTerms,
  type LegibilityFinding,
  type LegibilitySpec,
  type DashboardTerm,
  type TermDefinition,
} from '../../lib/demo-frame-legibility';

/**
 * `poverty-graduation/20260905-1345`'s spec, actions verbatim.
 *
 * Five `kind: scroll` (`'400'`, `'1280'`, `'bottom'`, `'320'`, `'top'`) and one
 * `scroll_to`. Three of the five are raw pixel guesses about how a page this
 * spec does not own renders.
 */
const POVERTY_GRADUATION_SPEC: LegibilitySpec = {
  scenes: [
    {
      id: 'the-programme-on-one-screen',
      title: 'Six weeks of a graduation programme, on one screen',
      actions: [
        { kind: 'goto', target: '${targeting_stage_par_url}' },
        { kind: 'wait_for', target: 'text:Targeting stage - weeks 1 to 6' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'six-weeks-of-census-saturation',
      title: 'What census saturation costs, in visits nobody pays for',
      actions: [
        { kind: 'scroll', value: '400' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'a-score-computed-in-the-app',
      title: 'A poverty score the app computes, not one a worker decides',
      actions: [
        { kind: 'scroll', value: '1280' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'the-threshold-is-not-ours',
      title: 'The decision this screen deliberately does not make',
      actions: [
        { kind: 'scroll', value: 'bottom' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'what-the-supervisor-sees',
      title: 'Monday morning, twelve workers',
      actions: [
        { kind: 'goto', target: '${flw_review_par_url}' },
        { kind: 'wait_for', target: 'text:Field-worker review - targeting quality' },
        { kind: 'scroll', value: '320' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'the-answer-profile-outlier',
      title: 'A different column, not a longer list',
      actions: [
        { kind: 'scroll', value: 'top' },
        { kind: 'click', target: 'testid:outliers-only' },
        { kind: 'wait_for', target: 'text:Showing 1 of 12 workers' },
        { kind: 'hold', seconds: 4 },
      ],
    },
    {
      id: 'the-decision-and-what-it-is-not',
      title: 'Recording the decision, and being honest about the record',
      actions: [
        { kind: 'click', target: 'testid:review-umar_b' },
        { kind: 'click', target: 'testid:status-umar_b-underperforming' },
        { kind: 'scroll_to', target: 'text:How the outlier column is decided' },
        { kind: 'hold', seconds: 4 },
      ],
    },
  ],
};

/**
 * The coined labels the jargon hard cap fired on, quoted from
 * `verdict-concept.yaml` (`concept_clarity`) and `verdict-user.yaml` (`clarity`).
 */
const COINED_TERMS: DashboardTerm[] = [
  { label: '31-point band', surface: 'row label' },
  { label: '10-point band', surface: 'row label' },
  { label: 'Surveys in the 31-point band', surface: 'column header' },
  { label: 'Mean likelihood below the line', surface: 'column header' },
  { label: 'Payable', surface: 'column header' },
  { label: 'Non-payable', surface: 'column header' },
];

const blocking = (fs: LegibilityFinding[]) => fs.filter((f) => f.blocking);
const kinds = (fs: LegibilityFinding[]) => fs.map((f) => f.kind);

describe('checkScrollFraming — a pixel offset guesses at a page it does not own', () => {
  it('fails the poverty-graduation spec on its three pixel scrolls', () => {
    const r = checkScrollFraming(POVERTY_GRADUATION_SPEC);

    expect(r.pass).toBe(false);
    const pixel = r.findings.filter((f) => f.kind === 'pixel-scroll-framing');
    expect(pixel.map((f) => f.scene)).toEqual([
      'six-weeks-of-census-saturation',
      'a-score-computed-in-the-app',
      'what-the-supervisor-sees',
    ]);
    expect(pixel.every((f) => f.blocking)).toBe(true);
    // The value the author wrote is named back, so the fix is unambiguous.
    expect(pixel[2].detail).toContain('320');
  });

  it('treats top and bottom more softly — deterministic, but still unanchored', () => {
    const r = checkScrollFraming(POVERTY_GRADUATION_SPEC);
    const soft = r.findings.filter((f) => f.kind === 'unanchored-scroll-framing');

    expect(soft.map((f) => f.scene)).toEqual([
      'the-threshold-is-not-ours',
      'the-answer-profile-outlier',
    ]);
    expect(soft.some((f) => f.blocking)).toBe(false);
  });

  it('leaves the one scroll_to scene alone', () => {
    const r = checkScrollFraming(POVERTY_GRADUATION_SPEC);
    expect(r.findings.map((f) => f.scene)).not.toContain('the-decision-and-what-it-is-not');
  });

  it('counts what it judged, so zero findings is measured and not assumed', () => {
    expect(checkScrollFraming(POVERTY_GRADUATION_SPEC).judged).toBe(5);
    expect(checkScrollFraming({ scenes: [] }).judged).toBe(0);
  });

  it('CONTROL — a spec that anchors every frame passes clean', () => {
    const r = checkScrollFraming({
      scenes: [
        {
          id: 'what-the-supervisor-sees',
          actions: [
            { kind: 'goto', target: '${flw_review_par_url}' },
            { kind: 'scroll_to', target: 'testid:worker-review-table' },
            { kind: 'hold', seconds: 4 },
          ],
        },
      ],
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('ignores a scroll that no judged frame follows', () => {
    // Scrolled, then navigated away — nothing was captured at that position.
    const r = checkScrollFraming({
      scenes: [
        {
          id: 'transient',
          actions: [
            { kind: 'scroll', value: '900' },
            { kind: 'goto', target: '${other_par_url}' },
            { kind: 'hold', seconds: 3 },
          ],
        },
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.judged).toBe(0);
  });

  it('judges a trailing scroll — the scene end frame is the judged still', () => {
    const r = checkScrollFraming({
      scenes: [{ id: 'ends-scrolled', actions: [{ kind: 'scroll', value: '640' }] }],
    });
    expect(kinds(r.findings)).toEqual(['pixel-scroll-framing']);
  });

  it('reads an omitted value as canopy does — the ScrollAction default is bottom', () => {
    const r = checkScrollFraming({
      scenes: [
        { id: 'defaulted', actions: [{ kind: 'scroll' }, { kind: 'hold', seconds: 2 }] },
      ],
    });
    expect(kinds(r.findings)).toEqual(['unanchored-scroll-framing']);
    expect(r.pass).toBe(true);
  });

  it('reads a numeric value as a pixel guess, not only a numeric string', () => {
    const r = checkScrollFraming({
      scenes: [{ id: 'numeric', actions: [{ kind: 'scroll', value: 430 }] }],
    });
    expect(kinds(r.findings)).toEqual(['pixel-scroll-framing']);
  });
});

describe('checkCoinedTerms — a label a lay viewer cannot read needs a definition', () => {
  it('fails every coined term when the page defines none', () => {
    const r = checkCoinedTerms(COINED_TERMS, []);

    expect(r.pass).toBe(false);
    expect(r.judged).toBe(6);
    expect(r.findings).toHaveLength(6);
    expect(new Set(kinds(r.findings))).toEqual(new Set(['undefined-term']));
    expect(r.findings.map((f) => f.term)).toContain('Mean likelihood below the line');
  });

  it('still fails when the definitions exist only in a panel elsewhere on the page', () => {
    // Iteration 2 of the real run: the "What each column means" panel was
    // VERIFIED PRESENT and correct, and the jargon cap fired on six of seven
    // scenes anyway, because the panel is below the fold of every frame that
    // uses the vocabulary.
    const panel: TermDefinition[] = COINED_TERMS.map((t) => ({
      term: t.label,
      at_point_of_use: false,
      where: 'What each column means panel',
    }));

    const r = checkCoinedTerms(COINED_TERMS, panel);
    expect(r.pass).toBe(false);
    expect(new Set(kinds(r.findings))).toEqual(new Set(['definition-not-at-point-of-use']));
    expect(blocking(r.findings)).toHaveLength(6);
  });

  it('does not block a panel definition for a label that is not on a hero surface', () => {
    const r = checkCoinedTerms(
      [{ label: 'Cohort median', surface: 'footnote', prominent: false }],
      [{ term: 'Cohort median', at_point_of_use: false, where: 'glossary panel' }],
    );
    expect(r.pass).toBe(true);
    expect(kinds(r.findings)).toEqual(['definition-not-at-point-of-use']);
    expect(blocking(r.findings)).toHaveLength(0);
  });

  it('CONTROL — every term glossed at its point of use passes clean', () => {
    const defined: TermDefinition[] = COINED_TERMS.map((t) => ({
      term: t.label,
      at_point_of_use: true,
      where: 'info affordance on the column header',
    }));

    const r = checkCoinedTerms(COINED_TERMS, defined);
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.judged).toBe(6);
  });

  it('matches a definition case- and whitespace-insensitively', () => {
    const r = checkCoinedTerms(
      [{ label: 'Surveys in the 31-point band' }],
      [{ term: '  surveys in the 31-POINT band ', at_point_of_use: true }],
    );
    expect(r.findings).toEqual([]);
  });

  it('reports a glossary that has drifted from the render, without blocking', () => {
    const r = checkCoinedTerms(
      [{ label: 'Payable', prominent: true }],
      [
        { term: 'Payable', at_point_of_use: true },
        { term: 'Verified share', at_point_of_use: true },
      ],
    );
    expect(kinds(r.findings)).toEqual(['orphan-definition']);
    expect(r.pass).toBe(true);
  });

  it('says so when nothing was enumerated — an empty list is not evidence', () => {
    const r = checkCoinedTerms([], []);
    expect(kinds(r.findings)).toEqual(['no-terms-enumerated']);
    expect(r.pass).toBe(true);
    expect(r.judged).toBe(0);
  });
});

/**
 * The ace#1660 audit, applied to the tier written after it.
 *
 * ace#1660's retracted check told authors to write `offset: 96` on a
 * `scroll_to`, which canopy REFUSES (`_ActionBase` sets `extra="forbid"`). This
 * tier's whole remedy is about scroll actions, so it is the single most likely
 * place to re-invent that syntax. The pin below is copied from
 * `test/lib/ddd-scene-actions.test.ts`, which derived it by constructing
 * canopy's own pydantic models.
 */
describe('remediation vocabulary is expressible in canopy (ace#1660)', () => {
  const ACTION_FIELDS = [
    'attr', 'kind', 'layer', 'must_succeed', 'note', 'pattern', 'points',
    'seconds', 'source', 'target', 'timeout_ms', 'tool', 'value', 'var', 'zoom',
  ];
  const SCENE_FIELDS = [
    'actions', 'concept_claim', 'design_intent', 'features', 'full_page', 'id',
    'impressive_because', 'narrative', 'pace', 'persona', 'provenance', 'role',
    'show', 'title', 'url', 'viewport',
  ];
  const PREFIXES = ['css', 'text', 'testid', 'aria', 'role'];
  const VOCABULARY = new Set([...ACTION_FIELDS, ...SCENE_FIELDS, ...PREFIXES]);

  // Colon-free inputs: we are auditing what this module WROTE, not what a
  // caller interpolated into it.
  const everyFinding = (): LegibilityFinding[] => [
    ...checkScrollFraming({
      scenes: [
        { id: 'pixel', actions: [{ kind: 'scroll', value: '430' }] },
        { id: 'anchorless', actions: [{ kind: 'scroll', value: 'bottom' }] },
      ],
    }).findings,
    ...checkCoinedTerms(
      [{ label: 'Payable' }, { label: 'Cohort median', prominent: false }],
      [
        { term: 'Cohort median', at_point_of_use: false },
        { term: 'Verified share', at_point_of_use: true },
      ],
    ).findings,
    ...checkCoinedTerms([], []).findings,
  ];

  it('generates at least one finding of every kind it can emit', () => {
    expect(new Set(kinds(everyFinding()))).toEqual(
      new Set([
        'pixel-scroll-framing',
        'unanchored-scroll-framing',
        'undefined-term',
        'definition-not-at-point-of-use',
        'orphan-definition',
        'no-terms-enumerated',
      ]),
    );
  });

  it('names no key canopy does not accept', () => {
    for (const f of everyFinding()) {
      for (const [, key] of f.detail.matchAll(/([a-z_][a-z0-9_]*):/g)) {
        expect(
          VOCABULARY.has(key),
          `finding "${f.kind}" names "${key}:" — either canopy vocabulary (add it ` +
            `to the pin with its source) or invented syntax canopy will reject ` +
            `(ace#1660), or prose that wants a dash.\n  detail: ${f.detail}`,
        ).toBe(true);
      }
    }
  });

  it('never names offset — the retracted ace#1660 remediation', () => {
    for (const f of everyFinding()) expect(f.detail).not.toMatch(/\boffset\b/);
  });

  it('names scroll_to as the remedy, since that is the whole point', () => {
    const pixel = everyFinding().filter((f) => f.kind === 'pixel-scroll-framing');
    expect(pixel).toHaveLength(1);
    expect(pixel[0].detail).toContain('scroll_to');
  });

  it('offset is still absent from canopy on disk, when canopy is on disk', () => {
    const root = `${process.env.HOME}/.claude/plugins/cache/canopy/canopy`;
    if (!existsSync(root)) return; // CI has no plugin cache; the pin stands alone.
    const newest = readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) =>
        a.split('.').map(Number).reduce((s, n, i) => s || n - Number(b.split('.')[i]), 0),
      )
      .pop();
    const models = `${root}/${newest}/runtime/scripts/narrative/models.py`;
    if (!existsSync(models)) return;
    const src = readFileSync(models, 'utf8');
    expect(/^\s{4}offset:/m.test(src), `offset declared in ${newest}`).toBe(false);
    // And the two actions this tier reasons about are still the two it thinks.
    expect(src).toContain('kind: Literal["scroll_to"]');
    expect(src).toContain('kind: Literal["scroll"]');
  });
});
