import { describe, it, expect } from 'vitest';
import {
  checkGapCopy,
  deriveGapTerms,
  extractProseLines,
  narrativeSources,
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

/** The DECISION gap from the same run, abridged. Its subject term is `threshold`. */
const DECISION_GAP: GapLike = {
  id: 'threshold-values-need-a-decision',
  type: 'DECISION',
  detail:
    'The two thresholds the analysis page fires on were chosen for this demo. The ' +
    'programme design names the controls but sets no numbers for them.',
  proposed_action:
    'Review the flag list with the programme manager and set both thresholds from ' +
    'that distribution before any flag is shown to a supervisor.',
};

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

  it('does not constrain on a DECISION gap either', () => {
    // Same rule, second instance (ace#1762). A DECISION gap says the VALUES are
    // unchosen; it does not forbid naming thresholds. This copy is the gap's own
    // proposed remedy — set the numbers from evidence — not a contradiction of
    // it, and separating the two is a judgement no keyword match should make.
    const code =
      '<p>Recording the disposition is what makes a flag threshold tunable on evidence later.</p>';
    const r = checkGapCopy([...GAPS, DECISION_GAP], [{ name: 'analysis', code }]);
    expect(r.findings.map((f) => f.gapId)).not.toContain('threshold-values-need-a-decision');
    expect(r.termsByGap['threshold-values-need-a-decision']).toBeUndefined();
  });

  it('reports its own derivation so an author can see why a line was flagged', () => {
    const r = checkGapCopy(GAPS, [{ name: 'x', code: '<p>nothing to see here at all</p>' }]);
    expect(r.termsByGap['area-register-does-not-exist']).toEqual(['area', 'register']);
  });
});

/**
 * The real ace#1759 instance from hh-poverty-targeting/20260827-0323, abridged
 * but verbatim in the parts that matter: the brief declares that the decision
 * is run state with no durable register, and its own spine item then asserts
 * the disposition is recorded WITH ITS REASON — a field its own gap says does
 * not exist.
 */
const BRIEF = {
  spine: [
    {
      id: 'decisions-are-recorded',
      claim:
        'Recording each disposition with its reason is what makes these thresholds ' +
        'tunable on evidence rather than on impression.',
      rationale:
        'A flag that is reviewed and forgotten teaches nobody anything. The design is ' +
        'explicit that the adjudication log is the validation harness for the whole ' +
        'verification layer.',
    },
    {
      id: 'review-stays-human',
      claim: 'Every signal prompts a human to look and none of them rejects a visit.',
    },
  ],
  gaps: [
    {
      id: 'adjudication-log-is-run-state-not-a-register',
      type: 'CAPABILITY',
      detail:
        "The decision is written to the workflow run's state. That is not the durable, " +
        'queryable adjudication log the design describes as the validation harness.',
      proposed_action:
        'Promote the disposition to a first-class record keyed on (worker, flag, week) ' +
        'with its reason, so a later analysis can ask what share were upheld.',
    },
  ],
};

const SPEC = {
  scenes: [
    {
      id: 'the-decision-is-the-artefact',
      show: 'The per-worker decision control on the analysis page.',
      concept_claim:
        'The disposition lands in the adjudication log with its reason, so the ' +
        'thresholds can be tuned on evidence later.',
    },
    {
      id: 'the-week-looks-fine',
      show: 'The weekly operations overview for the whole cohort.',
      concept_claim:
        'Recording vacant and refused doors is what lets a supervisor tell a thin ' +
        'settlement from a thin surveyor.',
    },
  ],
};

describe('narrativeSources', () => {
  it('labels each string by the artifact field it came from', () => {
    const names = narrativeSources(BRIEF, SPEC).map((s) => s.name);
    expect(names).toContain('why_brief:spine[decisions-are-recorded].claim');
    expect(names).toContain('why_brief:spine[decisions-are-recorded].rationale');
    expect(names).toContain(
      'unified_spec:scenes[the-decision-is-the-artefact].concept_claim',
    );
    // Absent fields produce no entry rather than an empty one.
    expect(names).not.toContain('why_brief:spine[review-stays-human].rationale');
  });

  it('does not emit gap prose as a source at all', () => {
    // `gaps[]` is the section whose JOB is to discuss unsupported things, so it
    // is not scanned — against its own gap or any other (ace#1762).
    const names = narrativeSources(BRIEF, SPEC).map((s) => s.name);
    expect(names.some((n) => n.startsWith('why_brief:gaps['))).toBe(false);
  });

  it('tolerates a missing brief or spec', () => {
    expect(narrativeSources()).toEqual([]);
    expect(narrativeSources({}, {})).toEqual([]);
  });
});

