// skills/eoi-round-review/check_claims.py — the quote checker every review
// subagent runs on its batch before returning, and the calibrator runs again
// after rewriting claims.
//
// It mirrors labs' save-time quote check so a batch is fixed before
// create_review, not after: labs refuses a whole review over one quote it
// cannot find. Python (stdlib only) because the subagent runs it from the skill dir
// with nothing installed; vitest is the only runner CI has, so it is driven
// from here.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'skills/eoi-round-review/check_claims.py');

// An invented applicant: no real organisation, person or place.
const batch = [
  {
    response_id: 'r1',
    org_name: 'Example Growers Cooperative',
    org_slug: '',
    earlier_submissions: [],
    labs_history: null,
    answers: [
      { question_id: 'q1', question: 'Where do you work?', answer: 'We work in  Alpha District\nand Beta District, with “weekly” market visits – every Tuesday.' },
      { question_id: 'q2', question: 'What would it cost?', answer: 'USD 900 per site, all inclusive.' },
    ],
  },
];

const criteria = [
  { id: 'named_sites', name: 'Named sites', weight: 60 },
  { id: 'cost_fit', name: 'Cost fit', weight: 40 },
];

const goodReview = () => ({
  response_id: 'r1',
  org_name: 'Example Growers Cooperative',
  criteria_scores: { named_sites: 7, cost_fit: 6 },
  claims: [
    {
      id: 'c1', about: 'criterion:named_sites', basis: 'quoted', text: 'Names two districts.',
      // case, whitespace runs, curly quotes and an en dash all normalise
      cites: [{ question: 'q1', quote: 'alpha district and beta district, with "weekly" market visits - every' }],
    },
    { id: 'c2', about: 'criterion:cost_fit', basis: 'quoted', text: 'Quotes USD 900 per site.', cites: [{ question: 'q2', quote: 'USD 900 per site' }] },
    { id: 'c3', about: 'concern', basis: 'quoted', text: 'Names no buyer.', cites: [{ question: 'q2', absent: true }] },
    { id: 'c4', about: 'strength', basis: 'synthesized', text: 'Registered locally.', cites: [{ source: 'web', detail: 'registry entry', url: 'https://example.org/registry' }] },
    { id: 'c5', about: 'outcome', basis: 'synthesized', text: 'Backup for the site role.' },
  ],
  outcome: 'backup',
  role: 'site partner',
  cost_per_site_usd: 900,
  cost_note: 'as quoted, USD per site',
  ask_next: 'Who buys the crop?',
  flags: [],
  one_line: 'Two named districts at USD 900 per site; no buyer named.',
});

