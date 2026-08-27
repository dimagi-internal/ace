import { describe, it, expect } from 'vitest';
import {
  checkGapCopy,
  deriveGapTerms,
  extractProseLines,
  type GapLike,
} from '../../lib/gap-copy-check';

/** The two capability gaps from hh-poverty-targeting/20260827-0323, abridged. */
const GAPS: GapLike[] = [
  {
    id: 'area-register-does-not-exist',
    type: 'CAPABILITY',
    detail:
      'The fourth Layer C control is coverage geometry. It cannot be shown: the visit ' +
      'form collects a free-text assigned-area field and the generator writes no value ' +
      'into it, so there is no area dimension on any surface. Bind it to a settlement ' +
      'register before making any coverage claim.',
  },
  {
    id: 'adjudication-log-is-run-state-not-a-register',
    type: 'CAPABILITY',
    detail:
      "The decision is written to the workflow run's state. That is not the durable, " +
      'queryable adjudication log the design describes as the validation harness.',
  },
  {
    id: 'detection-rates-are-not-evidenced',
    type: 'RESEARCH',
    detail: 'This dataset is synthetic and its outlier was seeded, so detection rates are unknown.',
  },
];

describe('deriveGapTerms', () => {
  it('takes the subject words the author used in BOTH the id and the detail', () => {
    expect(deriveGapTerms(GAPS[0])).toEqual(['area', 'register']);
  });

  it('drops generic product vocabulary that would match every surface', () => {
    // `run` and `state` are in this gap's id and detail, and would otherwise
    // flag any dashboard that says "this review run".
    const terms = deriveGapTerms(GAPS[1]);
    expect(terms).toContain('adjudication');
    expect(terms).not.toContain('run');
    expect(terms).not.toContain('state');
  });
});

describe('extractProseLines', () => {
  it('reads a JSX text node that WRAPS ACROSS LINES as one paragraph', () => {
    // Three of the four real ace#1750 instances lived on interior lines of a
    // wrapped paragraph, where neither `>` nor `<` appears on the line.
    const src = [
      '  <div style={{ fontSize: 13 }}>',
      '      asks whether one worker records that',
      '      answer far more often than colleagues working comparable areas.',
      '  </div>',
    ].join('\n');
    const prose = extractProseLines(src);
    expect(prose.some((p) => /records that answer far more often than colleagues/.test(p.text))).toBe(true);
  });

  it('does not mistake code for prose', () => {
    // A tag-aware character scanner desynchronises here: `i < n` opens a bogus
    // tag and `=>` closes it, after which code is reported as prose.
    const src = [
      'const f = (a, b) => a < b ? 1 : 0;',
      'const s = Object.assign({}, td, { textAlign: 5 });',
      'for (let i = 0; i < n; i++) { total += rows[i].count; }',
    ].join('\n');
    expect(extractProseLines(src)).toEqual([]);
  });
});

describe('checkGapCopy', () => {
  it('flags dashboard copy that asserts what a CAPABILITY gap forbids', () => {
    const code = [
      '  <div>',
      '      Worst location reading, outside the normal range for this area.',
      '  </div>',
    ].join('\n');
    const r = checkGapCopy(GAPS, [{ name: 'analysis', code }]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.gapId)).toContain('area-register-does-not-exist');
    expect(r.findings[0].term).toBe('area');
  });

  it('flags an adjudication-log claim the run state cannot back', () => {
    const code = '<p>Every decision here is written to the adjudication log with its reason.</p>';
    const r = checkGapCopy(GAPS, [{ name: 'analysis', code }]);
    expect(r.findings.map((f) => f.term)).toContain('adjudication');
  });

  it('passes copy that stays inside what the build supports', () => {
    const code = [
      '  <div>',
      '      Every decision recorded here is written onto this review run.',
      '      Peer comparisons exclude the worker being judged.',
      '  </div>',
    ].join('\n');
    expect(checkGapCopy(GAPS, [{ name: 'analysis', code }]).ok).toBe(true);
  });

  it('does not constrain on a RESEARCH gap', () => {
    // A RESEARCH gap means a QUANTIFIED claim is unevidenced; it does not forbid
    // the page naming the subject, and deciding otherwise is a judgement no
    // keyword match should make (ace#1238).
    const code = '<p>Detection rates are reported for every cycle.</p>';
    const r = checkGapCopy(GAPS, [{ name: 'analysis', code }]);
    expect(r.findings.map((f) => f.gapId)).not.toContain('detection-rates-are-not-evidenced');
  });

  it('reports its own derivation so an author can see why a line was flagged', () => {
    const r = checkGapCopy(GAPS, [{ name: 'x', code: '<p>nothing to see here at all</p>' }]);
    expect(r.termsByGap['area-register-does-not-exist']).toEqual(['area', 'register']);
  });
});
