// Check 21: the cascade story planned AND landed (ace#2510). Observed on
// spark-facilitator/20260925-1536, whose Phase 7 had no PDD-derived indicator
// cascade; the fixtures are the fork spark-facilitator/20260926-1800's live proof.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkCascadeStory, checkParUrlScope } from '../../../skills/demo-data-setup-qa/checks';

const plan = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cascade/spark-facilitator-story.json'), 'utf8'),
);
const periods = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cascade/spark-facilitator-graded-periods.json'), 'utf8'),
).periods;
const ids = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];

describe('checkCascadeStory (check 21)', () => {
  it('passes the live Spark programme, naming what each signal showed', () => {
    const r = checkCascadeStory(plan, ids, periods);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/lagging_partner landed — Partner C 62\.2%/);
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