function run(out: unknown, crit: unknown = criteria, b: unknown = batch) {
  const dir = mkdtempSync(join(tmpdir(), 'eoi-check-claims-'));
  writeFileSync(join(dir, 'batch.json'), JSON.stringify(b));
  writeFileSync(join(dir, 'out.json'), JSON.stringify(out));
  writeFileSync(join(dir, 'criteria.json'), JSON.stringify(crit));
  return spawnSync('python3', [SCRIPT, join(dir, 'batch.json'), join(dir, 'out.json'), join(dir, 'criteria.json')], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('eoi-round-review check_claims.py', () => {
  it('passes a clean batch, normalising as labs does', () => {
    const r = run([goodReview()]);
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe('OK: every claim checks');
    expect(r.status).toBe(0);
  });

  it('accepts the round shape for the criteria file too', () => {
    const r = run([goodReview()], { evaluation_criteria: criteria });
    expect(r.status).toBe(0);
  });

  it('finds a paraphrased quote and a quote cited to the wrong answer', () => {
    const rev = goodReview();
    rev.claims[0].cites = [{ question: 'q1', quote: 'works in two districts' }];
    rev.claims[1].cites = [{ question: 'q1', quote: 'USD 900 per site' }];
    const r = run([rev]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/r1 c1 cite 1: quote not found in answer q1/);
    expect(r.stdout).toMatch(/r1 c2 cite 1: quote not found in answer q1/);
  });

  it('finds unknown question ids, duplicate claim ids and a web cite with no url', () => {
    const rev = goodReview();
    rev.claims[2].cites = [{ question: 'q9', absent: true }];
    rev.claims[3].id = 'c1';
    rev.claims[3].cites = [{ source: 'web', detail: 'registry entry' } as never];
    const r = run([rev]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/question_id 'q9' is not a question of this response/);
    expect(r.stdout).toMatch(/r1 c1: claim id is used twice/);
    expect(r.stdout).toMatch(/web cite has no url/);
  });

  it('requires a 1-10 score and a reason claim for every criterion', () => {
    const rev = goodReview();
    rev.criteria_scores = { named_sites: 11 } as never;
    rev.claims = rev.claims.filter((c) => c.about !== 'criterion:cost_fit');
    const r = run([rev]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/score for named_sites is 11, not a whole number 1-10/);
    expect(r.stdout).toMatch(/r1: no score for criterion cost_fit/);
    expect(r.stdout).toMatch(/r1: no criterion:cost_fit claim/);
  });

  it('requires a valid outcome with an outcome claim', () => {
    const rev = goodReview();
    rev.outcome = 'shortlist';
    rev.claims = rev.claims.filter((c) => c.about !== 'outcome');
    const r = run([rev]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/outcome is 'shortlist'/);
    expect(r.stdout).toMatch(/r1: no outcome claim/);
  });

  it('requires every response in the batch to be reviewed', () => {
    const b = [...batch, { ...batch[0], response_id: 'r2' }];
    const r = run([goodReview()], criteria, b);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/r2: in the batch but not reviewed/);
  });

  it('exits 2 on a file it cannot read', () => {
    const r = spawnSync('python3', [SCRIPT, '/nonexistent/batch.json', '/nonexistent/out.json', '/nonexistent/c.json'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  describe('on an anchored rubric', () => {
    const anchored = (id: string, weight: number) => ({
      id,
      name: id,
      weight,
      scoring_guide: [
        '1: gives nothing on this point, or answers N/A',
        '3: mentions it in general terms with nothing checkable',
        '5: gives one checkable detail but no unit or source',
        '7: gives a checkable detail with a unit and a source',
        '10: gives several checkable details from its own field work',
        'Silent: 2 - blank or "No"; cite the answer with absent: true',
      ].join('\n'),
    });
    const anchoredCriteria = [anchored('named_sites', 60), anchored('cost_fit', 40)];
    const anchoredReview = () => {
      const rev = goodReview();
      rev.claims[0].text = 'Anchor 7: names two districts, with weekly market visits.';
      rev.claims[1].text = 'Anchor 5: quotes USD 900 per site, with no breakdown.';
      return rev;
    };

    it('passes when each criterion claim names the anchor nearest its score', () => {
      const rev = anchoredReview();
      rev.criteria_scores = { named_sites: 8, cost_fit: 6 };
      const r = run([rev], anchoredCriteria);
      expect(r.stdout.trim()).toBe('OK: every claim checks');
      expect(r.status).toBe(0);
    });

    it('accepts a Silent claim', () => {
      const rev = anchoredReview();
      rev.criteria_scores = { named_sites: 7, cost_fit: 2 };
      rev.claims[1] = { id: 'c2', about: 'criterion:cost_fit', basis: 'quoted', text: 'Silent: gives no cost.', cites: [{ question: 'q2', absent: true }] } as never;
      expect(run([rev], anchoredCriteria).status).toBe(0);
    });

    it('refuses a criterion claim with no anchor, or the wrong one for its score', () => {
      const rev = anchoredReview();
      rev.claims[0].text = 'Names two districts.';
      rev.criteria_scores = { named_sites: 7, cost_fit: 9 };
      const r = run([rev], anchoredCriteria);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/r1 c1: text must start 'Anchor <n>: '/);
      expect(r.stdout).toMatch(/r1 c2: cites anchor 5 for a score of 9; the nearest anchor is 10/);
    });

    it('does not ask for anchors when the guide is the older banded shape', () => {
      const banded = criteria.map((c) => ({ ...c, scoring_guide: '1-3: none. 4-6: some. 7-8: most. 9-10: all.' }));
      expect(run([goodReview()], banded).status).toBe(0);
    });
  });
});