describe('checkGapCopy over the narrative artifacts', () => {
  it('flags the brief contradicting the gap the brief itself declared', () => {
    // The real ace#1759 instance. `decisions-are-recorded` asserts the reason is
    // recorded; `adjudication-log-is-run-state-not-a-register` says the durable
    // register that would hold it does not exist.
    const r = checkGapCopy(BRIEF.gaps as GapLike[], narrativeSources(BRIEF, null));
    expect(r.ok).toBe(false);
    const hit = r.findings.find((f) =>
      f.source.startsWith('why_brief:spine[decisions-are-recorded]'),
    );
    expect(hit).toBeDefined();
    expect(hit!.gapId).toBe('adjudication-log-is-run-state-not-a-register');
    expect(hit!.term).toBe('adjudication');
  });

  it('flags a scene concept_claim that asserts what the gap forbids', () => {
    const r = checkGapCopy(BRIEF.gaps as GapLike[], narrativeSources(null, SPEC));
    expect(
      r.findings.map((f) => f.source),
    ).toContain('unified_spec:scenes[the-decision-is-the-artefact].concept_claim');
    // A scene that stays inside what the build supports is left alone.
    expect(
      r.findings.some((f) => f.source.includes('scenes[the-week-looks-fine]')),
    ).toBe(false);
  });

  it('does not flag gap prose against ANY gap, its own or another\'s', () => {
    // Every gap names its own subject — `detail` and `proposed_action` exist to
    // state the limit — and a proposed remedy routinely names ANOTHER gap's
    // subject on the way. The real ace#1762 instance is below: a RESEARCH gap
    // proposing to report rates "from the first cycle's adjudication log",
    // which the CAPABILITY gap says is run state and not a register. Nothing an
    // author can act on, and it is the whole gap list's failure mode.
    const brief = {
      spine: BRIEF.spine,
      gaps: [
        ...BRIEF.gaps,
        {
          id: 'detection-rates-are-not-evidenced',
          type: 'RESEARCH',
          detail: 'This dataset is synthetic and its outlier was seeded.',
          proposed_action:
            "Report sensitivity and false-positive rates from the first real cycle's " +
            'adjudication log, and state them alongside these checks.',
        },
      ],
    };
    const r = checkGapCopy(brief.gaps as GapLike[], narrativeSources(brief, SPEC));
    expect(r.findings.some((f) => f.source.startsWith('why_brief:gaps['))).toBe(false);

    // The omission is load-bearing, not a term that happens not to match: the
    // same two strings passed in as ordinary sources DO both match.
    const scanned = checkGapCopy(brief.gaps as GapLike[], [
      { name: 'gap-detail', text: brief.gaps[0].detail },
      { name: 'other-gap-action', text: brief.gaps[1].proposed_action },
    ]);
    expect(scanned.findings.map((f) => f.source).sort()).toEqual([
      'gap-detail',
      'other-gap-action',
    ]);
  });

  it('reports a prose source at line 1 with its text intact', () => {
    const r = checkGapCopy(BRIEF.gaps as GapLike[], [
      { name: 'why_brief:spine[x].claim', text: '  the adjudication log\n  holds the reason  ' },
    ]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(1);
    expect(r.findings[0].text).toBe('the adjudication log holds the reason');
  });

  it('still reads render_code alongside narrative sources in one call', () => {
    const r = checkGapCopy(BRIEF.gaps as GapLike[], [
      ...narrativeSources(BRIEF, null),
      { name: 'analysis', code: '<p>Written to the adjudication log with its reason.</p>' },
    ]);
    expect(r.findings.map((f) => f.source)).toContain('analysis');
    expect(r.findings.map((f) => f.source)).toContain(
      'why_brief:spine[decisions-are-recorded].rationale',
    );
  });
});
