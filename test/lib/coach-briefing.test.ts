import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  coachableIndicators,
  findOverstatements,
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
