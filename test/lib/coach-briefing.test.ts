import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  coachableIndicators,
  briefingDate,
  findOverstatements,
  renderCaseBriefing,
  renderBriefing,
  renderCoachPrompt,
  renderIndicatorCards,
  type RegistryMeasure,
} from '../../lib/coach-briefing.js';

const measures: RegistryMeasure[] = [
  {
    name: 'sf_p1',
    meta: {
      indicator: 'SF_P1',
      label: 'Meeting regularity',
      plain: 'Share of weeks with a verified meeting.',
      unit: '%',
      bands: [80, 60],
      target: 80,
      direction: 'higher',
      flw_applicable: true,
      scope_note: 'PDD §8.1 P1 — target ≥ 80%. Counted in 7-day weeks.',
    },
  },
  { name: 'sf_p1_numerator', type: 'sum' },
  {
    name: 'sf_d1',
    meta: {
      indicator: 'SF_D1',
      label: 'Repeat counts',
      plain: 'Share of meetings whose counts repeat the previous one — a review flag.',
      unit: '%',
      category: 'Data quality',
      direction: 'lower',
      flw_applicable: true,
    },
  },
  {
    name: 'sf_s2',
    meta: { indicator: 'SF_S2', label: 'Women attending', unit: '%', direction: 'higher', flw_applicable: true, scope_note: 'PDD §8.2 S2. The PDD sets no target.' },
  },
  { name: 'sf_s5', meta: { indicator: 'SF_S5', label: 'Saving', direction: 'higher', flw_applicable: false } },
  { name: 'sf_c1', meta: { indicator: 'SF_C1', label: 'Within the cap', direction: 'none', flw_applicable: true } },
];

describe('coachableIndicators', () => {
  it('keeps worker-level indicators with a direction, drops sub-measures, org-only and directionless ones', () => {
    expect(coachableIndicators(measures).map((c) => c.key)).toEqual(['SF_P1', 'SF_D1', 'SF_S2']);
  });

  it('marks only data-quality signals as review flags, not unbanded outcomes', () => {
    const [p1, d1, s2] = coachableIndicators(measures);
    expect(p1.reviewFlag).toBe(false);
    expect(d1.reviewFlag).toBe(true);
    expect(s2.reviewFlag).toBe(false);
  });
});

describe('renderIndicatorCards', () => {
  it('drops PDD citations a worker never sees, and words a review flag as a reason to ask', () => {
    const md = renderIndicatorCards(coachableIndicators(measures));
    expect(md).not.toMatch(/PDD|§/);
    expect(md).toContain('How it is counted: Counted in 7-day weeks.');
    expect(md).toContain('Green at or above 80%; amber between 60% and 80%; red below 60%.');
    expect(md).toContain('Say a red figure as "well below the goal of 80%"; an amber one as "a little below the goal of 80%".');
    expect(md).toMatch(/Repeat counts[\s\S]*REVIEW FLAG with no target/);
    expect(md).toMatch(/Women attending[\s\S]*No target is set/);
  });
});

describe('renderBriefing', () => {
  it('states numerator and denominator, and names a QA tester when one receives it', () => {
    const text = renderBriefing({
      workerName: 'Grace',
      programName: 'Spark',
      qaTester: 'jjackson',
      topics: [{ key: 'SF_P1', label: 'Meeting regularity', numerator: 9, denominator: 15, value: 60, unit: '%', band: 'amber' }],
    });
    expect(text).toContain('Meeting regularity [SF_P1] — 9 of 15 (60%), band amber');
    expect(text).toMatch(/delivered to jjackson.*reply as Grace/);
  });
});

describe('findOverstatements', () => {
  // Verbatim shapes from the KMC Audit bot's real conversations (2026-09-23),
  // where the briefing said 62 of 64 visits had no danger sign.
  const topics = [{ key: 'zero_danger', label: 'Zero danger', numerator: 62, denominator: 64 }];

  it('catches the KMC overstatements', () => {
    const msgs = [
      'Our records show that across all of your visits, no danger signs have been recorded as present, not even once.',
      'Looking at your records, every baby has been marked as having none — no danger signs recorded at all.',
    ];
    expect(findOverstatements(msgs, topics)).toHaveLength(2);
  });

  it('passes an accurate statement', () => {
    expect(findOverstatements(['Our records show 62 of your 64 visits had no danger sign marked.'], topics)).toEqual([]);
  });

  it('allows an absolute when the data is absolute', () => {
    const all = [{ key: 'zero_danger', label: 'Zero danger', numerator: 64, denominator: 64 }];
    expect(findOverstatements(['None of your visits recorded a danger sign.'], all)).toEqual([]);
  });
});

