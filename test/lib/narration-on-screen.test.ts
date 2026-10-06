// ace#2727 — narration must say what the END FRAME shows, and a page edit must
// not silently falsify a locked claim. Both observed on
// spark-facilitator/20261004-1706's Phase 7 demo: narration "100% as of 12 Jul"
// was a tooltip-only value; a page fix merged two identical peer-median columns
// under narration that said "both peer medians".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkNarratedFiguresOnScreen,
  extractNarratedFigures,
  narrationClaimsBySurface,
  renderClaimsLedger,
  type NarratedScene,
} from '../../lib/narration-on-screen';

const ROOT = join(__dirname, '../..');

describe('extractNarratedFigures', () => {
  it('finds percentages, N-of-M, money and dates; leaves bare integers alone', () => {
    expect(extractNarratedFigures('Step 7 reached 100% as of 12 Jul; 35 of 173 records, USD 3 each, over 13 weeks')).toEqual([
      '100%',
      '12 Jul',
      '35 of 173',
      'USD 3',
    ]);
  });

  it('keeps the longest overlapping figure', () => {
    expect(extractNarratedFigures('as of 12 July 2026, 62.2% held')).toEqual(['12 July 2026', '62.2%']);
  });
});

describe('checkNarratedFiguresOnScreen', () => {
  const programme = '${programme_par_url}';

  it('flags the observed tooltip-only claim ("100% as of 12 Jul") as hover-only', () => {
    const scenes: NarratedScene[] = [
      {
        id: 'step7',
        url: programme,
        narrative: 'Every partner is at 100% as of 12 Jul.',
        actions: [{ kind: 'hover', target: 'css:td[data-ind="SF_P3"]' }],
        features: [{ description: 'Step 7 cell', verify: 'hovering the Step 7 cell shows a tooltip "100% as of 12 Jul"' }],
      },
    ];
    const r = checkNarratedFiguresOnScreen(scenes);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.kind, f.figure])).toEqual([
      ['hover-only-figure', '100%'],
      ['hover-only-figure', '12 Jul'],
    ]);
  });

  it('flags a narrated figure nothing anchors to the end frame', () => {
    const r = checkNarratedFiguresOnScreen([{ title: 'lagging', narrative: 'Its regularity sits at 62%.' }]);
    expect(r.findings).toMatchObject([{ kind: 'unanchored-figure', scene: 'lagging', figure: '62%' }]);
  });

  it('accepts a figure anchored by a features[].verify naming where it is on screen', () => {
    const r = checkNarratedFiguresOnScreen([
      {
        title: 'lagging',
        narrative: ["Tsogolo Women's Forum (example) holds 62% of planned meetings."],
        features: [{ verify: 'the Meeting regularity column of the partner table reads 62% on that row' }],
      },
    ]);
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it('accepts a figure gated by a wait_for, and ignores narration with no figures', () => {
    const r = checkNarratedFiguresOnScreen([
      { narrative: 'Five of the partners appear.', actions: [] },
      { narrative: 'The flag rate is 92%.', actions: [{ kind: 'wait_for', target: 'text:92%' }] },
    ]);
    expect(r.ok).toBe(true);
  });

  it('flags narration that itself tells the viewer to hover', () => {
    const r = checkNarratedFiguresOnScreen([
      { narrative: 'Hover the cell and you see 45%.', features: [{ verify: 'the cell reads 45%' }] },
    ]);
    expect(r.findings[0].kind).toBe('hover-only-figure');
  });
});

describe('narrationClaimsBySurface — the locked-claims ledger', () => {
  const scenes: NarratedScene[] = [
    { id: 'headline', url: '${programme_par_url}', narrative: 'Meeting regularity is 84% against an 80% target.' },
    { id: 'partner', narrative: 'Sorting partners puts the one at 62% first.' },
    { id: 'benchmark', url: '${tiyende_community_trust_opp_report_par_url}', narrative: 'Both peer medians sit above it.' },
  ];

  it('groups follow-on scenes (no url) under the page they are on', () => {
    const ledger = narrationClaimsBySurface(scenes);
    expect(ledger.map((e) => [e.surface, e.scenes.map((s) => s.scene)])).toEqual([
      ['${programme_par_url}', ['headline', 'partner']],
      ['${tiyende_community_trust_opp_report_par_url}', ['benchmark']],
    ]);
  });

  it('renders every claim verbatim — including figure-free ones like "both peer medians"', () => {
    const md = renderClaimsLedger(narrationClaimsBySurface(scenes));
    expect(md).toMatch(/### \$\{tiyende_community_trust_opp_report_par_url\}\n- \*\*benchmark\*\*: "Both peer medians sit above it\."/);
    expect(md).toMatch(/\[figures: 84%, 80%\]/);
  });
});

describe('the rules are wired into the procedures that author and dispatch (ace#2727)', () => {
  const narrative = readFileSync(join(ROOT, 'skills/demo-narrative/SKILL.md'), 'utf8');
  const phase7 = readFileSync(join(ROOT, 'agents/synthetic-data-and-workflows.md'), 'utf8');

  it('demo-narrative step 3b runs the end-frame check and says why the saved-run rule missed it', () => {
    expect(narrative).toMatch(/checkNarratedFiguresOnScreen/);
    expect(narrative).toMatch(/END FRAME/);
    expect(narrative).toMatch(/necessary, not sufficient/);
  });

  it('Phase 7 Step 3 hands the DDD loop the per-page ledger with the do-not-falsify rule', () => {
    const step3 = phase7.slice(phase7.indexOf('### Step 3: Render + converge'), phase7.indexOf('### Step 3.9'));
    expect(step3).toMatch(/narration-claims\.ts.*--ledger/s);
    expect(step3).toMatch(/do NOT make the edit; route the finding as NARRATION/);
    expect(step3).toMatch(/re-check the claims of\s+every scene that page appears in/);
  });
});
