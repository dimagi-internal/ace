// skills/eoi-round-review/rubric_health.py — after the AI first pass and
// calibration, how well the round's rubric served the pool: spread,
// separation, effective weight, evidence, redundancy, what the slate turned on
// beyond the score, and what calibration and people changed. Python (stdlib
// only); vitest drives it.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'skills/eoi-round-review/rubric_health.py');

// An invented round of 12 responses: no real organisation, person or place.
// - sites separates picks from passes and is fine;
// - prices is a near-copy of sites (redundant);
// - effort is the same for everyone (bunched, separates nothing);
// - chain is scored low mostly because answers were silent.
const criteria = [
  { id: 'sites', name: 'Named sites', weight: 30 },
  { id: 'prices', name: 'Price data', weight: 20 },
  { id: 'effort', name: 'Effort', weight: 20 },
  { id: 'chain', name: 'Chain links', weight: 30 },
];

type Row = [number, number, number, number, string];
const rows: Row[] = [
  [9, 9, 5, 9, 'pick'],
  [8, 8, 5, 8, 'pick'],
  [8, 7, 6, 3, 'backup'], // passed over below: a higher scorer that ends up backup
  [7, 7, 5, 7, 'backup'],
  [6, 6, 5, 2, 'waitlist'],
  [5, 5, 5, 2, 'waitlist'],
  [5, 4, 5, 2, 'waitlist'],
  [3, 3, 5, 2, 'pass'],
  [2, 2, 6, 1, 'pass'],
  [2, 2, 5, 2, 'pass'],
  [1, 1, 5, 1, 'pass'],
  [6, 5, 5, 2, 'pick'], // promoted on slot coverage, below several higher scorers
];

const reviews = rows.map(([sites, prices, effort, chain, outcome], n) => ({
  id: 100 + n,
  response_id: 1 + n,
  kind: 'ai',
  outcome,
  criteria_scores: { sites, prices, effort, chain },
  claims: [
    { id: 'c1', about: 'criterion:sites', basis: 'quoted', text: 'Anchor 7: names a district.', cites: [{ question: 'q1', quote: 'district' }] },
    { id: 'c2', about: 'criterion:prices', basis: 'quoted', text: 'Anchor 5: one price.', cites: [{ question: 'q2', quote: 'price' }] },
    { id: 'c3', about: 'criterion:effort', basis: 'quoted', text: 'Anchor 5: a plan.', cites: [{ question: 'q3', quote: 'plan' }] },
    chain <= 3
      ? { id: 'c4', about: 'criterion:chain', basis: 'quoted', text: 'Silent: names no chain actor.', cites: [{ question: 'q4', absent: true }] }
      : { id: 'c4', about: 'criterion:chain', basis: 'quoted', text: 'Anchor 7: a named dealer.', cites: [{ question: 'q4', quote: 'dealer' }] },
    {
      id: 'c5', about: 'outcome', basis: 'synthesized',
      text: n === 11 ? 'Pick for site B: the only credible applicant covering it.'
        : n === 2 ? 'Backup, slot rule: a higher scorer covers site A.' : 'Placed on score.',
    },
  ],
}));

// One person's review, starting from the AI review of response 3, disagreeing.
const human = {
  id: 900, response_id: 3, kind: 'human', based_on: 102, stance: 'disagrees', outcome: 'waitlist',
  criteria_scores: { sites: 8, prices: 4, effort: 6, chain: 3 }, claims: [],
};

function run(revs: unknown, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'eoi-rubric-health-'));
  writeFileSync(join(dir, 'round.json'), JSON.stringify({ round: { evaluation_criteria: criteria } }));
  writeFileSync(join(dir, 'reviews.json'), JSON.stringify(revs));
  writeFileSync(join(dir, 'cal.json'), JSON.stringify({
    changes: [
      { response_id: 12, field: 'outcome', before: 'waitlist', after: 'pick', why: 'slot coverage' },
      { response_id: 3, field: 'score:chain', before: 5, after: 3, why: 'silent answer' },
    ],
  }));
  const args = [SCRIPT, join(dir, 'round.json'), join(dir, 'reviews.json'),
    '--calibration', join(dir, 'cal.json'), '--json', join(dir, 'h.json'), ...extra];
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 20_000 });
  let h: any = null;
  try { h = JSON.parse(readFileSync(join(dir, 'h.json'), 'utf8')); } catch { /* no json on failure */ }
  return { r, h };
}

describe('eoi-round-review rubric_health.py', () => {
  it('reports spread, separation and effective weight per criterion', () => {
    const { r, h } = run([...reviews, human]);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(h.n_ai).toBe(12);
    expect(h.per_criterion.sites.auc_selected_vs_pass).toBeGreaterThan(0.9);
    expect(h.per_criterion.effort.sd).toBeLessThan(1);
    const eff = Object.values(h.per_criterion).reduce((a: number, p: any) => a + p.effective_weight, 0);
    expect(eff).toBeCloseTo(1, 5);
    expect(r.stdout).toMatch(/### Per criterion/);
  });

  it('finds the redundant pair and drops the bunched criterion', () => {
    const { h } = run(reviews);
    expect(h.correlations['sites|prices']).toBeGreaterThan(0.9);
    const actions = h.recommendations.map((x: any) => `${x.action} ${x.criterion}`);
    expect(actions).toContain('drop effort');
    expect(actions.some((a: string) => /^drop (sites|prices)$/.test(a))).toBe(true);
  });

  it('counts low scores given for a silent answer', () => {
    const { h } = run(reviews);
    expect(h.per_criterion.chain.thin_evidence_share).toBeCloseTo(9 / 12, 5);
    expect(h.per_criterion.sites.thin_evidence_share).toBe(0);
  });

  it('names what the slate turned on beyond the score', () => {
    const { r, h } = run(reviews);
    const promoted = h.overrides.map((o: any) => o.response_id);
    expect(promoted).toContain(12);
    expect(h.override_reasons['slot or geography']).toBeGreaterThanOrEqual(1);
    expect(h.recommendations.some((x: any) => x.action === 'add' && /slot or geography/.test(x.why))).toBe(true);
    expect(r.stdout).toMatch(/What the slate turned on besides the score/);
  });

  it('reads calibration changes and human reviews against the AI review they started from', () => {
    const { r, h } = run({ '3': [reviews[2], human] , '1': [reviews[0]], ...Object.fromEntries(reviews.slice(3).map((x) => [String(x.response_id), [x]])), '2': [reviews[1]] });
    expect(h.calibration.outcome_changes).toBe(1);
    expect(h.calibration.score_changes).toEqual({ chain: 1 });
    expect(h.human).toHaveLength(1);
    expect(h.human[0]).toMatchObject({ stance: 'disagrees', outcome_before: 'backup', outcome_after: 'waitlist' });
    expect(h.human[0].deltas).toEqual({ prices: -3 });
    expect(r.stdout).toMatch(/3: disagrees, outcome backup -> waitlist; prices -3/);
  });

  it('exits 2 when no AI review scores every criterion', () => {
    const { r } = run([human]);
    expect(r.status).toBe(2);
  });
});