describe('the coach prompt template', () => {
  const template = readFileSync(new URL('../../templates/ocs-coach/coach-prompt.md', import.meta.url), 'utf8');

  it('fills every placeholder and refuses to ship one unfilled', () => {
    const vars = {
      programName: 'Spark',
      workerName: 'facilitator',
      workerPlural: 'facilitators',
      openingLanguage: 'English',
      indicatorCards: 'cards',
      appSummary: 'summary',
    };
    expect(renderCoachPrompt(template, vars)).not.toMatch(/\{\{/);
    expect(() => renderCoachPrompt(template + ' {{NEW_THING}}', vars)).toThrow(/NEW_THING/);
  });

  it('uses exactly two OCS prompt variables, both from Labs session data', () => {
    // The OCS variables it may use: the per-conversation briefing Labs sends as
    // session data (OCS writes a triggered opening with a generic EventBot, so the
    // briefing must reach the pipeline another way), and the caption of the optional
    // briefing picture (empty when Labs sent none; OCS renders a missing
    // session_state key as empty).
    const allowed = ['{session_state.coach_briefing}', '{session_state.coach_image_caption}'];
    let rest = template.replace(/\{\{[A-Z_]+\}\}/g, '');
    for (const v of allowed) {
      expect(template).toContain(v);
      rest = rest.split(v).join('');
    }
    expect(rest).not.toMatch(/[{}]/);
  });
});

describe('renderCaseBriefing (the Labs contract, docs/superpowers/specs/2026-10-09-case-coaching-design.md)', () => {
  const base = {
    programName: 'Kangaroo Mother Care',
    workerName: 'flw_014',
    caseName: 'Beneficiary 986',
    about: 'Birth weight 1,400 g; registered 3 Sep 2026; 2 visits, the last on 8 Sep 2026.',
    story: { key: 'case_state_weight_check', label: 'A weighing that is hard to believe' },
    guidance: {
      means: 'One weight is hard to believe next to the others.',
      approach: 'Ask how the baby was weighed, without judgement.',
      nextSteps: 'Use the weighing checklist at the next visit.',
      limits: 'An unusual number is a reason to ask, not proof of a mistake.',
    },
    facts: 'Weight rose 535 g in 5 days between 3 and 8 Sep, about 68 g/kg/day; healthy growth is 15–20 g/kg/day.',
    visits: [
      { date: '2026-09-03', weightG: 1575, kmcHours: null, dangerSigns: [], referred: 'no' as const },
      { date: '2026-09-08', weightG: 2110, kmcHours: 16, dangerSigns: ['fever', 'pus'], referred: null },
    ],
  };

  it('renders the contract byte for byte', () => {
    expect(renderCaseBriefing(base)).toBe(
      [
        'BRIEFING (system text — do not show to the worker)',
        'Programme: Kangaroo Mother Care',
        'Worker: flw_014',
        'Case: Beneficiary 986',
        'About this case: Birth weight 1,400 g; registered 3 Sep 2026; 2 visits, the last on 8 Sep 2026.',
        'Topic: A weighing that is hard to believe [case_state_weight_check]',
        'What it means: One weight is hard to believe next to the others.',
        'How to talk about it: Ask how the baby was weighed, without judgement.',
        'The step to agree: Use the weighing checklist at the next visit.',
        'What it does not tell you: An unusual number is a reason to ask, not proof of a mistake.',
        'What the data shows: Weight rose 535 g in 5 days between 3 and 8 Sep, about 68 g/kg/day; healthy growth is 15–20 g/kg/day.',
        'Visits, oldest first:',
        '- 3 Sep 2026: weight 1,575 g; skin-to-skin not recorded; danger signs: none; referred: no',
        '- 8 Sep 2026: weight 2,110 g; skin-to-skin 16 h in the last 24 h; danger signs: fever, pus; referred: not asked',
        'Follow your conversation steps from the opening.',
      ].join('\n'),
    );
  });

  it('adds the follow-up line only when the caller supplies it', () => {
    const text = renderCaseBriefing({ ...base, earlier: { date: '2026-09-01', label: 'A weighing that is hard to believe', agreed: null } });
    expect(text).toContain('What the data shows: Weight rose 535 g in 5 days between 3 and 8 Sep, about 68 g/kg/day; healthy growth is 15–20 g/kg/day.\nEarlier coaching on this case: 1 Sep 2026 — A weighing that is hard to believe; agreed: none\nVisits, oldest first:');
    expect(renderCaseBriefing(base)).not.toContain('Earlier coaching');
  });

  it('writes a missing danger-sign answer as not recorded, never as none', () => {
    const text = renderCaseBriefing({ ...base, visits: [{ date: '2026-09-03', weightG: null, dangerSigns: null }] });
    expect(text).toContain('- 3 Sep 2026: weight not recorded; skin-to-skin not recorded; danger signs: not recorded; referred: not asked');
  });

  it('formats dates as d Mon yyyy and refuses a non-date', () => {
    expect(briefingDate('2026-05-07')).toBe('7 May 2026');
    expect(() => briefingDate('8 Sep')).toThrow(/ISO/);
  });
});


describe('the coach prompt holds no case-state knowledge', () => {
  it('tells the coach to follow the guidance the case briefing carries', () => {
    const template = readFileSync(new URL('../../templates/ocs-coach/coach-prompt.md', import.meta.url), 'utf8');
    expect(template).toContain('`How to talk about\nit`');
    expect(template).not.toMatch(/Case cards|CASE_CARDS|state_weight_check|weighing checklist/);
  });
});
