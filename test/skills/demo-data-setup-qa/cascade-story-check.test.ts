// Check 21: the cascade story planned AND landed (ace#2510). Observed on
// spark-facilitator/20260925-1536, whose Phase 7 had no PDD-derived indicator
// cascade; the fixtures are the fork spark-facilitator/20260926-1800's live proof.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkCascadeStory, checkParUrlScope } from '../../../skills/demo-data-setup-qa/checks';

// The plan demo-data-setup § C0/C3 now requires (realistic "(example)" partner
// names, five partners, a display roster, a headline spread — ace#2727); the
// saved runs are relabelled to the same names. The as-authored "Partner A/B/C"
// plan is refused below, and so is the be59309d "Example partner A" relabel.
const NAMES: Record<string, string> = {
  A: 'Tiyende Community Trust (example)',
  B: 'Kuunika Outreach Network (example)',
  C: "Tsogolo Women's Forum (example)",
};
const relabel = (text: string) => text.replace(/\bPartner ([ABC])\b/g, (_m, l: string) => NAMES[l]);
const FIX = join(__dirname, '../../fixtures/cascade');
const authoredPlan = JSON.parse(readFileSync(join(FIX, 'spark-facilitator-story.json'), 'utf8'));
const plan = JSON.parse(readFileSync(join(FIX, 'spark-facilitator-story-named.json'), 'utf8'));
const periods = JSON.parse(relabel(readFileSync(join(FIX, 'spark-facilitator-graded-periods.json'), 'utf8'))).periods;
const ids = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];

describe('checkCascadeStory (check 21)', () => {
  it('passes the live Spark programme, naming what each signal and headline showed', () => {
    const r = checkCascadeStory(plan, ids, periods);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/lagging_partner landed — Tsogolo Women's Forum \(example\) 62\.2%/);
    expect(r.detail).toMatch(/headline spread — SF_P1 across 3 partners/);
  });

  it('fails a single-implementer pilot shown as three unlabelled partners (Partner A/B/C)', () => {
    const r = checkCascadeStory(authoredPlan, ids, periods);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/"Partner A" \(carries no trailing "\(example\)" marker\)/);
  });

  it('fails the be59309d relabel "Example partner A/B/C" — a placeholder the DDD judge scored at clarity 2 (ace#2727)', () => {
    const placeholder = JSON.parse(JSON.stringify(plan));
    placeholder.partners.forEach((p: { label: string }, i: number) => (p.label = `Example partner ${'ABCDE'[i]}`));
    const r = checkCascadeStory(placeholder, ids, periods);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/"Example partner A" \(carries no trailing/);
    expect(r.auto_fix_hint).toMatch(/realistic invented partner names/);
  });

  it("fails a worker carrying a real person's name from the inputs", () => {
    const named = JSON.parse(JSON.stringify(plan));
    named.workers[0].display_name = 'Anne Mwale';
    expect(checkCascadeStory(named, ids, periods, ['Anne Mwale']).pass).toBe(false);
  });

  it('fails when the story file is missing', () => {
    expect(checkCascadeStory(null, ids, periods).pass).toBe(false);
  });

  it('fails a signal that did not land, with a fix-the-pool hint', () => {
    const wrong = JSON.parse(JSON.stringify(plan));
    wrong.signals[1].carrier = 'cbf_b04';
    const r = checkCascadeStory(wrong, ids, periods);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/standout_worker DID NOT LAND/);
    expect(r.auto_fix_hint).toMatch(/pool/);
  });
});

describe('check 2 scope for the indicator trio', () => {
  it('the programme report is program-owned; a partner opp report is opp-owned', () => {
    const r = checkParUrlScope([
      {
        key: 'programme',
        template: 'indicator_programme_report',
        par_url: 'https://labs.connect.dimagi.com/labs/workflow/6371/run/?run_id=6394&program_id=10082',
      },
      {
        key: 'partner_c_opp_report',
        template: 'indicator_opp_report',
        par_url: 'https://labs.connect.dimagi.com/labs/workflow/6380/run/?run_id=6433&opportunity_id=10084',
      },
    ]);
    expect(r.pass).toBe(true);
  });
});
